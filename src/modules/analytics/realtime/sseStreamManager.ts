import { Request, Response } from 'express';

export class SseStreamManager {
  private static instance: SseStreamManager;
  private clientsByDomain: Map<string, Set<Response>> = new Map();
  private lastActiveVisitorCountByDomain: Map<string, number> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;

  private constructor() {
    this.startHeartbeat();
  }

  public static getInstance(): SseStreamManager {
    if (!SseStreamManager.instance) {
      SseStreamManager.instance = new SseStreamManager();
    }
    return SseStreamManager.instance;
  }

  public normalizeDomain(domain?: string): string {
    const norm = (domain || 'leadersperformance.ae').toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (norm === 'lioneleersteling.com' || norm.includes('lioneleersteling') || norm === 'le') {
      return 'lioneleersteling.com';
    }
    if (norm === 'leadersperformance.ae' || norm.includes('leadersperformance') || norm === 'lp' || !domain) {
      return 'leadersperformance.ae';
    }
    return norm;
  }

  public registerClient(req: Request, res: Response): void {
    const rawDomain = (req.query.domain as string) || 'leadersperformance.ae';
    const canonicalDomain = this.normalizeDomain(rawDomain);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disables Nginx/Traefik reverse proxy buffering
    res.flushHeaders?.();

    if (!this.clientsByDomain.has(canonicalDomain)) {
      this.clientsByDomain.set(canonicalDomain, new Set());
    }
    const domainClients = this.clientsByDomain.get(canonicalDomain)!;
    domainClients.add(res);

    const lastCount = this.lastActiveVisitorCountByDomain.get(canonicalDomain) ?? 0;

    // Send initial connection acknowledgment and domain-specific active visitor state
    res.write(`:connected\n\n`);
    res.write(
      `event: initial_state\ndata: ${JSON.stringify({
        activeVisitors: lastCount,
        domain: canonicalDomain,
        timestamp: new Date().toISOString(),
        clientCount: domainClients.size,
      })}\n\n`
    );

    req.on('close', () => {
      const set = this.clientsByDomain.get(canonicalDomain);
      if (set) {
        set.delete(res);
        if (set.size === 0) {
          this.clientsByDomain.delete(canonicalDomain);
        }
      }
      res.end();
    });
  }

  public broadcastActiveVisitors(count: number, metadata: Record<string, any> = {}, targetDomain = 'leadersperformance.ae'): void {
    const canonicalDomain = this.normalizeDomain(targetDomain);
    this.lastActiveVisitorCountByDomain.set(canonicalDomain, count);

    this.broadcastEvent(
      'active_visitors',
      {
        count,
        domain: canonicalDomain,
        timestamp: new Date().toISOString(),
        ...metadata,
      },
      canonicalDomain
    );
  }

  public broadcastLeadEvent(lead: Record<string, any>, targetDomain?: string): void {
    this.broadcastEvent(
      'inbound_lead',
      {
        lead,
        timestamp: new Date().toISOString(),
      },
      targetDomain ? this.normalizeDomain(targetDomain) : undefined
    );
  }

  public broadcastTelemetryAlert(alert: Record<string, any>, targetDomain?: string): void {
    this.broadcastEvent(
      'telemetry_alert',
      {
        alert,
        timestamp: new Date().toISOString(),
      },
      targetDomain ? this.normalizeDomain(targetDomain) : undefined
    );
  }

  /**
   * Broadcasts `notifications_changed` event without any personal/lead payload
   * so the logged-in CRM client knows to refetch /api/v1/notifications.
   */
  public broadcastNotificationsChanged(): void {
    this.broadcastEvent('notifications_changed', {});
  }

  public broadcastEvent(eventType: string, payload: Record<string, any>, targetDomain?: string): void {
    const message = `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;

    if (targetDomain) {
      const canonical = this.normalizeDomain(targetDomain);
      const domainClients = this.clientsByDomain.get(canonical);
      if (domainClients) {
        for (const client of Array.from(domainClients)) {
          try {
            client.write(message);
          } catch {
            domainClients.delete(client);
          }
        }
      }
    } else {
      // Broadcast to all domains
      for (const [, clients] of this.clientsByDomain.entries()) {
        for (const client of Array.from(clients)) {
          try {
            client.write(message);
          } catch {
            clients.delete(client);
          }
        }
      }
    }
  }

  public getActiveClientCount(targetDomain?: string): number {
    if (targetDomain) {
      const canonical = this.normalizeDomain(targetDomain);
      return this.clientsByDomain.get(canonical)?.size || 0;
    }
    let total = 0;
    for (const set of this.clientsByDomain.values()) {
      total += set.size;
    }
    return total;
  }

  public getActiveDomains(): string[] {
    return Array.from(this.clientsByDomain.keys()).filter(
      (domain) => (this.clientsByDomain.get(domain)?.size || 0) > 0
    );
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval) return;
    // 15s standard SSE heartbeat comment
    this.heartbeatInterval = setInterval(() => {
      for (const [, clients] of this.clientsByDomain.entries()) {
        for (const client of Array.from(clients)) {
          try {
            client.write(`:ping\n\n`);
          } catch {
            clients.delete(client);
          }
        }
      }
    }, 15000);
  }
}
