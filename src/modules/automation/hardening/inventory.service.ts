import path from 'path';
import fs from 'fs';
import { automationPrisma } from '../state/transition';
import {
  DEFAULT_FOLDER_RULES,
  resolveChannelAlias,
  resolveExpectedDrivePath,
  matchDriveFolderListing,
  DriveFileInput,
  DriveSubfolderInput,
  FolderRuleConfig,
} from '../ingest/folderMatcher';
import {
  splitChannelsCell,
  isRowMarkedSkipped,
  parseCalendarDateToYmd,
  parseCalendarTimeToHhMm,
} from '../ingest/calendarParser';
import { parseXlsxBuffer } from '../ingest/fileParsers';
import {
  getGoogleDriveClient,
  fetchCalendarSpreadsheetBuffer,
  parseAllCalendarSections,
  scanSocialMediaDriveFolders,
} from '../ingest/driveClient';
import { notificationService, getRecipientLists } from '../notifications/notification.service';
import { sendSmtpEmail } from '../notifications/smtpDispatcher';

export interface InventoryCalendarRowInput {
  dateYmd: string;
  timeHhMm?: string;
  channelRaw: string;
  contentType?: string | null;
  subject?: string | null;
  tab?: string;
  rowNumber?: number;
}

export interface InventoryFolderListingInput {
  drivePath: string;
  folderFound?: boolean;
  files?: DriveFileInput[];
  subfolders?: DriveSubfolderInput[];
}

export interface MissingContentItem {
  dateYmd: string;
  channel: string;
  platform: string;
  contentType: string | null;
  subject: string | null;
  expectedDrivePath: string | null;
  reason: string;
}

export interface StreamCoverageItem {
  streamPath: string;
  platform: string;
  postKind: string;
  plannedRows: number;
  readyRows: number;
  readyUntil: string | null;
  daysReady: number;
  isUrgent: boolean; // ready for < 14 days
}

export interface InventoryCheckResult {
  checkedFromDate: string;
  checkedToDate: string;
  totalPlannedPosts: number;
  totalReadyPosts: number;
  missingContent: MissingContentItem[];
  coveragePerStream: StreamCoverageItem[];
  calendarGaps: string[];
  emailQueued: boolean;
  notificationId?: string;
}

/**
 * Computes ISO 8601 week key `YYYY-Www` for weekly `INVENTORY_LOW` email deduplication (Plan Section 6 Flow 3 Step 5).
 */
export function getIsoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

/**
 * Automatically connects to Google Drive via Service Account to fetch:
 * 1. 30-day rows from Content Calendar spreadsheet
 * 2. Real-time folder listings in 07_Social_media
 */
async function fetchLiveCalendarRowsAndDriveFolders(
  checkedFromDate: string,
  checkedToDate: string
): Promise<{ rows: InventoryCalendarRowInput[]; folderListings: InventoryFolderListingInput[] }> {
  const ctx = getGoogleDriveClient();
  if (!ctx) {
    return { rows: [], folderListings: [] };
  }

  const calFileId = process.env.CALENDAR_FILE_ID || '1eb9XK1hvhX-ABd4nHjpmMBdtTH6cmMgL';
  const rootFolderId = process.env.DRIVE_ROOT_FOLDER_ID || '177ptcsSWKiBveriapQmPo1KQwFhsi44C';

  let rows: InventoryCalendarRowInput[] = [];
  let folderListings: InventoryFolderListingInput[] = [];

  try {
    console.log(`[InventoryCheck] Fetching calendar ${calFileId} from Google Drive...`);
    const calBuf = await fetchCalendarSpreadsheetBuffer(ctx.drive, calFileId);
    const sheets = parseXlsxBuffer(calBuf);
    const rawItems = parseAllCalendarSections(sheets, {
      fromDate: checkedFromDate,
      toDate: checkedToDate,
    });
    rows = rawItems.map((r) => ({
      dateYmd: r.dateYmd,
      timeHhMm: r.timeHhMm,
      channelRaw: r.channelRaw,
      contentType: r.contentType,
      subject: r.subject,
      tab: r.tab,
      rowNumber: r.rowNumber,
    }));
    console.log(`[InventoryCheck] Extracted ${rows.length} calendar rows between ${checkedFromDate} and ${checkedToDate} across all sheet sections.`);
  } catch (err: any) {
    console.error('[InventoryCheck] Failed to fetch/parse calendar from Google Drive:', err?.message);
  }

  try {
    console.log(`[InventoryCheck] Scanning Google Drive root ${rootFolderId} for 07_Social_media folders...`);
    folderListings = await scanSocialMediaDriveFolders(ctx.drive, rootFolderId);
    console.log(`[InventoryCheck] Found ${folderListings.length} matching date folders in Google Drive.`);
  } catch (err: any) {
    console.error('[InventoryCheck] Failed to scan Google Drive folders:', err?.message);
  }

  return { rows, folderListings };
}

