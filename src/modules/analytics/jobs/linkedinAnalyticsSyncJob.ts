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

  public static async runSync(): Promise<void> {
    const orgUrn = this.adapter.getOrganizationUrn();
    if (!orgUrn) {
      return;
    }

    console.log(`[LinkedInAnalyticsSyncJob] Syncing LinkedIn company analytics for ${orgUrn}...`);
    try {
      const [analytics7d, analytics30d, posts] = await Promise.all([
        this.adapter.getCompanyAnalytics('7d', true),
        this.adapter.getCompanyAnalytics('30d', true),
        this.adapter.getPosts(true),
      ]);

      console.log(
        `[LinkedInAnalyticsSyncJob] Sync complete: ${posts.length} posts cached, followers: ${analytics30d.followers ?? 'null'}, impressions(30d): ${analytics30d.impressions ?? 'null'}`
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
