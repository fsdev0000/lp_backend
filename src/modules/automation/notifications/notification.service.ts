import { automationPrisma } from '../state/transition';
import { sendSmtpEmail } from './smtpDispatcher';
import { notificationSettingsService } from './settings.service';
import { reminderService } from './reminder.service';
import { SseStreamManager } from '../../analytics/realtime/sseStreamManager';

export interface DualTimezoneFormatted {
  amsterdam: string;
  dubai: string;
  shortSubjectDate: string;
}

/**
 * Formats a UTC Date into both Europe/Amsterdam (CET/CEST) and Asia/Dubai (GST)
 * as required by Plan Section 7 & 8.
 */
export function formatDualTimezone(date: Date): DualTimezoneFormatted {
  const amsFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Amsterdam',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
    hourCycle: 'h23',
  });

  const dubaiFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dubai',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
    hourCycle: 'h23',
  });

  const shortFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Amsterdam',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
    hourCycle: 'h23',
  });

  return {
    amsterdam: amsFormatter.format(date).replace(/,/g, ''),
    dubai: dubaiFormatter.format(date).replace(/,/g, ''),
    shortSubjectDate: shortFormatter.format(date).replace(/,/g, ''),
  };
}

export function getCrmPostUrl(postId: string): string {
  const base = (
    process.env.CRM_BASE_URL ||
    'https://social.leadersperformance.ae'
  ).replace(/\/+$/, '');
  return `${base}/approvals?post=${postId}`;
}

export function getRecipientLists(): {
  approver: string[];
  editors: string[];
  admin: string[];
  info: string[];
  reportCc: string[];
} {
  const cfg = notificationSettingsService.getSettingsSync();
  const isTesting =
    cfg.dryRunTestingMode ||
    process.env.DRY_RUN_EMAIL_OVERRIDE === 'true' ||
    process.env.NOTIFICATIONS_LIVE !== 'true';
  const testSafety = cfg.testSafetyEmail || 'asif@leadersperformance.ae';

  const sanitizeTestingList = (list: string[], fallback: string[]): string[] => {
    const raw = list && list.length > 0 ? list : fallback;
    if (!isTesting) return raw;
    // CRITICAL SAFETY RULE: Lionel and Danielle explicitly disabled in testing phase; reroute to Asif
    const filtered = raw.filter((e) => {
      const low = e.toLowerCase();
      return !low.includes('lionel') && !low.includes('danielle');
    });
    if (
      filtered.length === 0 ||
      raw.some((e) => e.toLowerCase().includes('lionel') || e.toLowerCase().includes('danielle'))
    ) {
      return Array.from(new Set([...filtered, testSafety]));
    }
    return filtered;
  };

  return {
    approver: sanitizeTestingList(cfg.approverEmails, [testSafety]),
    reportCc: sanitizeTestingList(cfg.reportCcEmails, [testSafety]),
    editors:
      cfg.editorEmails && cfg.editorEmails.length > 0
        ? cfg.editorEmails
        : ['sharathkiranpr@gmail.com', 'mirza@leadersperformance.ae'],
    admin:
      cfg.adminEmails && cfg.adminEmails.length > 0
        ? cfg.adminEmails
        : ['asif@leadersperformance.ae', 'mirza@leadersperformance.ae'],
    info:
      cfg.infoEmails && cfg.infoEmails.length > 0
        ? cfg.infoEmails
        : ['info@leadersperformance.ae'],
  };
}

const PLATFORM_DISPLAY: Record<string, string> = {
  LINKEDIN: 'LinkedIn',
  LINKEDIN_NEWSLETTER: 'LinkedIn Newsletter',
  INSTAGRAM: 'Instagram',
  YOUTUBE: 'YouTube',
  TIKTOK: 'TikTok',
  MEDIUM: 'Medium',
  INSPO: 'INSPO',
  WEBSITE: 'Website',
  X: 'X',
};

export function formatPlatformDisplay(platform: string): string {
  return PLATFORM_DISPLAY[platform] || platform;
}

export interface QueueNotificationInput {
  type: string;
  postId?: string | null;
  recipients: string[];
  cc?: string[];
  subject: string;
  body: string;
  dedupeKey: string;
}

export class NotificationService {
  /**
   * Queues an email in the Notification outbox table, deduplicated by unique `dedupeKey` (Edge Case #29).
   * If a notification with the same `dedupeKey` already exists, returns the existing row without duplicating.
   */
  public async enqueue(input: QueueNotificationInput) {
    const existing = await automationPrisma.notification.findUnique({
      where: { dedupeKey: input.dedupeKey },
    });

    if (existing) {
      return { notification: existing, created: false };
    }

    const created = await automationPrisma.notification.create({
      data: {
        type: input.type,
        postId: input.postId ?? null,
        recipients: input.recipients,
        cc: input.cc ?? [],
        subject: input.subject,
        body: input.body,
        dedupeKey: input.dedupeKey,
        status: 'PENDING',
        attemptCount: 0,
      },
    });

    console.log(
      `[Notification] postId=${input.postId || 'none'} queued type=${input.type} dedupeKey=${input.dedupeKey}`
    );

    // In-app inbox synchronization: writes to crm_inbox_notifications and fires SSE ping
    try {
      const meta = this.getInboxMetadataForType(input.type, input.postId);
      const recipientSet = new Set<string>();
      for (const r of input.recipients) recipientSet.add(r.toLowerCase());
      if (meta.roles.includes('Approver')) {
        recipientSet.add('developer');
      }

      for (const recipient of recipientSet) {
        await automationPrisma.crmInboxNotification.upsert({
          where: {
            recipient_dedupeKey: {
              recipient,
              dedupeKey: input.dedupeKey,
            },
          },
          create: {
            recipient,
            category: meta.category,
            type: input.type,
            title: meta.title,
            message: input.subject.replace(/^\[.*?\]\s*/, ''),
            link: meta.link,
            entityId: input.postId ?? null,
            dedupeKey: input.dedupeKey,
            readAt: null,
          },
          update: {},
        });
      }

      SseStreamManager.getInstance().broadcastNotificationsChanged();
    } catch (inboxErr: any) {
      console.warn('[NotificationService] Inbox sync warning:', inboxErr?.message);
    }

    return { notification: created, created: true };
  }

