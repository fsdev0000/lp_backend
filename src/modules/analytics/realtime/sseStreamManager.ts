import { Request, Response } from 'express';

export class SseStreamManager {
  private static instance: SseStreamManager;
  private clients: Set<Response> = new Set();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private lastActiveVisitorCount = 0;

  private constructor() {
    this.startHeartbeat();
  }

  public static getInstance(): SseStreamManager {
    if (!SseStreamManager.instance) {
      SseStreamManager.instance = new SseStreamManager();
    }
    return SseStreamManager.instance;
  }

  public registerClient(req: Request, res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disables Nginx/Traefik reverse proxy buffering
    res.flushHeaders?.();

    // Send initial connection acknowledgment and current active visitor state
    res.write(`:connected\n\n`);
    res.write(
      `event: initial_state\ndata: ${JSON.stringify({
        activeVisitors: this.lastActiveVisitorCount,
        timestamp: new Date().toISOString(),
        clientCount: this.clients.size + 1,
      })}\n\n`
    );

    this.clients.add(res);

    req.on('close', () => {
      this.clients.delete(res);
      res.end();
    });
  }

  public broadcastActiveVisitors(count: number, metadata: Record<string, any> = {}): void {
    this.lastActiveVisitorCount = count;
    this.broadcastEvent('active_visitors', {
      count,
      timestamp: new Date().toISOString(),
      ...metadata,
    });
  }

  public broadcastLeadEvent(lead: Record<string, any>): void {
    this.broadcastEvent('inbound_lead', {
      lead,
      timestamp: new Date().toISOString(),
    });
  }

  public broadcastTelemetryAlert(alert: Record<string, any>): void {
    this.broadcastEvent('telemetry_alert', {
      alert,
      timestamp: new Date().toISOString(),
    });
  }

  public broadcastEvent(eventType: string, payload: Record<string, any>): void {
    const message = `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(message);
      } catch (err) {
        this.clients.delete(client);
      }
    }
  }

  public getActiveClientCount(): number {
    return this.clients.size;
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval) return;
    // 15s standard SSE heartbeat comment
    this.heartbeatInterval = setInterval(() => {
      for (const client of this.clients) {
        try {
          client.write(`:ping\n\n`);
        } catch {
          this.clients.delete(client);
        }
      }
    }, 15000);
  }
}