export class InventoryService {
  /**
   * Flow 3 — Inventory Check (`POST /internal/inventory/check`).
   * Strictly read-only: never downloads, uploads, or modifies Post/ContentItem rows.
   * Evaluates 30-day calendar rows against Drive folder listings using Section 4 matching rules.
   */
  public async checkInventory(params: {
    rows: InventoryCalendarRowInput[];
    folderListings: InventoryFolderListingInput[];
    calendarGaps?: string[];
    now?: Date;
    daysAhead?: number;
    isManualRun?: boolean;
  }): Promise<InventoryCheckResult> {
    const now = params.now || new Date();
    const daysAhead =
      params.daysAhead ?? (Number(process.env.INVENTORY_DAYS_AHEAD) || 30);

    const startDay = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
    );
    const endDay = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysAhead)
    );

    const checkedFromDate = startDay.toISOString().slice(0, 10);
    const checkedToDate = endDay.toISOString().slice(0, 10);
    const socialRoot = (process.env.SOCIAL_FOLDER_NAME || '07_Social_media').replace(/\/+$/, '');

    // Load DB channel aliases, folder rules, and accounts (read-only)
    const dbAliases = await automationPrisma.channelAlias.findMany();
    const dbRules = await automationPrisma.folderRule.findMany({ where: { isActive: true } });
    const dbAccounts = await automationPrisma.socialAccount.findMany({ where: { isActive: true } });

    const rules: FolderRuleConfig[] = (
      dbRules.length > 0 ? dbRules : DEFAULT_FOLDER_RULES
    ).map((r) => {
      const defaultRule = DEFAULT_FOLDER_RULES.find(
        (def) => def.drivePath === r.drivePath
      );
      const mergedAliases = Array.from(
        new Set([
          ...(r.contentTypeAliases || []),
          ...(defaultRule ? defaultRule.contentTypeAliases : []),
        ])
      );
      return {
        drivePath: r.drivePath,
        platform: r.platform,
        postKind: r.postKind,
        contentTypeAliases: mergedAliases,
        mode: r.mode,
        expectedFiles: r.expectedFiles,
      };
    });

    let rows = params.rows || [];
    let folderListings = params.folderListings || [];

    if (rows.length === 0 || folderListings.length === 0) {
      console.log('[InventoryCheck] Querying live Google Drive & Content Calendar spreadsheet...');
      const live = await fetchLiveCalendarRowsAndDriveFolders(checkedFromDate, checkedToDate);
      if (rows.length === 0) rows = live.rows;
      if (folderListings.length === 0) folderListings = live.folderListings;
    }

    // Fallback: If rows is still empty (e.g. offline Drive), load from database
    if (rows.length === 0) {
      const dbPosts = await automationPrisma.post.findMany({
        where: {
          scheduledAt: { gte: startDay, lte: endDay },
        },
      });
      rows = dbPosts.map((p) => ({
        dateYmd: p.scheduledAt.toISOString().slice(0, 10),
        timeHhMm: p.scheduledAt.toISOString().slice(11, 16),
        channelRaw: p.platform,
        contentType: 'Post',
        subject: p.title || p.caption?.slice(0, 40) || 'Scheduled Post',
      }));
    }

    const listingsMap = new Map<string, InventoryFolderListingInput>();
    for (const item of folderListings) {
      const cleanPath = (item.drivePath || '').replace(/^\/+|\/+$/g, '');
      listingsMap.set(cleanPath, item);
    }

    const streamStats = new Map<
      string,
      {
        rule: FolderRuleConfig;
        plannedDates: string[];
        missingDates: Set<string>;
        plannedCount: number;
        readyCount: number;
      }
    >();

    for (const r of rules) {
      streamStats.set(r.drivePath, {
        rule: r,
        plannedDates: [],
        missingDates: new Set<string>(),
        plannedCount: 0,
        readyCount: 0,
      });
    }

    const missingContent: MissingContentItem[] = [];
    const calendarGaps: string[] = [...(params.calendarGaps || [])];

    const windowRows = rows.filter(
      (r) => r.dateYmd >= checkedFromDate && r.dateYmd <= checkedToDate
    );

    if (windowRows.length === 0) {
      calendarGaps.push(
        `No calendar rows planned between ${checkedFromDate} and ${checkedToDate}`
      );
    }

    let totalPlannedPosts = 0;
    let totalReadyPosts = 0;

    for (const row of windowRows) {
      if (
        isRowMarkedSkipped({
          subject: row.subject,
          contentType: row.contentType,
          channelRaw: row.channelRaw,
        }).skipped
      ) {
        continue;
      }

      const tokens = splitChannelsCell(row.channelRaw);
      for (const token of tokens) {
        const resolvedChannel = resolveChannelAlias(
          token,
          row.contentType,
          dbAliases,
          dbAccounts
        );
        if (!resolvedChannel.known) {
          continue;
        }

        // Plan Section 6 Flow 3: Manual channels with no Drive folder (Medium, INSPO, Website, X) are not checked;
        // 04_Newsletter_Article (LINKEDIN_NEWSLETTER) IS checked.
        if (
          resolvedChannel.platform === 'MEDIUM' ||
          resolvedChannel.platform === 'INSPO' ||
          resolvedChannel.platform === 'WEBSITE' ||
          resolvedChannel.platform === 'X'
        ) {
          continue;
        }

        totalPlannedPosts += 1;

        const pathResolution = resolveExpectedDrivePath({
          platform: resolvedChannel.platform,
          contentType: row.contentType,
          dateYmd: row.dateYmd,
          folderRules: rules,
          socialRootName: socialRoot,
        });

        if (!pathResolution.drivePath || !pathResolution.rule) {
          missingContent.push({
            dateYmd: row.dateYmd,
            channel: token,
            platform: resolvedChannel.platform,
            contentType: row.contentType ?? null,
            subject: row.subject ?? null,
            expectedDrivePath: null,
            reason:
              pathResolution.blockedReason ||
              `Cannot map content type "${row.contentType || ''}" to a Drive folder`,
          });
          continue;
        }

        const expectedPath = pathResolution.drivePath.replace(/^\/+|\/+$/g, '');
        const stat = streamStats.get(pathResolution.rule.drivePath);
        if (stat) {
          stat.plannedCount += 1;
          stat.plannedDates.push(row.dateYmd);
        }

        const listing = listingsMap.get(expectedPath);
        const folderFound = Boolean(listing && listing.folderFound !== false);

        const matchResult = matchDriveFolderListing({
          platform: resolvedChannel.platform,
          contentType: row.contentType,
          subject: row.subject,
          drivePath: expectedPath,
          folderFound,
          files: listing?.files || [],
          subfolders: listing?.subfolders || [],
        });

        // Flow 3 Step 3: "rows whose date folder is missing, empty, has no usable media, has no caption .docx, or matches ambiguously"
        if (!matchResult.matched || matchResult.missingCaptionDocx) {
          const reason = !matchResult.matched
            ? matchResult.blockedReason || 'Missing or ambiguous media'
            : `Missing caption .docx in ${expectedPath}`;

          missingContent.push({
            dateYmd: row.dateYmd,
            channel: token,
            platform: resolvedChannel.platform,
            contentType: row.contentType ?? null,
            subject: row.subject ?? null,
            expectedDrivePath: expectedPath,
            reason,
          });
          if (stat) {
            stat.missingDates.add(row.dateYmd);
          }
        } else {
          totalReadyPosts += 1;
          if (stat) {
            stat.readyCount += 1;
          }
        }
      }
    }

    const coveragePerStream: StreamCoverageItem[] = [];
    for (const [streamPath, stat] of streamStats.entries()) {
      const sortedPlanned = Array.from(new Set(stat.plannedDates)).sort();
      let readyUntil: string | null = checkedToDate;

      if (stat.plannedCount === 0) {
        readyUntil = null;
      } else if (stat.missingDates.size > 0) {
        const firstMissingDate = Array.from(stat.missingDates).sort()[0];
        const readyBeforeFirstMissing = sortedPlanned.filter((d) => d < firstMissingDate);
        readyUntil =
          readyBeforeFirstMissing.length > 0
            ? readyBeforeFirstMissing[readyBeforeFirstMissing.length - 1]
            : null;
      } else {
        readyUntil = sortedPlanned[sortedPlanned.length - 1] || checkedToDate;
      }

      const daysReady = readyUntil
        ? Math.max(
            0,
            Math.ceil(
              (new Date(`${readyUntil}T00:00:00Z`).getTime() - now.getTime()) /
                (24 * 60 * 60 * 1000)
            )
          )
        : 0;

      // Plan Section 6 Flow 3 Step 4: "Any stream that is ready for less than 14 days is marked URGENT"
      const isUrgent = stat.plannedCount > 0 && stat.missingDates.size > 0 && daysReady < 14;

      coveragePerStream.push({
        streamPath: `${socialRoot}/${streamPath}`,
        platform: stat.rule.platform,
        postKind: stat.rule.postKind,
        plannedRows: stat.plannedCount,
        readyRows: stat.readyCount,
        readyUntil,
        daysReady,
        isUrgent,
      });
    }

    let emailQueued = false;
    let notificationId: string | undefined;

    const hasGaps = missingContent.length > 0 || calendarGaps.length > 0;
    if (hasGaps) {
      const dedupeSuffix = params.isManualRun
        ? `manual-${Date.now()}`
        : getIsoWeekKey(now);

      const base = (
        process.env.CRM_BASE_URL ||
        process.env.FRONTEND_URL ||
        'https://staging.leadersperformance.ae'
      ).replace(/\/+$/, '');

      const summaryLine = `${missingContent.length} of ${totalPlannedPosts} posts for the next ${daysAhead} days are not ready`;
      const urgentStreams = coveragePerStream.filter((s) => s.isUrgent);

      const subject = `${
        urgentStreams.length > 0 ? '[URGENT Inventory Low]' : '[Inventory Check]'
      } ${summaryLine}`;

      const bodyLines: string[] = [
        summaryLine,
        '',
        'Coverage per stream:',
        ...coveragePerStream.map(
          (s) =>
            `- ${s.isUrgent ? '[URGENT <14d] ' : ''}${s.streamPath} (${s.platform} ${
              s.postKind
            }): ${s.readyRows}/${s.plannedRows} ready · Ready until: ${
              s.readyUntil || 'none'
            }`
        ),
      ];

      if (missingContent.length > 0) {
        bodyLines.push(
          '',
          'Missing / Incomplete rows:',
          ...missingContent.map(
            (m) =>
              `- ${m.dateYmd} · ${m.platform} (${m.contentType || 'Post'}) · "${
                m.subject || 'Untitled'
              }" -> Expected path: ${m.expectedDrivePath || 'unmapped'} (${m.reason})`
          )
        );
      }

      if (calendarGaps.length > 0) {
        bodyLines.push('', 'Calendar gaps:', ...calendarGaps.map((g) => `- ${g}`));
      }

      bodyLines.push('', `Inspect in Social CRM (Blocked & Failed): ${base}/blocked`);

      const queued = await notificationService.queueInventoryLow({
        dedupeSuffix,
        subject,
        body: bodyLines.join('\n'),
      });
      emailQueued = queued.created;
      notificationId = queued.notification.id;

      if (emailQueued) {
        try {
          const recipients = getRecipientLists();
          const targetEmails = [...recipients.editors, ...recipients.admin]
            .filter(
              (e) =>
                !e.toLowerCase().includes('lionel') &&
                !e.toLowerCase().includes('asad') &&
                !e.toLowerCase().includes('sarath@leadersperformance.ae')
            )
            .filter((val, idx, arr) => arr.indexOf(val) === idx);

          if (targetEmails.length > 0) {
            await sendSmtpEmail({
              to: targetEmails,
              subject,
              html: `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1E293B; max-width: 640px; margin: 20px auto; padding: 24px; border: 1px solid #E2E8F0; border-radius: 12px; background: #FFFFFF; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
                <div style="height: 4px; background: linear-gradient(90deg, #D4AF37 0%, #C5A880 100%); margin: -24px -24px 20px -24px; border-radius: 12px 12px 0 0;"></div>
                <a href="https://leadersperformance.ae" target="_blank" style="text-decoration: none; display: inline-block;">
                  <img src="https://tpyudbsbzrhhngulxyxp.supabase.co/storage/v1/object/public/avatars/branding/logo-gold.png" alt="Leaders Performance" height="38" style="height: 38px; width: auto; max-width: 220px; display: block; margin-bottom: 12px; border: 0;" border="0" />
                </a>
                <div style="font-size: 11px; font-weight: 700; color: #D4AF37; letter-spacing: 2px; text-transform: uppercase;">LEADERS PERFORMANCE · CONTENT OPS</div>
                <h2 style="color: #0F172A; margin: 6px 0 16px 0;">${subject}</h2>
                <div style="background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
                  <div style="font-size: 14px; font-weight: 600; color: #0F172A; margin-bottom: 8px;">30-Day Pipeline Summary:</div>
                  <div style="font-size: 13px; color: #475569; line-height: 1.6;">
                    Checked window: <strong>${checkedFromDate}</strong> to <strong>${checkedToDate}</strong><br/>
                    Total planned posts: <strong>${totalPlannedPosts}</strong><br/>
                    Ready posts with assets: <strong>${totalReadyPosts}</strong><br/>
                    Missing or incomplete: <strong style="color: #DC2626;">${missingContent.length}</strong>
                  </div>
                </div>
                <div style="font-size: 13px; font-weight: 700; color: #0F172A; text-transform: uppercase; margin-bottom: 8px;">Coverage per stream:</div>
                <table style="width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 20px;">
                  <thead>
                    <tr style="background: #F1F5F9; text-align: left;">
                      <th style="padding: 8px 10px; border: 1px solid #E2E8F0;">Stream</th>
                      <th style="padding: 8px 10px; border: 1px solid #E2E8F0;">Ready / Planned</th>
                      <th style="padding: 8px 10px; border: 1px solid #E2E8F0;">Days Ready</th>
                      <th style="padding: 8px 10px; border: 1px solid #E2E8F0;">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${coveragePerStream.map(s => `
                      <tr style="border-bottom: 1px solid #E2E8F0; ${s.isUrgent ? 'background: #FEF2F2;' : ''}">
                        <td style="padding: 8px 10px; font-weight: 600;">${s.streamPath}</td>
                        <td style="padding: 8px 10px;">${s.readyRows} / ${s.plannedRows}</td>
                        <td style="padding: 8px 10px;">${s.daysReady} days</td>
                        <td style="padding: 8px 10px; font-weight: 700; color: ${s.isUrgent ? '#DC2626' : '#16A34A'};">
                          ${s.isUrgent ? '🚨 URGENT (<14d)' : '✅ On Track'}
                        </td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
                <div style="text-align: center; margin: 24px 0 12px 0;">
                  <a href="https://social.leadersperformance.ae/approvals" style="background: #0F172A; border: 1px solid #D4AF37; color: #FFFFFF; font-size: 14px; font-weight: 700; text-decoration: none; padding: 12px 28px; border-radius: 6px; display: inline-block;">
                    Open Social CRM →
                  </a>
                </div>
                <div style="margin-top: 24px; padding-top: 12px; border-top: 1px solid #E2E8F0; font-size: 11px; color: #94A3B8; text-align: center;">
                  Leaders Performance Management Consultancies L.L.C · Dubai
                </div>
              </div>`,
            });
            await notificationService.markSent(queued.notification.id);
          }
        } catch (emailErr: any) {
          console.error('[InventoryCheck] Failed to dispatch email alert:', emailErr?.message);
        }
      }
    }

    return {
      checkedFromDate,
      checkedToDate,
      totalPlannedPosts,
      totalReadyPosts,
      missingContent,
      coveragePerStream,
      calendarGaps,
      emailQueued,
      notificationId,
    };
  }
}

export const inventoryService = new InventoryService();