  private getInboxMetadataForType(type: string, postId?: string | null): {
    category: 'LEAD' | 'APPROVAL' | 'SYSTEM';
    roles: Array<'Approver' | 'Marketing' | 'Advisor'>;
    title: string;
    link: string | null;
  } {
    const postLink = postId ? `/calendar?post=${postId}` : '/calendar';
    switch (type) {
      case 'REVIEW_REQUEST':
      case 'REVISION_READY':
        return { category: 'APPROVAL', roles: ['Approver'], title: 'Post Waiting for Review', link: postLink };
      case 'CHANGES_REQUESTED':
        return { category: 'APPROVAL', roles: ['Marketing'], title: 'Changes Requested on Post', link: '/content' };
      case 'REJECTED':
        return { category: 'APPROVAL', roles: ['Marketing'], title: 'Post Rejected', link: '/content' };
      case 'APPROVED':
        return { category: 'APPROVAL', roles: ['Marketing'], title: 'Post Approved', link: postLink };
      case 'PUBLISHED':
        return { category: 'APPROVAL', roles: ['Approver', 'Marketing'], title: 'Post Published', link: postLink };
      case 'PUBLISH_FAILED':
      case 'AUTO_DISPATCH_FAILED':
      case 'INSTAGRAM_PUBLISH_FAILED':
        return { category: 'APPROVAL', roles: ['Approver', 'Marketing'], title: 'Publishing Failed', link: postLink };
      case 'MISSED':
        return { category: 'APPROVAL', roles: ['Approver', 'Marketing'], title: 'Scheduled Slot Missed', link: postLink };
      case 'MANUAL_TASK_DUE':
        return { category: 'APPROVAL', roles: ['Marketing'], title: 'Manual Post Due', link: postLink };
      case 'STALE_APPROVAL_EXPIRED_AT_GOLIVE':
        return { category: 'APPROVAL', roles: ['Approver'], title: 'Approval Expired Before Go-Live', link: '/approvals' };
      case 'APPROVAL_SLA':
        return { category: 'APPROVAL', roles: ['Approver'], title: 'Pending Approval Reminder', link: '/approvals' };
      case 'ACCOUNT_DISCONNECTED':
        return { category: 'SYSTEM', roles: ['Approver'], title: 'Social Account Disconnected', link: '/integrations' };
      case 'TOKEN_EXPIRING':
        return { category: 'SYSTEM', roles: ['Approver'], title: 'Access Token Expiring Soon', link: '/integrations' };
      case 'JOB_FAILED':
        return { category: 'SYSTEM', roles: ['Approver'], title: 'Automation Job Failed', link: '/integrations' };
      case 'INVENTORY_LOW':
        return { category: 'SYSTEM', roles: ['Marketing'], title: 'Content Calendar Running Low', link: '/calendar' };
      case 'SCHEDULED_EMAIL_FAILED':
        return { category: 'SYSTEM', roles: ['Approver'], title: 'Scheduled Email Delivery Failed', link: null };
      case 'CLARITY_RAGE_CLICK_ANOMALY':
        return { category: 'SYSTEM', roles: ['Approver'], title: 'High UX Friction Anomaly', link: '/analytics/website' };
      default:
        return { category: 'SYSTEM', roles: ['Approver'], title: type, link: null };
    }
  }

  /**
   * 1. REVIEW_REQUEST: Queued when a post is staged and ready for Lionel's review.
   * To: Lionel | Cc: Sarath, Asad, Asif
   */
  public async queueReviewRequest(post: {
    id: string;
    platform: string;
    scheduledAt: Date;
    title?: string | null;
    caption?: string | null;
    revision: number;
  }) {
    const r = getRecipientLists();
    const tz = formatDualTimezone(post.scheduledAt);
    const platformLabel = formatPlatformDisplay(post.platform);
    const topic = post.title || (post.caption || '').slice(0, 48).trim() || 'Scheduled Post';
    const crmUrl = getCrmPostUrl(post.id);

    const subject = `[Approval] ${platformLabel} · ${tz.shortSubjectDate} · ${topic}`;
    const body = [
      `A new ${platformLabel} post is staged and ready for your review (Revision ${post.revision}).`,
      `Topic: ${topic}`,
      `Scheduled: ${tz.amsterdam} (Europe/Amsterdam) · ${tz.dubai} (Asia/Dubai)`,
      `Review in Social CRM: ${crmUrl}`,
    ].join('\n');

    const queued = await this.enqueue({
      type: 'REVIEW_REQUEST',
      postId: post.id,
      recipients: r.approver,
      cc: [...r.editors, ...r.admin],
      subject,
      body,
      dedupeKey: `REVIEW_REQUEST:${post.id}:r${post.revision}`,
    });

    if (queued.notification && queued.created) {
      await reminderService.scheduleReminderForPost({
        notificationId: queued.notification.id,
        postId: post.id,
      });
    }

    return queued;
  }

  /**
   * 2. REVISION_READY: Immediately on editor resubmit, showing what changed.
   * To: Lionel | Cc: Sarath, Asad, Asif
   */
  public async queueRevisionReady(params: {
    post: {
      id: string;
      platform: string;
      scheduledAt: Date;
      title?: string | null;
      caption?: string | null;
      revision: number;
    };
    editorActor: string;
    changeSummary: string;
  }) {
    const { post, editorActor, changeSummary } = params;
    const r = getRecipientLists();
    const tz = formatDualTimezone(post.scheduledAt);
    const platformLabel = formatPlatformDisplay(post.platform);
    const topic = post.title || (post.caption || '').slice(0, 48).trim() || 'Scheduled Post';
    const crmUrl = getCrmPostUrl(post.id);

    const subject = `[Revision ${post.revision}] ${platformLabel} · ${tz.shortSubjectDate} · ${topic}`;
    const body = [
      `${editorActor} updated and resubmitted this ${platformLabel} post (Revision ${post.revision}).`,
      `What changed: ${changeSummary}`,
      `Scheduled: ${tz.amsterdam} (Europe/Amsterdam) · ${tz.dubai} (Asia/Dubai)`,
      `Review in Social CRM: ${crmUrl}`,
    ].join('\n');

    const queued = await this.enqueue({
      type: 'REVISION_READY',
      postId: post.id,
      recipients: r.approver,
      cc: [...r.editors, ...r.admin],
      subject,
      body,
      dedupeKey: `REVISION_READY:${post.id}:r${post.revision}`,
    });

    if (queued.notification && queued.created) {
      await reminderService.scheduleReminderForPost({
        notificationId: queued.notification.id,
        postId: post.id,
      });
    }

    return queued;
  }

