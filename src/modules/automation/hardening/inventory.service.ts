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
import { splitChannelsCell, isRowMarkedSkipped } from '../ingest/calendarParser';
import { notificationService } from '../notifications/notification.service';

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

    const rules: FolderRuleConfig[] =
      dbRules.length > 0
        ? dbRules.map((r) => ({
            drivePath: r.drivePath,
            platform: r.platform,
            postKind: r.postKind,
            contentTypeAliases: r.contentTypeAliases,
            mode: r.mode,
            expectedFiles: r.expectedFiles,
          }))
        : DEFAULT_FOLDER_RULES;

    const listingsMap = new Map<string, InventoryFolderListingInput>();
    for (const item of params.folderListings || []) {
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

    const windowRows = (params.rows || []).filter(
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
