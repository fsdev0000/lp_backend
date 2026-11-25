import { GscAdapter } from '../adapters/gsc.adapter';

export class GscIngestionJob {
  private static interval: NodeJS.Timeout | null = null;
  private static gscAdapter = new GscAdapter();
  // Search Console data has 24-48h ingestion latency, so running once every 12 hours is optimal
  private static readonly TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

  public static start(): void {
    if (this.interval) return;

    // Run initial sync on startup asynchronously in the background
    this.runSync().catch((err) => console.warn('[GscIngestionJob] Initial sync notice:', err?.message));

    // Schedule 12-hour cron runner
    this.interval = setInterval(() => {
      this.runSync().catch((err) => console.error('[GscIngestionJob] 12-hour sync error:', err));
    }, this.TWELVE_HOURS_MS);

    // Unref so the interval does not block graceful process termination
    if (this.interval.unref) {
      this.interval.unref();
    }
  }

  public static async runSync(): Promise<void> {
    console.log('[GscIngestionJob] Starting 12-hour multi-domain GSC keyword ingestion...');
    const domains = ['leadersperformance.ae', 'lioneleersteling.com'];
    for (const domain of domains) {
      try {
        const result = await this.gscAdapter.syncKeywords(30, 50, domain);
        console.log(`[GscIngestionJob] Completed GSC sync: ${result.upserted} keywords synced for ${result.siteUrl}`);
      } catch (err: any) {
        console.error(`[GscIngestionJob] Error syncing GSC keywords for ${domain}:`, err?.message || err);
      }
    }
  }

  public static stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}
