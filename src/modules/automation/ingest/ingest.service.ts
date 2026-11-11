import { Platform, PublishMode } from '@prisma/client';
import {
  automationPrisma,
  computeTransition,
  transition,
  FINAL_POST_STATUSES,
  PostStatusType,
} from '../state/transition';
import {
  IStorageService,
  storageService as defaultStorageService,
  buildStorageObjectKey,
} from '../storage/storage.service';
import {
  RawCalendarRowInput,
  parseAndFilterCalendarRows,
  selectCurrentAndNextMonthTabs,
} from './calendarParser';
import {
  resolveChannelAlias,
  resolveExpectedDrivePath,
  matchDriveFolderListing,
  DriveFileInput,
  DriveSubfolderInput,
  FolderRuleConfig,
} from './folderMatcher';
import {
  parseXlsxBuffer,
  extractDocxText,
  probeMediaBuffer,
  validateMediaForPlatform,
} from './fileParsers';
import {
  getGoogleDriveClient,
  fetchCalendarSpreadsheetBuffer,
  parseAllCalendarSections,
  scanSocialMediaDriveFolders,
  downloadDriveFileBuffer,
  DriveFolderListing,
} from './driveClient';
import { notificationService } from '../notifications/notification.service';
import { sendSmtpEmail } from '../notifications/smtpDispatcher';

export interface IngestRowsInput {
  sheetId?: string;
  tab?: string;
  rows?: RawCalendarRowInput[];
  xlsxBase64?: string;
  referenceDate?: string | Date;
  dumpDaysBefore?: number;
  windowStartYmd?: string;
  windowEndYmd?: string;
  timeZone?: string;
  markUnseenRows?: boolean;
}

export interface PostNeedingFolder {
  postId: string;
  contentItemId: string;
  platform: Platform;
  mode: PublishMode;
  status: string;
  scheduledAt: string;
  dateYmd: string;
  contentType: string | null;
  subject: string | null;
  drivePath: string;
}

export interface IngestRowsResult {
  windowStartYmd: string;
  windowEndYmd: string;
  stagedRowCount: number;
  outOfWindowCount: number;
  skippedNoiseCount: number;
  postsCreated: number;
  postsUpdated: number;
  postsSkipped: number;
  postsBlocked: number;
  postsCancelled: number;
  postsUnchanged: number;
  postsNeedingFolders: PostNeedingFolder[];
  warnings: string[];
}

export interface FolderListingItemInput {
  postId: string;
  drivePath: string;
  folderFound: boolean;
  files?: DriveFileInput[];
  subfolders?: DriveSubfolderInput[];
}

export interface FolderListingProcessResult {
  postId: string;
  drivePath: string;
  status: string;
  blockedReason: string | null;
  unchanged: boolean;
  uploadsNeeded: Array<{
    mediaAssetId: string;
    driveFileId: string;
    fileName: string;
    mimeType: string;
    role: string;
    position: number;
    bucket: string;
    objectKey: string;
    signedUploadUrl: string;
    uploadToken?: string;
  }>;
  reusedAssetsCount: number;
}

export class IngestService {
  constructor(private readonly storage: IStorageService = defaultStorageService) { }

