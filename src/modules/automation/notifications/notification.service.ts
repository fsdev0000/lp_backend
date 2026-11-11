import { automationPrisma } from '../state/transition';
import { sendSmtpEmail } from './smtpDispatcher';

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
} {
  const parseList = (raw: string | undefined, fallback: string[]): string[] => {
    const cleaned = (raw || '')
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean)
      .filter((e) => !e.toLowerCase().includes('lionel') && !e.toLowerCase().includes('asad') && !e.toLowerCase().includes('sarath'));
    return cleaned.length > 0 ? cleaned : fallback;
  };

  return {
    approver: parseList(process.env.EMAIL_APPROVER, ['asif@leadersperformance.ae']),
    editors: parseList(process.env.EMAIL_EDITORS, [
      'sharathkiranpr@gmail.com',
      'mirza@leadersperformance.ae',
    ]),
    admin: parseList(process.env.EMAIL_ADMIN, [
      'asif@leadersperformance.ae',
      'mirza@leadersperformance.ae',
    ]),
    info: parseList(process.env.EMAIL_INFO, ['info@leadersperformance.ae']),
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

    return { notification: created, created: true };
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

    return this.enqueue({
      type: 'REVIEW_REQUEST',
      postId: post.id,
      recipients: r.approver,
      cc: [...r.editors, ...r.admin],
      subject,
      body,
      dedupeKey: `REVIEW_REQUEST:${post.id}:r${post.revision}`,
    });
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

    return this.enqueue({
      type: 'REVISION_READY',
      postId: post.id,
      recipients: r.approver,
      cc: [...r.editors, ...r.admin],
      subject,
      body,
      dedupeKey: `REVISION_READY:${post.id}:r${post.revision}`,
    });
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
   * 5. APPROVAL_SLA: Pending review within 24h or 6h of slot (max 2 per post).
   * To: Lionel | Cc: Sarath, Asad
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
    windowLabel: '24H' | '6H';
  }) {
    const { post, windowLabel } = params;
    const r = getRecipientLists();
    const tz = formatDualTimezone(post.scheduledAt);
    const platformLabel = formatPlatformDisplay(post.platform);
    const topic = post.title || (post.caption || '').slice(0, 48).trim() || 'Scheduled Post';
    const crmUrl = getCrmPostUrl(post.id);

    const subject = `[Reminder <${windowLabel.toLowerCase()}>] ${platformLabel} · ${tz.shortSubjectDate} · ${topic}`;
    const body = [
      `This ${platformLabel} post is scheduled in less than ${windowLabel === '24H' ? '24 hours' : '6 hours'} and is still awaiting approval.`,
      `Topic: ${topic}`,
      `Scheduled: ${tz.amsterdam} (Europe/Amsterdam) · ${tz.dubai} (Asia/Dubai)`,
      `Approve or review in Social CRM: ${crmUrl}`,
    ].join('\n');

    return this.enqueue({
      type: 'APPROVAL_SLA',
      postId: post.id,
      recipients: r.approver,
      cc: r.editors,
      subject,
      body,
      dedupeKey: `APPROVAL_SLA:${post.id}:${windowLabel}`,
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
   * To: Sarath, Asad, Asif | Cc: —
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
      cc: [],
      subject: params.subject,
      body: params.body,
      dedupeKey: `DAILY_DIGEST:${params.dateKey}`,
    });
  }

  /**
   * 11. INVENTORY_LOW: Sent by Flow 3 (weekly Monday 08:30, or manual Run Now) when gaps exist in the next 30 days.
   * To: info@leadersperformance.ae, Sarath, Asad, Asif | Cc: —
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
      cc: [],
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
  }) {
    const r = getRecipientLists();
    const base = (
      process.env.CRM_BASE_URL ||
      process.env.FRONTEND_URL ||
      'https://social.leadersperformance.ae'
    ).replace(/\/+$/, '');

    const subject = `[Workflow Error] ${params.workflowName} failed${params.failedNode ? ` at "${params.failedNode}"` : ''
      }`;
    const body = [
      `n8n workflow "${params.workflowName}" crashed.`,
      `Failed node: ${params.failedNode || 'unknown'}`,
      `Error: ${params.errorMessage}`,
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
   */
  public async dispatchPendingOutbox(): Promise<{ sent: number; failed: number }> {
    const pending = await automationPrisma.notification.findMany({
      where: { status: 'PENDING' },
      take: 50,
      orderBy: { createdAt: 'asc' },
    });

    let sent = 0;
    let failed = 0;

    for (const notif of pending) {
      try {
        const recipients = [...notif.recipients, ...(notif.cc || [])]
          .filter(
            (e) =>
              !e.toLowerCase().includes('lionel') &&
              !e.toLowerCase().includes('asad') &&
              !e.toLowerCase().includes('sarath@leadersperformance.ae')
          )
          .filter((val, idx, arr) => arr.indexOf(val) === idx);

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

        const html = buildLeadersPerformanceNotificationHtml({
          subject: notif.subject,
          type: notif.type,
          body: notif.body,
          postId: notif.postId,
          post: postData,
        });

        const success = await sendSmtpEmail({
          to: recipients,
          subject: notif.subject,
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
            <div style="font-size: 11px; font-weight: 700; letter-spacing: 2px; color: #D4AF37; text-transform: uppercase; margin-bottom: 6px;">
              LEADERS PERFORMANCE
            </div>
            <div style="font-size: 20px; font-weight: 800; color: #F8FAFC; letter-spacing: -0.5px;">
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

export const notificationService = new NotificationService();

