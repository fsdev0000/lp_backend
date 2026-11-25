import { PrismaClient } from '@prisma/client';
import { InstagramAdapter } from '../../social/adapters/instagram.adapter';
import { verifyPostApprovalGuard } from '../../../utils/approvalSignature';

const prisma = new PrismaClient();

export interface InstagramPublishParams {
  postId?: string;
  caption: string;
  mediaType?: 'IMAGE' | 'VIDEO' | 'REELS' | 'CAROUSEL';
  mediaUrl: string;
  carouselItems?: string[]; // Up to 10 child image/video URLs
  approvalSignature: string;
  approvedBy: string;
  title?: string;
  hook?: string;
}

export interface InstagramPublishResult {
  success: boolean;
  publishedMediaId: string;
  permalink?: string;
  containerId: string;
  publishedAt: string;
}

export class InstagramPublishingService {
  private adapter = new InstagramAdapter();
  private accountId: string;
  private defaultToken: string;

  constructor() {
    this.accountId =
      process.env.INSTAGRAM_ACCOUNT_ID ||
      process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID ||
      '17841427503988004';
    this.defaultToken = process.env.INSTAGRAM_ACCESS_TOKEN || '';
  }

  /**
   * Publishes content to Instagram Professional profile using Meta 2-step Container API
   */
  public async publishToInstagram(params: InstagramPublishParams): Promise<InstagramPublishResult> {
    const postPayload = {
      id: params.postId || `draft-${Date.now()}`,
      title: params.title || params.caption.slice(0, 50),
      hook: params.hook || null,
      body: params.caption,
      platform: 'INSTAGRAM',
      mediaUrl: params.mediaUrl,
      status: 'APPROVED',
      approvalSignature: params.approvalSignature,
      approvedBy: params.approvedBy,
    };

    // 1. Strict Server-Side Cryptographic Pre-Flight Guard
    const guard = verifyPostApprovalGuard(postPayload);
    if (!guard.isValid) {
      const err = `Publishing aborted by executive guard: ${guard.reason}`;
      console.error('[InstagramPublishingService]', err);
      await this.logPublishingAttempt({
        postId: params.postId,
        mediaType: params.mediaType || 'IMAGE',
        caption: params.caption,
        status: 'FAILED_VALIDATION',
        approvalSignature: params.approvalSignature,
        approvedBy: params.approvedBy,
        errorDetails: err,
      });
      throw new Error(err);
    }

    // 2. Strict Kill Switch: Nothing may be posted to Instagram while INSTAGRAM_PUBLISHING_ENABLED is false (Item 4d)
    if (process.env.INSTAGRAM_PUBLISHING_ENABLED !== 'true') {
      const err = 'Instagram publishing is currently disabled (INSTAGRAM_PUBLISHING_ENABLED=false). No posts may be sent until the owner enables publishing.';
      console.warn('[InstagramPublishingService]', err);
      throw new Error(err);
    }

    // 2. Resolve Active Connection Token
    const conn = await this.adapter.getActiveConnection();
    const token = conn?.accessToken || this.defaultToken;
    const accountId = (conn?.metadata as any)?.accountId || this.accountId;

    if (!token) {
      throw new Error('No active Instagram connection or token available for publishing');
    }

    const mediaType = (params.mediaType || 'IMAGE').toUpperCase() as 'IMAGE' | 'VIDEO' | 'REELS' | 'CAROUSEL';
    let containerId = '';

    try {
      // 3. Step 1: Create Container based on media type
      if (mediaType === 'CAROUSEL' && params.carouselItems && params.carouselItems.length > 0) {
        // Multi-image/video carousel (Max 10 items)
        const items = params.carouselItems.slice(0, 10);
        const childContainerIds: string[] = [];

        for (const itemUrl of items) {
          const childId = await this.createChildContainer(accountId, token, itemUrl);
          childContainerIds.push(childId);
        }

        containerId = await this.createCarouselParentContainer(
          accountId,
          token,
          childContainerIds,
          params.caption
        );
      } else if (mediaType === 'REELS' || mediaType === 'VIDEO') {
        containerId = await this.createReelsContainer(accountId, token, params.mediaUrl, params.caption);
      } else {
        containerId = await this.createImageContainer(accountId, token, params.mediaUrl, params.caption);
      }

      // 4. Step 2: Poll Container Processing Status (for videos/reels/carousels)
      await this.pollContainerStatus(containerId, token);

      // 5. Step 3: Publish Container
      const publishedMediaId = await this.publishContainer(accountId, token, containerId);

      const publishedAt = new Date().toISOString();
      const permalink = `https://www.instagram.com/p/${publishedMediaId}/`;

      // 6. Step 4: Persist result and audit log
      await this.logPublishingAttempt({
        postId: params.postId,
        containerId,
        publishedMediaId,
        mediaType,
        caption: params.caption,
        status: 'FINISHED',
        approvalSignature: params.approvalSignature,
        approvedBy: params.approvedBy,
        publishedAt: new Date(publishedAt),
      });

      return {
        success: true,
        publishedMediaId,
        permalink,
        containerId,
        publishedAt,
      };
    } catch (error: any) {
      console.error('[InstagramPublishingService] Publishing pipeline failed:', error);
      await this.logPublishingAttempt({
        postId: params.postId,
        containerId: containerId || undefined,
        mediaType,
        caption: params.caption,
        status: 'FAILED',
        approvalSignature: params.approvalSignature,
        approvedBy: params.approvedBy,
        errorDetails: error?.message || 'Meta API publishing error',
      });
      throw error;
    }
  }

