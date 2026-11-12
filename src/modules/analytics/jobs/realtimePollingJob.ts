import { Ga4Adapter } from '../adapters/ga4.adapter';
import { SseStreamManager } from '../realtime/sseStreamManager';

export class RealtimePollingJob {
  private static interval: NodeJS.Timeout | null = null;
  private static ga4Adapter = new Ga4Adapter();

  public static start(pollingIntervalMs = 20000): void {
    if (this.interval) return;

    this.interval = setInterval(async () => {
      try {
        const streamManager = SseStreamManager.getInstance();
        const activeDomains = streamManager.getActiveDomains();
        if (activeDomains.length === 0) {
          return; // No active subscribers connected, save CPU and quota
        }

        // Poll and broadcast independently for each active domain
        for (const domain of activeDomains) {
          try {
            const data = await this.ga4Adapter.getRealtimeActiveUsers(domain);
            streamManager.broadcastActiveVisitors(
              data.activeUsers,
              { byCountry: data.byCountry },
              domain
            );
          } catch (domainErr) {
            console.error(`[RealtimePollingJob] Polling error for ${domain}:`, domainErr);
          }
        }
      } catch (err) {
        console.error('[RealtimePollingJob] Polling error:', err);
      }
    }, pollingIntervalMs);
  }

  public static stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}
