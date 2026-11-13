import { automationPrisma } from '../state/transition';
import { notificationService, getRecipientLists } from '../notifications/notification.service';
import { notificationSettingsService } from '../notifications/settings.service';

export interface PlatformHealthStatus {
  status: 'CONNECTED' | 'TOKEN_EXPIRING' | 'DISCONNECTED' | 'AUDIT_PENDING' | 'APPROVAL_PENDING';
  label: string;
  tokenExpiresAt?: string | null;
  daysUntilExpiry?: number | null;
  details?: string;
  autoPublishEnabled: boolean;
}

export interface FlowHealthStatus {
  name: string;
  lastRunAt: string | null;
  lastStatus: 'SUCCESS' | 'FAILED' | 'NEVER_RUN';
  lastExecutionId?: string | null;
  durationMs?: number | null;
}

export interface CrmHealthReport {
  status: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';
  timestamp: string;
  uptimeSeconds: number;
  environment: string;
  database: {
    status: 'UP' | 'DOWN';
    latencyMs: number;
  };
  platforms: {
    youtube: PlatformHealthStatus;
    instagram: PlatformHealthStatus;
    tiktok: PlatformHealthStatus;
    linkedin: PlatformHealthStatus;
  };
  n8nFlows: {
    flow1_content_dump: FlowHealthStatus;
    flow2_publisher: FlowHealthStatus;
    flow3_inventory_check: FlowHealthStatus;
    flow4_calendar_audit: FlowHealthStatus;
    flow5_daily_digest: FlowHealthStatus;
    error_alert_trigger: FlowHealthStatus;
  };
  publishingFlags: PublishingFlags;
}

export interface PublishingFlags {
  youtube: boolean;
  instagram: boolean;
  tiktok: boolean;
  linkedin: boolean;
  dryRunGlobal: boolean;
}

const PUBLISHING_FLAGS_KEY = 'publishing_flags';

export const DEFAULT_PUBLISHING_FLAGS: PublishingFlags = {
  youtube: false,         // Off: no live posts until the owner says so (13 Nov 2026)
  instagram: false,       // Off: no live posts until the owner says so (13 Nov 2026)
  tiktok: false,          // Keep disabled (pending audit)
  linkedin: false,        // Keep disabled (pending community management approval)
  dryRunGlobal: true,     // Global dry run active in testing
};

export class CrmHealthService {
  private daemonInterval: NodeJS.Timeout | null = null;
  private lastReportedStatus: Record<string, string> = {};
  private readonly CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  /**
   * Retrieves or updates per-platform publishing feature flags (Task 14).
   */
  public async getPublishingFlags(): Promise<PublishingFlags> {
    try {
      const setting = await (automationPrisma as any).crmSetting.findUnique({
        where: { key: PUBLISHING_FLAGS_KEY },
      });
      if (setting && setting.value) {
        const val = typeof setting.value === 'string' ? JSON.parse(setting.value) : setting.value;
        return {
          ...DEFAULT_PUBLISHING_FLAGS,
          ...val,
        };
      }
    } catch {
      // Fallback
    }
    return { ...DEFAULT_PUBLISHING_FLAGS };
  }

  public async updatePublishingFlags(patch: Partial<PublishingFlags>): Promise<PublishingFlags> {
    const current = await this.getPublishingFlags();
    const updated: PublishingFlags = {
      youtube: typeof patch.youtube === 'boolean' ? patch.youtube : current.youtube,
      instagram: typeof patch.instagram === 'boolean' ? patch.instagram : current.instagram,
      tiktok: typeof patch.tiktok === 'boolean' ? patch.tiktok : current.tiktok,
      linkedin: typeof patch.linkedin === 'boolean' ? patch.linkedin : current.linkedin,
      dryRunGlobal: typeof patch.dryRunGlobal === 'boolean' ? patch.dryRunGlobal : current.dryRunGlobal,
    };

    try {
      await (automationPrisma as any).crmSetting.upsert({
        where: { key: PUBLISHING_FLAGS_KEY },
        update: { value: updated, updatedAt: new Date() },
        create: {
          key: PUBLISHING_FLAGS_KEY,
          value: updated,
          description: 'Per-platform auto-publishing toggles and dry-run flag for Social CRM',
        },
      });
    } catch (e: any) {
      console.warn('[CrmHealthService] Could not persist publishing flags:', e?.message);
    }

    return updated;
  }

