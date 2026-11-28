import { ContentService, contentPrisma } from '../services/content.service';
import { isLinkedInPublishingEnabled } from '../../social/config/linkedin.config';

const contentService = new ContentService();
const SWITCH_STATE_CONFIG_KEY = 'linkedin_publishing_switch_state';

export class LinkedInSchedulerJob {
  private static timer: NodeJS.Timeout | null = null;
  private static bootTimeout: NodeJS.Timeout | null = null;
  private static isRunning = false;
  private static intervalMs = 60 * 1000; // Check every 60 seconds
  private static wasPublishingEnabled: boolean | null = null;
  private static publishingEnabledAt: Date | null = null;

  private static async loadPersistedState(): Promise<{ enabled: boolean; enabledAt?: string } | null> {
    try {
      if (typeof contentPrisma?.systemConfig?.findUnique !== 'function') {
        return null;
      }
      const row = await contentPrisma.systemConfig.findUnique({
        where: { key: SWITCH_STATE_CONFIG_KEY },
      });
      if (row?.value) {
        return JSON.parse(row.value);
      }
    } catch (err: any) {
      console.warn('[LinkedInSchedulerJob] Notice: Failed to load publishing state from DB:', err?.message);
    }
    return null;
  }

  private static async persistState(state: { enabled: boolean; enabledAt?: string; updatedAt: string }): Promise<void> {
    try {
      if (typeof contentPrisma?.systemConfig?.upsert !== 'function') {
        return;
      }
      await contentPrisma.systemConfig.upsert({
        where: { key: SWITCH_STATE_CONFIG_KEY },
        update: { value: JSON.stringify(state), updatedAt: new Date() },
        create: { key: SWITCH_STATE_CONFIG_KEY, value: JSON.stringify(state), updatedAt: new Date() },
      });
    } catch (err: any) {
      console.warn('[LinkedInSchedulerJob] Notice: Failed to persist publishing state to DB:', err?.message);
    }
  }

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
    // NOTE: Do NOT reset this.wasPublishingEnabled or this.publishingEnabledAt to false here.
    // Preserving state across restarts (via in-memory and SystemConfig) ensures deploys do not falsely trigger "just went live".
    console.log(
      `[LinkedInSchedulerJob] Background scheduler initialized (polling interval: ${
        intervalMs / 1000
      }s, publishingEnabled: ${isLinkedInPublishingEnabled()})`
    );

    // Run first tick after 5 seconds to allow server boot
    this.bootTimeout = setTimeout(() => {
      this.bootTimeout = null;
      this.tick();
      this.timer = setInterval(() => this.tick(), this.intervalMs);
    }, 5000);
  }

  public static stop() {
    if (this.bootTimeout) {
      clearTimeout(this.bootTimeout);
      this.bootTimeout = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[LinkedInSchedulerJob] Background scheduler stopped');
    }
  }

  /**
   * Resets internal go-live transition tracking (useful in tests or when toggling the flag).
   */
  public static resetState(options?: {
    wasPublishingEnabled?: boolean | null;
    publishingEnabledAt?: Date | null;
  }) {
    this.wasPublishingEnabled = options?.wasPublishingEnabled !== undefined ? options.wasPublishingEnabled : null;
    this.publishingEnabledAt = options?.publishingEnabledAt !== undefined ? options.publishingEnabledAt : null;
    this.isRunning = false;
  }

  public static async tick() {
    if (this.isRunning) {
      return;
    }

    // Item 1: Kill switch — while LINKEDIN_PUBLISHING_ENABLED is false, send nothing
    const isPublishing = isLinkedInPublishingEnabled();
    if (!isPublishing) {
      if (this.wasPublishingEnabled !== false) {
        this.wasPublishingEnabled = false;
        this.publishingEnabledAt = null;
        await this.persistState({
          enabled: false,
          updatedAt: new Date().toISOString(),
        });
      }
      return;
    }

    // Publishing switch is currently ON
    // If wasPublishingEnabled is uninitialized (null on startup/restart), hydrate from SystemConfig
    if (this.wasPublishingEnabled === null) {
      const persisted = await this.loadPersistedState();
      if (persisted) {
        this.wasPublishingEnabled = persisted.enabled;
        if (persisted.enabledAt) {
          this.publishingEnabledAt = new Date(persisted.enabledAt);
        }
      } else {
        // First boot with no prior record: initialize as enabled, not a transition from OFF
        this.wasPublishingEnabled = true;
        this.publishingEnabledAt = new Date();
        await this.persistState({
          enabled: true,
          enabledAt: this.publishingEnabledAt.toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
    }

    this.isRunning = true;

    try {
      const now = new Date();
      // Only "just went live" if transitioning from explicitly false (real change of the switch from off to on)
      const justWentLive = this.wasPublishingEnabled === false;
      this.wasPublishingEnabled = true;
      if (justWentLive || !this.publishingEnabledAt) {
        this.publishingEnabledAt = now;
        await this.persistState({
          enabled: true,
          enabledAt: this.publishingEnabledAt.toISOString(),
          updatedAt: now.toISOString(),
        });
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
