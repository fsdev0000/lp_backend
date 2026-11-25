import { InstagramAnalyticsAdapter } from '../adapters/instagramAnalytics.adapter';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export class InstagramAnalyticsSyncJob {
  private static interval: NodeJS.Timeout | null = null;
  private static adapter = new InstagramAnalyticsAdapter();
  private static isRunning = false;
  // 2-hour interval respects Meta Graph API rate limits (200 calls/hr/user) while keeping CRM cache fresh
  private static readonly SYNC_INTERVAL_MS = 2 * 60 * 60 * 1000;

  public static start(): void {
    if (this.interval) return;

    // Run initial sync 12 seconds after boot
    setTimeout(() => {
      this.runSync().catch((err) =>
        console.warn('[InstagramAnalyticsSyncJob] Startup sync notice:', err?.message)
      );
    }, 12000);

    // Schedule 2-hour recurring sync
    this.interval = setInterval(() => {
      this.runSync().catch((err) =>
        console.error('[InstagramAnalyticsSyncJob] Recurring sync error:', err?.message || err)
      );
    }, this.SYNC_INTERVAL_MS);

    if (this.interval.unref) {
      this.interval.unref();
    }
  }

  public static async runSync(): Promise<void> {
    if (this.isRunning) {
      console.log('[InstagramAnalyticsSyncJob] Execution skipped: previous sync cycle still in progress');
      return;
    }

    this.isRunning = true;
    const start = Date.now();
    console.log('[InstagramAnalyticsSyncJob] Polling Meta Graph API for Instagram analytics & media...');

    try {
      // 1. Fetch account analytics across standard ranges with forceRefresh=true
      const [analytics7d, analytics30d, posts] = await Promise.all([
        this.adapter.getAccountAnalytics('7d', true),
        this.adapter.getAccountAnalytics('30d', true),
        this.adapter.getPosts(true),
      ]);

      const elapsedMs = Date.now() - start;
      console.log(
        `[InstagramAnalyticsSyncJob] Sync complete (${elapsedMs}ms): @${analytics30d.username} followers: ${analytics30d.followers ?? 'null'}, cached ${posts.length} posts.`
      );
    } catch (err: any) {
      console.warn('[InstagramAnalyticsSyncJob] Sync notice:', err?.message);
    } finally {
      this.isRunning = false;
    }
  }

  public static stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.isRunning = false;
  }
}