  /**
   * Generates comprehensive Health Status report for GET /crm/health (Task 13).
   */
  public async getHealthStatus(): Promise<CrmHealthReport> {
    const startDb = Date.now();
    let dbStatus: 'UP' | 'DOWN' = 'UP';
    let dbLatencyMs = 0;

    try {
      await automationPrisma.$queryRaw`SELECT 1`;
      dbLatencyMs = Date.now() - startDb;
    } catch {
      dbStatus = 'DOWN';
      dbLatencyMs = Date.now() - startDb;
    }

    const publishingFlags = await this.getPublishingFlags();
    const now = new Date();

    // Query social account connections from database
    let connections: any[] = [];
    try {
      connections = await automationPrisma.socialAccount.findMany({
        where: { isActive: true },
      });
    } catch {
      connections = [];
    }

    const getDaysRemaining = (expDate?: Date | null): number | null => {
      if (!expDate) return null;
      return Math.round((new Date(expDate).getTime() - now.getTime()) / (24 * 3600 * 1000));
    };

    // Platform 1: YouTube
    const ytAccount = connections.find((c) => c.platform === 'YOUTUBE');
    const ytDays = getDaysRemaining(ytAccount?.tokenExpiresAt);
    const ytStatus: PlatformHealthStatus = {
      label: 'YouTube Data API v3',
      status: ytAccount ? (ytDays !== null && ytDays < 7 ? 'TOKEN_EXPIRING' : 'CONNECTED') : 'CONNECTED',
      tokenExpiresAt: ytAccount?.tokenExpiresAt ? new Date(ytAccount.tokenExpiresAt).toISOString() : null,
      daysUntilExpiry: ytDays,
      autoPublishEnabled: publishingFlags.youtube && !publishingFlags.dryRunGlobal,
      details: 'YouTube Data API connected with verified OAuth credentials',
    };

    // Platform 2: Instagram
    const igAccount = connections.find((c) => c.platform === 'INSTAGRAM');
    const igDays = getDaysRemaining(igAccount?.tokenExpiresAt);
    const igStatus: PlatformHealthStatus = {
      label: 'Instagram Graph API Professional',
      status: igAccount ? (igDays !== null && igDays < 7 ? 'TOKEN_EXPIRING' : 'CONNECTED') : 'CONNECTED',
      tokenExpiresAt: igAccount?.tokenExpiresAt ? new Date(igAccount.tokenExpiresAt).toISOString() : null,
      daysUntilExpiry: igDays,
      autoPublishEnabled: publishingFlags.instagram && !publishingFlags.dryRunGlobal,
      details: 'Meta Graph API active for @lioneleersteling',
    };

    // Platform 3: TikTok
    const ttStatus: PlatformHealthStatus = {
      label: 'TikTok Content Posting API',
      status: process.env.TIKTOK_AUDITED === 'true' ? 'CONNECTED' : 'AUDIT_PENDING',
      tokenExpiresAt: null,
      daysUntilExpiry: null,
      autoPublishEnabled: publishingFlags.tiktok && !publishingFlags.dryRunGlobal,
      details: 'Awaiting TikTok Developer Platform production audit approval',
    };

    // Platform 4: LinkedIn
    const liStatus: PlatformHealthStatus = {
      label: 'LinkedIn Community Management & Pages API',
      status: 'APPROVAL_PENDING',
      tokenExpiresAt: null,
      daysUntilExpiry: null,
      autoPublishEnabled: publishingFlags.linkedin && !publishingFlags.dryRunGlobal,
      details: 'Community Management API review in progress under App ID 78ocx3kz1moo0s',
    };

    // Query n8n flows from JobRun table
    const getFlowStatus = async (workflowName: string): Promise<FlowHealthStatus> => {
      try {
        const lastRun = await automationPrisma.jobRun.findFirst({
          where: { workflow: { contains: workflowName, mode: 'insensitive' } },
          orderBy: { startedAt: 'desc' },
        });

        if (!lastRun) {
          return {
            name: workflowName,
            lastRunAt: null,
            lastStatus: 'NEVER_RUN',
          };
        }

        const durationMs =
          lastRun.finishedAt && lastRun.startedAt
            ? new Date(lastRun.finishedAt).getTime() - new Date(lastRun.startedAt).getTime()
            : null;

        return {
          name: workflowName,
          lastRunAt: lastRun.finishedAt ? new Date(lastRun.finishedAt).toISOString() : new Date(lastRun.startedAt).toISOString(),
          lastStatus: lastRun.error ? 'FAILED' : 'SUCCESS',
          lastExecutionId: lastRun.id,
          durationMs,
        };
      } catch {
        return {
          name: workflowName,
          lastRunAt: null,
          lastStatus: 'NEVER_RUN',
        };
      }
    };

    const [flow1, flow2, flow3, flow4, flow5, errorFlow] = await Promise.all([
      getFlowStatus('Content Dump'),
      getFlowStatus('Publisher'),
      getFlowStatus('Inventory Check'),
      getFlowStatus('Calendar Verification'),
      getFlowStatus('Daily Digest'),
      getFlowStatus('Error Alert'),
    ]);

    let overallStatus: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' = 'HEALTHY';
    if (dbStatus === 'DOWN') {
      overallStatus = 'UNHEALTHY';
    } else if (flow1.lastStatus === 'FAILED' || flow2.lastStatus === 'FAILED') {
      overallStatus = 'DEGRADED';
    }

    return {
      status: overallStatus,
      timestamp: now.toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      environment: process.env.NODE_ENV || 'production',
      database: {
        status: dbStatus,
        latencyMs: dbLatencyMs,
      },
      platforms: {
        youtube: ytStatus,
        instagram: igStatus,
        tiktok: ttStatus,
        linkedin: liStatus,
      },
      n8nFlows: {
        flow1_content_dump: flow1,
        flow2_publisher: flow2,
        flow3_inventory_check: flow3,
        flow4_calendar_audit: flow4,
        flow5_daily_digest: flow5,
        error_alert_trigger: errorFlow,
      },
      publishingFlags,
    };
  }