  /**
   * Step 6 of Flow 1: Upserts ContentItems and Posts from calendar rows,
   * applies channel/type aliases, handles SKIPPED/CANCELLED/edited rows,
   * and returns the list of posts that need Drive folder listings.
   */
  public async ingestRows(input: IngestRowsInput): Promise<IngestRowsResult> {
    const sheetId =
      (input.sheetId || process.env.CALENDAR_FILE_ID || '1eb9XK1hvhX-ABd4nHjpmMBdtTH6cmMgL').trim();
    const defaultTab = (input.tab || process.env.CALENDAR_SHEET_NAME || 'Master Content Calendar').trim();
    const refDate = input.referenceDate ? new Date(input.referenceDate) : new Date();
    const timeZone = input.timeZone || process.env.CALENDAR_TZ || 'Europe/Amsterdam';
    const dumpDaysBefore =
      input.dumpDaysBefore ?? (Number(process.env.DUMP_DAYS_BEFORE) || 14);

    let rawRows: RawCalendarRowInput[] = input.rows ? [...input.rows] : [];
    const warnings: string[] = [];

    // Support direct .xlsx base64 parsing when CALENDAR_SOURCE=xlsx
    if (input.xlsxBase64) {
      const buf = Buffer.from(input.xlsxBase64, 'base64');
      const sheets = parseXlsxBuffer(buf);
      const tabSelection = selectCurrentAndNextMonthTabs(
        sheets.map((s) => s.name),
        refDate,
        timeZone
      );
      warnings.push(...tabSelection.warnings);

      for (const tabName of tabSelection.selectedTabs) {
        const sheet = sheets.find((s) => s.name === tabName);
        if (!sheet) continue;
        for (const r of sheet.rows) {
          rawRows.push({
            rowNumber: r.rowNumber,
            tab: sheet.name,
            cells: r.cells,
          });
        }
      }
    }

    const parsed = parseAndFilterCalendarRows({
      sheetId,
      defaultTab,
      rows: rawRows,
      referenceDate: refDate,
      dumpDaysBefore,
      windowStartYmd: input.windowStartYmd,
      windowEndYmd: input.windowEndYmd,
      timeZone,
    });
    warnings.push(...parsed.warnings);

    // Load DB config sequentially to avoid cold-start connection spikes on Supabase PgBouncer
    const dbRules = await automationPrisma.folderRule.findMany({ where: { isActive: true } });
    const dbAliases = await automationPrisma.channelAlias.findMany();
    const activeAccounts = await automationPrisma.socialAccount.findMany({ where: { isActive: true } });

    const folderRules: FolderRuleConfig[] = dbRules.map((r) => ({
      drivePath: r.drivePath,
      platform: r.platform,
      postKind: r.postKind,
      contentTypeAliases: r.contentTypeAliases,
      mode: r.mode,
      expectedFiles: r.expectedFiles,
    }));

    const now = new Date();
    let postsCreated = 0;
    let postsUpdated = 0;
    let postsSkipped = 0;
    let postsBlocked = 0;
    let postsCancelled = 0;
    let postsUnchanged = 0;
    const postsNeedingFolders: PostNeedingFolder[] = [];
    const seenContentItemIds = new Set<string>();

    // Deduplicate stagedRows by rowKey within the same payload (Edge Case #4: boundary week in both month tabs)
    const uniqueRowsByKey = new Map<string, (typeof parsed.stagedRows)[number]>();
    for (const row of parsed.stagedRows) {
      if (!uniqueRowsByKey.has(row.rowKey)) {
        uniqueRowsByKey.set(row.rowKey, row);
      }
    }

    for (const row of uniqueRowsByKey.values()) {
      const existingItem = await automationPrisma.contentItem.findUnique({
        where: { rowKey: row.rowKey },
        include: { posts: true },
      });

      let contentItem = existingItem;
      let rowHashChanged = false;

      if (!existingItem) {
        contentItem = await automationPrisma.contentItem.create({
          data: {
            sheetId: row.sheetId,
            sheetTab: row.sheetTab,
            rowNumber: row.rowNumber,
            rowKey: row.rowKey,
            rowHash: row.rowHash,
            scheduledAt: row.scheduledAtUtc,
            channelRaw: row.channelRaw,
            contentType: row.contentType,
            subject: row.subject,
            fileLocation: row.fileLocation,
            rawRow: row.rawRow,
            category: row.category,
            lastSeenAt: now,
            unseenRuns: 0,
          },
          include: { posts: true },
        });
      } else {
        rowHashChanged = existingItem.rowHash !== row.rowHash;
        contentItem = await automationPrisma.contentItem.update({
          where: { id: existingItem.id },
          data: {
            lastSeenAt: now,
            unseenRuns: 0,
            ...(rowHashChanged
              ? {
                sheetTab: row.sheetTab,
                rowNumber: row.rowNumber,
                rowHash: row.rowHash,
                scheduledAt: row.scheduledAtUtc,
                channelRaw: row.channelRaw,
                contentType: row.contentType,
                subject: row.subject,
                fileLocation: row.fileLocation,
                rawRow: row.rawRow,
                ...(row.category ? { category: row.category } : {}),
              }
              : {}),
          },
          include: { posts: true },
        });
      }

      seenContentItemIds.add(contentItem.id);

      // Process each channel from the row (e.g. "LinkedIn & YouTube" -> 2 posts)
      for (const channelToken of row.channels) {
        const resolved = resolveChannelAlias(
          channelToken,
          row.contentType,
          dbAliases,
          activeAccounts
        );

        // Hide / Skip manual posting channels (X, INSPO, MEDIUM, WEBSITE) from automated post creation
        if (
          resolved.platform === 'X' ||
          resolved.platform === 'INSPO' ||
          resolved.platform === 'MEDIUM' ||
          resolved.platform === 'WEBSITE'
        ) {
          continue;
        }

        const idempotencyKey = resolved.known
          ? `${contentItem.id}|${resolved.platform}|${resolved.accountId || 'default'}`
          : `${contentItem.id}|UNKNOWN:${resolved.normalizedAlias}|none`;

        const existingPost = contentItem.posts.find(
          (p) => p.idempotencyKey === idempotencyKey
        );

        // 1. Handle SKIPPED rows ("No video posted", "Geen post online gegaan", "No post scheduled")
        if (row.isSkipped) {
          if (!existingPost) {
            const tempId = 'new-post';
            const tr = computeTransition(
              {
                id: tempId,
                status: null,
                mode: resolved.mode,
                scheduledAt: row.scheduledAtUtc,
                revision: 1,
                attemptCount: 0,
              },
              'INGEST_SKIPPED',
              { actorId: 'ingest-bot', comment: `Skipped: ${row.skipReason}` }
            );
            const created = await automationPrisma.post.create({
              data: {
                contentItemId: contentItem.id,
                accountId: resolved.accountId,
                platform: resolved.platform,
                mode: resolved.mode,
                status: tr.nextStatus,
                scheduledAt: row.scheduledAtUtc,
                title: row.subject,
                options: { usedDefaultTime: row.usedDefaultTime, skipReason: row.skipReason },
                idempotencyKey,
              },
            });
            if (tr.reviewEvent) {
              await automationPrisma.reviewEvent.create({
                data: { ...tr.reviewEvent, postId: created.id },
              });
            }
            console.log(
              `[Ingest] postId=${created.id} event=INGEST_SKIPPED status=SKIPPED reason="${row.skipReason}"`
            );
            postsCreated++;
            postsSkipped++;
          } else {
            postsUnchanged++;
          }
          continue;
        }

        // 2. Handle UNKNOWN channel (Edge Case #8)
        if (!resolved.known) {
          const blockedReason = `unknown channel: "${channelToken}"`;
          if (!existingPost) {
            const tr = computeTransition(
              {
                id: 'new-post',
                status: null,
                mode: 'MANUAL',
                scheduledAt: row.scheduledAtUtc,
                revision: 1,
                attemptCount: 0,
              },
              'INGEST_BLOCKED',
              { actorId: 'ingest-bot', blockedReason }
            );
            const created = await automationPrisma.post.create({
              data: {
                contentItemId: contentItem.id,
                accountId: null,
                platform: 'WEBSITE',
                mode: 'MANUAL',
                status: tr.nextStatus,
                blockedReason,
                scheduledAt: row.scheduledAtUtc,
                title: row.subject,
                options: { rawChannel: channelToken, usedDefaultTime: row.usedDefaultTime },
                idempotencyKey,
              },
            });
            if (tr.reviewEvent) {
              await automationPrisma.reviewEvent.create({
                data: { ...tr.reviewEvent, postId: created.id },
              });
            }
            console.log(
              `[Ingest] postId=${created.id} event=INGEST_BLOCKED status=BLOCKED reason="${blockedReason}"`
            );
            postsCreated++;
            postsBlocked++;
          } else {
            postsUnchanged++;
          }
          continue;
        }

        // 3. Resolve Drive path for known channel
        const pathInfo = resolveExpectedDrivePath({
          platform: resolved.platform,
          contentType: row.contentType,
          dateYmd: row.dateYmd,
          folderRules,
        });

        if (!existingPost) {
          // Brand-new post
          if (pathInfo.blockedReason) {
            const tr = computeTransition(
              {
                id: 'new-post',
                status: null,
                mode: resolved.mode,
                scheduledAt: row.scheduledAtUtc,
                revision: 1,
                attemptCount: 0,
              },
              'INGEST_BLOCKED',
              { actorId: 'ingest-bot', blockedReason: pathInfo.blockedReason }
            );
            const created = await automationPrisma.post.create({
              data: {
                contentItemId: contentItem.id,
                accountId: resolved.accountId,
                platform: resolved.platform,
                mode: resolved.mode,
                status: tr.nextStatus,
                blockedReason: pathInfo.blockedReason,
                scheduledAt: row.scheduledAtUtc,
                title: row.subject,
                options: { usedDefaultTime: row.usedDefaultTime },
                idempotencyKey,
              },
            });
            if (tr.reviewEvent) {
              await automationPrisma.reviewEvent.create({
                data: { ...tr.reviewEvent, postId: created.id },
              });
            }
            postsCreated++;
            postsBlocked++;
            continue;
          }

          if (!pathInfo.requiresDriveFolder) {
            // Manual channel with no Drive folder (e.g. Medium, INSPO) -> straight to PENDING_REVIEW
            const tr = computeTransition(
              {
                id: 'new-post',
                status: null,
                mode: resolved.mode,
                scheduledAt: row.scheduledAtUtc,
                revision: 1,
                attemptCount: 0,
              },
              'INGEST_VALID',
              { actorId: 'ingest-bot', comment: 'Staged manual channel task from calendar' }
            );
            const created = await automationPrisma.post.create({
              data: {
                contentItemId: contentItem.id,
                accountId: resolved.accountId,
                platform: resolved.platform,
                mode: resolved.mode,
                status: tr.nextStatus,
                scheduledAt: row.scheduledAtUtc,
                title: row.subject,
                caption: row.subject || row.fileLocation || '',
                captionSource: 'CALENDAR',
                options: { usedDefaultTime: row.usedDefaultTime },
                idempotencyKey,
              },
            });
            if (tr.reviewEvent) {
              await automationPrisma.reviewEvent.create({
                data: { ...tr.reviewEvent, postId: created.id },
              });
            }
            postsCreated++;
            continue;
          }

          // Post needs Drive folder inspection: create initially as BLOCKED ("awaiting folder listing")
          // until step 7 (/internal/ingest/folder-listing) runs in the same Flow 1 execution.
          const initialBlockedReason = `folder missing: ${pathInfo.drivePath}`;
          const tr = computeTransition(
            {
              id: 'new-post',
              status: null,
              mode: pathInfo.rule?.mode || resolved.mode,
              scheduledAt: row.scheduledAtUtc,
              revision: 1,
              attemptCount: 0,
            },
            'INGEST_BLOCKED',
            { actorId: 'ingest-bot', blockedReason: initialBlockedReason }
          );

          const created = await automationPrisma.post.create({
            data: {
              contentItemId: contentItem.id,
              accountId: resolved.accountId,
              platform: resolved.platform,
              mode: pathInfo.rule?.mode || resolved.mode,
              status: tr.nextStatus,
              blockedReason: initialBlockedReason,
              scheduledAt: row.scheduledAtUtc,
              title: row.subject,
              options: {
                usedDefaultTime: row.usedDefaultTime,
                expectedDrivePath: pathInfo.drivePath,
                postKind: pathInfo.rule?.postKind || null,
              },
              idempotencyKey,
            },
          });

          if (tr.reviewEvent) {
            await automationPrisma.reviewEvent.create({
              data: { ...tr.reviewEvent, postId: created.id },
            });
          }

          console.log(
            `[Ingest] postId=${created.id} created status=${created.status} drivePath=${pathInfo.drivePath}`
          );
          postsCreated++;
          postsNeedingFolders.push({
            postId: created.id,
            contentItemId: contentItem.id,
            platform: created.platform,
            mode: created.mode,
            status: created.status,
            scheduledAt: created.scheduledAt.toISOString(),
            dateYmd: row.dateYmd,
            contentType: row.contentType,
            subject: row.subject,
            drivePath: pathInfo.drivePath!,
          });
        } else {
          // Existing post: handle rowHash edits (Edge Case #6)
          const isFinal = FINAL_POST_STATUSES.has(existingPost.status as PostStatusType);
          if (rowHashChanged && !isFinal) {
            await automationPrisma.post.update({
              where: { id: existingPost.id },
              data: {
                scheduledAt: row.scheduledAtUtc,
                title: row.subject ?? existingPost.title,
              },
            });

            if (existingPost.status === 'APPROVED') {
              await transition(existingPost.id, 'EDIT_CONTENT', {
                actorId: 'calendar-ingest',
                comment: 'Calendar row edited after approval; moved back to PENDING_REVIEW',
              });
            }
            postsUpdated++;
          } else {
            postsUnchanged++;
          }

          if (pathInfo.requiresDriveFolder && pathInfo.drivePath && !isFinal) {
            postsNeedingFolders.push({
              postId: existingPost.id,
              contentItemId: contentItem.id,
              platform: existingPost.platform,
              mode: existingPost.mode,
              status: existingPost.status,
              scheduledAt: row.scheduledAtUtc.toISOString(),
              dateYmd: row.dateYmd,
              contentType: row.contentType,
              subject: row.subject,
              drivePath: pathInfo.drivePath,
            });
          }
        }
      }
    }

    // Edge Case #7: Row deleted from sheet -> after 2 ingests unseen -> CANCELLED (if not published)
    if (input.markUnseenRows) {
      const windowStartUtc = new Date(`${parsed.stagedRows[0]?.dateYmd || input.windowStartYmd || '2026-01-01'}T00:00:00.000Z`);
      const unseenItems = await automationPrisma.contentItem.findMany({
        where: {
          sheetId,
          id: { notIn: Array.from(seenContentItemIds) },
          scheduledAt: { gte: windowStartUtc },
        },
        include: { posts: true },
      });

      for (const item of unseenItems) {
        const nextUnseen = item.unseenRuns + 1;
        await automationPrisma.contentItem.update({
          where: { id: item.id },
          data: { unseenRuns: nextUnseen },
        });

        if (nextUnseen >= 2) {
          for (const p of item.posts) {
            if (!FINAL_POST_STATUSES.has(p.status as PostStatusType)) {
              await transition(p.id, 'CALENDAR_ROW_DELETED', {
                actorId: 'ingest-bot',
                comment: `Calendar row unseen for ${nextUnseen} consecutive ingest runs`,
              });
              postsCancelled++;
            }
          }
        }
      }
    }

    const todayYmd =
      input.windowStartYmd ||
      new Intl.DateTimeFormat('en-CA', { timeZone }).format(refDate);
    const endDate = new Date(refDate.getTime() + dumpDaysBefore * 86400 * 1000);
    const endYmd =
      input.windowEndYmd ||
      new Intl.DateTimeFormat('en-CA', { timeZone }).format(endDate);

    return {
      windowStartYmd: todayYmd,
      windowEndYmd: endYmd,
      stagedRowCount: uniqueRowsByKey.size,
      outOfWindowCount: parsed.outOfWindowCount,
      skippedNoiseCount: parsed.skippedNoiseCount,
      postsCreated,
      postsUpdated,
      postsSkipped,
      postsBlocked,
      postsCancelled,
      postsUnchanged,
      postsNeedingFolders,
      warnings,
    };
  }

