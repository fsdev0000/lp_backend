import { sendSmtpEmail } from '../notifications/smtpDispatcher';
import { automationPrisma } from '../state/transition';
import {
  formatDualTimezone,
  getRecipientLists,
  getCrmPostUrl,
} from '../notifications/notification.service';
import { splitChannelsCell, isRowMarkedSkipped } from '../ingest/calendarParser';

export interface VerifyCalendarRowInput {
  dateYmd: string;
  timeHhMm?: string;
  channelRaw: string;
  contentType?: string | null;
  subject?: string | null;
  fileLocation?: string | null;
  statusSheet?: string | null;
  tab?: string;
  rowNumber?: number;
}

export interface VerifiedPostItem {
  date: string;
  time: string;
  channel: string;
  contentType: string;
  subject: string;
  status: 'PUBLISHED' | 'SCHEDULED' | 'OVERDUE' | 'MISSING_CONTENT' | 'BLOCKED';
  badge: string;
  badgeColor: string;
  liveUrl?: string;
  notes: string;
  rowNumber?: number;
  needsWriteback?: boolean;
}

export interface CalendarVerificationResult {
  stats: {
    total: number;
    published: number;
    scheduled: number;
    overdue: number;
    missing: number;
    blocked: number;
    auditDate: string;
  };
  verifiedList: VerifiedPostItem[];
  writebackList: Array<{ rowNumber?: number; date: string; channel: string; newStatus: string }>;
  emailSubject: string;
  emailHtml: string;
  recipientEmails: string;
}

