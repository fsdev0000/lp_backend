import { PrismaClient } from '@prisma/client';
import { inboxService } from '../../automation/notifications/inbox.service';

const prisma = new PrismaClient();

export interface UpstreamDiagnosticError {
  provider: 'GA4' | 'GSC' | 'CLARITY' | 'GHL';
  endpoint: string;
  statusCode: number;
  message: string;
  timestamp: string;
  rawDetails?: string;
}

export class LiveErrorBoundary {
  public static async logUpstreamError(
    provider: 'GA4' | 'GSC' | 'CLARITY' | 'GHL',
    endpoint: string,
    error: any,
    suggestedStatus = 502
  ): Promise<UpstreamDiagnosticError> {
    const message = error?.message || 'Unknown upstream provider communication failure';
    const rawDetails = typeof error === 'object' ? JSON.stringify(error, Object.getOwnPropertyNames(error)) : String(error);

    try {
      await prisma.systemLog.create({
        data: {
          level: 'error',
          action: `UPSTREAM_API_${provider}_FAILURE`,
          details: JSON.stringify({
            endpoint,
            message,
            statusCode: error?.status || error?.statusCode || suggestedStatus,
            stack: error?.stack,
          }),
        },
      });

      // Item 6 (System): notify Approver at most once an hour per upstream provider
      LiveErrorBoundary.notifyUpstreamFailure(provider, endpoint, message);
    } catch (logErr) {
      console.error(`[LiveErrorBoundary] Failed to persist systemLog for ${provider}:`, logErr);
    }

    return {
      provider,
      endpoint,
      statusCode: error?.status || error?.statusCode || suggestedStatus,
      message,
      timestamp: new Date().toISOString(),
      rawDetails: process.env.NODE_ENV === 'development' ? rawDetails : undefined,
    };
  }

  private static lastNotifiedByProvider = new Map<string, number>();

  private static notifyUpstreamFailure(provider: string, endpoint: string, message: string): void {
    const now = Date.now();
    const last = this.lastNotifiedByProvider.get(provider) || 0;
    if (now - last < 3600_000) return; // rate limit to at most once an hour per source

    this.lastNotifiedByProvider.set(provider, now);

    inboxService.notify({
      category: 'SYSTEM',
      type: 'UPSTREAM_ANALYTICS_ERROR',
      title: 'Analytics Integration Unresponsive',
      message: `${provider} failed at ${endpoint}: ${message.slice(0, 100)}`,
      link: '/analytics/website',
      dedupeKey: `UPSTREAM_ANALYTICS_ERROR:${provider}:${Math.floor(now / 3600000)}`,
      roles: ['Approver'],
    }).catch(() => {});
  }

  public static isCredentialMissing(providerName: string, missingItem: string): UpstreamDiagnosticError {
    return {
      provider: providerName as any,
      endpoint: 'AUTH_CREDENTIAL_CHECK',
      statusCode: 503,
      message: `Provider ${providerName} is not configured: missing [${missingItem}]. Operating in decoupled cached mode.`,
      timestamp: new Date().toISOString(),
    };
  }
}