  /**
   * Step 7 of Flow 1: Applies the 11 folder matching rules from Plan Section 4,
   * deduplicates MediaAssets by checksumMd5, detects replaced Drive files on APPROVED posts,
   * and returns signed upload URLs or transitions to BLOCKED / PENDING_REVIEW.
   */
  public async processFolderListings(params: {
    listings: FolderListingItemInput[];
    allDateFoldersInDrive?: string[];
  }): Promise<{
    results: FolderListingProcessResult[];
    orphanFolders: string[];
  }> {
    const results: FolderListingProcessResult[] = [];
    const activeDrivePaths = new Set<string>();

    for (const item of params.listings) {
      activeDrivePaths.add(item.drivePath);

      const post = await automationPrisma.post.findUnique({
        where: { id: item.postId },
        include: {
          contentItem: true,
          media: {
            include: { asset: true },
          },
        },
      });

      if (!post) {
        throw new Error(`[IngestFolderListing] postId=${item.postId} Post not found`);
      }

      const matchResult = matchDriveFolderListing({
        platform: post.platform,
        contentType: post.contentItem.contentType,
        subject: post.contentItem.subject,
        drivePath: item.drivePath,
        folderFound: item.folderFound,
        files: item.files || [],
        subfolders: item.subfolders || [],
      });

      if (!matchResult.matched) {
        const blockedReason = matchResult.blockedReason || `blocked: ${item.drivePath}`;
        const currentOpts =
          typeof post.options === 'object' && post.options !== null
            ? (post.options as Record<string, any>)
            : {};

        // Idempotent check: if already BLOCKED with the exact same reason & candidates, do not write duplicate audit events
        const sameBlocked =
          post.status === 'BLOCKED' &&
          post.blockedReason === blockedReason &&
          JSON.stringify(currentOpts.candidates || null) ===
          JSON.stringify(matchResult.candidates || null);

        if (!sameBlocked && !FINAL_POST_STATUSES.has(post.status as PostStatusType)) {
          await transition(post.id, 'INGEST_BLOCKED', {
            actorId: 'ingest-bot',
            blockedReason,
          });
          await automationPrisma.post.update({
            where: { id: post.id },
            data: {
              options: {
                ...currentOpts,
                expectedDrivePath: item.drivePath,
                candidates: matchResult.candidates || null,
              },
            },
          });
        }

        results.push({
          postId: post.id,
          drivePath: item.drivePath,
          status: 'BLOCKED',
          blockedReason,
          unchanged: sameBlocked,
          uploadsNeeded: [],
          reusedAssetsCount: 0,
        });
        continue;
      }

      // Check if existing PostMedia for the current revision already match the exact selected assets (Rule 8 & 9)
      const currentRevMedia = post.media.filter((m) => m.revision === post.revision);
      const currentSignature = currentRevMedia
        .map((m) => `${m.role}:${m.position}:${m.asset.checksumMd5}:${m.asset.status}`)
        .sort()
        .join('|');
      const incomingSignature = matchResult.selectedAssets
        .map((a) => `${a.role}:${a.position}:${a.checksumMd5}:READY`)
        .sort()
        .join('|');

      if (
        currentRevMedia.length > 0 &&
        currentSignature === incomingSignature &&
        post.status !== 'BLOCKED'
      ) {
        // Second run with identical ready files -> 100% no-op!
        console.log(
          `[IngestFolderListing] postId=${post.id} unchanged=true status=${post.status} (all ${currentRevMedia.length} assets match checksumMd5)`
        );
        results.push({
          postId: post.id,
          drivePath: item.drivePath,
          status: post.status,
          blockedReason: null,
          unchanged: true,
          uploadsNeeded: [],
          reusedAssetsCount: currentRevMedia.length,
        });
        continue;
      }

      // Rule 9 & Edge Case #13: If post was APPROVED and Drive file changed (md5 changed or added),
      // transition back to PENDING_REVIEW (revision + 1) via transition('EDIT_CONTENT')!
      let activeRevision = post.revision;
      let currentStatus = post.status as PostStatusType;

      const currentMd5Sig = currentRevMedia
        .map((m) => `${m.role}:${m.position}:${m.asset.checksumMd5}`)
        .sort()
        .join('|');
      const incomingMd5Sig = matchResult.selectedAssets
        .map((a) => `${a.role}:${a.position}:${a.checksumMd5}`)
        .sort()
        .join('|');

      if (
        currentStatus === 'APPROVED' &&
        currentRevMedia.length > 0 &&
        currentMd5Sig !== incomingMd5Sig
      ) {
        const updatedPost = await transition(post.id, 'EDIT_CONTENT', {
          actorId: 'drive-ingest',
          comment: 'File replaced or changed in Google Drive; re-approval required',
        });
        activeRevision = updatedPost.revision;
        currentStatus = updatedPost.status as PostStatusType;
      }

      const uploadsNeeded: FolderListingProcessResult['uploadsNeeded'] = [];
      let reusedAssetsCount = 0;
      let allAssetsReady = true;

      for (const candidate of matchResult.selectedAssets) {
        // Rule 8 & Edge Case #12: Check if exact driveFileId + checksumMd5 exists,
        // or if any READY MediaAsset with the same checksumMd5 already exists in Storage
        let mediaAsset = await automationPrisma.mediaAsset.findUnique({
          where: {
            driveFileId_checksumMd5: {
              driveFileId: candidate.driveFileId,
              checksumMd5: candidate.checksumMd5,
            },
          },
        });

        if (!mediaAsset) {
          const sameMd5Ready = await automationPrisma.mediaAsset.findFirst({
            where: {
              checksumMd5: candidate.checksumMd5,
              status: 'READY',
              objectKey: { not: null },
            },
          });

          if (sameMd5Ready) {
            // Reuse the stored objectKey without uploading again!
            mediaAsset = await automationPrisma.mediaAsset.create({
              data: {
                driveFileId: candidate.driveFileId,
                checksumMd5: candidate.checksumMd5,
                fileName: candidate.fileName,
                mimeType: candidate.mimeType,
                sizeBytes: BigInt(candidate.sizeBytes),
                width: sameMd5Ready.width,
                height: sameMd5Ready.height,
                durationSec: sameMd5Ready.durationSec,
                storageProvider: sameMd5Ready.storageProvider,
                bucket: sameMd5Ready.bucket,
                objectKey: sameMd5Ready.objectKey,
                status: 'READY',
              },
            });
          } else {
            mediaAsset = await automationPrisma.mediaAsset.create({
              data: {
                driveFileId: candidate.driveFileId,
                checksumMd5: candidate.checksumMd5,
                fileName: candidate.fileName,
                mimeType: candidate.mimeType,
                sizeBytes: BigInt(candidate.sizeBytes),
                storageProvider: this.storage.provider,
                bucket: this.storage.defaultBucket,
                status: 'PENDING_UPLOAD',
              },
            });

            const objectKey = buildStorageObjectKey(mediaAsset.id, candidate.fileName);
            mediaAsset = await automationPrisma.mediaAsset.update({
              where: { id: mediaAsset.id },
              data: { objectKey },
            });
          }
        }

        if (mediaAsset.status === 'READY') {
          reusedAssetsCount++;
        } else {
          allAssetsReady = false;
          const objectKey =
            mediaAsset.objectKey || buildStorageObjectKey(mediaAsset.id, candidate.fileName);
          if (!mediaAsset.objectKey) {
            mediaAsset = await automationPrisma.mediaAsset.update({
              where: { id: mediaAsset.id },
              data: { objectKey },
            });
          }

          let signedUploadUrl = `/internal/media/${mediaAsset.id}/complete`;
          let uploadToken: string | undefined;
          try {
            const signed = await this.storage.signedUploadUrl(objectKey, mediaAsset.bucket);
            signedUploadUrl = signed.signedUrl;
            uploadToken = signed.token;
          } catch {
            // Fallback when running offline or before bucket creation
          }

          uploadsNeeded.push({
            mediaAssetId: mediaAsset.id,
            driveFileId: candidate.driveFileId,
            fileName: candidate.fileName,
            mimeType: candidate.mimeType,
            role: candidate.role,
            position: candidate.position,
            bucket: mediaAsset.bucket,
            objectKey,
            signedUploadUrl,
            uploadToken,
          });
        }

        await automationPrisma.postMedia.upsert({
          where: {
            postId_assetId_role_revision: {
              postId: post.id,
              assetId: mediaAsset.id,
              role: candidate.role,
              revision: activeRevision,
            },
          },
          update: {
            position: candidate.position,
          },
          create: {
            postId: post.id,
            assetId: mediaAsset.id,
            role: candidate.role,
            position: candidate.position,
            revision: activeRevision,
          },
        });
      }

      const currentOpts =
        typeof post.options === 'object' && post.options !== null
          ? (post.options as Record<string, any>)
          : {};

      await automationPrisma.post.update({
        where: { id: post.id },
        data: {
          options: {
            ...currentOpts,
            expectedDrivePath: item.drivePath,
            mediaType: matchResult.mediaType,
            missingCaptionDocx: matchResult.missingCaptionDocx,
            candidates: null,
          },
          ...(matchResult.missingCaptionDocx && !post.captionSource
            ? {
              captionSource: 'CALENDAR',
              caption: post.caption || post.contentItem.subject || '',
            }
            : {}),
        },
      });

      if (allAssetsReady && currentStatus === 'BLOCKED') {
        const transitioned = await transition(post.id, 'FILE_RESOLVED', {
          actorId: 'ingest-bot',
          comment: 'All required Drive assets matched and ready',
        });
        currentStatus = transitioned.status as PostStatusType;
      }

      results.push({
        postId: post.id,
        drivePath: item.drivePath,
        status: currentStatus,
        blockedReason: currentStatus === 'BLOCKED' ? post.blockedReason : null,
        unchanged: false,
        uploadsNeeded,
        reusedAssetsCount,
      });
    }

    // Rule 10: Date folders in Drive with no matching calendar row in the window
    const orphanFolders = (params.allDateFoldersInDrive || []).filter(
      (folderPath) => !activeDrivePaths.has(folderPath)
    );

    return { results, orphanFolders };
  }

