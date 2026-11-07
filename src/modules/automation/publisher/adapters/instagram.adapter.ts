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

export const IG_GRAPH_VERSION = 'v21.0';
export const IG_DAILY_CAP_DEFAULT = 50;

export class InstagramPublishAdapter implements IPublishAdapter {
  public readonly platform = 'INSTAGRAM';

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
        throw new RetryableError(`Instagram API request timed out after ${timeoutMs}ms`, {
          httpStatus: 504,
          errorCode: 'INSTAGRAM_TIMEOUT',
        });
      }
      throw new RetryableError(`Instagram network error: ${err?.message || 'unknown'}`, {
        httpStatus: 503,
        errorCode: 'INSTAGRAM_NETWORK_ERROR',
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

    const code = bodyJson?.error?.code;
    const msg = bodyJson?.error?.message || `HTTP ${res.status}`;
    console.error(`[InstagramAdapter] postId=${postId} step=${step} status=${res.status} code=${code} msg=${msg}`);

    if (res.status === 401 || code === 190) {
      throw new TokenExpiredError(`Instagram 401/OAuthException at ${step}: ${msg}`);
    }

    if (res.status === 429 || res.status >= 500 || code === 4 || code === 2) {
      throw new RetryableError(`Instagram transient error (${res.status}) at ${step}: ${msg}`, {
        httpStatus: res.status,
        errorCode: `INSTAGRAM_${res.status}`,
        rawResponse: bodyJson || { status: res.status },
      });
    }

    throw new FatalError(`Instagram non-retryable error (${res.status}) at ${step}: ${msg}`, {
      httpStatus: res.status,
      errorCode: `INSTAGRAM_FATAL_${res.status}`,
      rawResponse: bodyJson || { status: res.status },
    });
  }

  private async checkPublishingLimit(post: PublishablePostContext, igUserId: string): Promise<void> {
    const url = `https://graph.facebook.com/${IG_GRAPH_VERSION}/${encodeURIComponent(
      igUserId
    )}/content_publishing_limit?fields=config,quota_usage&access_token=${encodeURIComponent(
      post.account.accessToken
    )}`;

    const res = await this.fetchWithTimeout(url, { method: 'GET' });
    if (!res.ok) {
      await this.handleErrorResponse(res, 'content_publishing_limit', post.id);
    }

    const data: any = await res.json();
    const entry = data?.data?.[0];
    const quotaUsage = Number(entry?.quota_usage ?? 0);
    const quotaTotal = Number(entry?.config?.quota_total ?? IG_DAILY_CAP_DEFAULT);

    // Edge Case #23: Instagram daily cap reached -> nextAttemptAt = +60 min
    if (quotaUsage >= quotaTotal) {
      throw new RetryableError(
        `Instagram daily publishing limit reached (${quotaUsage}/${quotaTotal})`,
        {
          httpStatus: 429,
          errorCode: 'INSTAGRAM_DAILY_CAP_REACHED',
          rawResponse: data,
          customDelayMinutes: 60,
        }
      );
    }
  }

  private async createMediaContainer(
    post: PublishablePostContext,
    igUserId: string
  ): Promise<{ containerId: string; rawResponse: any }> {
    const mainMedia = post.media
      .filter((m) => m.role === 'MAIN')
      .sort((a, b) => a.position - b.position);

    if (mainMedia.length === 0) {
      throw new FatalError('Instagram publish requires at least 1 MAIN media asset', {
        httpStatus: 400,
        errorCode: 'INSTAGRAM_MISSING_MEDIA',
      });
    }

    const caption = buildFullPostCaption(post.caption, post.hashtags).slice(0, 2200);
    const createEndpoint = `https://graph.facebook.com/${IG_GRAPH_VERSION}/${encodeURIComponent(
      igUserId
    )}/media`;

    // Case 1: Multi-item CAROUSEL
    if (mainMedia.length > 1) {
      const childIds: string[] = [];
      for (const item of mainMedia) {
        const signedUrl = await post.storage.signedUrl(item.objectKey, 24 * 3600, item.bucket);
        const isVideo = item.mimeType.toLowerCase().startsWith('video/');
        const childParams = new URLSearchParams({
          is_carousel_item: 'true',
          access_token: post.account.accessToken,
        });
        if (isVideo) {
          childParams.set('media_type', 'VIDEO');
          childParams.set('video_url', signedUrl);
        } else {
          childParams.set('image_url', signedUrl);
        }

        const childRes = await this.fetchWithTimeout(createEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: childParams.toString(),
        });

        if (!childRes.ok) {
          await this.handleErrorResponse(childRes, 'media.createCarouselChild', post.id);
        }

        const childData: any = await childRes.json();
        if (!childData?.id) {
          throw new FatalError('Instagram carousel child creation did not return an id', {
            httpStatus: 500,
            errorCode: 'INSTAGRAM_MISSING_CHILD_ID',
            rawResponse: childData,
          });
        }
        childIds.push(String(childData.id));
      }

      const parentParams = new URLSearchParams({
        media_type: 'CAROUSEL',
        children: childIds.join(','),
        caption,
        access_token: post.account.accessToken,
      });

      const parentRes = await this.fetchWithTimeout(createEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: parentParams.toString(),
      });

      if (!parentRes.ok) {
        await this.handleErrorResponse(parentRes, 'media.createCarouselParent', post.id);
      }

      const parentData: any = await parentRes.json();
      return { containerId: String(parentData.id), rawResponse: parentData };
    }

    // Case 2: Single Video (REELS) or Single Image
    const item = mainMedia[0];
    const signedUrl = await post.storage.signedUrl(item.objectKey, 24 * 3600, item.bucket);
    const isVideo = item.mimeType.toLowerCase().startsWith('video/');

    const params = new URLSearchParams({
      caption,
      access_token: post.account.accessToken,
    });

    if (isVideo) {
      params.set('media_type', 'REELS');
      params.set('video_url', signedUrl);
      const coverItem = post.media.find((m) => m.role === 'COVER' || m.role === 'THUMBNAIL');
      if (coverItem) {
        const coverUrl = await post.storage.signedUrl(
          coverItem.objectKey,
          24 * 3600,
          coverItem.bucket
        );
        params.set('cover_url', coverUrl);
      }
    } else {
      params.set('image_url', signedUrl);
    }

    const res = await this.fetchWithTimeout(createEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!res.ok) {
      await this.handleErrorResponse(res, 'media.createContainer', post.id);
    }

    const data: any = await res.json();
    if (!data?.id) {
      throw new FatalError('Instagram media container creation did not return an id', {
        httpStatus: 500,
        errorCode: 'INSTAGRAM_MISSING_CONTAINER_ID',
        rawResponse: data,
      });
    }

    return { containerId: String(data.id), rawResponse: data };
  }

  public async publish(post: PublishablePostContext): Promise<PublishAdapterResult> {
    if (post.processingRef) {
      return this.poll(post);
    }

    const igUserId = String(post.account.externalId || '').trim();
    if (!igUserId) {
      throw new FatalError('Instagram account is missing externalId (IG user id)', {
        httpStatus: 400,
        errorCode: 'INSTAGRAM_MISSING_USER_ID',
      });
    }

    await this.checkPublishingLimit(post, igUserId);
    const { containerId, rawResponse } = await this.createMediaContainer(post, igUserId);

    return {
      state: 'PROCESSING',
      processingRef: containerId,
      httpStatus: 202,
      rawResponse,
    };
  }

  public async poll(post: PublishablePostContext): Promise<PollAdapterResult> {
    const containerId = String(post.processingRef || '').trim();
    const igUserId = String(post.account.externalId || '').trim();
    if (!containerId || !igUserId) {
      throw new FatalError('Cannot poll Instagram without processingRef and externalId', {
        httpStatus: 400,
        errorCode: 'INSTAGRAM_MISSING_PROCESSING_REF',
      });
    }

    const statusUrl = `https://graph.facebook.com/${IG_GRAPH_VERSION}/${encodeURIComponent(
      containerId
    )}?fields=status_code,status&access_token=${encodeURIComponent(post.account.accessToken)}`;

    const statusRes = await this.fetchWithTimeout(statusUrl, { method: 'GET' });
    if (!statusRes.ok) {
      await this.handleErrorResponse(statusRes, 'container.pollStatus', post.id);
    }

    const statusData: any = await statusRes.json();
    const statusCode = String(statusData?.status_code || 'IN_PROGRESS').toUpperCase();

    if (statusCode === 'ERROR') {
      throw new FatalError(
        `Instagram container ${containerId} failed with status_code=ERROR: ${
          statusData?.status || 'unknown'
        }`,
        {
          httpStatus: 400,
          errorCode: 'INSTAGRAM_CONTAINER_ERROR',
          rawResponse: statusData,
        }
      );
    }

    // Edge Case #24: IG container EXPIRED -> recreate container once, then FAILED
    if (statusCode === 'EXPIRED') {
      if (post.options?.igContainerRecreated) {
        throw new FatalError(
          `Instagram container ${containerId} EXPIRED a second time after recreation`,
          {
            httpStatus: 400,
            errorCode: 'INSTAGRAM_CONTAINER_EXPIRED_TWICE',
            rawResponse: statusData,
          }
        );
      }

      const recreated = await this.createMediaContainer(post, igUserId);
      return {
        state: 'PROCESSING',
        processingRef: recreated.containerId,
        httpStatus: 202,
        rawResponse: {
          recreatedFromExpired: containerId,
          newContainerId: recreated.containerId,
          igContainerRecreated: true,
        },
      };
    }

    if (statusCode === 'IN_PROGRESS') {
      const containerStartedMs = post.options?.igContainerCreatedAt
        ? new Date(post.options.igContainerCreatedAt).getTime()
        : post.scheduledAt.getTime();
      const elapsedMinutes = (Date.now() - containerStartedMs) / 60000;

      // Edge Case #24: Poll up to 30 min; if stuck > 30 min -> FAILED
      if (elapsedMinutes > 30) {
        throw new FatalError(
          `Instagram container ${containerId} stuck IN_PROGRESS for over 30 minutes`,
          {
            httpStatus: 408,
            errorCode: 'INSTAGRAM_CONTAINER_STUCK',
            rawResponse: statusData,
          }
        );
      }

      return {
        state: 'PROCESSING',
        processingRef: containerId,
        httpStatus: 202,
        rawResponse: statusData,
      };
    }

    // FINISHED or PUBLISHED -> call media_publish
    const publishUrl = `https://graph.facebook.com/${IG_GRAPH_VERSION}/${encodeURIComponent(
      igUserId
    )}/media_publish`;
    const publishRes = await this.fetchWithTimeout(publishUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        creation_id: containerId,
        access_token: post.account.accessToken,
      }).toString(),
    });

    if (!publishRes.ok) {
      await this.handleErrorResponse(publishRes, 'media_publish', post.id);
    }

    const publishData: any = await publishRes.json();
    const mediaId = String(publishData?.id || '').trim();

    // Fetch permalink
    let permalink = `https://www.instagram.com/`;
    if (mediaId) {
      const linkRes = await this.fetchWithTimeout(
        `https://graph.facebook.com/${IG_GRAPH_VERSION}/${encodeURIComponent(
          mediaId
        )}?fields=permalink&access_token=${encodeURIComponent(post.account.accessToken)}`,
        { method: 'GET' }
      );
      if (linkRes.ok) {
        const linkData: any = await linkRes.json();
        if (linkData?.permalink) {
          permalink = String(linkData.permalink);
        }
      }
    }

    return {
      state: 'PUBLISHED',
      platformPostId: mediaId || containerId,
      url: permalink,
      httpStatus: 200,
      rawResponse: publishData,
    };
  }

  public async refreshToken(account: {
    id: string;
    platform: string;
    externalId: string;
    refreshToken: string;
  }): Promise<RefreshTokenResult> {
    const res = await this.fetchWithTimeout(
      `https://graph.facebook.com/${IG_GRAPH_VERSION}/oauth/access_token?` +
        new URLSearchParams({
          grant_type: 'fb_exchange_token',
          client_id: (process.env.INSTAGRAM_APP_ID || process.env.META_APP_ID || '').trim(),
          client_secret: (
            process.env.INSTAGRAM_APP_SECRET ||
            process.env.META_APP_SECRET ||
            ''
          ).trim(),
          fb_exchange_token: account.refreshToken,
        }).toString(),
      { method: 'GET' }
    );

    if (!res.ok) {
      throw new FatalError(`Instagram token refresh failed with HTTP ${res.status}`, {
        httpStatus: res.status,
        errorCode: 'INSTAGRAM_REFRESH_FAILED',
      });
    }

    const data: any = await res.json();
    const expiresInSec = Number(data?.expires_in || 5184000);
    return {
      accessToken: String(data.access_token),
      refreshToken: String(data.access_token),
      expiresAt: new Date(Date.now() + expiresInSec * 1000),
    };
  }
}