  /**
   * 3. CHANGES_REQUESTED / REJECTED: Immediately when Lionel requests changes or rejects.
   * To: Sarath, Asad | Cc: Asif
   */
  public async queueChangesRequestedOrRejected(params: {
    type: 'CHANGES_REQUESTED' | 'REJECTED';
    post: {
      id: string;
      platform: string;
      scheduledAt: Date;
      title?: string | null;
      caption?: string | null;
      revision: number;
    };
    comment: string;
  }) {
    const { type, post, comment } = params;
    const r = getRecipientLists();
    const tz = formatDualTimezone(post.scheduledAt);
    const platformLabel = formatPlatformDisplay(post.platform);
    const topic = post.title || (post.caption || '').slice(0, 48).trim() || 'Scheduled Post';
    const crmUrl = getCrmPostUrl(post.id);
    const tag = type === 'CHANGES_REQUESTED' ? 'Changes Requested' : 'Rejected';

    const subject = `[${tag}] ${platformLabel} · ${tz.shortSubjectDate} · ${topic}`;
    const body = [
      `Mr. Lionel ${type === 'CHANGES_REQUESTED' ? 'requested changes on' : 'rejected'} this ${platformLabel} post (Revision ${post.revision}).`,
      `Comment: "${comment}"`,
      `Scheduled: ${tz.amsterdam} (Europe/Amsterdam) · ${tz.dubai} (Asia/Dubai)`,
      `Open in Social CRM: ${crmUrl}`,
    ].join('\n');

    return this.enqueue({
      type,
      postId: post.id,
      recipients: r.editors,
      cc: r.admin,
      subject,
      body,
      dedupeKey: `${type}:${post.id}:r${post.revision}`,
    });
  }

  /**
   * 4. APPROVED: Immediately when Lionel approves.
   * To: Sarath, Asad | Cc: Asif
   */
  public async queueApproved(post: {
    id: string;
    platform: string;
    scheduledAt: Date;
    title?: string | null;
    caption?: string | null;
    revision: number;
  }) {
    const r = getRecipientLists();
    const tz = formatDualTimezone(post.scheduledAt);
    const platformLabel = formatPlatformDisplay(post.platform);
    const topic = post.title || (post.caption || '').slice(0, 48).trim() || 'Scheduled Post';
    const crmUrl = getCrmPostUrl(post.id);

    const subject = `[Approved] ${platformLabel} · ${tz.shortSubjectDate} · ${topic}`;
    const body = [
      `Mr. Lionel approved this ${platformLabel} post (Revision ${post.revision}).`,
      `It will be published automatically at the scheduled slot.`,
      `Scheduled: ${tz.amsterdam} (Europe/Amsterdam) · ${tz.dubai} (Asia/Dubai)`,
      `View in Social CRM: ${crmUrl}`,
    ].join('\n');

    return this.enqueue({
      type: 'APPROVED',
      postId: post.id,
      recipients: r.editors,
      cc: r.admin,
      subject,
      body,
      dedupeKey: `APPROVED:${post.id}:r${post.revision}`,
    });
  }

  /**
   * 5. APPROVAL_SLA: Pending review reminders (24h reminder 1, 48h reminder 2, or SLA window 24h/6h before slot).
   * To: Lionel (Approver) | Cc: Editors
   */
  public async queueApprovalSlaReminder(params: {
    post: {
      id: string;
      platform: string;
      scheduledAt: Date;
      title?: string | null;
      caption?: string | null;
      revision: number;
    };
    windowLabel?: '24H' | '6H';
    reminderLevel?: number;
    reminderLabel?: string;
    hoursRemaining?: number;
  }) {
    const { post, windowLabel, reminderLevel, reminderLabel } = params;
    const r = getRecipientLists();
    const tz = formatDualTimezone(post.scheduledAt);
    const platformLabel = formatPlatformDisplay(post.platform);
    const topic = post.title || (post.caption || '').slice(0, 48).trim() || 'Scheduled Post';
    const crmUrl = getCrmPostUrl(post.id);

    const label =
      reminderLabel ||
      (reminderLevel ? `Reminder #${reminderLevel}` : windowLabel ? `<${windowLabel.toLowerCase()}>` : 'Follow-up');

    const subject = `[${label}] ${platformLabel} · ${tz.shortSubjectDate} · ${topic}`;
    const body = [
      `This ${platformLabel} post is awaiting executive review (${label}).`,
      `Topic: ${topic}`,
      `Scheduled: ${tz.amsterdam} (Europe/Amsterdam) · ${tz.dubai} (Asia/Dubai)`,
      `Approve or review in Social CRM: ${crmUrl}`,
    ].join('\n');

    const dedupeKey = reminderLevel
      ? `APPROVAL_SLA:${post.id}:rem${reminderLevel}`
      : `APPROVAL_SLA:${post.id}:${windowLabel || '24H'}`;

    return this.enqueue({
      type: 'APPROVAL_SLA',
      postId: post.id,
      recipients: r.approver,
      cc: r.editors,
      subject,
      body,
      dedupeKey,
    });
  }

  /**
   * 6. PUBLISHED: Immediately when Flow 2 publishes a post, with live URL.
   * To: Sarath, Asad | Cc: Asif
   */
  public async queuePublished(post: {
    id: string;
    platform: string;
    scheduledAt: Date;
    title?: string | null;
    caption?: string | null;
    revision: number;
    platformUrl?: string | null;
  }) {
    const r = getRecipientLists();
    const tz = formatDualTimezone(post.scheduledAt);
    const platformLabel = formatPlatformDisplay(post.platform);
    const topic = post.title || (post.caption || '').slice(0, 48).trim() || 'Scheduled Post';
    const crmUrl = getCrmPostUrl(post.id);

    const subject = `[Published] ${platformLabel} · ${tz.shortSubjectDate} · ${topic}`;
    const body = [
      `This ${platformLabel} post has been published automatically.`,
      `Live URL: ${post.platformUrl || 'Pending permalink'}`,
      `Scheduled: ${tz.amsterdam} (Europe/Amsterdam) · ${tz.dubai} (Asia/Dubai)`,
      `View in Social CRM: ${crmUrl}`,
    ].join('\n');

    return this.enqueue({
      type: 'PUBLISHED',
      postId: post.id,
      recipients: r.editors,
      cc: r.admin,
      subject,
      body,
      dedupeKey: `PUBLISHED:${post.id}:r${post.revision}`,
    });
  }

