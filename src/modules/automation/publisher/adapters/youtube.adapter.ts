import {
  IPublishAdapter,
  PublishablePostContext,
  PublishAdapterResult,
  PollAdapterResult,
  RefreshTokenResult,
  RetryableError,
  FatalError,
  TokenExpiredError,
  HttpFetchFn,
  buildFullPostCaption,
} from './base.adapter';

export class YouTubePublishAdapter implements IPublishAdapter {
  public readonly platform = 'YOUTUBE';

  constructor(private readonly httpFetch: HttpFetchFn = fetch) {}

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs = 30000
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.httpFetch(url, {
        ...init,
        signal: controller.signal,
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        throw new RetryableError(`YouTube API request timed out after ${timeoutMs}ms`, {
          httpStatus: 504,
          errorCode: 'YOUTUBE_TIMEOUT',
        });
      }
      throw new RetryableError(`YouTube network error: ${err?.message || 'unknown'}`, {
        httpStatus: 503,
        errorCode: 'YOUTUBE_NETWORK_ERROR',
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async handleErrorResponse(res: Response, step: string, postId: string): Promise<never> {
    let bodyJson: any = null;
    try {
      bodyJson = await res.json();
    } catch {
      bodyJson = null;
    }

    const reason =
      bodyJson?.error?.errors?.[0]?.reason ||
      bodyJson?.error?.status ||
      bodyJson?.error?.message ||
      `HTTP ${res.status}`;

    console.error(`[YouTubeAdapter] postId=${postId} step=${step} status=${res.status} reason=${reason}`);

    if (res.status === 401) {
      throw new TokenExpiredError(`YouTube 401 at ${step}: ${reason}`);
    }

    // Edge Case #26: YouTube quota exceeded -> retry next day window (+24h = 1440m) and alert Asif
    if (
      res.status === 403 &&
      /quotaExceeded|dailyLimitExceeded/i.test(JSON.stringify(bodyJson || reason))
    ) {
      throw new RetryableError(`YouTube daily quota exceeded at ${step}: ${reason}`, {
        httpStatus: 403,
        errorCode: 'YOUTUBE_QUOTA_EXCEEDED',
        rawResponse: bodyJson || { status: res.status },
        customDelayMinutes: 24 * 60,
      });
    }

    if (res.status === 429 || res.status >= 500) {
      throw new RetryableError(`YouTube transient error (${res.status}) at ${step}: ${reason}`, {
        httpStatus: res.status,
        errorCode: `YOUTUBE_${res.status}`,
        rawResponse: bodyJson || { status: res.status },
      });
    }

    throw new FatalError(`YouTube non-retryable error (${res.status}) at ${step}: ${reason}`, {
      httpStatus: res.status,
      errorCode: `YOUTUBE_FATAL_${res.status}`,
      rawResponse: bodyJson || { status: res.status },
    });
  }

  public async publish(post: PublishablePostContext): Promise<PublishAdapterResult> {
    // Idempotency: if processingRef already exists from an interrupted run, poll instead of re-uploading
    if (post.processingRef) {
      return this.poll(post);
    }

    const mainVideo = post.media.find((m) => m.role === 'MAIN');
    if (!mainVideo) {
      throw new FatalError('YouTube publish requires a MAIN video asset', {
        httpStatus: 400,
        errorCode: 'YOUTUBE_MISSING_VIDEO',
      });
    }

    const videoBuffer = await post.storage.get(mainVideo.objectKey, mainVideo.bucket);
    const title = (post.title || post.caption || 'Leaders Performance').slice(0, 100).trim();
    const description = buildFullPostCaption(post.caption, post.hashtags).slice(0, 5000);
    const tags = (post.hashtags || []).map((t) => t.replace(/^#/, '')).filter(Boolean);

    const nowMs = Date.now();
    const isFutureSlot = post.scheduledAt.getTime() > nowMs + 60 * 1000;

    // Plan Section 7: Resumable videos.insert with privacyStatus=private and publishAt=scheduledAt when future
    const metadataBody = {
      snippet: {
        title,
        description,
        tags,
        categoryId: String(post.options?.categoryId || '22'),
      },
      status: isFutureSlot
        ? {
            privacyStatus: 'private',
            publishAt: post.scheduledAt.toISOString(),
            selfDeclaredMadeForKids: false,
          }
        : {
            privacyStatus: String(post.options?.privacyStatus || 'public'),
            selfDeclaredMadeForKids: false,
          },
    };

    const initUrl =
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';
    const initRes = await this.fetchWithTimeout(initUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${post.account.accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(videoBuffer.length),
        'X-Upload-Content-Type': mainVideo.mimeType || 'video/mp4',
      },
      body: JSON.stringify(metadataBody),
    });

    if (!initRes.ok) {
      await this.handleErrorResponse(initRes, 'videos.insert.init', post.id);
    }

    const uploadUrl = initRes.headers.get('location') || initRes.headers.get('Location');
    if (!uploadUrl) {
      throw new FatalError('YouTube resumable upload did not return a Location header', {
        httpStatus: 500,
        errorCode: 'YOUTUBE_NO_UPLOAD_LOCATION',
      });
    }

    // Step 2: Upload binary video bytes
    const putRes = await this.fetchWithTimeout(
      uploadUrl,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${post.account.accessToken}`,
          'Content-Length': String(videoBuffer.length),
          'Content-Type': mainVideo.mimeType || 'video/mp4',
        },
        body: new Uint8Array(videoBuffer),
      },
      120000
    );

    if (!putRes.ok) {
      await this.handleErrorResponse(putRes, 'videos.insert.upload', post.id);
    }

    const videoData: any = await putRes.json();
    const videoId = String(videoData?.id || '').trim();
    if (!videoId) {
      throw new FatalError('YouTube upload succeeded without returning a video id', {
        httpStatus: 500,
        errorCode: 'YOUTUBE_MISSING_VIDEO_ID',
        rawResponse: videoData,
      });
    }

    // Step 3: Optional playlistItems.insert if options.playlistId is configured
    const playlistId = post.options?.playlistId ? String(post.options.playlistId).trim() : '';
    if (playlistId) {
      const playlistRes = await this.fetchWithTimeout(
        'https://www.googleapis.com/youtube/v3/playlistItems?part=snippet',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${post.account.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            snippet: {
              playlistId,
              resourceId: {
                kind: 'youtube#video',
                videoId,
              },
            },
          }),
        }
      );
      if (!playlistRes.ok && playlistRes.status >= 500) {
        console.warn(`[YouTubeAdapter] postId=${post.id} playlistItems.insert warning HTTP ${playlistRes.status}`);
      }
    }

    // Step 4: Optional thumbnails.set if a THUMBNAIL asset exists
    const thumbnailAsset = post.media.find((m) => m.role === 'THUMBNAIL');
    if (thumbnailAsset) {
      const thumbBuffer = await post.storage.get(
        thumbnailAsset.objectKey,
        thumbnailAsset.bucket
      );
      const thumbRes = await this.fetchWithTimeout(
        `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(
          videoId
        )}&uploadType=media`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${post.account.accessToken}`,
            'Content-Type': thumbnailAsset.mimeType || 'image/jpeg',
            'Content-Length': String(thumbBuffer.length),
          },
          body: new Uint8Array(thumbBuffer),
        }
      );
      if (!thumbRes.ok && thumbRes.status >= 500) {
        console.warn(`[YouTubeAdapter] postId=${post.id} thumbnails.set warning HTTP ${thumbRes.status}`);
      }
    }

    const processingStatus = videoData?.processingDetails?.processingStatus;
    const liveUrl = `https://www.youtube.com/watch?v=${videoId}`;

    if (processingStatus && processingStatus === 'processing') {
      return {
        state: 'PROCESSING',
        processingRef: videoId,
        platformPostId: videoId,
        url: liveUrl,
        httpStatus: 202,
        rawResponse: videoData,
      };
    }

    return {
      state: 'PUBLISHED',
      platformPostId: videoId,
      url: liveUrl,
      httpStatus: 200,
      rawResponse: videoData,
    };
  }

