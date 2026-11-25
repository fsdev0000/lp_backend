import { automationPrisma } from '../state/transition';
import {
  notificationService,
  formatDualTimezone,
  formatPlatformDisplay,
  getCrmPostUrl,
} from '../notifications/notification.service';

export interface DigestBlockedItem {
  postId: string;
  platform: string;
  scheduledAt: string;
  scheduledAtAmsterdam: string;
  scheduledAtDubai: string;
  title: string | null;
  blockedReason: string | null;
  daysLeft: number;
  isUrgent: boolean; // < 7 days left
  crmUrl: string;
}

export interface DigestPendingSoonItem {
  postId: string;
  platform: string;
  scheduledAt: string;
  scheduledAtAmsterdam: string;
  scheduledAtDubai: string;
  title: string | null;
  hoursLeft: number;
  crmUrl: string;
}

export interface DigestFailedOrMissedItem {
  postId: string;
  platform: string;
  status: string;
  scheduledAt: string;
  scheduledAtAmsterdam: string;
  title: string | null;
  reason: string | null;
  crmUrl: string;
}

export interface DigestExpiringAccountItem {
  accountId: string;
  platform: string;
  label: string;
  tokenExpiresAt: string;
  daysLeft: number;
}

export interface DailyDigestPayload {
  isEmpty: boolean;
  generatedAt: string;
  urgentBlockedPosts: DigestBlockedItem[];
  upcomingBlockedPosts: DigestBlockedItem[];
  pendingWithin48h: DigestPendingSoonItem[];
  failedAndMissedLast24h: DigestFailedOrMissedItem[];
  expiringAccountsWithin7d: DigestExpiringAccountItem[];
  ingestWarnings: string[];
  emailQueued: boolean;
  notificationId?: string;
}