export class CalendarVerificationService {
  /**
   * Verifies the content calendar schedule against live database & publishing states.
   * - Evaluates rows within a 14-day rolling window (past 7 days to next 7 days).
   * - Matches against automationPrisma.post records.
   * - Identifies published, scheduled, overdue, and missing content.
   * - Generates reconciliation writeback instructions and executive HTML digest.
   */
  public async verifyCalendar(options: {
    rows?: VerifyCalendarRowInput[];
    now?: Date;
    lookbackDays?: number;
    lookaheadDays?: number;
  } = {}): Promise<CalendarVerificationResult> {
    const now = options.now || new Date();
    const lookback = options.lookbackDays ?? 7;
    const lookahead = options.lookaheadDays ?? 7;

    const windowStart = new Date(now.getTime() - lookback * 24 * 60 * 60 * 1000);
    const windowEnd = new Date(now.getTime() + lookahead * 24 * 60 * 60 * 1000);

    // 1. Fetch relevant posts from DB
    const dbPosts = await automationPrisma.post.findMany({
      where: {
        scheduledAt: {
          gte: windowStart,
          lte: windowEnd,
        },
      },
      orderBy: { scheduledAt: 'asc' },
    });

    const verifiedList: VerifiedPostItem[] = [];
    const writebackList: Array<{ rowNumber?: number; date: string; channel: string; newStatus: string }> = [];

    let total = 0;
    let published = 0;
    let scheduled = 0;
    let overdue = 0;
    let missing = 0;
    let blocked = 0;

    // 2. If input calendar rows were provided (from Google Sheets / Excel)
    if (Array.isArray(options.rows) && options.rows.length > 0) {
      for (const row of options.rows) {
        const skipCheck = isRowMarkedSkipped({
          subject: row.subject,
          channelRaw: row.channelRaw,
          contentType: row.contentType,
          statusCell: row.statusSheet,
          fileLocation: row.fileLocation,
        });
        if (!row.dateYmd || skipCheck.skipped) {
          continue;
        }

        const channels = splitChannelsCell(row.channelRaw || '');
        for (const ch of channels) {
          total++;
          const targetTime = row.timeHhMm || '09:00';
          const scheduledDate = new Date(`${row.dateYmd}T${targetTime}:00`);
          const isPast = scheduledDate <= now;

          // Match against DB post
          const matchedPost = dbPosts.find((p) => {
            const pDate = p.scheduledAt.toISOString().split('T')[0];
            const titleMatch =
              p.title &&
              row.subject &&
              (p.title.toLowerCase().includes(row.subject.toLowerCase()) ||
                row.subject.toLowerCase().includes(p.title.toLowerCase()));
            return pDate === row.dateYmd && titleMatch;
          });

          let status: VerifiedPostItem['status'] = 'SCHEDULED';
          let badge = '⏳ SCHEDULED';
          let badgeColor = '#3B82F6';
          let notes = row.fileLocation ? 'Asset staged in Drive' : 'Ready for review';
          let liveUrl = (matchedPost as any)?.platformPostUrl || undefined;
          let needsWriteback = false;

          const sheetStatus = (row.statusSheet || '').trim().toLowerCase();
          const dbStatus = matchedPost?.status;

          if (sheetStatus === 'published' || dbStatus === 'PUBLISHED') {
            status = 'PUBLISHED';
            badge = '✅ PUBLISHED';
            badgeColor = '#10B981';
            published++;
            notes = (matchedPost as any)?.publishedAt
              ? `Published at ${new Date((matchedPost as any).publishedAt).toLocaleTimeString()}`
              : 'Verified Live';

            if (sheetStatus !== 'published') {
              needsWriteback = true;
              writebackList.push({
                rowNumber: row.rowNumber,
                date: row.dateYmd,
                channel: ch,
                newStatus: 'Published',
              });
            }
          } else if (dbStatus === 'BLOCKED') {
            status = 'BLOCKED';
            badge = '🛑 BLOCKED';
            badgeColor = '#E11D48';
            blocked++;
            notes = (matchedPost as any)?.blockedReason || 'Blocked by validation rule';
          } else if (isPast) {
            status = 'OVERDUE';
            badge = '🚨 OVERDUE';
            badgeColor = '#EF4444';
            overdue++;
            notes = 'Scheduled slot passed without publication';
          } else if (!row.subject || sheetStatus.includes('fail') || sheetStatus.includes('miss')) {
            status = 'MISSING_CONTENT';
            badge = '⚠️ MISSING ASSET';
            badgeColor = '#F59E0B';
            missing++;
            notes = row.statusSheet || 'Asset missing or creation pending';
          } else {
            scheduled++;
          }

          verifiedList.push({
            date: row.dateYmd,
            time: targetTime,
            channel: ch,
            contentType: row.contentType || 'Media',
            subject: row.subject || 'Untitled Post',
            status,
            badge,
            badgeColor,
            liveUrl,
            notes,
            rowNumber: row.rowNumber,
            needsWriteback,
          });
        }
      }
    } else {
      // 3. Fallback: Audit purely from lp_backend DB records
      for (const p of dbPosts) {
        total++;
        const pDate = p.scheduledAt.toISOString().split('T')[0];
        const pTime = p.scheduledAt.toISOString().split('T')[1].slice(0, 5);
        const isPast = p.scheduledAt <= now;

        let status: VerifiedPostItem['status'] = 'SCHEDULED';
        let badge = '⏳ SCHEDULED';
        let badgeColor = '#3B82F6';
        let notes = 'Staged in CRM';
        const liveUrl = (p as any).platformPostUrl || undefined;

        if (p.status === 'PUBLISHED') {
          status = 'PUBLISHED';
          badge = '✅ PUBLISHED';
          badgeColor = '#10B981';
          published++;
          notes = 'Live on platform';
        } else if (p.status === 'BLOCKED') {
          status = 'BLOCKED';
          badge = '🛑 BLOCKED';
          badgeColor = '#E11D48';
          blocked++;
          notes = (p as any).blockedReason || 'Blocked';
        } else if (isPast) {
          status = 'OVERDUE';
          badge = '🚨 OVERDUE';
          badgeColor = '#EF4444';
          overdue++;
          notes = 'Post time passed - Not published';
        } else {
          scheduled++;
        }

        verifiedList.push({
          date: pDate,
          time: pTime,
          channel: String(p.platform),
          contentType: (p as any).mediaType || 'Post',
          subject: p.title || 'Untitled',
          status,
          badge,
          badgeColor,
          liveUrl,
          notes,
        });
      }
    }

    // Sort chronologically
    verifiedList.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

    const auditDateStr = now.toISOString().split('T')[0];
    const recipients = getRecipientLists();
    const recipientEmails = [...recipients.approver, ...recipients.editors, ...recipients.admin].join(', ');

    const emailSubject = `[Content Ops] Content Calendar Publishing Audit (${published}/${total} Published, ${overdue} Overdue) — ${auditDateStr}`;
    const emailHtml = this.buildEmailHtml({
      auditDate: auditDateStr,
      stats: { total, published, scheduled, overdue, missing, blocked, auditDate: auditDateStr },
      list: verifiedList,
    });

    // Automatically dispatch email notification via verified SMTP
    try {
      await sendSmtpEmail({
        to: recipientEmails,
        subject: emailSubject,
        html: emailHtml,
      });
    } catch (err: any) {
      console.error('[CalendarVerification] Failed to dispatch email:', err?.message);
    }

    return {
      stats: { total, published, scheduled, overdue, missing, blocked, auditDate: auditDateStr },
      verifiedList,
      writebackList,
      emailSubject,
      emailHtml,
      recipientEmails,
    };
  }