  /**
   * Creates single image container
   */
  private async createImageContainer(accountId: string, token: string, imageUrl: string, caption: string): Promise<string> {
    const url = `https://graph.facebook.com/v21.0/${accountId}/media`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_url: imageUrl,
        caption,
        access_token: token,
      }),
    });

    const data = (await res.json()) as any;
    if (!res.ok || !data.id) {
      throw new Error(`Create image container failed: ${data?.error?.message || res.statusText}`);
    }
    return data.id;
  }

  /**
   * Creates Reels video container
   */
  private async createReelsContainer(accountId: string, token: string, videoUrl: string, caption: string): Promise<string> {
    const url = `https://graph.facebook.com/v21.0/${accountId}/media`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        media_type: 'REELS',
        video_url: videoUrl,
        caption,
        share_to_feed: true,
        access_token: token,
      }),
    });

    const data = (await res.json()) as any;
    if (!res.ok || !data.id) {
      throw new Error(`Create Reels container failed: ${data?.error?.message || res.statusText}`);
    }
    return data.id;
  }

  /**
   * Creates child item for a carousel
   */
  private async createChildContainer(accountId: string, token: string, mediaUrl: string): Promise<string> {
    const isVideo = mediaUrl.endsWith('.mp4') || mediaUrl.includes('video');
    const url = `https://graph.facebook.com/v21.0/${accountId}/media`;
    const body: any = {
      is_carousel_item: true,
      access_token: token,
    };

    if (isVideo) {
      body.media_type = 'VIDEO';
      body.video_url = mediaUrl;
    } else {
      body.image_url = mediaUrl;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = (await res.json()) as any;
    if (!res.ok || !data.id) {
      throw new Error(`Create carousel child item failed: ${data?.error?.message || res.statusText}`);
    }
    return data.id;
  }

  /**
   * Creates parent carousel container
   */
  private async createCarouselParentContainer(
    accountId: string,
    token: string,
    children: string[],
    caption: string
  ): Promise<string> {
    const url = `https://graph.facebook.com/v21.0/${accountId}/media`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        media_type: 'CAROUSEL',
        children: children.join(','),
        caption,
        access_token: token,
      }),
    });

    const data = (await res.json()) as any;
    if (!res.ok || !data.id) {
      throw new Error(`Create carousel container failed: ${data?.error?.message || res.statusText}`);
    }
    return data.id;
  }

  /**
   * Polls container processing status until FINISHED
   */
  private async pollContainerStatus(containerId: string, token: string, maxAttempts = 6): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const url = `https://graph.facebook.com/v21.0/${containerId}?fields=status_code,status&access_token=${token}`;
      const res = await fetch(url);

      if (res.ok) {
        const data = (await res.json()) as any;
        const statusCode = data.status_code || data.status;

        if (statusCode === 'FINISHED') {
          return;
        }
        if (statusCode === 'ERROR' || statusCode === 'EXPIRED') {
          throw new Error(`Media container processing failed with status: ${statusCode}`);
        }
      }

      // Wait 1.5 seconds before polling again
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  /**
   * Publishes container to live account
   */
  private async publishContainer(accountId: string, token: string, containerId: string): Promise<string> {
    const url = `https://graph.facebook.com/v21.0/${accountId}/media_publish`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creation_id: containerId,
        access_token: token,
      }),
    });

    const data = (await res.json()) as any;
    if (!res.ok || !data.id) {
      throw new Error(`Publish container failed: ${data?.error?.message || res.statusText}`);
    }
    return data.id;
  }

  private async logPublishingAttempt(log: {
    postId?: string;
    containerId?: string;
    publishedMediaId?: string;
    mediaType: string;
    caption?: string;
    status: string;
    approvalSignature: string;
    approvedBy: string;
    errorDetails?: string;
    publishedAt?: Date;
  }) {
    try {
      await prisma.instagramPublishingLog.create({
        data: {
          postId: log.postId,
          containerId: log.containerId,
          publishedMediaId: log.publishedMediaId,
          mediaType: log.mediaType,
          caption: log.caption,
          status: log.status,
          approvalSignature: log.approvalSignature,
          approvedBy: log.approvedBy,
          errorDetails: log.errorDetails,
          publishedAt: log.publishedAt,
        },
      });

      await prisma.socialAuditLog.create({
        data: {
          actor: log.approvedBy,
          action: log.status === 'FINISHED' ? 'INSTAGRAM_POST_PUBLISHED' : 'INSTAGRAM_PUBLISH_FAILED',
          entity: log.postId ? `ContentPost #${log.postId}` : 'InstagramPost',
          details:
            log.status === 'FINISHED'
              ? `Published ${log.mediaType} to Instagram (@lioneleersteling). Media ID: ${log.publishedMediaId}.`
              : `Instagram publishing failed: ${log.errorDetails}`,
        },
      });
    } catch (e: any) {
      console.warn('[InstagramPublishingService] Audit write notice:', e?.message);
    }
  }
}
