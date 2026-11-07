import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import zlib from 'zlib';
import { internalAutomationRouter } from '../modules/automation/internal.routes';
import { automationPrisma, transition } from '../modules/automation/state/transition';
import {
  parseCalendarDateToYmd,
  parseCalendarTimeToHhMm,
  localDateTimeToUtc,
  computeRowIdentity,
  parseAndFilterCalendarRows,
} from '../modules/automation/ingest/calendarParser';
import {
  resolveExpectedDrivePath,
  matchDriveFolderListing,
} from '../modules/automation/ingest/folderMatcher';
import { extractDocxText } from '../modules/automation/ingest/fileParsers';

const TEST_INTERNAL_KEY = 'test-internal-key-ingest-2026';
process.env.INTERNAL_API_KEY = TEST_INTERNAL_KEY;

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/internal', internalAutomationRouter);

/**
 * Helper to create a minimal valid .docx buffer (ZIP containing word/document.xml) for tests.
 */
function buildTestDocxBuffer(paragraphs: string[]): Buffer {
  const xmlBody = paragraphs
    .map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`)
    .join('');
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${xmlBody}</w:body></w:document>`;
  const fileName = Buffer.from('word/document.xml', 'utf8');
  const compressed = zlib.deflateRawSync(Buffer.from(xml, 'utf8'));

  // Local file header (30 bytes + fileName)
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(8, 8); // deflate
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(Buffer.byteLength(xml, 'utf8'), 22);
  localHeader.writeUInt16LE(fileName.length, 26);

  // Central directory header (46 bytes + fileName)
  const cdHeader = Buffer.alloc(46);
  cdHeader.writeUInt32LE(0x02014b50, 0);
  cdHeader.writeUInt16LE(20, 4);
  cdHeader.writeUInt16LE(20, 6);
  cdHeader.writeUInt16LE(8, 10);
  cdHeader.writeUInt32LE(compressed.length, 20);
  cdHeader.writeUInt32LE(Buffer.byteLength(xml, 'utf8'), 24);
  cdHeader.writeUInt16LE(fileName.length, 28);
  cdHeader.writeUInt32LE(0, 42); // localHeaderOffset = 0

  const cdOffset = localHeader.length + fileName.length + compressed.length;
  const cdSize = cdHeader.length + fileName.length;

  // End of Central Directory (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);

  return Buffer.concat([localHeader, fileName, compressed, cdHeader, fileName, eocd]);
}

