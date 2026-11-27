import { ContentService, contentPrisma } from '../services/content.service';
import { isLinkedInPublishingEnabled } from '../../social/config/linkedin.config';

const contentService = new ContentService();

export class LinkedInSchedulerJob {
  private static timer: NodeJS.Timeout | null = null;
  private static isRunning = false;
  private static intervalMs = 60 * 1000; // Check every 60 seconds
  private static wasPublishingEnabled: boolean | null = null;
  private static publishingEnabledAt: Date | null = null;

  public static start(intervalMs = 60 * 1000) {
    if (this.timer) {
      return;
    }

    // Safety guard: prevent local developer backend from auto-publishing to Lionel's live profile
    if (process.env.NODE_ENV !== 'production' && process.env.ENABLE_LOCAL_SCHEDULER !== 'true') {
      console.log(
        '[LinkedInSchedulerJob] Background scheduler disabled in local/development mode to prevent accidental live posting. Set ENABLE_LOCAL_SCHEDULER=true to override.'
      );
      return;
    }

    this.intervalMs = intervalMs;
    this.wasPublishingEnabled = false;
    this.publishingEnabledAt = null;
    console.log(
      `[LinkedInSchedulerJob] Background scheduler initialized (polling interval: ${
        intervalMs / 1000
      }s, publishingEnabled: ${isLinkedInPublishingEnabled()})`
    );

    // Run first tick after 5 seconds to allow server boot
    setTimeout(() => {
      this.tick();
      this.timer = setInterval(() => this.tick(), this.intervalMs);
    }, 5000);
  }

  public static stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[LinkedInSchedulerJob] Background scheduler stopped');
    }
  }

  /**
   * Resets internal go-live transition tracking (useful in tests or when toggling the flag).
   */
  public static resetState() {
    this.wasPublishingEnabled = false;
    this.publishingEnabledAt = null;
  }

  public static async tick() {
    if (this.isRunning) {
      return;
    }

    // Item 1: Kill switch — while LINKEDIN_PUBLISHING_ENABLED is false, send nothing
    const isPublishing = isLinkedInPublishingEnabled();
    if (!isPublishing) {
      this.wasPublishingEnabled = false;
      this.publishingEnabledAt = null;
      return;
    }

    this.isRunning = true;

    try {
      const now = new Date();
      // Only "just went live" if transitioning from explicitly false (not server boot)
      const justWentLive = this.wasPublishingEnabled === false;
      this.wasPublishingEnabled = true;
      if (justWentLive || !this.publishingEnabledAt) {
        this.publishingEnabledAt = now;
      }

      // Query approved SCHEDULED posts that are due (supporting LINKEDIN and TIKTOK)
      const duePosts = await contentPrisma.socialPost.findMany({
        where: {
          platform: 'LINKEDIN',
          status: 'SCHEDULED',
          approvalSignature: { not: null },
          scheduledFor: { lte: now },
        },
        take: 20,
        orderBy: { scheduledFor: 'asc' },
      });

      const dueTikTokPosts = await contentPrisma.socialPost
        .findMany({
          where: {
            platform: 'TIKTOK',
            status: 'SCHEDULED',
            approvalSignature: { not: null },
            scheduledFor: { lte: now },
          },
          take: 20,
          orderBy: { scheduledFor: 'asc' },
        })
        .catch(() => []);

      const allDuePosts = [...duePosts, ...dueTikTokPosts];

      if (allDuePosts.length > 0) {
        console.log(`[LinkedInSchedulerJob] Evaluating ${allDuePosts.length} due post(s).`);
      }

      for (const post of allDuePosts) {
        const meta =
          post.metadata && typeof post.metadata === 'object' && !Array.isArray(post.metadata)
            ? (post.metadata as Record<string, any>)
            : {};

        const scheduledTimeMs = post.scheduledFor ? new Date(post.scheduledFor).getTime() : 0;
        const goLiveMs = this.publishingEnabledAt ? this.publishingEnabledAt.getTime() : now.getTime();

        // Issue 13 fix: Do NOT mark approved posts FAILED on a normal server restart.
        // A post should only be expired if it was approved while publishing was disabled,
        // or if publishing just went live and its scheduled time had already passed.
        const isPastDueAtGoLive =
          Boolean(meta.approvedWhilePublishingDisabled) ||
          (justWentLive && scheduledTimeMs < goLiveMs);

        // Item 4: Do not auto-publish posts whose scheduled time had already passed while publishing was off
        if (isPastDueAtGoLive) {
          console.warn(
            `[LinkedInSchedulerJob] Post "${post.title}" (${post.id}) was approved while publishing was disabled or its scheduled time already passed before go-live. Marking FAILED / needs re-approval.`
          );

          await contentPrisma.socialPost.update({
            where: { id: post.id },
            data: {
              status: 'FAILED',
              approvalSignature: null,
              approvedAt: null,
              approvedBy: null,
              rejectionReason:
                'Scheduled time already passed while publishing was disabled — needs re-approval before publishing.',
            },
          });

          await contentPrisma.socialAuditLog.create({
            data: {
              actor: 'LinkedInSchedulerDaemon',
              action: 'STALE_APPROVAL_EXPIRED_AT_GOLIVE',
              entity: `SocialPost #${post.id}`,
              details: `Post "${post.title}" scheduled for ${post.scheduledFor?.toISOString()} expired before publishing went live. Marked FAILED for re-approval.`,
            },
          });
          continue;
        }

        try {
          console.log(`[LinkedInSchedulerJob] Executing automated dispatch for post "${post.title}" (${post.id})...`);
          await contentService.publishPostNow(post.id, 'LinkedInSchedulerJob:Daemon');
          console.log(`[LinkedInSchedulerJob] Successfully published post ${post.id}`);
        } catch (postError: any) {
          console.error(
            `[LinkedInSchedulerJob] Failed to auto-dispatch post ${post.id}:`,
            postError?.message || postError
          );
          await contentPrisma.socialPost.update({
            where: { id: post.id },
            data: {
              status: 'FAILED',
              rejectionReason: `Auto-dispatch error: ${postError?.message || 'LinkedIn API error'}`,
            },
          });

          await contentPrisma.socialAuditLog.create({
            data: {
              actor: 'LinkedInSchedulerDaemon',
              action: 'AUTO_DISPATCH_FAILED',
              entity: `SocialPost #${post.id}`,
              details: `Auto-dispatch failed at scheduled time: ${postError?.message || 'Unknown error'}`,
              metadata: { error: String(postError) },
            },
          });
        }
      }
    } catch (err: any) {
      console.error('[LinkedInSchedulerJob] Error in scheduler tick:', err?.message || err);
    } finally {
      this.isRunning = false;
    }
  }
}