  /**
   * Step 8 of Flow 1: Completes a MediaAsset upload, probes media dimensions/duration or extracts .docx text,
   * validates against platform rules, and transitions linked posts to PENDING_REVIEW when all assets are READY.
   */
  public async completeMediaUpload(
    mediaId: string,
    payload: {
      base64Data?: string;
      buffer?: Buffer;
      width?: number;
      height?: number;
      durationSec?: number;
      sizeBytes?: number;
      skipStoragePut?: boolean;
    } = {}
  ) {
    const asset = await automationPrisma.mediaAsset.findUnique({
      where: { id: mediaId },
      include: {
        postMedia: {
          include: {
            post: {
              include: { contentItem: true },
            },
          },
        },
      },
    });

    if (!asset) {
      throw new Error(`MediaAsset ${mediaId} not found`);
    }

    const objectKey = asset.objectKey || buildStorageObjectKey(asset.id, asset.fileName);
    let fileBuffer: Buffer | null = null;

    if (payload.buffer) {
      fileBuffer = payload.buffer;
      if (!payload.skipStoragePut) {
        try {
          await this.storage.put({
            bucket: asset.bucket,
            objectKey,
            data: fileBuffer,
            contentType: asset.mimeType,
          });
        } catch (err: any) {
          console.warn(
            `[MediaComplete] postId=multi assetId=${asset.id} storage.put notice: ${err?.message}`
          );
        }
      }
    } else if (payload.base64Data) {
      fileBuffer = Buffer.from(payload.base64Data, 'base64');
      if (!payload.skipStoragePut) {
        try {
          await this.storage.put({
            bucket: asset.bucket,
            objectKey,
            data: fileBuffer,
            contentType: asset.mimeType,
          });
        } catch (err: any) {
          console.warn(
            `[MediaComplete] postId=multi assetId=${asset.id} storage.put notice: ${err?.message}`
          );
        }
      }
    } else {
      try {
        fileBuffer = await this.storage.get(objectKey, asset.bucket);
      } catch {
        fileBuffer = null;
      }
    }

    const lowerName = asset.fileName.toLowerCase();
    const isDocx =
      asset.mimeType ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      asset.mimeType === 'application/vnd.google-apps.document' ||
      lowerName.endsWith('.docx');

    let extractedCaption: string | null = null;
    let width = payload.width ?? asset.width ?? undefined;
    let height = payload.height ?? asset.height ?? undefined;
    let durationSec = payload.durationSec ?? asset.durationSec ?? undefined;
    const sizeBytes = payload.sizeBytes ?? Number(asset.sizeBytes || fileBuffer?.length || 0);

    if (isDocx) {
      if (fileBuffer && fileBuffer.length > 0) {
        try {
          extractedCaption = extractDocxText(fileBuffer);
        } catch (err: any) {
          const invalidReason = `Invalid .docx caption file "${asset.fileName}": ${err?.message}`;
          const updatedAsset = await automationPrisma.mediaAsset.update({
            where: { id: asset.id },
            data: { status: 'INVALID', invalidReason, objectKey },
          });
          for (const pm of asset.postMedia) {
            await transition(pm.postId, 'INGEST_BLOCKED', {
              actorId: 'media-validator',
              blockedReason: invalidReason,
            });
          }
          return { asset: updatedAsset, extractedCaption: null, transitionedPosts: [] };
        }
      }
    } else {
      if (fileBuffer && fileBuffer.length > 0) {
        const probed = probeMediaBuffer(fileBuffer, asset.mimeType, asset.fileName);
        width = width ?? probed.width;
        height = height ?? probed.height;
        durationSec = durationSec ?? probed.durationSec;
      }

      // Validate media against every linked post's platform (Edge Case #14)
      for (const pm of asset.postMedia) {
        if (pm.role === 'MAIN') {
          const check = validateMediaForPlatform({
            platform: pm.post.platform,
            mimeType: asset.mimeType,
            fileName: asset.fileName,
            sizeBytes,
            width,
            height,
            durationSec,
          });
          if (!check.valid) {
            const invalidReason = check.invalidReason || 'Media failed platform validation';
            const updatedAsset = await automationPrisma.mediaAsset.update({
              where: { id: asset.id },
              data: {
                status: 'INVALID',
                invalidReason,
                objectKey,
                width: width ?? null,
                height: height ?? null,
                durationSec: durationSec ?? null,
              },
            });
            await transition(pm.postId, 'INGEST_BLOCKED', {
              actorId: 'media-validator',
              blockedReason: invalidReason,
            });
            return { asset: updatedAsset, extractedCaption: null, transitionedPosts: [] };
          }
        }
      }
    }

    const updatedAsset = await automationPrisma.mediaAsset.update({
      where: { id: asset.id },
      data: {
        status: 'READY',
        invalidReason: null,
        objectKey,
        sizeBytes: BigInt(sizeBytes),
        width: width ?? null,
        height: height ?? null,
        durationSec: durationSec ?? null,
      },
    });

    const transitionedPosts: string[] = [];

    for (const pm of asset.postMedia) {
      const post = pm.post;

      if (extractedCaption !== null && pm.role === 'CAPTION_SOURCE') {
        await automationPrisma.post.update({
          where: { id: post.id },
          data: {
            caption: extractedCaption,
            captionSource: 'DRIVE_FILE',
          },
        });
      }

      // Check if all PostMedia for this post's current revision are now READY
      const allPostMedia = await automationPrisma.postMedia.findMany({
        where: { postId: post.id, revision: post.revision },
        include: { asset: true },
      });

      const allReady =
        allPostMedia.length > 0 &&
        allPostMedia.every((m) => m.asset.status === 'READY');

      if (allReady) {
        const freshPost = await automationPrisma.post.findUnique({
          where: { id: post.id },
        });
        if (freshPost && freshPost.status === 'BLOCKED') {
          await transition(post.id, 'FILE_RESOLVED', {
            actorId: 'ingest-bot',
            comment: 'All media and caption assets uploaded and validated',
          });
          transitionedPosts.push(post.id);

          // Save initial PostRevision snapshot
          const existingRev = await automationPrisma.postRevision.findFirst({
            where: { postId: post.id, revision: freshPost.revision },
          });
          if (!existingRev) {
            await automationPrisma.postRevision.create({
              data: {
                postId: post.id,
                revision: freshPost.revision,
                title: freshPost.title,
                caption: extractedCaption ?? freshPost.caption,
                mediaSnapshot: allPostMedia.map((m) => ({
                  assetId: m.assetId,
                  role: m.role,
                  position: m.position,
                  fileName: m.asset.fileName,
                  objectKey: m.asset.objectKey,
                })),
                createdById: 'ingest-bot',
              },
            });
          }
        }
      }
    }

    return {
      asset: {
        ...updatedAsset,
        sizeBytes: Number(updatedAsset.sizeBytes),
      },
      extractedCaption,
      transitionedPosts,
    };
  }