  public async poll(post: PublishablePostContext): Promise<PollAdapterResult> {
    const videoId = String(post.processingRef || post.platformPostId || '').trim();
    if (!videoId) {
      throw new FatalError('Cannot poll YouTube status without processingRef (videoId)', {
        httpStatus: 400,
        errorCode: 'YOUTUBE_MISSING_PROCESSING_REF',
      });
    }

    const url = `https://www.googleapis.com/youtube/v3/videos?part=status,processingDetails&id=${encodeURIComponent(
      videoId
    )}`;
    const res = await this.fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${post.account.accessToken}`,
      },
    });

    if (!res.ok) {
      await this.handleErrorResponse(res, 'videos.list.poll', post.id);
    }

    const data: any = await res.json();
    const item = data?.items?.[0];
    if (!item) {
      throw new FatalError(`YouTube video ${videoId} not found during poll`, {
        httpStatus: 404,
        errorCode: 'YOUTUBE_VIDEO_NOT_FOUND',
        rawResponse: data,
      });
    }

    const procStatus = item?.processingDetails?.processingStatus;
    const uploadStatus = item?.status?.uploadStatus;

    if (procStatus === 'failed' || uploadStatus === 'Failed' || uploadStatus === 'rejected') {
      throw new FatalError(
        `YouTube processing failed for video ${videoId}: ${
          item?.processingDetails?.processingFailureReason || uploadStatus
        }`,
        {
          httpStatus: 400,
          errorCode: 'YOUTUBE_PROCESSING_FAILED',
          rawResponse: item,
        }
      );
    }

    if (procStatus === 'processing') {
      return {
        state: 'PROCESSING',
        processingRef: videoId,
        platformPostId: videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        httpStatus: 202,
        rawResponse: item,
      };
    }

    return {
      state: 'PUBLISHED',
      platformPostId: videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      httpStatus: 200,
      rawResponse: item,
    };
  }

  public async refreshToken(account: {
    id: string;
    platform: string;
    externalId: string;
    refreshToken: string;
  }): Promise<RefreshTokenResult> {
    const clientId = (process.env.YOUTUBE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '').trim();
    const clientSecret = (
      process.env.YOUTUBE_CLIENT_SECRET ||
      process.env.GOOGLE_CLIENT_SECRET ||
      ''
    ).trim();

    const res = await this.fetchWithTimeout('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: account.refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });

    if (!res.ok) {
      throw new FatalError(`YouTube token refresh failed with HTTP ${res.status}`, {
        httpStatus: res.status,
        errorCode: 'YOUTUBE_REFRESH_FAILED',
      });
    }

    const data: any = await res.json();
    const expiresInSec = Number(data?.expires_in || 3600);
    return {
      accessToken: String(data.access_token),
      refreshToken: data.refresh_token ? String(data.refresh_token) : account.refreshToken,
      expiresAt: new Date(Date.now() + expiresInSec * 1000),
    };
  }
}