  /**
   * Constructs the executive HTML email digest.
   */
  private buildEmailHtml(data: {
    auditDate: string;
    stats: CalendarVerificationResult['stats'];
    list: VerifiedPostItem[];
  }): string {
    const { stats, list, auditDate } = data;

    const rowsHtml = list
      .map(
        (item) => `
      <tr style="border-bottom: 1px solid #E2E8F0;">
        <td style="padding: 10px 14px; font-weight: 600; color: #1E293B; white-space: nowrap;">${item.date}</td>
        <td style="padding: 10px 14px; color: #64748B; white-space: nowrap;">${item.time}</td>
        <td style="padding: 10px 14px;">
          <span style="background-color: #F1F5F9; color: #0F172A; padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: 700;">
            ${item.channel}
          </span>
        </td>
        <td style="padding: 10px 14px; color: #334155;">${item.contentType}</td>
        <td style="padding: 10px 14px; color: #0F172A; font-weight: 500;">${item.subject}</td>
        <td style="padding: 10px 14px; white-space: nowrap;">
          <span style="background-color: ${item.badgeColor}15; color: ${item.badgeColor}; border: 1px solid ${item.badgeColor}; padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 700; display: inline-block;">
            ${item.badge}
          </span>
        </td>
        <td style="padding: 10px 14px; font-size: 12px; color: #64748B;">
          ${
            item.liveUrl
              ? `<a href="${item.liveUrl}" style="color: #D4AF37; font-weight: 700; text-decoration: none;">View Live Post ↗</a>`
              : item.notes
          }
        </td>
      </tr>
    `
      )
      .join('');

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Content Calendar Audit</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #F8FAFC; margin: 0; padding: 24px;">
  <div style="max-width: 920px; margin: 0 auto; background: #FFFFFF; border-radius: 12px; overflow: hidden; border: 1px solid #E2E8F0; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
    
    <!-- Header -->
    <div style="background: #0F172A; padding: 24px 32px; border-bottom: 3px solid #D4AF37;">
      <h1 style="color: #FFFFFF; margin: 0; font-size: 22px; font-weight: 700;">Leaders Performance · Content Calendar Audit</h1>
      <p style="color: #94A3B8; margin: 6px 0 0 0; font-size: 13px;">Daily Publishing Verification & Calendar Reconciliation Report — ${auditDate}</p>
    </div>

    <!-- Metric KPI Cards -->
    <div style="padding: 24px 32px; background: #F8FAFC; border-bottom: 1px solid #E2E8F0;">
      <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px;">
        <div style="background: #FFFFFF; padding: 16px; border-radius: 8px; border: 1px solid #E2E8F0; text-align: center;">
          <div style="color: #64748B; font-size: 11px; text-transform: uppercase; font-weight: 700;">Total Audited</div>
          <div style="font-size: 26px; font-weight: 800; color: #0F172A; margin-top: 4px;">${stats.total}</div>
        </div>
        <div style="background: #FFFFFF; padding: 16px; border-radius: 8px; border: 1px solid #E2E8F0; text-align: center;">
          <div style="color: #10B981; font-size: 11px; text-transform: uppercase; font-weight: 700;">Published</div>
          <div style="font-size: 26px; font-weight: 800; color: #10B981; margin-top: 4px;">${stats.published}</div>
        </div>
        <div style="background: #FFFFFF; padding: 16px; border-radius: 8px; border: 1px solid #E2E8F0; text-align: center;">
          <div style="color: #3B82F6; font-size: 11px; text-transform: uppercase; font-weight: 700;">Scheduled</div>
          <div style="font-size: 26px; font-weight: 800; color: #3B82F6; margin-top: 4px;">${stats.scheduled}</div>
        </div>
        <div style="background: #FFFFFF; padding: 16px; border-radius: 8px; border: 1px solid #E2E8F0; text-align: center;">
          <div style="color: #EF4444; font-size: 11px; text-transform: uppercase; font-weight: 700;">Overdue / Action</div>
          <div style="font-size: 26px; font-weight: 800; color: #EF4444; margin-top: 4px;">${stats.overdue}</div>
        </div>
      </div>
    </div>

    <!-- Content Table -->
    <div style="padding: 24px 32px;">
      <h2 style="font-size: 16px; font-weight: 700; color: #0F172A; margin: 0 0 16px 0;">Content Schedule & Publishing Verification</h2>
      <div style="overflow-x: auto;">
        <table style="width: 100%; border-collapse: collapse; font-size: 13px; text-align: left;">
          <thead>
            <tr style="background-color: #F8FAFC; border-bottom: 2px solid #E2E8F0; color: #475569;">
              <th style="padding: 10px 14px;">Date</th>
              <th style="padding: 10px 14px;">Time</th>
              <th style="padding: 10px 14px;">Channel</th>
              <th style="padding: 10px 14px;">Type</th>
              <th style="padding: 10px 14px;">Subject / Title</th>
              <th style="padding: 10px 14px;">Status</th>
              <th style="padding: 10px 14px;">Details / Link</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml || '<tr><td colspan="7" style="text-align: center; padding: 24px; color: #64748B;">No scheduled posts found in active audit window.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Footer -->
    <div style="background: #F8FAFC; padding: 16px 32px; border-top: 1px solid #E2E8F0; text-align: center; font-size: 12px; color: #94A3B8;">
      Leaders Performance Management Consultancies L.L.C · Dubai<br/>
      Automated via Social CRM Flow 4 (Calendar Verification Engine)
    </div>
  </div>
</body>
</html>
    `;
  }
}

export const calendarVerificationService = new CalendarVerificationService();