  /**
   * 7. PUBLISH_FAILED (final) / MISSED: Immediately when retries are exhausted or approval window missed.
   * To: Sarath, Asad, Asif | Cc: —
   */
  public async queuePublishFailedOrMissed(params: {
    type: 'PUBLISH_FAILED' | 'MISSED';
    post: {
      id: string;
      platform: string;
      scheduledAt: Date;
      title?: string | null;
      caption?: string | null;
      revision: number;
    };
    reason: string;
  }) {
    const { type, post, reason } = params;
    const r = getRecipientLists();
    const tz = formatDualTimezone(post.scheduledAt);
    const platformLabel = formatPlatformDisplay(post.platform);
    const topic = post.title || (post.caption || '').slice(0, 48).trim() || 'Scheduled Post';
    const crmUrl = getCrmPostUrl(post.id);
    const tag = type === 'MISSED' ? 'Missed Slot' : 'Publish Failed';

    const subject = `[${tag}] ${platformLabel} · ${tz.shortSubjectDate} · ${topic}`;
    const body = [
      type === 'MISSED'
        ? `This ${platformLabel} post was not approved before its scheduled slot + grace period and was marked MISSED.`
        : `Publishing failed for this ${platformLabel} post after maximum attempts.`,
      `Reason: ${reason}`,
      `Scheduled: ${tz.amsterdam} (Europe/Amsterdam) · ${tz.dubai} (Asia/Dubai)`,
      `${type === 'MISSED' ? 'Pick a new date/time' : 'Retry or inspect'} in Social CRM: ${crmUrl}`,
    ].join('\n');

    const recipients = Array.from(new Set([...r.editors, ...r.admin]));

    return this.enqueue({
      type,
      postId: post.id,
      recipients,
      cc: [],
      subject,
      body,
      dedupeKey: `${type}:${post.id}:r${post.revision}:${post.scheduledAt.toISOString()}`,
    });
  }

  /**
   * 8. MANUAL_TASK_DUE (Medium, LinkedIn Newsletter, INSPO): At scheduled time, and 24h reminder if still not done (Edge Case #30).
   * To: Sarath, Asad | Cc: Asif
   */
  public async queueManualTaskDue(params: {
    post: {
      id: string;
      platform: string;
      scheduledAt: Date;
      title?: string | null;
      caption?: string | null;
      revision: number;
    };
    windowLabel: 'INITIAL' | 'REMINDER_24H';
  }) {
    const { post, windowLabel } = params;
    const r = getRecipientLists();
    const tz = formatDualTimezone(post.scheduledAt);
    const platformLabel = formatPlatformDisplay(post.platform);
    const topic = post.title || (post.caption || '').slice(0, 48).trim() || 'Manual Post';
    const crmUrl = getCrmPostUrl(post.id);
    const prefix = windowLabel === 'REMINDER_24H' ? '[Manual Reminder +24h]' : '[Manual Publish Due]';

    const subject = `${prefix} ${platformLabel} · ${tz.shortSubjectDate} · ${topic}`;
    const body = [
      `This approved ${platformLabel} post is due for manual publication.`,
      `Topic: ${topic}`,
      `Scheduled: ${tz.amsterdam} (Europe/Amsterdam) · ${tz.dubai} (Asia/Dubai)`,
      `Checklist: 1) Copy approved text & assets from CRM -> 2) Publish on ${platformLabel} -> 3) Paste live URL in CRM to mark MANUAL_DONE: ${crmUrl}`,
    ].join('\n');

    return this.enqueue({
      type: 'MANUAL_TASK_DUE',
      postId: post.id,
      recipients: r.editors,
      cc: r.admin,
      subject,
      body,
      dedupeKey: `MANUAL_TASK_DUE:${post.id}:${windowLabel}`,
    });
  }

  /**
   * 9. ACCOUNT_DISCONNECTED / TOKEN_EXPIRING: Sent to Asif on 401 refresh failure or 7 days before token expiry (Edge Case #22).
   * To: Asif | Cc: —
   */
  public async queueAccountAlert(params: {
    type: 'ACCOUNT_DISCONNECTED' | 'TOKEN_EXPIRING';
    account: {
      id: string;
      platform: string;
      label: string;
    };
    reason: string;
    dedupeSuffix: string;
  }) {
    const { type, account, reason, dedupeSuffix } = params;
    const r = getRecipientLists();
    const platformLabel = formatPlatformDisplay(account.platform);
    const base = (
      process.env.CRM_BASE_URL ||
      process.env.FRONTEND_URL ||
      'https://social.leadersperformance.ae'
    ).replace(/\/+$/, '');

    const subject =
      type === 'ACCOUNT_DISCONNECTED'
        ? `[Account Disconnected] ${platformLabel} (${account.label}) requires reconnection`
        : `[Token Expiring] ${platformLabel} (${account.label}) expires soon`;

    const body = [
      `Social account "${account.label}" (${platformLabel}) requires admin attention.`,
      `Reason: ${reason}`,
      `Reconnect account in Social CRM: ${base}/accounts`,
    ].join('\n');

    return this.enqueue({
      type,
      postId: null,
      recipients: r.admin,
      cc: [],
      subject,
      body,
      dedupeKey: `${type}:${account.id}:${dedupeSuffix}`,
    });
  }

  /**
   * 10. DAILY_DIGEST: Queued at end of Flow 1 only if non-empty.
   * To: Editors, Admin | Cc: Danielle (Report CC)
   */
  public async queueDailyDigest(params: {
    dateKey: string;
    subject: string;
    body: string;
  }) {
    const r = getRecipientLists();
    const recipients = Array.from(new Set([...r.editors, ...r.admin]));

    return this.enqueue({
      type: 'DAILY_DIGEST',
      postId: null,
      recipients,
      cc: r.reportCc,
      subject: params.subject,
      body: params.body,
      dedupeKey: `DAILY_DIGEST:${params.dateKey}`,
    });
  }