export class DigestService {
  /**
   * Builds the Daily Digest (Plan Section 6 Flow 1 "Daily digest"):
   * - BLOCKED posts in the next 14 days, with the reason. Posts with < 7 days left are marked URGENT at the top.
   * - Posts still PENDING_REVIEW within 48h of their slot.
   * - FAILED and MISSED posts from the last 24h.
   * - Accounts whose token expires within 7 days.
   * - Ingest warnings (missing tab, folder without a calendar row).
   * Queues one DAILY_DIGEST email to Sarath, Asad, and Asif only if the digest is not empty.
   */
  public async generateDigest(options: {
    now?: Date;
    ingestWarnings?: string[];
    queueEmail?: boolean;
  } = {}): Promise<DailyDigestPayload> {
    const now = options.now || new Date();
    const queueEmail = options.queueEmail !== false;
    const in14Days = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    const in48Hours = new Date(now.getTime() + 48 * 60 * 60 * 1000);
    const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const last24Hours = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // 1. BLOCKED posts in the next 14 days
    const blockedPosts = await automationPrisma.post.findMany({
      where: {
        status: 'BLOCKED',
        scheduledAt: { gte: now, lte: in14Days },
      },
      orderBy: { scheduledAt: 'asc' },
    });

    const urgentBlockedPosts: DigestBlockedItem[] = [];
    const upcomingBlockedPosts: DigestBlockedItem[] = [];

    for (const bp of blockedPosts) {
      const tz = formatDualTimezone(bp.scheduledAt);
      const daysLeft = Math.max(
        0,
        Math.ceil((bp.scheduledAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
      );
      const isUrgent = daysLeft < 7;
      const item: DigestBlockedItem = {
        postId: bp.id,
        platform: bp.platform,
        scheduledAt: bp.scheduledAt.toISOString(),
        scheduledAtAmsterdam: tz.amsterdam,
        scheduledAtDubai: tz.dubai,
        title: bp.title,
        blockedReason: bp.blockedReason,
        daysLeft,
        isUrgent,
        crmUrl: getCrmPostUrl(bp.id),
      };
      if (isUrgent) {
        urgentBlockedPosts.push(item);
      } else {
        upcomingBlockedPosts.push(item);
      }
    }

    // 2. Posts still PENDING_REVIEW within 48h of their slot
    const pendingSoon = await automationPrisma.post.findMany({
      where: {
        status: 'PENDING_REVIEW',
        scheduledAt: { gte: now, lte: in48Hours },
      },
      orderBy: { scheduledAt: 'asc' },
    });

    const pendingWithin48h: DigestPendingSoonItem[] = pendingSoon.map((p) => {
      const tz = formatDualTimezone(p.scheduledAt);
      const hoursLeft = Math.max(
        0,
        Math.round((p.scheduledAt.getTime() - now.getTime()) / (60 * 60 * 1000))
      );
      return {
        postId: p.id,
        platform: p.platform,
        scheduledAt: p.scheduledAt.toISOString(),
        scheduledAtAmsterdam: tz.amsterdam,
        scheduledAtDubai: tz.dubai,
        title: p.title,
        hoursLeft,
        crmUrl: getCrmPostUrl(p.id),
      };
    });

    // 3. FAILED and MISSED posts from the last 24h
    const failedOrMissed = await automationPrisma.post.findMany({
      where: {
        status: { in: ['FAILED', 'MISSED'] },
        updatedAt: { gte: last24Hours },
      },
      orderBy: { updatedAt: 'desc' },
    });

    const failedAndMissedLast24h: DigestFailedOrMissedItem[] = failedOrMissed.map((p) => {
      const tz = formatDualTimezone(p.scheduledAt);
      return {
        postId: p.id,
        platform: p.platform,
        status: p.status,
        scheduledAt: p.scheduledAt.toISOString(),
        scheduledAtAmsterdam: tz.amsterdam,
        title: p.title,
        reason: p.lastError || p.blockedReason || 'Failed or missed window',
        crmUrl: getCrmPostUrl(p.id),
      };
    });

    // 4. Accounts whose token expires within 7 days
    const expiringAccounts = await automationPrisma.socialAccount.findMany({
      where: {
        isActive: true,
        tokenExpiresAt: { not: null, lte: in7Days },
      },
      orderBy: { tokenExpiresAt: 'asc' },
    });

    const expiringAccountsWithin7d: DigestExpiringAccountItem[] = expiringAccounts.map((acc) => {
      const expDate = acc.tokenExpiresAt!;
      const daysLeft = Math.ceil((expDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
      return {
        accountId: acc.id,
        platform: acc.platform,
        label: acc.label,
        tokenExpiresAt: expDate.toISOString(),
        daysLeft,
      };
    });

    // 5. Ingest warnings from latest flow1 JobRun + caller-supplied warnings
    const latestFlow1Run = await automationPrisma.jobRun.findFirst({
      where: { workflow: { contains: 'flow1', mode: 'insensitive' } },
      orderBy: { startedAt: 'desc' },
    });
    const runWarnings: string[] = Array.isArray((latestFlow1Run?.stats as any)?.warnings)
      ? ((latestFlow1Run?.stats as any).warnings as string[])
      : [];
    const ingestWarnings = Array.from(
      new Set([...(options.ingestWarnings || []), ...runWarnings])
    );

    const isEmpty =
      urgentBlockedPosts.length === 0 &&
      upcomingBlockedPosts.length === 0 &&
      pendingWithin48h.length === 0 &&
      failedAndMissedLast24h.length === 0 &&
      expiringAccountsWithin7d.length === 0 &&
      ingestWarnings.length === 0;

    let emailQueued = false;
    let notificationId: string | undefined;

    if (!isEmpty && queueEmail) {
      const dateKey = now.toISOString().slice(0, 10);
      const subject = `[Daily Digest] ${dateKey} · ${urgentBlockedPosts.length} Urgent, ${
        upcomingBlockedPosts.length
      } Blocked, ${pendingWithin48h.length} Pending <48h`;

      const lines: string[] = [
        `Social CRM Daily Digest (${dateKey}):`,
      ];

      if (urgentBlockedPosts.length > 0) {
        lines.push(
          `\nURGENT BLOCKED (<7 days):`,
          ...urgentBlockedPosts.map(
            (b) =>
              `- [URGENT ${b.daysLeft}d] ${formatPlatformDisplay(b.platform)} · ${
                b.scheduledAtAmsterdam
              } · ${b.title || 'Untitled'} — ${b.blockedReason} (${b.crmUrl})`
          )
        );
      }

      if (upcomingBlockedPosts.length > 0) {
        lines.push(
          `\nBLOCKED (7–14 days):`,
          ...upcomingBlockedPosts.map(
            (b) =>
              `- [${b.daysLeft}d] ${formatPlatformDisplay(b.platform)} · ${
                b.scheduledAtAmsterdam
              } · ${b.title || 'Untitled'} — ${b.blockedReason} (${b.crmUrl})`
          )
        );
      }

      if (pendingWithin48h.length > 0) {
        lines.push(
          `\nPENDING REVIEW (<48h to slot):`,
          ...pendingWithin48h.map(
            (p) =>
              `- [${p.hoursLeft}h left] ${formatPlatformDisplay(p.platform)} · ${
                p.scheduledAtAmsterdam
              } · ${p.title || 'Untitled'} (${p.crmUrl})`
          )
        );
      }

      if (failedAndMissedLast24h.length > 0) {
        lines.push(
          `\nFAILED & MISSED (last 24h):`,
          ...failedAndMissedLast24h.map(
            (f) =>
              `- [${f.status}] ${formatPlatformDisplay(f.platform)} · ${
                f.scheduledAtAmsterdam
              } · ${f.title || 'Untitled'} — ${f.reason} (${f.crmUrl})`
          )
        );
      }

      if (expiringAccountsWithin7d.length > 0) {
        lines.push(
          `\nEXPIRING TOKENS (<7 days):`,
          ...expiringAccountsWithin7d.map(
            (a) =>
              `- ${formatPlatformDisplay(a.platform)} (${a.label}) expires in ${a.daysLeft}d (${a.tokenExpiresAt})`
          )
        );
      }

      if (ingestWarnings.length > 0) {
        lines.push(`\nINGEST WARNINGS:`, ...ingestWarnings.map((w) => `- ${w}`));
      }

      const queued = await notificationService.queueDailyDigest({
        dateKey,
        subject,
        body: lines.join('\n'),
      });
      emailQueued = queued.created;
      notificationId = queued.notification.id;
    }

    return {
      isEmpty,
      generatedAt: now.toISOString(),
      urgentBlockedPosts,
      upcomingBlockedPosts,
      pendingWithin48h,
      failedAndMissedLast24h,
      expiringAccountsWithin7d,
      ingestWarnings,
      emailQueued,
      notificationId,
    };
  }
}

export const digestService = new DigestService();