  /**
   * Autonomous Flow 1 Dump:
   * 1. Fetches Content Calendar from Google Drive via service_account.json
   * 2. Upserts ContentItems & Posts in the window
   * 3. Scans 07_Social_media date folders for ready assets (.mp4, .mov, .jpg, .png, Caption.docx)
   * 4. Downloads matched files and saves to Storage, probing metadata & extracting docx captions
   * 5. Automatically transitions posts with complete assets to PENDING_REVIEW
   * 6. Queues and dispatches approval request email to configured approvers
   */
  public async dumpFromDrive(options?: {
    sheetId?: string;
    referenceDate?: string | Date;
    daysAhead?: number;
    windowStartYmd?: string;
    windowEndYmd?: string;
    timeZone?: string;
    sendNotification?: boolean;
    async?: boolean;
    jobRunId?: string;
    concurrency?: number;
  }): Promise<{
    windowStartYmd: string;
    windowEndYmd: string;
    totalCalendarRows: number;
    postsCreated: number;
    postsUpdated: number;
    postsNeedingFolders: number;
    downloadedAssetsCount: number;
    transitionedToReview: string[];
    notificationsQueued: number;
    status?: string;
  }> {
    console.log('[DumpFromDrive] Starting autonomous content dump from Google Drive...');
    const ctx = getGoogleDriveClient();
    if (!ctx) {
      throw new Error('Google service account credentials not found in candidate paths');
    }

    const sheetId = options?.sheetId || process.env.CALENDAR_FILE_ID || '1eb9XK1hvhX-ABd4nHjpmMBdtTH6cmMgL';
    console.log(`[DumpFromDrive] Fetching calendar sheet ${sheetId}...`);
    const calBuf = await fetchCalendarSpreadsheetBuffer(ctx.drive, sheetId);
    const sheets = parseXlsxBuffer(calBuf);
    const calendarRows = parseAllCalendarSections(sheets, {
      fromDate: options?.windowStartYmd,
      toDate: options?.windowEndYmd,
    });
    console.log(`[DumpFromDrive] Extracted ${calendarRows.length} calendar rows across all sheet sections.`);

    const rawRows: RawCalendarRowInput[] = calendarRows.map((cr) => ({
      rowNumber: cr.rowNumber || 1,
      tab: cr.tab,
      date: cr.dateYmd,
      time: cr.timeHhMm || '09:00',
      channel: cr.channelRaw,
      type: cr.contentType || null,
      subject: cr.subject || null,
      cells: [cr.dateYmd, cr.timeHhMm || '09:00', cr.channelRaw, cr.contentType || null, cr.subject || null],
    }));

    const ingestResult = await this.ingestRows({
      sheetId,
      rows: rawRows,
      referenceDate: options?.referenceDate,
      dumpDaysBefore: options?.daysAhead ?? 14,
      windowStartYmd: options?.windowStartYmd,
      windowEndYmd: options?.windowEndYmd,
      timeZone: options?.timeZone,
    });

    console.log(
      `[DumpFromDrive] Ingest completed: created=${ingestResult.postsCreated}, updated=${ingestResult.postsUpdated}, needingFolders=${ingestResult.postsNeedingFolders.length}`
    );

    console.log('[DumpFromDrive] Scanning Google Drive folders for ready assets...');
    const folderListings = await scanSocialMediaDriveFolders(ctx.drive, undefined, {
      fromDate: ingestResult.windowStartYmd,
      toDate: ingestResult.windowEndYmd,
    });
    const listingsMap = new Map<string, DriveFolderListing>();
    for (const fl of folderListings) {
      const clean = (fl.drivePath || '').replace(/^\/+|\/+$/g, '');
      listingsMap.set(clean, fl);
    }

    const folderListingInputs: FolderListingItemInput[] = ingestResult.postsNeedingFolders.map((p) => {
      const clean = p.drivePath.replace(/^\/+|\/+$/g, '');
      const shortClean = clean.replace(/^07_Social_media\//, '');
      const found = listingsMap.get(clean) || listingsMap.get(shortClean);
      return {
        postId: p.postId,
        drivePath: p.drivePath,
        folderFound: Boolean(found && found.folderFound !== false),
        files: found?.files || [],
        subfolders: found?.subfolders || [],
      };
    });

    const folderProcResult = await this.processFolderListings({
      listings: folderListingInputs,
    });

    const allUploads: Array<{
      mediaAssetId: string;
      driveFileId: string;
      fileName: string;
      mimeType: string;
    }> = [];
    for (const res of folderProcResult.results) {
      for (const upl of res.uploadsNeeded) {
        allUploads.push(upl);
      }
    }

    const candidatePostIds = Array.from(
      new Set(ingestResult.postsNeedingFolders.map((p) => p.postId))
    );

    const runDownloads = async () => {
      let downloadedAssetsCount = 0;
      const allTransitioned = new Set<string>();
      const concurrency = options?.concurrency && options.concurrency > 0 ? options.concurrency : 4;

      console.log(
        `[DumpFromDrive] Processing ${allUploads.length} uploads with concurrency=${concurrency}...`
      );

      for (let i = 0; i < allUploads.length; i += concurrency) {
        const batch = allUploads.slice(i, i + concurrency);
        await Promise.all(
          batch.map(async (upl) => {
            try {
              console.log(`[DumpFromDrive] Downloading asset "${upl.fileName}" (${upl.driveFileId})...`);
              const fileBuf = await downloadDriveFileBuffer(ctx.drive, upl.driveFileId, upl.mimeType);
              const completed = await this.completeMediaUpload(upl.mediaAssetId, {
                buffer: fileBuf,
                sizeBytes: fileBuf.length,
              });
              downloadedAssetsCount++;
              for (const pid of completed.transitionedPosts) {
                allTransitioned.add(pid);
              }
            } catch (dlErr: any) {
              console.error(
                `[DumpFromDrive] Failed to download/complete asset "${upl.fileName}" (${upl.driveFileId}):`,
                dlErr?.message
              );
            }
          })
        );
      }

      // Identify all posts that are now in PENDING_REVIEW
      const checkPostIds = Array.from(
        new Set([...Array.from(allTransitioned), ...candidatePostIds])
      );

      const pendingPosts = await automationPrisma.post.findMany({
        where: {
          id: { in: checkPostIds },
          status: 'PENDING_REVIEW',
        },
      });

      let notificationsQueued = 0;
      if (options?.sendNotification !== false) {
        for (const p of pendingPosts) {
          try {
            const queued = await notificationService.queueReviewRequest({
              id: p.id,
              platform: p.platform,
              scheduledAt: p.scheduledAt,
              title: p.title,
              caption: p.caption,
              revision: p.revision,
            });
            if (queued.created) {
              notificationsQueued++;
              try {
                const allRecipients = Array.from(
                  new Set([...queued.notification.recipients, ...(queued.notification.cc || [])])
                );
                await sendSmtpEmail({
                  to: allRecipients,
                  subject: queued.notification.subject,
                  html: queued.notification.body.replace(/\n/g, '<br/>'),
                });
                await notificationService.markSent(queued.notification.id);
              } catch (smtpErr: any) {
                console.warn(`[DumpFromDrive] SMTP dispatch notice for post ${p.id}:`, smtpErr?.message);
              }
            }
          } catch (notifErr: any) {
            console.warn(`[DumpFromDrive] Failed to queue review request for post ${p.id}:`, notifErr?.message);
          }
        }
      }

      console.log(
        `[DumpFromDrive] Completed download/review cycle: downloaded=${downloadedAssetsCount} assets, transitioned=${allTransitioned.size} posts, notificationsQueued=${notificationsQueued}.`
      );

      if (options?.jobRunId) {
        try {
          await automationPrisma.jobRun.update({
            where: { id: options.jobRunId },
            data: {
              finishedAt: new Date(),
              status: 'SUCCESS',
              stats: {
                windowStartYmd: ingestResult.windowStartYmd,
                windowEndYmd: ingestResult.windowEndYmd,
                totalCalendarRows: calendarRows.length,
                postsCreated: ingestResult.postsCreated,
                postsUpdated: ingestResult.postsUpdated,
                downloadedAssetsCount,
                transitionedToReview: Array.from(allTransitioned),
                notificationsQueued,
              },
            },
          });
        } catch {
          // ignore jobRun update error
        }
      }

      return {
        downloadedAssetsCount,
        transitionedToReview: Array.from(allTransitioned),
        notificationsQueued,
      };
    };

    if (options?.async) {
      console.log('[DumpFromDrive] Async mode requested. Running download tasks in background.');
      setImmediate(() => {
        runDownloads().catch((err) => {
          console.error('[DumpFromDrive] Async background run error:', err?.message);
        });
      });

      return {
        windowStartYmd: ingestResult.windowStartYmd,
        windowEndYmd: ingestResult.windowEndYmd,
        totalCalendarRows: calendarRows.length,
        postsCreated: ingestResult.postsCreated,
        postsUpdated: ingestResult.postsUpdated,
        postsNeedingFolders: ingestResult.postsNeedingFolders.length,
        downloadedAssetsCount: 0,
        transitionedToReview: [],
        notificationsQueued: 0,
        status: 'PROCESSING_IN_BACKGROUND',
      };
    }

    const runResult = await runDownloads();

    return {
      windowStartYmd: ingestResult.windowStartYmd,
      windowEndYmd: ingestResult.windowEndYmd,
      totalCalendarRows: calendarRows.length,
      postsCreated: ingestResult.postsCreated,
      postsUpdated: ingestResult.postsUpdated,
      postsNeedingFolders: ingestResult.postsNeedingFolders.length,
      downloadedAssetsCount: runResult.downloadedAssetsCount,
      transitionedToReview: runResult.transitionedToReview,
      notificationsQueued: runResult.notificationsQueued,
      status: 'SUCCESS',
    };
  }
}

export const ingestService = new IngestService();