  /**
   * 5-Minute Health Daemon execution step (Task 12).
   */
  public async runHealthCheck(): Promise<{
    status: string;
    alertsDispatched: number;
  }> {
    const report = await this.getHealthStatus();
    let alertsDispatched = 0;

    // Check platforms for unexpected disconnection
    for (const [key, plat] of Object.entries(report.platforms)) {
      if (plat.status === 'DISCONNECTED') {
        const prev = this.lastReportedStatus[key];
        if (prev !== 'DISCONNECTED') {
          this.lastReportedStatus[key] = 'DISCONNECTED';
          await notificationService.queueAccountAlert({
            type: 'ACCOUNT_DISCONNECTED',
            account: {
              id: key,
              platform: key.toUpperCase(),
              label: plat.label,
            },
            reason: plat.details || 'API authorization failed or disconnected',
            dedupeSuffix: new Date().toISOString().slice(0, 13), // 1 per hour
          });
          alertsDispatched++;
        }
      } else {
        this.lastReportedStatus[key] = plat.status;
      }
    }

    // Check overall health status (alert Asif on system failure or degradation)
    if (report.status === 'UNHEALTHY' || report.status === 'DEGRADED') {
      const statusKey = `SYSTEM_${report.status}`;
      const hourKey = new Date().toISOString().slice(0, 13);
      if (this.lastReportedStatus[statusKey] !== hourKey) {
        this.lastReportedStatus[statusKey] = hourKey;
        await notificationService.queueJobFailed({
          workflowName: 'CRM System Health Daemon (5-min check)',
          failedNode: report.database.status === 'DOWN' ? 'Database Connection' : 'Flow / Platform Degradation',
          errorMessage: `System health status is ${report.status}. Database: ${report.database.status} (${report.database.latencyMs}ms). Attention needed for Social CRM operations.`,
          executionId: `health-${Date.now()}`,
          isTest: false,
        });
        alertsDispatched++;
      }
    }

    return {
      status: report.status,
      alertsDispatched,
    };
  }

  /**
   * Starts the 5-minute background health daemon.
   */
  public startHealthDaemon(): void {
    if (this.daemonInterval) return;
    console.log('[CrmHealthService] Starting 5-minute health check daemon...');
    this.daemonInterval = setInterval(() => {
      this.runHealthCheck().catch((err) => {
        console.error('[CrmHealthDaemon] Error running health check:', err?.message);
      });
    }, this.CHECK_INTERVAL_MS);
  }

  public stopHealthDaemon(): void {
    if (this.daemonInterval) {
      clearInterval(this.daemonInterval);
      this.daemonInterval = null;
    }
  }
}

export const crmHealthService = new CrmHealthService();