describe('Step 2 Ingest (Flow 1): Calendar Parser, 11 Folder Rules & Idempotent Ingest API', () => {
  jest.setTimeout(180000);

  const testSheetId = `jest-ingest-sheet-${Date.now()}`;

  afterAll(async () => {
    try {
      const items = await automationPrisma.contentItem.findMany({
        where: { sheetId: testSheetId },
        select: { id: true },
      });
      const itemIds = items.map((i) => i.id);
      if (itemIds.length > 0) {
        await automationPrisma.contentItem.deleteMany({
          where: { id: { in: itemIds } },
        });
      }
      await automationPrisma.mediaAsset.deleteMany({
        where: { driveFileId: { startsWith: 'jest-drive-' } },
      });
    } catch {
      // Ignore cleanup errors
    }
    await automationPrisma.$disconnect();
  });

  describe('1. Calendar Date/Time Parsing, DST Timezone & 14-Day Window (Edge Cases #1–#5, #8, #9, #27)', () => {
    it('parses Excel serial dates, ISO dates, DD-MM-YYYY dates, and text dates', () => {
      // 46328 in Excel (1899-12-30 epoch) = 2026-11-02
      expect(parseCalendarDateToYmd(46328)).toBe('2026-11-02');
      expect(parseCalendarDateToYmd('2026-11-09')).toBe('2026-11-09');
      expect(parseCalendarDateToYmd('09-11-2026')).toBe('2026-11-09');
      expect(parseCalendarDateToYmd('11/11/2026')).toBe('2026-11-11');
      expect(parseCalendarDateToYmd('2 Nov 2026')).toBe('2026-11-02');
      expect(parseCalendarDateToYmd('Nov 16, 2026')).toBe('2026-11-16');
      expect(parseCalendarDateToYmd('Not a date')).toBeNull();
    });

    it('parses Excel time fractions and text times, and converts Europe/Amsterdam CET/CEST to UTC accurately (Edge Case #27)', () => {
      expect(parseCalendarTimeToHhMm(0.375)).toBe('09:00');
      expect(parseCalendarTimeToHhMm(0.625)).toBe('15:00');
      expect(parseCalendarTimeToHhMm('9:00')).toBe('09:00');
      expect(parseCalendarTimeToHhMm('14.30')).toBe('14:30');
      expect(parseCalendarTimeToHhMm('2:00 PM')).toBe('14:00');

      // Winter CET (UTC+1): 2026-11-02 09:00 Europe/Amsterdam = 08:00 UTC
      const winterUtc = localDateTimeToUtc('2026-11-02', '09:00', 'Europe/Amsterdam');
      expect(winterUtc.toISOString()).toBe('2026-11-02T08:00:00.000Z');

      // Summer CEST (UTC+2): 2026-07-15 09:00 Europe/Amsterdam = 07:00 UTC
      const summerUtc = localDateTimeToUtc('2026-07-15', '09:00', 'Europe/Amsterdam');
      expect(summerUtc.toISOString()).toBe('2026-07-15T07:00:00.000Z');
    });

    it('excludes tab name from rowKey so boundary-week rows in two month tabs share one identity (Edge Case #4)', () => {
      const idNov = computeRowIdentity({
        sheetId: 'sheet-1',
        dateYmd: '2026-11-30',
        timeHhMm: '09:00',
        channelRaw: 'LinkedIn',
        subject: 'Founder Bottleneck',
        allCells: ['2026-11-30', '09:00', 'LinkedIn', 'Quotes', 'Founder Bottleneck', '', ''],
      });
      const idDec = computeRowIdentity({
        sheetId: 'sheet-1',
        dateYmd: '2026-11-30',
        timeHhMm: '09:00',
        channelRaw: 'linkedin ',
        subject: 'Founder  Bottleneck',
        allCells: ['2026-11-30', '09:00', 'LinkedIn', 'Quotes', 'Founder Bottleneck', '', ''],
      });
      expect(idNov.rowKey).toBe(idDec.rowKey);
    });

    it('filters noise rows, enforces the 14-day window, defaults empty time, and detects SKIPPED rows', () => {
      const parsed = parseAndFilterCalendarRows({
        sheetId: testSheetId,
        defaultTab: 'Content calendar November 2026',
        referenceDate: new Date('2026-11-02T06:00:00Z'),
        dumpDaysBefore: 14, // window: 2026-11-02 .. 2026-11-16
        rows: [
          { rowNumber: 1, cells: ['Date', 'Time', 'Channel', 'Type', 'Subject', 'File', 'Status'] },
          { rowNumber: 2, cells: ['Week 45', null, null, null, null, null, null] },
          { rowNumber: 3, cells: ['2026-11-02', null, 'LinkedIn', 'Quotes', 'Founder Reality', '', ''] },
          { rowNumber: 4, cells: ['2026-11-03', '15:00', 'YouTube', 'Video', 'No video posted', '', ''] },
          { rowNumber: 5, cells: ['2026-11-25', '09:00', 'LinkedIn', 'Quotes', 'Future Post >14d', '', ''] },
          { rowNumber: 6, cells: ['bad-date-cell', '09:00', 'LinkedIn', 'Quotes', 'Broken Date', '', ''] },
        ],
      });

      expect(parsed.stagedRows.length).toBe(2);
      expect(parsed.outOfWindowCount).toBe(1);
      expect(parsed.skippedNoiseCount).toBe(3);
      expect(parsed.warnings.some((w) => w.includes('UNPARSEABLE_DATE'))).toBe(true);

      // Row 3 used default time 09:00 for LinkedIn
      expect(parsed.stagedRows[0].usedDefaultTime).toBe(true);
      expect(parsed.stagedRows[0].timeHhMm).toBe('09:00');

      // Row 4 is marked skipped
      expect(parsed.stagedRows[1].isSkipped).toBe(true);
    });
  });

  describe('2. Drive Folder Mapping & 11 Matching Rules (Plan Section 4 & Edge Cases #10–#15)', () => {
    it('maps all 8 canonical 07_Social_media folders accurately', () => {
      expect(
        resolveExpectedDrivePath({
          platform: 'LINKEDIN',
          contentType: 'Quotes',
          dateYmd: '2026-11-02',
        }).drivePath
      ).toBe('07_Social_media/01_Linkedin/01_Quotes/2026-11-02');

      expect(
        resolveExpectedDrivePath({
          platform: 'LINKEDIN',
          contentType: 'Poster',
          dateYmd: '2026-11-04',
        }).drivePath
      ).toBe('07_Social_media/01_Linkedin/02_Poster/2026-11-04');

      expect(
        resolveExpectedDrivePath({
          platform: 'LINKEDIN',
          contentType: 'Video',
          dateYmd: '2026-11-09',
        }).drivePath
      ).toBe('07_Social_media/01_Linkedin/03_Video/2026-11-09');

      expect(
        resolveExpectedDrivePath({
          platform: 'LINKEDIN_NEWSLETTER',
          contentType: 'Newsletter',
          dateYmd: '2026-11-03',
        }).drivePath
      ).toBe('07_Social_media/01_Linkedin/04_Newsletter_Article/2026-11-03');

      expect(
        resolveExpectedDrivePath({
          platform: 'INSTAGRAM',
          contentType: 'Reel',
          dateYmd: '2026-11-02',
        }).drivePath
      ).toBe('07_Social_media/02_Instagram/01_Video/2026-11-02');

      expect(
        resolveExpectedDrivePath({
          platform: 'INSTAGRAM',
          contentType: 'Carousel',
          dateYmd: '2026-11-04',
        }).drivePath
      ).toBe('07_Social_media/02_Instagram/02_Photo/2026-11-04');

      expect(
        resolveExpectedDrivePath({
          platform: 'YOUTUBE',
          contentType: 'Video',
          dateYmd: '2026-11-03',
        }).drivePath
      ).toBe('07_Social_media/03_Youtube/2026-11-03');

      expect(
        resolveExpectedDrivePath({
          platform: 'TIKTOK',
          contentType: 'Video',
          dateYmd: '2026-11-02',
        }).drivePath
      ).toBe('07_Social_media/04_Tiktok/2026-11-02');
    });

    it('disambiguates multiple media files by Column E subject or blocks with candidates (Rule 4 / Edge Case #11)', () => {
      const files = [
        { id: 'f1', name: 'Founder Reality.jpg', mimeType: 'image/jpeg' },
        { id: 'f2', name: 'The Busy Company.jpg', mimeType: 'image/jpeg' },
        { id: 'f3', name: 'Captions.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      ];

      // Subject matches "The Busy Company"
      const matched = matchDriveFolderListing({
        platform: 'LINKEDIN',
        contentType: 'Poster',
        subject: 'The Busy Company',
        drivePath: '07_Social_media/01_Linkedin/02_Poster/2026-11-04',
        folderFound: true,
        files,
      });
      expect(matched.matched).toBe(true);
      expect(matched.selectedAssets.find((a) => a.role === 'MAIN')?.fileName).toBe(
        'The Busy Company.jpg'
      );

      // Subject matches neither -> BLOCKED with candidates
      const ambiguous = matchDriveFolderListing({
        platform: 'LINKEDIN',
        contentType: 'Poster',
        subject: 'Unrelated Topic',
        drivePath: '07_Social_media/01_Linkedin/02_Poster/2026-11-04',
        folderFound: true,
        files,
      });
      expect(ambiguous.matched).toBe(false);
      expect(ambiguous.blockedReason).toContain('ambiguous');
      expect(ambiguous.candidates?.length).toBe(2);
    });

    it('orders carousel slides by filename and blocks when Instagram carousel exceeds 10 slides (Edge Case #15)', () => {
      const sixSlides = ['03.jpg', '01.jpg', '02.jpg'].map((name, i) => ({
        id: `slide-${i}`,
        name,
        mimeType: 'image/jpeg',
      }));

      const validCarousel = matchDriveFolderListing({
        platform: 'INSTAGRAM',
        contentType: 'Carousel',
        subject: 'Leadership Slides',
        drivePath: '07_Social_media/02_Instagram/02_Photo/2026-11-04',
        folderFound: true,
        files: [
          {
            id: 'cap-1',
            name: 'Captions.docx',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          },
        ],
        subfolders: [{ id: 'sf-1', name: '01_Carousels', files: sixSlides }],
      });
      expect(validCarousel.matched).toBe(true);
      expect(validCarousel.mediaType).toBe('CAROUSEL');
      expect(
        validCarousel.selectedAssets
          .filter((a) => a.role === 'MAIN')
          .map((a) => a.fileName)
      ).toEqual(['01.jpg', '02.jpg', '03.jpg']);

      // 11 slides on Instagram -> BLOCKED
      const elevenSlides = Array.from({ length: 11 }, (_, i) => ({
        id: `slide-${i}`,
        name: `${String(i + 1).padStart(2, '0')}.jpg`,
        mimeType: 'image/jpeg',
      }));
      const tooMany = matchDriveFolderListing({
        platform: 'INSTAGRAM',
        contentType: 'Carousel',
        subject: 'Too Many Slides',
        drivePath: '07_Social_media/02_Instagram/02_Photo/2026-11-04',
        folderFound: true,
        files: [],
        subfolders: [{ id: 'sf-1', name: '01_Carousels', files: elevenSlides }],
      });
      expect(tooMany.matched).toBe(false);
      expect(tooMany.blockedReason).toContain('carousel limit exceeded');
    });
  });

  describe('3. End-to-End Ingest API, MD5 Deduplication & Idempotency ("Done When" Check)', () => {
    it('stages a realistic copy of the calendar, matches Drive folders, extracts .docx captions, deduplicates MD5 across platforms, and changes nothing on a second run', async () => {
      // Warm up PgBouncer connection with retry in case initial handshake packet is dropped
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await automationPrisma.$queryRaw`SELECT 1`;
          break;
        } catch (err) {
          if (attempt === 3) throw err;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }

      const calendarPayload = {
        sheetId: testSheetId,
        tab: 'Content calendar November 2026',
        referenceDate: '2026-11-02T06:00:00.000Z',
        dumpDaysBefore: 14, // 2026-11-02 .. 2026-11-16
        rows: [
          // Noise row
          { rowNumber: 1, cells: ['Date', 'Time', 'Channel', 'Type', 'Subject', 'Location', 'Status'] },
          // Row 2: LinkedIn Quote on 2026-11-02 (uses Founder Reality.jpg, md5="md5-founder-reality")
          {
            rowNumber: 2,
            cells: ['2026-11-02', '09:00', 'LinkedIn', 'Quotes', 'Founder Reality', '', ''],
          },
          // Row 3: Instagram Photo on 2026-11-06 (reuses Founder Reality.jpg with same md5="md5-founder-reality"!)
          {
            rowNumber: 3,
            cells: ['2026-11-06', '12:00', 'Instagram', 'Photo', 'Founder Reality', '', ''],
          },
          // Row 4: Skipped row ("Geen post online gegaan")
          {
            rowNumber: 4,
            cells: ['2026-11-07', '18:00', 'TikTok', 'Video', 'Geen post online gegaan', '', ''],
          },
          // Row 5: Unknown channel ("Threads") -> BLOCKED "unknown channel"
          {
            rowNumber: 5,
            cells: ['2026-11-08', '10:00', 'Threads', 'Image', 'New Threads Post', '', ''],
          },
          // Row 6: Missing date folder on 2026-11-14 -> BLOCKED "folder missing"
          {
            rowNumber: 6,
            cells: ['2026-11-14', '09:00', 'LinkedIn', 'Quotes', 'Missing Folder Post', '', ''],
          },
        ],
      };

      // --- FIRST RUN: POST /internal/ingest/rows ---
      const run1Res = await request(app)
        .post('/internal/ingest/rows')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send(calendarPayload);

      expect(run1Res.status).toBe(200);
      expect(run1Res.body.success).toBe(true);
      const run1 = run1Res.body.data;
      expect(run1.stagedRowCount).toBe(5);
      expect(run1.postsCreated).toBe(5);
      expect(run1.postsSkipped).toBe(1);
      expect(run1.postsNeedingFolders.length).toBe(3);

      const liQuotePost = run1.postsNeedingFolders.find(
        (p: any) => p.platform === 'LINKEDIN' && p.dateYmd === '2026-11-02'
      );
      const igPhotoPost = run1.postsNeedingFolders.find(
        (p: any) => p.platform === 'INSTAGRAM' && p.dateYmd === '2026-11-06'
      );
      const liMissingFolderPost = run1.postsNeedingFolders.find(
        (p: any) => p.platform === 'LINKEDIN' && p.dateYmd === '2026-11-14'
      );

      expect(liQuotePost.drivePath).toBe('07_Social_media/01_Linkedin/01_Quotes/2026-11-02');
      expect(igPhotoPost.drivePath).toBe('07_Social_media/02_Instagram/02_Photo/2026-11-06');

      // --- STEP 7: POST /internal/ingest/folder-listing for LinkedIn Quote (2026-11-02) ---
      const sharedImageMd5 = `jest-md5-founder-reality-${Date.now()}`;
      const sharedDocxMd5 = `jest-md5-caption-docx-${Date.now()}`;

      const listing1Res = await request(app)
        .post('/internal/ingest/folder-listing')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({
          postId: liQuotePost.postId,
          drivePath: liQuotePost.drivePath,
          folderFound: true,
          files: [
            {
              id: `jest-drive-img-li-${Date.now()}`,
              name: 'Founder Reality.jpg',
              mimeType: 'image/jpeg',
              md5Checksum: sharedImageMd5,
              size: 1323356,
            },
            {
              id: `jest-drive-docx-li-${Date.now()}`,
              name: 'Captions.docx',
              mimeType:
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              md5Checksum: sharedDocxMd5,
              size: 7200,
            },
          ],
        });

      expect(listing1Res.status).toBe(200);
      expect(listing1Res.body.data.uploadsNeeded.length).toBe(2);

      // --- STEP 8: Complete media uploads for LinkedIn Quote ---
      const docxBuffer = buildTestDocxBuffer([
        'Most founders do not have a business problem.',
        'They have a leadership structure that has not evolved with the business.',
      ]);
      expect(extractDocxText(docxBuffer)).toContain(
        'Most founders do not have a business problem.'
      );

      for (const upload of listing1Res.body.data.uploadsNeeded) {
        const isDocx = upload.role === 'CAPTION_SOURCE';
        const completeRes = await request(app)
          .post(`/internal/media/${upload.mediaAssetId}/complete`)
          .set('X-Internal-Key', TEST_INTERNAL_KEY)
          .send({
            base64Data: isDocx
              ? docxBuffer.toString('base64')
              : Buffer.from('fake-jpeg-bytes').toString('base64'),
            width: isDocx ? undefined : 1080,
            height: isDocx ? undefined : 1350,
            sizeBytes: isDocx ? docxBuffer.length : 1323356,
            skipStoragePut: true,
          });
        expect(completeRes.status).toBe(200);
      }

      // Verify LinkedIn Quote post is now PENDING_REVIEW with extracted .docx caption!
      const liPostAfterMedia = await automationPrisma.post.findUnique({
        where: { id: liQuotePost.postId },
      });
      expect(liPostAfterMedia?.status).toBe('PENDING_REVIEW');
      expect(liPostAfterMedia?.captionSource).toBe('DRIVE_FILE');
      expect(liPostAfterMedia?.caption).toContain(
        'Most founders do not have a business problem.'
      );

      // --- STEP 7 for Instagram Photo (2026-11-06) using the SAME checksumMd5 (Rule 8 Deduplication!) ---
      const listing2Res = await request(app)
        .post('/internal/ingest/folder-listing')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({
          postId: igPhotoPost.postId,
          drivePath: igPhotoPost.drivePath,
          folderFound: true,
          files: [
            {
              id: `jest-drive-img-ig-${Date.now()}`,
              name: 'Founder Reality.jpg',
              mimeType: 'image/jpeg',
              md5Checksum: sharedImageMd5, // Same MD5 as LinkedIn!
              size: 1323356,
            },
            {
              id: `jest-drive-docx-ig-${Date.now()}`,
              name: 'Captions.docx',
              mimeType:
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              md5Checksum: sharedDocxMd5, // Same MD5 as LinkedIn!
              size: 7200,
            },
          ],
        });

      expect(listing2Res.status).toBe(200);
      // Because both files matched READY assets by checksumMd5, 0 uploads needed and status is immediately PENDING_REVIEW!
      expect(listing2Res.body.data.uploadsNeeded.length).toBe(0);
      expect(listing2Res.body.data.reusedAssetsCount).toBe(2);
      expect(listing2Res.body.data.status).toBe('PENDING_REVIEW');

      // --- STEP 7 for Missing Folder Post (2026-11-14) ---
      const listing3Res = await request(app)
        .post('/internal/ingest/folder-listing')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({
          postId: liMissingFolderPost.postId,
          drivePath: liMissingFolderPost.drivePath,
          folderFound: false,
          files: [],
        });
      expect(listing3Res.status).toBe(200);
      expect(listing3Res.body.data.status).toBe('BLOCKED');
      expect(listing3Res.body.data.blockedReason).toContain('folder missing');

      // --- SECOND RUN (IDEMPOTENCY CHECK: "and running it twice changes nothing") ---
      const run2Res = await request(app)
        .post('/internal/ingest/rows')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send(calendarPayload);

      expect(run2Res.status).toBe(200);
      expect(run2Res.body.data.postsCreated).toBe(0);
      expect(run2Res.body.data.postsUpdated).toBe(0);
      expect(run2Res.body.data.postsUnchanged).toBe(5);

      const listing1RepeatRes = await request(app)
        .post('/internal/ingest/folder-listing')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({
          postId: liQuotePost.postId,
          drivePath: liQuotePost.drivePath,
          folderFound: true,
          files: [
            {
              id: `jest-drive-img-li-repeat`,
              name: 'Founder Reality.jpg',
              mimeType: 'image/jpeg',
              md5Checksum: sharedImageMd5,
              size: 1323356,
            },
            {
              id: `jest-drive-docx-li-repeat`,
              name: 'Captions.docx',
              mimeType:
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              md5Checksum: sharedDocxMd5,
              size: 7200,
            },
          ],
        });
      expect(listing1RepeatRes.status).toBe(200);
      expect(listing1RepeatRes.body.data.unchanged).toBe(true);
      expect(listing1RepeatRes.body.data.uploadsNeeded.length).toBe(0);

      // --- EDGE CASE #6: Editing an APPROVED row in the calendar moves it back to PENDING_REVIEW ---
      await transition(liQuotePost.postId, 'APPROVE', {
        actorId: 'lionel@leadersperformance.ae',
        comment: 'Approved on first review',
      });
      const approvedCheck = await automationPrisma.post.findUnique({
        where: { id: liQuotePost.postId },
      });
      expect(approvedCheck?.status).toBe('APPROVED');

      // Now edit Column F (note/file location) on Row 2 so rowHash changes while rowKey stays identical
      const editedPayload = {
        ...calendarPayload,
        rows: calendarPayload.rows.map((r) =>
          r.rowNumber === 2
            ? {
                rowNumber: 2,
                cells: [
                  '2026-11-02',
                  '09:00',
                  'LinkedIn',
                  'Quotes',
                  'Founder Reality',
                  'Updated note in calendar',
                  '',
                ],
              }
            : r
        ),
      };

      const run3Res = await request(app)
        .post('/internal/ingest/rows')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send(editedPayload);
      expect(run3Res.status).toBe(200);
      expect(run3Res.body.data.postsUpdated).toBe(1);

      const postAfterCalendarEdit = await automationPrisma.post.findUnique({
        where: { id: liQuotePost.postId },
      });
      expect(postAfterCalendarEdit?.status).toBe('PENDING_REVIEW');
      expect(postAfterCalendarEdit?.revision).toBe(2);
      expect(postAfterCalendarEdit?.approvedById).toBeNull();
    });
  });
});