  /**
   * 11. INVENTORY_LOW: Sent by Flow 3 (weekly Monday 08:30, or manual Run Now) when gaps exist in the next 30 days.
   * To: info@leadersperformance.ae, Editors, Admin | Cc: Danielle (Report CC)
   */
  public async queueInventoryLow(params: {
    dedupeSuffix: string;
    subject: string;
    body: string;
  }) {
    const r = getRecipientLists();
    const recipients = Array.from(new Set([...r.info, ...r.editors, ...r.admin]));

    return this.enqueue({
      type: 'INVENTORY_LOW',
      postId: null,
      recipients,
      cc: r.reportCc,
      subject: params.subject,
      body: params.body,
      dedupeKey: `INVENTORY_LOW:${params.dedupeSuffix}`,
    });
  }

  /**
   * 12. JOB_FAILED: Sent by the n8n Error Trigger workflow when Flow 1, Flow 2, or Flow 3 crashes.
   * To: Asif | Cc: —
   */
  public async queueJobFailed(params: {
    workflowName: string;
    failedNode?: string;
    errorMessage: string;
    executionId?: string;
    executionUrl?: string;
    isTest?: boolean;
  }) {
    const r = getRecipientLists();
    const base = (
      process.env.CRM_BASE_URL ||
      process.env.FRONTEND_URL ||
      'https://social.leadersperformance.ae'
    ).replace(/\/+$/, '');

    const isTest =
      params.isTest ||
      params.workflowName === 'Example Workflow' ||
      params.failedNode === 'Node With Error';

    const subject = isTest
      ? '✅ [System Test] Leaders Performance Alert Workflow is Connected & Operational'
      : `[Workflow Error] ${params.workflowName} failed${
          params.failedNode ? ` at "${params.failedNode}"` : ''
        }`;
    const body = [
      `n8n workflow "${params.workflowName}" crashed.`,
      `Failed node: ${params.failedNode || 'unknown'}`,
      `Error: ${params.errorMessage}`,
      `Execution ID: ${params.executionId || 'none'}`,
      `Inspect JobRuns in Social CRM: ${base}/accounts`,
    ].join('\n');

    const suffix = params.executionId || new Date().toISOString().slice(0, 16);

    return this.enqueue({
      type: 'JOB_FAILED',
      postId: null,
      recipients: r.admin,
      cc: [],
      subject,
      body,
      dedupeKey: `JOB_FAILED:${params.workflowName}:${suffix}`,
    });
  }

