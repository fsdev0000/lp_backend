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
        if (streamManager.getActiveClientCount() === 0) {
          return; // No active subscribers connected, save CPU and quota
        }

        const data = await this.ga4Adapter.getRealtimeActiveUsers();
        streamManager.broadcastActiveVisitors(data.activeUsers, { byCountry: data.byCountry });
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
