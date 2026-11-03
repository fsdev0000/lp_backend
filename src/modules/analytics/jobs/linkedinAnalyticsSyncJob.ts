import { LinkedInAnalyticsAdapter } from '../adapters/linkedinAnalytics.adapter';

export class LinkedInAnalyticsSyncJob {
  private static interval: NodeJS.Timeout | null = null;
  private static adapter = new LinkedInAnalyticsAdapter();
  // 2-hour interval respects LinkedIn's strict API rate limits while keeping CRM fresh
  private static readonly SYNC_INTERVAL_MS = 2 * 60 * 60 * 1000;

  public static start(): void {
    if (this.interval) return;

    // Run initial sync 10 seconds after server startup
    setTimeout(() => {
      this.runSync().catch((err) =>
        console.warn('[LinkedInAnalyticsSyncJob] Startup sync notice:', err?.message)
      );
    }, 10000);

    // Schedule 2-hour recurring sync
    this.interval = setInterval(() => {
      this.runSync().catch((err) =>
        console.error('[LinkedInAnalyticsSyncJob] Recurring sync error:', err?.message || err)
      );
    }, this.SYNC_INTERVAL_MS);

    if (this.interval.unref) {
      this.interval.unref();
    }
  }

  /**
   * Item 14: Warms all supported analytics ranges (7d, 30d, 90d, all) and recent page posts.
   */
  public static async runSync(): Promise<void> {
    console.log('[LinkedInAnalyticsSyncJob] Syncing LinkedIn company analytics (7d, 30d, 90d, all)...');
    try {
      const [analytics7d, analytics30d, analytics90d, analyticsAll, posts] = await Promise.all([
        this.adapter.getCompanyAnalytics('7d', true),
        this.adapter.getCompanyAnalytics('30d', true),
        this.adapter.getCompanyAnalytics('90d', true),
        this.adapter.getCompanyAnalytics('all', true),
        this.adapter.getPosts(true),
      ]);

      if (!analytics30d.connected) {
        return;
      }

      console.log(
        `[LinkedInAnalyticsSyncJob] Sync complete: ${posts.length} posts cached, followers: ${
          analytics30d.followers ?? 'null'
        }, impressions(7d/30d/90d/all): ${analytics7d.impressions ?? 'null'}/${
          analytics30d.impressions ?? 'null'
        }/${analytics90d.impressions ?? 'null'}/${analyticsAll.impressions ?? 'null'}`
      );
    } catch (err: any) {
      console.warn('[LinkedInAnalyticsSyncJob] Sync notice:', err?.message);
    }
  }

  public static stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}
