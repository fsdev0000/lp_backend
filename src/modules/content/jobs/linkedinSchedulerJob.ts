import { PrismaClient } from '@prisma/client';
import { ContentService } from '../services/content.service';

const prisma = new PrismaClient();
const contentService = new ContentService();

export class LinkedInSchedulerJob {
  private static timer: NodeJS.Timeout | null = null;
  private static isRunning = false;
  private static intervalMs = 60 * 1000; // Check every 60 seconds

  public static start(intervalMs = 60 * 1000) {
    if (this.timer) {
      return;
    }
    this.intervalMs = intervalMs;
    console.log(`[LinkedInSchedulerJob] Background scheduler initialized (polling interval: ${intervalMs / 1000}s)`);

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

  public static async tick() {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;

    try {
      const now = new Date();

      // Find posts scheduled at or before now that have been approved by Mr. Lionel
      const duePosts = await prisma.socialPost.findMany({
        where: {
          status: 'SCHEDULED',
          approvalSignature: { not: null },
          scheduledFor: { lte: now },
        },
        take: 10,
        orderBy: { scheduledFor: 'asc' },
      });

      if (duePosts.length > 0) {
        console.log(`[LinkedInSchedulerJob] Found ${duePosts.length} due post(s) ready for automatic dispatch.`);
      }

      for (const post of duePosts) {
        try {
          console.log(`[LinkedInSchedulerJob] Executing automated dispatch for post "${post.title}" (${post.id})...`);
          await contentService.publishPostNow(post.id, 'LinkedInSchedulerJob:Daemon');
          console.log(`[LinkedInSchedulerJob] Successfully published post ${post.id}`);
        } catch (postError: any) {
          console.error(`[LinkedInSchedulerJob] Failed to auto-dispatch post ${post.id}:`, postError?.message || postError);
          // Mark post as failed so it doesn't get stuck in an infinite loop
          await prisma.socialPost.update({
            where: { id: post.id },
            data: {
              status: 'FAILED',
              rejectionReason: `Auto-dispatch error: ${postError?.message || 'LinkedIn API error'}`,
            },
          });

          await prisma.socialAuditLog.create({
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