  /**
   * Lists notifications from the outbox (paginated).
   */
  public async listOutbox(params: {
    status?: string;
    limit?: number;
    page?: number;
  }) {
    const status = (params.status || 'PENDING').toUpperCase();
    const limit = Math.min(Math.max(Number(params.limit) || 50, 1), 100);
    const page = Math.max(Number(params.page) || 1, 1);
    const skip = (page - 1) * limit;

    const items = await automationPrisma.notification.findMany({
      where: { status },
      orderBy: { createdAt: 'asc' },
      take: limit,
      skip,
    });

    const total = await automationPrisma.notification.count({
      where: { status },
    });

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  /**
   * Marks a notification as SENT.
   */
  public async markSent(id: string) {
    const existing = await automationPrisma.notification.findUnique({ where: { id } });
    if (!existing) {
      throw new Error(`Notification ${id} not found`);
    }

    const updated = await automationPrisma.notification.update({
      where: { id },
      data: {
        status: 'SENT',
        sentAt: new Date(),
        attemptCount: existing.attemptCount + 1,
        error: null,
      },
    });

    console.log(
      `[Notification] postId=${updated.postId || 'none'} notificationId=${updated.id} status=SENT`
    );
    return updated;
  }

  /**
   * Marks a notification send attempt as failed (Edge Case #28: retried 3 times, then FAILED).
   */
  public async markFailed(id: string, errorMessage: string) {
    const existing = await automationPrisma.notification.findUnique({ where: { id } });
    if (!existing) {
      throw new Error(`Notification ${id} not found`);
    }

    const nextAttempt = existing.attemptCount + 1;
    const isFinalFailure = nextAttempt >= 3;
    const nextStatus = isFinalFailure ? 'FAILED' : 'PENDING';

    const updated = await automationPrisma.notification.update({
      where: { id },
      data: {
        status: nextStatus,
        attemptCount: nextAttempt,
        error: errorMessage || 'Email send failed',
      },
    });

    console.log(
      `[Notification] postId=${updated.postId || 'none'} notificationId=${updated.id} attempt=${nextAttempt} status=${nextStatus}`
    );
    return updated;
  }

  /**
   * Automatically dispatches all pending outbox notifications via verified SMTP.
   * Handles deduplication, recipient filtering, and updates status to SENT or FAILED.
   * In testing mode (dryRunTestingMode=true), Mr. Lionel and Danielle NEVER receive live emails;
   * transmissions are safely suppressed or re-routed to the safety test mailbox (asif@leadersperformance.ae).
   */
  public async dispatchPendingOutbox(): Promise<{ sent: number; failed: number }> {
    const pending = await automationPrisma.notification.findMany({
      where: { status: 'PENDING' },
      take: 50,
      orderBy: { createdAt: 'asc' },
    });

    let sent = 0;
    let failed = 0;

    const settings = await notificationSettingsService.getSettings();
    const isDryRun = settings.dryRunTestingMode;
    const safetyEmail = settings.testSafetyEmail || 'asif@leadersperformance.ae';

    for (const notif of pending) {
      try {
        const rawRecipients = [...notif.recipients, ...(notif.cc || [])];
        let recipients: string[] = [];
        let hadRestrictedRecipients = false;

        if (isDryRun) {
          // CRITICAL SAFETY RULE: Both Mr. Lionel and Danielle MUST NEVER receive live emails during testing phase.
          const liveAllowed = rawRecipients.filter((e) => {
            const low = e.trim().toLowerCase();
            const isRestricted =
              low.includes('lionel') ||
              low.includes('danielle') ||
              low.includes('asad') ||
              low.includes('sarath@leadersperformance.ae');
            if (low.includes('lionel') || low.includes('danielle')) {
              hadRestrictedRecipients = true;
            }
            return !isRestricted;
          });

          if (hadRestrictedRecipients || liveAllowed.length === 0) {
            recipients = Array.from(new Set([...liveAllowed, safetyEmail]));
          } else {
            recipients = Array.from(new Set(liveAllowed));
          }
        } else {
          // Live production mode
          recipients = Array.from(new Set(rawRecipients.map((e) => e.trim().toLowerCase()).filter(Boolean)));
        }

        if (recipients.length === 0) {
          await this.markSent(notif.id);
          continue;
        }

        let postData: any = null;
        if (notif.postId) {
          postData = await automationPrisma.post.findUnique({
            where: { id: notif.postId },
          });
        }

        let html: string;
        if (notif.type === 'JOB_FAILED') {
          html = buildLeadersPerformanceWorkflowErrorHtml({
            workflowName: notif.subject.replace(/^\[(Test · )?Workflow Error\]\s*/, '').split(' failed')[0] || 'Social CRM Workflow',
            errorMessage: notif.body,
          });
        } else {
          html = buildLeadersPerformanceNotificationHtml({
            subject: notif.subject,
            type: notif.type,
            body: notif.body,
            postId: notif.postId,
            post: postData,
          });
        }

        let subjectToSend = notif.subject;
        if (isDryRun && hadRestrictedRecipients) {
          subjectToSend = `[TEST DRY-RUN] ${notif.subject}`;
          const dryRunBanner = `
            <div style="background: #FEF3C7; border: 2px dashed #F59E0B; color: #92400E; padding: 12px 16px; margin: 0 0 16px 0; border-radius: 8px; font-family: monospace; font-size: 12px; line-height: 1.5;">
              <strong>🛡️ DRY-RUN TESTING SAFETY GUARD ACTIVE</strong><br/>
              Original Intended Recipients: <strong>${escapeHtml(notif.recipients.join(', '))}</strong><br/>
              Original CC: <strong>${escapeHtml((notif.cc || []).join(', ') || 'none')}</strong><br/>
              Live delivery suppressed for: <em>lionel@leadersperformance.ae, danielle@eersteling.nl</em><br/>
              Re-routed to safety mailbox: <strong>${escapeHtml(safetyEmail)}</strong>
            </div>
          `;
          html = dryRunBanner + html;
        }

        const success = await sendSmtpEmail({
          to: recipients,
          subject: subjectToSend,
          html,
        });

        if (success) {
          await this.markSent(notif.id);
          sent++;
        } else {
          await this.markFailed(notif.id, 'SMTP dispatcher returned false');
          failed++;
        }
      } catch (err: any) {
        await this.markFailed(notif.id, err?.message || 'SMTP exception');
        failed++;
      }
    }

    return { sent, failed };
  }
}

function escapeHtml(str: string): string {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function buildLeadersPerformanceNotificationHtml(params: {
  subject: string;
  type: string;
  body: string;
  postId?: string | null;
  post?: any;
}): string {
  const { subject, type, body, postId, post } = params;
  const crmUrl = postId
    ? getCrmPostUrl(postId)
    : (process.env.CRM_BASE_URL || 'https://social.leadersperformance.ae').replace(/\/+$/, '') + '/approvals';

  let badgeText = 'EXECUTIVE NOTICE';
  let badgeBg = 'rgba(212, 175, 55, 0.15)';
  let badgeColor = '#D4AF37';
  let badgeBorder = '#D4AF37';
  let isApproval = false;

  if (type === 'REVIEW_REQUEST' || type === 'APPROVAL_SLA') {
    badgeText = '⏳ ACTION REQUIRED: EXECUTIVE APPROVAL';
    badgeBg = '#FEF3C7';
    badgeColor = '#92400E';
    badgeBorder = '#FCD34D';
    isApproval = true;
  } else if (type === 'REVISION_READY') {
    badgeText = '📝 REVISION SUBMITTED';
    badgeBg = '#DBEAFE';
    badgeColor = '#1E40AF';
    badgeBorder = '#93C5FD';
    isApproval = true;
  } else if (type === 'APPROVED') {
    badgeText = '✅ POST APPROVED';
    badgeBg = '#D1FAE5';
    badgeColor = '#065F46';
    badgeBorder = '#6EE7B7';
  } else if (type === 'CHANGES_REQUESTED' || type === 'REJECTED') {
    badgeText = '⚠️ CHANGES REQUESTED';
    badgeBg = '#FEE2E2';
    badgeColor = '#991B1B';
    badgeBorder = '#FCA5A5';
  } else if (type === 'PUBLISHED') {
    badgeText = '🚀 POST PUBLISHED';
    badgeBg = '#D1FAE5';
    badgeColor = '#065F46';
    badgeBorder = '#6EE7B7';
  } else if (type === 'INVENTORY_LOW') {
    badgeText = '⚠️ LOW INVENTORY ALERT';
    badgeBg = '#FFEDD5';
    badgeColor = '#9A3412';
    badgeBorder = '#FDBA74';
  }

  const platform = post?.platform || '';
  const platformLabel = platform ? formatPlatformDisplay(platform) : '';
  const scheduledDate = post?.scheduledAt ? new Date(post.scheduledAt) : null;
  const tz = scheduledDate ? formatDualTimezone(scheduledDate) : null;
  const caption = post?.caption || '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #F8FAFC; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1E293B;">
  <div style="max-width: 620px; margin: 30px auto; background: #FFFFFF; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08); border: 1px solid #E2E8F0;">
    
    <!-- Top Gold Accent Bar -->
    <div style="height: 4px; background: linear-gradient(90deg, #D4AF37 0%, #F3E5AB 50%, #C5A880 100%);"></div>

    <!-- Executive Header with Leaders Performance Branding -->
    <div style="background: #0F172A; padding: 26px 32px; color: #FFFFFF;">
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td>
            <a href="https://leadersperformance.ae" target="_blank" style="text-decoration: none; display: inline-block;">
              <img src="https://tpyudbsbzrhhngulxyxp.supabase.co/storage/v1/object/public/avatars/branding/logo-gold.png" alt="Leaders Performance" height="38" style="height: 38px; width: auto; max-width: 220px; display: block; margin-bottom: 10px; border: 0;" border="0" />
            </a>
            <div style="font-size: 11px; font-weight: 700; letter-spacing: 2px; color: #D4AF37; text-transform: uppercase; margin-bottom: 4px;">
              LEADERS PERFORMANCE
            </div>
            <div style="font-size: 19px; font-weight: 800; color: #F8FAFC; letter-spacing: -0.5px; line-height: 1.2;">
              Social CRM & Content Ops
            </div>
          </td>
          <td style="text-align: right; vertical-align: middle;">
            <span style="background: ${badgeBg}; border: 1px solid ${badgeBorder}; color: ${badgeColor}; padding: 6px 12px; border-radius: 20px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; display: inline-block;">
              ${badgeText}
            </span>
          </td>
        </tr>
      </table>
    </div>

    <!-- Notification Body -->
    <div style="padding: 28px 32px 20px 32px;">
      <div style="font-size: 18px; font-weight: 700; color: #0F172A; margin-bottom: 12px; line-height: 1.4;">
        ${escapeHtml(subject)}
      </div>

      <!-- Key Metadata Card (Dual Timezone & Channel) -->
      ${
        tz || platformLabel
          ? `
      <div style="background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px; padding: 18px; margin-bottom: 24px;">
        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
          ${
            platformLabel
              ? `<tr>
            <td style="padding: 6px 0; color: #64748B; width: 140px; font-weight: 600;">Platform</td>
            <td style="padding: 6px 0; font-weight: 700; color: #0F172A;">
              <span style="background: #0F172A; color: #F8FAFC; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 700;">
                ${escapeHtml(platformLabel)}
              </span>
            </td>
          </tr>`
              : ''
          }
          ${
            tz
              ? `<tr>
            <td style="padding: 6px 0; color: #64748B; font-weight: 600;">Europe/Amsterdam</td>
            <td style="padding: 6px 0; color: #1E293B; font-weight: 600;">${tz.amsterdam}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #64748B; font-weight: 600;">Asia/Dubai</td>
            <td style="padding: 6px 0; color: #1E293B; font-weight: 600;">${tz.dubai}</td>
          </tr>`
              : ''
          }
          ${
            post?.revision
              ? `<tr>
            <td style="padding: 6px 0; color: #64748B; font-weight: 600;">Revision</td>
            <td style="padding: 6px 0; color: #1E293B; font-weight: 600;">Revision ${post.revision}</td>
          </tr>`
              : ''
          }
        </table>
      </div>`
          : ''
      }

      <!-- Post Draft Preview / Body Details -->
      <div style="margin-bottom: 28px;">
        <div style="font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #64748B; margin-bottom: 8px;">
          ${caption ? 'Content Preview / Caption:' : 'Notification Details:'}
        </div>
        <div style="background: #FFFFFF; border-left: 4px solid #D4AF37; border-top: 1px solid #E2E8F0; border-right: 1px solid #E2E8F0; border-bottom: 1px solid #E2E8F0; border-radius: 0 8px 8px 0; padding: 16px; font-size: 14px; line-height: 1.6; color: #334155; white-space: pre-wrap;">${escapeHtml(
          caption || body
        )}</div>
      </div>

      <!-- Prominent Call to Action Button -->
      <div style="text-align: center; margin: 32px 0 20px 0;">
        <a href="${crmUrl}" style="background: #0F172A; border: 2px solid #D4AF37; color: #FFFFFF; font-size: 15px; font-weight: 700; text-decoration: none; padding: 14px 32px; border-radius: 8px; display: inline-block; box-shadow: 0 4px 10px rgba(15, 23, 42, 0.2);">
          ${isApproval ? '👉 Review & Approve in Social CRM' : '👉 Open in Social CRM'}
        </a>
        <div style="margin-top: 12px; font-size: 12px; color: #94A3B8;">
          Direct Link: <a href="${crmUrl}" style="color: #64748B; text-decoration: underline;">${crmUrl}</a>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <div style="background: #F8FAFC; padding: 20px 32px; border-top: 1px solid #E2E8F0; text-align: center; font-size: 12px; color: #94A3B8; line-height: 1.5;">
      <strong>Leaders Performance Management Consultancies L.L.C</strong> · Dubai<br />
      Executive Social CRM Automated Governance System · <a href="https://social.leadersperformance.ae" style="color: #64748B; text-decoration: underline;">social.leadersperformance.ae</a>
    </div>
  </div>
</body>
</html>`;
}

export function buildLeadersPerformanceWorkflowErrorHtml(params: {
  workflowName: string;
  failedNode?: string;
  errorMessage: string;
  executionId?: string;
  executionUrl?: string;
  isTest?: boolean;
}): string {
  const { workflowName, failedNode, errorMessage, executionId, executionUrl, isTest } = params;
  const crmUrl = (process.env.CRM_BASE_URL || 'https://social.leadersperformance.ae').replace(/\/+$/, '') + '/accounts';
  const now = new Date();
  const tz = formatDualTimezone(now);

  const isMockSimulation = isTest || workflowName === 'Example Workflow' || failedNode === 'Node With Error';
  const badgeText = isMockSimulation ? '🟢 SYSTEM CONNECTED' : '🚨 WORKFLOW CRASH';
  const badgeBg = isMockSimulation ? '#D1FAE5' : '#FEE2E2';
  const badgeColor = isMockSimulation ? '#065F46' : '#991B1B';
  const badgeBorder = isMockSimulation ? '#6EE7B7' : '#FCA5A5';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${isMockSimulation ? 'Alert System Connected' : `Workflow Alert · ${escapeHtml(workflowName)}`}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #F8FAFC; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1E293B;">
  <div style="max-width: 640px; margin: 30px auto; background: #FFFFFF; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08); border: 1px solid #E2E8F0;">
    
    <!-- Top Gold Accent Bar -->
    <div style="height: 4px; background: linear-gradient(90deg, #D4AF37 0%, #F3E5AB 50%, #C5A880 100%);"></div>

    <!-- Executive Header with Leaders Performance Branding -->
    <div style="background: #0F172A; padding: 24px 32px; color: #FFFFFF;">
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td>
            <a href="https://leadersperformance.ae" target="_blank" style="text-decoration: none; display: inline-block;">
              <img src="https://tpyudbsbzrhhngulxyxp.supabase.co/storage/v1/object/public/avatars/branding/logo-gold.png" alt="Leaders Performance" height="38" style="height: 38px; width: auto; max-width: 220px; display: block; margin-bottom: 10px; border: 0;" border="0" />
            </a>
            <div style="font-size: 11px; font-weight: 700; letter-spacing: 2px; color: #D4AF37; text-transform: uppercase; margin-bottom: 4px;">
              LEADERS PERFORMANCE
            </div>
            <div style="font-size: 18px; font-weight: 800; color: #F8FAFC; letter-spacing: -0.5px; line-height: 1.2;">
              Social CRM & Automation Engine
            </div>
          </td>
          <td style="text-align: right; vertical-align: middle;">
            <span style="background: ${badgeBg}; border: 1px solid ${badgeBorder}; color: ${badgeColor}; padding: 6px 14px; border-radius: 20px; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px; display: inline-block;">
              ${badgeText}
            </span>
          </td>
        </tr>
      </table>
    </div>

    <!-- Alert Body -->
    <div style="padding: 28px 32px 24px 32px;">
      
      ${
        isMockSimulation
          ? `
      <div style="font-size: 20px; font-weight: 800; color: #0F172A; margin-bottom: 8px; letter-spacing: -0.5px;">
        Alert System Connected Successfully
      </div>
      <div style="font-size: 14px; color: #64748B; margin-bottom: 20px; line-height: 1.5;">
        Your n8n Error Alert workflow executed a simulation test and communicated with the backend successfully.
      </div>

      <!-- Test Diagnostic Card -->
      <div style="background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px; padding: 18px; margin-bottom: 20px;">
        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
          <tr>
            <td style="padding: 6px 0; color: #64748B; width: 150px; font-weight: 600;">System Component</td>
            <td style="padding: 6px 0; font-weight: 700; color: #0F172A;">Social CRM Error & Alert Dispatcher</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #64748B; font-weight: 600;">Integration Status</td>
            <td style="padding: 6px 0; font-weight: 700; color: #059669;">✅ Connected to Backend API & Verified SMTP</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #64748B; font-weight: 600;">Monitored Workflows</td>
            <td style="padding: 6px 0; color: #1E293B;">Flow 1 (Dump), Flow 2 (Publisher), Flow 3 (Inventory), Flow 4 (Audit), Flow 5 (Digest)</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #64748B; font-weight: 600;">Verification Time</td>
            <td style="padding: 6px 0; color: #334155;">${tz.amsterdam} (AMS) · ${tz.dubai} (DXB)</td>
          </tr>
        </table>
      </div>

      <!-- Explanation Notice -->
      <div style="background: #F1F5F9; border-left: 4px solid #D4AF37; border-radius: 0 8px 8px 0; padding: 14px 18px; margin-bottom: 24px; font-size: 13px; color: #334155; line-height: 1.6;">
        <strong>💡 How this workflow operates in production:</strong><br />
        You do not need to trigger this workflow manually. It stands by in the background as an automatic crash listener. Whenever an active production workflow encounters a real failure, you will immediately receive an alert displaying the exact workflow name, failing step, and full diagnostic logs.
      </div>`
          : `
      <div style="font-size: 18px; font-weight: 700; color: #0F172A; margin-bottom: 14px; line-height: 1.4;">
        Execution Failure in <span style="color: #DC2626;">${escapeHtml(workflowName)}</span>
      </div>

      <!-- Failure Metadata Card -->
      <div style="background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px; padding: 18px; margin-bottom: 24px;">
        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
          <tr>
            <td style="padding: 6px 0; color: #64748B; width: 140px; font-weight: 600;">Workflow</td>
            <td style="padding: 6px 0; font-weight: 700; color: #0F172A;">
              <span style="background: #0F172A; color: #F8FAFC; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 700;">
                ${escapeHtml(workflowName)}
              </span>
            </td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #64748B; font-weight: 600;">Failed Node</td>
            <td style="padding: 6px 0; font-weight: 700; color: #DC2626;">
              ${escapeHtml(failedNode || 'Unspecified Node')}
            </td>
          </tr>
          ${
            executionId
              ? `<tr>
            <td style="padding: 6px 0; color: #64748B; font-weight: 600;">Execution ID</td>
            <td style="padding: 6px 0; color: #334155; font-family: monospace;">#${escapeHtml(executionId)}</td>
          </tr>`
              : ''
          }
          <tr>
            <td style="padding: 6px 0; color: #64748B; font-weight: 600;">Incident Time</td>
            <td style="padding: 6px 0; color: #334155;">${tz.amsterdam} (AMS) · ${tz.dubai} (DXB)</td>
          </tr>
        </table>
      </div>

      <!-- Error Details Box -->
      <div style="margin-bottom: 28px;">
        <div style="font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #64748B; margin-bottom: 8px;">
          Error Details & Message:
        </div>
        <div style="background: #0B0F19; border: 1px solid #1E293B; border-radius: 8px; padding: 16px; font-family: 'JetBrains Mono', Consolas, Menlo, monospace; font-size: 13px; line-height: 1.5; color: #F87171; white-space: pre-wrap; word-break: break-all;">${escapeHtml(
          errorMessage
        )}</div>
      </div>`
      }

      <!-- Action Buttons -->
      <div style="text-align: center; margin: 30px 0 16px 0;">
        <a href="${crmUrl}" style="background: #0F172A; border: 2px solid #D4AF37; color: #FFFFFF; font-size: 14px; font-weight: 700; text-decoration: none; padding: 12px 28px; border-radius: 8px; display: inline-block; box-shadow: 0 4px 10px rgba(15, 23, 42, 0.2); margin: 4px;">
          ${isMockSimulation ? 'View Workflows in Social CRM →' : 'Inspect JobRuns in Social CRM →'}
        </a>
        ${
          executionUrl
            ? `
        <a href="${escapeHtml(executionUrl)}" style="background: #FFFFFF; border: 1px solid #CBD5E1; color: #475569; font-size: 14px; font-weight: 600; text-decoration: none; padding: 12px 24px; border-radius: 8px; display: inline-block; margin: 4px;">
          Open n8n Execution
        </a>`
            : ''
        }
      </div>

    </div>

    <!-- Luxury Executive Footer -->
    <div style="background: #F8FAFC; border-top: 1px solid #E2E8F0; padding: 20px 32px; text-align: center;">
      <div style="font-size: 11px; font-weight: 700; letter-spacing: 1.5px; color: #94A3B8; text-transform: uppercase;">
        Leaders Performance · Social CRM Automation
      </div>
      <div style="font-size: 11px; color: #94A3B8; margin-top: 4px;">
        Automated Operations & Workflow Diagnostics · Confidential
      </div>
    </div>

  </div>
</body>
</html>`;
}

export const notificationService = new NotificationService();

