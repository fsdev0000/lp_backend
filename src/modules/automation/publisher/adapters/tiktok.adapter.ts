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

export const TIKTOK_DEFAULT_CHUNK_SIZE = 10 * 1024 * 1024; // 10 MB

export class TikTokPublishAdapter implements IPublishAdapter {
  public readonly platform = 'TIKTOK';

  constructor(private readonly httpFetch: HttpFetchFn = fetch) {}

  private isAudited(): boolean {
    const raw = (process.env.TIKTOK_AUDITED || 'false').trim().toLowerCase();
    return raw === 'true' || raw === '1';
  }

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
        throw new RetryableError(`TikTok API request timed out after ${timeoutMs}ms`, {
          httpStatus: 504,
          errorCode: 'TIKTOK_TIMEOUT',
        });
      }
      throw new RetryableError(`TikTok network error: ${err?.message || 'unknown'}`, {
        httpStatus: 503,
        errorCode: 'TIKTOK_NETWORK_ERROR',
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

    const code = bodyJson?.error?.code || `HTTP_${res.status}`;
    const msg = bodyJson?.error?.message || `HTTP ${res.status}`;
    console.error(`[TikTokAdapter] postId=${postId} step=${step} status=${res.status} code=${code} msg=${msg}`);

    if (res.status === 401 || code === 'access_token_invalid') {
      throw new TokenExpiredError(`TikTok 401 at ${step}: ${msg}`);
    }

    if (res.status === 429 || res.status >= 500 || code === 'rate_limit_exceeded') {
      throw new RetryableError(`TikTok transient error (${res.status}) at ${step}: ${msg}`, {
        httpStatus: res.status,
        errorCode: `TIKTOK_${res.status}`,
        rawResponse: bodyJson || { status: res.status },
      });
    }

    throw new FatalError(`TikTok non-retryable error (${res.status}) at ${step}: ${msg}`, {
      httpStatus: res.status,
      errorCode: `TIKTOK_FATAL_${res.status}`,
      rawResponse: bodyJson || { status: res.status },
    });
  }

  public async publish(post: PublishablePostContext): Promise<PublishAdapterResult> {
    // Edge Case #25: TikTok app not yet audited -> refuse public posting and mark FAILED "TikTok audit pending"
    if (!this.isAudited()) {
      throw new FatalError(
        'TikTok audit pending (TIKTOK_AUDITED=false); refusing to publish or silently post private',
        {
          httpStatus: 403,
          errorCode: 'TIKTOK_AUDIT_PENDING',
        }
      );
    }

    if (post.processingRef) {
      return this.poll(post);
    }

    const mainVideo = post.media.find((m) => m.role === 'MAIN');
    if (!mainVideo) {
      throw new FatalError('TikTok publish requires a MAIN video asset', {
        httpStatus: 400,
        errorCode: 'TIKTOK_MISSING_VIDEO',
      });
    }

    // Step 1: creator_info/query
    const creatorRes = await this.fetchWithTimeout(
      'https://open.tiktokapis.com/v2/post/publish/creator_info/query/',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${post.account.accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify({}),
      }
    );

    if (!creatorRes.ok) {
      await this.handleErrorResponse(creatorRes, 'creator_info.query', post.id);
    }

    const creatorData: any = await creatorRes.json();
    const privacyOptions: string[] = creatorData?.data?.privacy_level_options || [
      'PUBLIC_TO_EVERYONE',
    ];
    const maxVideoDurationSec = Number(creatorData?.data?.max_video_post_duration_sec || 600);

    if (mainVideo.durationSec && mainVideo.durationSec > maxVideoDurationSec) {
      throw new FatalError(
        `TikTok video duration (${mainVideo.durationSec}s) exceeds creator max (${maxVideoDurationSec}s)`,
        {
          httpStatus: 400,
          errorCode: 'TIKTOK_DURATION_EXCEEDED',
          rawResponse: creatorData,
        }
      );
    }

    const requestedPrivacy = String(post.options?.privacyLevel || 'PUBLIC_TO_EVERYONE');
    if (!privacyOptions.includes(requestedPrivacy)) {
      throw new FatalError(
        `TikTok requested privacy_level "${requestedPrivacy}" is not permitted by creator_info (${privacyOptions.join(
          ', '
        )})`,
        {
          httpStatus: 400,
          errorCode: 'TIKTOK_PRIVACY_NOT_ALLOWED',
          rawResponse: creatorData,
        }
      );
    }

    // Step 2: video/init with FILE_UPLOAD
    const videoBuffer = await post.storage.get(mainVideo.objectKey, mainVideo.bucket);
    const totalBytes = videoBuffer.length;
    const chunkSize = Math.min(totalBytes, TIKTOK_DEFAULT_CHUNK_SIZE);
    const totalChunkCount = Math.max(1, Math.ceil(totalBytes / chunkSize));

    const title = buildFullPostCaption(post.caption || post.title, post.hashtags).slice(0, 2200);

    const initRes = await this.fetchWithTimeout(
      'https://open.tiktokapis.com/v2/post/publish/video/init/',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${post.account.accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify({
          post_info: {
            title,
            privacy_level: requestedPrivacy,
            disable_duet: Boolean(post.options?.disableDuet),
            disable_comment: Boolean(post.options?.disableComment),
            disable_stitch: Boolean(post.options?.disableStitch),
          },
          source_info: {
            source: 'FILE_UPLOAD',
            video_size: totalBytes,
            chunk_size: chunkSize,
            total_chunk_count: totalChunkCount,
          },
        }),
      }
    );

    if (!initRes.ok) {
      await this.handleErrorResponse(initRes, 'video.init', post.id);
    }

    const initData: any = await initRes.json();
    const publishId = String(initData?.data?.publish_id || '').trim();
    const uploadUrl = String(initData?.data?.upload_url || '').trim();

    if (!publishId || !uploadUrl) {
      throw new FatalError('TikTok video/init did not return publish_id and upload_url', {
        httpStatus: 500,
        errorCode: 'TIKTOK_MISSING_INIT_FIELDS',
        rawResponse: initData,
      });
    }

    // Step 3: Chunked PUT upload
    for (let i = 0; i < totalChunkCount; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, totalBytes);
      const chunk = videoBuffer.subarray(start, end);

      const putRes = await this.fetchWithTimeout(
        uploadUrl,
        {
          method: 'PUT',
          headers: {
            'Content-Type': mainVideo.mimeType || 'video/mp4',
            'Content-Length': String(chunk.length),
            'Content-Range': `bytes ${start}-${end - 1}/${totalBytes}`,
          },
          body: new Uint8Array(chunk),
        },
        90000
      );

      if (!putRes.ok) {
        await this.handleErrorResponse(putRes, `video.uploadChunk.${i}`, post.id);
      }
    }

    return {
      state: 'PROCESSING',
      processingRef: publishId,
      httpStatus: 202,
      rawResponse: initData,
    };
  }

  public async poll(post: PublishablePostContext): Promise<PollAdapterResult> {
    const publishId = String(post.processingRef || '').trim();
    if (!publishId) {
      throw new FatalError('Cannot poll TikTok status without processingRef (publish_id)', {
        httpStatus: 400,
        errorCode: 'TIKTOK_MISSING_PROCESSING_REF',
      });
    }

    const res = await this.fetchWithTimeout(
      'https://open.tiktokapis.com/v2/post/publish/status/fetch/',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${post.account.accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify({
          publish_id: publishId,
        }),
      }
    );

    if (!res.ok) {
      await this.handleErrorResponse(res, 'status.fetch', post.id);
    }

    const data: any = await res.json();
    const status = String(data?.data?.status || 'PROCESSING_UPLOAD').toUpperCase();

    if (status === 'FAILED') {
      throw new FatalError(
        `TikTok publish failed for ${publishId}: ${data?.data?.fail_reason || 'unknown'}`,
        {
          httpStatus: 400,
          errorCode: 'TIKTOK_PUBLISH_FAILED',
          rawResponse: data,
        }
      );
    }

    if (status === 'PUBLISH_COMPLETE') {
      const publicId = String(
        data?.data?.publicaly_available_post_id?.[0] || publishId
      ).trim();
      return {
        state: 'PUBLISHED',
        platformPostId: publicId,
        url: `https://www.tiktok.com/@${encodeURIComponent(
          post.account.externalId || 'leadersperformance'
        )}/video/${encodeURIComponent(publicId)}`,
        httpStatus: 200,
        rawResponse: data,
      };
    }

    return {
      state: 'PROCESSING',
      processingRef: publishId,
      httpStatus: 202,
      rawResponse: data,
    };
  }

  public async refreshToken(account: {
    id: string;
    platform: string;
    externalId: string;
    refreshToken: string;
  }): Promise<RefreshTokenResult> {
    const clientKey = (process.env.TIKTOK_CLIENT_KEY || '').trim();
    const clientSecret = (process.env.TIKTOK_CLIENT_SECRET || '').trim();

    const res = await this.fetchWithTimeout('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: clientKey,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: account.refreshToken,
      }).toString(),
    });

    if (!res.ok) {
      throw new FatalError(`TikTok token refresh failed with HTTP ${res.status}`, {
        httpStatus: res.status,
        errorCode: 'TIKTOK_REFRESH_FAILED',
      });
    }

    const data: any = await res.json();
    const expiresInSec = Number(data?.expires_in || 86400);
    return {
      accessToken: String(data.access_token),
      refreshToken: data.refresh_token ? String(data.refresh_token) : account.refreshToken,
      expiresAt: new Date(Date.now() + expiresInSec * 1000),
    };
  }
}
