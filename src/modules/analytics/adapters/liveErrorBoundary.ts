import { PrismaClient } from '@prisma/client';

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
