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

export const DEFAULT_LINKEDIN_VERSION = '202504';

export class LinkedInPublishAdapter implements IPublishAdapter {
  public readonly platform = 'LINKEDIN';

  constructor(private readonly httpFetch: HttpFetchFn = fetch) {}

  private getLinkedInHeaders(accessToken: string, extra: Record<string, string> = {}) {
    const version = (process.env.LINKEDIN_API_VERSION || DEFAULT_LINKEDIN_VERSION).trim();
    return {
      Authorization: `Bearer ${accessToken}`,
      'Linkedin-Version': version,
      'X-Restli-Protocol-Version': '2.0.0',
      ...extra,
    };
  }

  private normalizeAuthorUrn(externalId: string): string {
    const clean = (externalId || '').trim();
    if (clean.startsWith('urn:li:')) return clean;
    if (/^\d+$/.test(clean)) return `urn:li:organization:${clean}`;
    return `urn:li:person:${clean}`;
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
        throw new RetryableError(`LinkedIn API request timed out after ${timeoutMs}ms`, {
          httpStatus: 504,
          errorCode: 'LINKEDIN_TIMEOUT',
        });
      }
      throw new RetryableError(`LinkedIn network error: ${err?.message || 'unknown'}`, {
        httpStatus: 503,
        errorCode: 'LINKEDIN_NETWORK_ERROR',
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

    const message = bodyJson?.message || bodyJson?.error_description || `HTTP ${res.status}`;
    console.error(`[LinkedInAdapter] postId=${postId} step=${step} status=${res.status} msg=${message}`);

    if (res.status === 401) {
      throw new TokenExpiredError(`LinkedIn 401 at ${step}: ${message}`);
    }

    if (res.status === 429 || res.status >= 500) {
      throw new RetryableError(`LinkedIn transient error (${res.status}) at ${step}: ${message}`, {
        httpStatus: res.status,
        errorCode: `LINKEDIN_${res.status}`,
        rawResponse: bodyJson || { status: res.status },
      });
    }

    throw new FatalError(`LinkedIn non-retryable error (${res.status}) at ${step}: ${message}`, {
      httpStatus: res.status,
      errorCode: `LINKEDIN_FATAL_${res.status}`,
      rawResponse: bodyJson || { status: res.status },
    });
  }

  private async uploadImage(
    post: PublishablePostContext,
    authorUrn: string,
    mediaItem: PublishablePostContext['media'][number]
  ): Promise<string> {
    const initRes = await this.fetchWithTimeout(
      'https://api.linkedin.com/rest/images?action=initializeUpload',
      {
        method: 'POST',
        headers: this.getLinkedInHeaders(post.account.accessToken, {
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          initializeUploadRequest: {
            owner: authorUrn,
          },
        }),
      }
    );

    if (!initRes.ok) {
      await this.handleErrorResponse(initRes, 'images.initializeUpload', post.id);
    }

    const initData: any = await initRes.json();
    const uploadUrl = initData?.value?.uploadUrl;
    const imageUrn = initData?.value?.image;

    if (!uploadUrl || !imageUrn) {
      throw new FatalError('LinkedIn images.initializeUpload did not return uploadUrl and image URN', {
        httpStatus: 500,
        errorCode: 'LINKEDIN_MISSING_IMAGE_URN',
        rawResponse: initData,
      });
    }

    const imgBuffer = await post.storage.get(mediaItem.objectKey, mediaItem.bucket);
    const putRes = await this.fetchWithTimeout(
      uploadUrl,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${post.account.accessToken}`,
          'Content-Type': mediaItem.mimeType || 'image/jpeg',
          'Content-Length': String(imgBuffer.length),
        },
        body: new Uint8Array(imgBuffer),
      },
      60000
    );

    if (!putRes.ok) {
      await this.handleErrorResponse(putRes, 'images.putBinary', post.id);
    }

    return String(imageUrn);
  }

  private async uploadVideo(
    post: PublishablePostContext,
    authorUrn: string,
    mediaItem: PublishablePostContext['media'][number]
  ): Promise<{ videoUrn: string; isAvailable: boolean }> {
    const videoBuffer = await post.storage.get(mediaItem.objectKey, mediaItem.bucket);

    const initRes = await this.fetchWithTimeout(
      'https://api.linkedin.com/rest/videos?action=initializeUpload',
      {
        method: 'POST',
        headers: this.getLinkedInHeaders(post.account.accessToken, {
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          initializeUploadRequest: {
            owner: authorUrn,
            fileSizeBytes: videoBuffer.length,
            uploadCaptions: false,
            uploadThumbnail: false,
          },
        }),
      }
    );

    if (!initRes.ok) {
      await this.handleErrorResponse(initRes, 'videos.initializeUpload', post.id);
    }

    const initData: any = await initRes.json();
    const videoUrn = String(initData?.value?.video || '').trim();
    const uploadToken = String(initData?.value?.uploadToken || '');
    const instructions: Array<{ uploadUrl: string; firstByte?: number; lastByte?: number }> =
      initData?.value?.uploadInstructions || [];

    if (!videoUrn || instructions.length === 0) {
      throw new FatalError('LinkedIn videos.initializeUpload did not return video URN or uploadInstructions', {
        httpStatus: 500,
        errorCode: 'LINKEDIN_MISSING_VIDEO_INSTRUCTIONS',
        rawResponse: initData,
      });
    }

    const uploadedPartIds: string[] = [];

    for (const part of instructions) {
      const start = part.firstByte ?? 0;
      const end = part.lastByte !== undefined ? part.lastByte + 1 : videoBuffer.length;
      const chunk = videoBuffer.subarray(start, end);

      const partRes = await this.fetchWithTimeout(
        part.uploadUrl,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(chunk.length),
          },
          body: new Uint8Array(chunk),
        },
        90000
      );

      if (!partRes.ok) {
        await this.handleErrorResponse(partRes, 'videos.uploadChunk', post.id);
      }

      const etag = (partRes.headers.get('etag') || partRes.headers.get('ETag') || 'part-etag-1')
        .replace(/"/g, '')
        .trim();
      uploadedPartIds.push(etag);
    }

    const finalizeRes = await this.fetchWithTimeout(
      'https://api.linkedin.com/rest/videos?action=finalizeUpload',
      {
        method: 'POST',
        headers: this.getLinkedInHeaders(post.account.accessToken, {
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          finalizeUploadRequest: {
            video: videoUrn,
            uploadToken,
            uploadedPartIds,
          },
        }),
      }
    );

    if (!finalizeRes.ok) {
      await this.handleErrorResponse(finalizeRes, 'videos.finalizeUpload', post.id);
    }

    // Check if video is immediately AVAILABLE
    const statusRes = await this.fetchWithTimeout(
      `https://api.linkedin.com/rest/videos/${encodeURIComponent(videoUrn)}`,
      {
        method: 'GET',
        headers: this.getLinkedInHeaders(post.account.accessToken),
      }
    );

    if (statusRes.ok) {
      const statusData: any = await statusRes.json();
      if (statusData?.status === 'AVAILABLE') {
        return { videoUrn, isAvailable: true };
      }
      if (statusData?.status === 'PROCESSING_FAILED') {
        throw new FatalError('LinkedIn video processing failed after finalizeUpload', {
          httpStatus: 400,
          errorCode: 'LINKEDIN_VIDEO_PROCESSING_FAILED',
          rawResponse: statusData,
        });
      }
    }

    return { videoUrn, isAvailable: false };
  }

  private async createRestPost(
    post: PublishablePostContext,
    authorUrn: string,
    mediaUrns: string[]
  ): Promise<PublishAdapterResult> {
    const commentary = buildFullPostCaption(post.caption, post.hashtags).slice(0, 3000);
    const body: Record<string, any> = {
      author: authorUrn,
      commentary,
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    };

    if (mediaUrns.length === 1) {
      body.content = {
        media: {
          title: (post.title || 'Leaders Performance').slice(0, 200),
          id: mediaUrns[0],
        },
      };
    } else if (mediaUrns.length > 1) {
      body.content = {
        multiImage: {
          images: mediaUrns.map((urn) => ({
            id: urn,
            altText: (post.title || 'Leaders Performance').slice(0, 120),
          })),
        },
      };
    }

    const postRes = await this.fetchWithTimeout('https://api.linkedin.com/rest/posts', {
      method: 'POST',
      headers: this.getLinkedInHeaders(post.account.accessToken, {
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify(body),
    });

    if (!postRes.ok) {
      await this.handleErrorResponse(postRes, 'rest.posts.create', post.id);
    }

    let respBody: any = null;
    try {
      respBody = await postRes.json();
    } catch {
      respBody = null;
    }

    const headerUrn =
      postRes.headers.get('x-restli-id') ||
      postRes.headers.get('X-RestLi-Id') ||
      respBody?.id ||
      `urn:li:share:${Date.now()}`;

    const postUrn = String(headerUrn).trim();
    const url = `https://www.linkedin.com/feed/update/${encodeURIComponent(postUrn)}/`;

    return {
      state: 'PUBLISHED',
      platformPostId: postUrn,
      url,
      httpStatus: postRes.status || 201,
      rawResponse: respBody || { id: postUrn },
    };
  }

  public async publish(post: PublishablePostContext): Promise<PublishAdapterResult> {
    if (post.processingRef) {
      return this.poll(post);
    }

    const authorUrn = this.normalizeAuthorUrn(
      String(post.options?.authorUrn || post.account.externalId)
    );

    const mainMedia = post.media
      .filter((m) => m.role === 'MAIN')
      .sort((a, b) => a.position - b.position);

    if (mainMedia.length === 0) {
      return this.createRestPost(post, authorUrn, []);
    }

    const first = mainMedia[0];
    const isVideo = first.mimeType.toLowerCase().startsWith('video/');

    if (isVideo) {
      const { videoUrn, isAvailable } = await this.uploadVideo(post, authorUrn, first);
      if (!isAvailable) {
        return {
          state: 'PROCESSING',
          processingRef: videoUrn,
          httpStatus: 202,
          rawResponse: { videoUrn, status: 'PROCESSING' },
        };
      }
      return this.createRestPost(post, authorUrn, [videoUrn]);
    }

    // Single image or multi-image carousel
    const imageUrns: string[] = [];
    for (const item of mainMedia) {
      const urn = await this.uploadImage(post, authorUrn, item);
      imageUrns.push(urn);
    }

    return this.createRestPost(post, authorUrn, imageUrns);
  }

  public async poll(post: PublishablePostContext): Promise<PollAdapterResult> {
    const videoUrn = String(post.processingRef || '').trim();
    if (!videoUrn) {
      throw new FatalError('Cannot poll LinkedIn video without processingRef', {
        httpStatus: 400,
        errorCode: 'LINKEDIN_MISSING_PROCESSING_REF',
      });
    }

    const statusRes = await this.fetchWithTimeout(
      `https://api.linkedin.com/rest/videos/${encodeURIComponent(videoUrn)}`,
      {
        method: 'GET',
        headers: this.getLinkedInHeaders(post.account.accessToken),
      }
    );

    if (!statusRes.ok) {
      await this.handleErrorResponse(statusRes, 'videos.getStatus', post.id);
    }

    const statusData: any = await statusRes.json();
    if (statusData?.status === 'PROCESSING_FAILED') {
      throw new FatalError('LinkedIn video processing failed', {
        httpStatus: 400,
        errorCode: 'LINKEDIN_VIDEO_PROCESSING_FAILED',
        rawResponse: statusData,
      });
    }

    if (statusData?.status !== 'AVAILABLE') {
      return {
        state: 'PROCESSING',
        processingRef: videoUrn,
        httpStatus: 202,
        rawResponse: statusData,
      };
    }

    const authorUrn = this.normalizeAuthorUrn(
      String(post.options?.authorUrn || post.account.externalId)
    );
    return this.createRestPost(post, authorUrn, [videoUrn]);
  }

  public async refreshToken(account: {
    id: string;
    platform: string;
    externalId: string;
    refreshToken: string;
  }): Promise<RefreshTokenResult> {
    const clientId = (process.env.LINKEDIN_CLIENT_ID || '').trim();
    const clientSecret = (process.env.LINKEDIN_CLIENT_SECRET || '').trim();

    const res = await this.fetchWithTimeout('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: account.refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });

    if (!res.ok) {
      throw new FatalError(`LinkedIn token refresh failed with HTTP ${res.status}`, {
        httpStatus: res.status,
        errorCode: 'LINKEDIN_REFRESH_FAILED',
      });
    }

    const data: any = await res.json();
    const expiresInSec = Number(data?.expires_in || 5184000);
    return {
      accessToken: String(data.access_token),
      refreshToken: data.refresh_token ? String(data.refresh_token) : account.refreshToken,
      expiresAt: new Date(Date.now() + expiresInSec * 1000),
    };
  }
}
