import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { internalAutomationRouter } from '../modules/automation/internal.routes';
import {
  automationPrisma,
  computeTransition,
  transition,
  InvalidTransitionError,
  PostStateSnapshot,
  RETRY_BACKOFF_MS,
} from '../modules/automation/state/transition';
import {
  normalizeFileNameNfc,
  sanitizeFileNameForObjectKey,
  buildStorageObjectKey,
  assertNotFullUrl,
  IStorageService,
} from '../modules/automation/storage/storage.service';
import { encryptToken, decryptToken } from '../modules/automation/crypto/tokenCrypto';

const TEST_INTERNAL_KEY = 'test-internal-key-foundation-2026';
process.env.INTERNAL_API_KEY = TEST_INTERNAL_KEY;
process.env.TOKEN_ENCRYPTION_KEY =
  process.env.TOKEN_ENCRYPTION_KEY ||
  'a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f809';

const app = express();
app.use(express.json());
app.use('/internal', internalAutomationRouter);

describe('Step 1 Foundation: State Machine, StorageService, TokenCrypto & JobRuns', () => {
  jest.setTimeout(60000);

  let testAccountId = '';
  let testContentItemId = '';
  let testPostId = '';
  const createdJobRunIds: string[] = [];

  beforeAll(async () => {
    const now = new Date();
    const account = await automationPrisma.socialAccount.create({
      data: {
        platform: 'LINKEDIN',
        label: 'Jest Foundation Test LinkedIn',
        externalId: `urn:li:person:jest-foundation-${Date.now()}`,
        isActive: true,
      },
    });
    testAccountId = account.id;

    const contentItem = await automationPrisma.contentItem.create({
      data: {
        sheetId: '1eb9XK1hvhX-ABd4nHjpmMBdtTH6cmMgL',
        sheetTab: 'Master Content Calendar',
        rowNumber: 999991,
        rowKey: `jest-foundation-rowkey-${Date.now()}`,
        rowHash: `jest-foundation-hash-${Date.now()}`,
        scheduledAt: new Date(now.getTime() + 60 * 60 * 1000),
        channelRaw: 'LinkedIn',
        contentType: 'Quotes',
        subject: 'Discipline vs Motivation',
        fileLocation: '07_Social_media/01_Linkedin/01_Quotes/2026-11-20',
        rawRow: { date: '2026-11-20', time: '09:00', channel: 'LinkedIn' },
        category: 'Leadership',
        lastSeenAt: now,
      },
    });
    testContentItemId = contentItem.id;

    const post = await automationPrisma.post.create({
      data: {
        contentItemId: testContentItemId,
        accountId: testAccountId,
        platform: 'LINKEDIN',
        mode: 'AUTO',
        status: 'BLOCKED',
        blockedReason: 'DATE_FOLDER_MISSING',
        scheduledAt: new Date(now.getTime() + 60 * 60 * 1000),
        caption: 'Initial test caption',
        revision: 1,
        idempotencyKey: `${testContentItemId}|LINKEDIN|${testAccountId}`,
      },
    });
    testPostId = post.id;
  });

  afterAll(async () => {
    try {
      if (createdJobRunIds.length > 0) {
        await automationPrisma.jobRun.deleteMany({
          where: { id: { in: createdJobRunIds } },
        });
      }
      if (testPostId) {
        await automationPrisma.reviewEvent.deleteMany({ where: { postId: testPostId } });
        await automationPrisma.publishAttempt.deleteMany({ where: { postId: testPostId } });
        await automationPrisma.post.deleteMany({ where: { id: testPostId } });
      }
      if (testContentItemId) {
        await automationPrisma.contentItem.deleteMany({ where: { id: testContentItemId } });
      }
      if (testAccountId) {
        await automationPrisma.socialAccount.deleteMany({ where: { id: testAccountId } });
      }
    } catch {
      // Ignore cleanup errors
    }
    await automationPrisma.$disconnect();
  });

  describe('1. Pure State Machine Rules (Plan Section 5 – All 18 Rows)', () => {
    const scheduledTime = new Date('2026-11-20T08:00:00.000Z');
    const baseSnapshot: PostStateSnapshot = {
      id: '00000000-0000-4000-8000-000000000001',
      status: null,
      mode: 'AUTO',
      scheduledAt: scheduledTime,
      revision: 1,
      approvedById: null,
      approvedAt: null,
      attemptCount: 0,
      nextAttemptAt: null,
      lockedAt: null,
      lockedBy: null,
      platformPostId: null,
      platformUrl: null,
      processingRef: null,
      publishedAt: null,
      blockedReason: null,
      lastError: null,
    };

    it('Row 1-3: handles (new) -> PENDING_REVIEW, BLOCKED, and SKIPPED', () => {
      const valid = computeTransition(baseSnapshot, 'INGEST_VALID', {
        actorId: 'ingest-bot',
      });
      expect(valid.nextStatus).toBe('PENDING_REVIEW');
      expect(valid.reviewEvent?.action).toBe('SUBMITTED');

      expect(() => computeTransition(baseSnapshot, 'INGEST_BLOCKED', {})).toThrow(
        InvalidTransitionError
      );

      const blocked = computeTransition(baseSnapshot, 'INGEST_BLOCKED', {
        blockedReason: 'DATE_FOLDER_MISSING',
      });
      expect(blocked.nextStatus).toBe('BLOCKED');
      expect(blocked.postUpdates.blockedReason).toBe('DATE_FOLDER_MISSING');

      const skipped = computeTransition(baseSnapshot, 'INGEST_SKIPPED', {
        comment: 'No video posted',
      });
      expect(skipped.nextStatus).toBe('SKIPPED');
    });

    it('Row 4: handles BLOCKED -> PENDING_REVIEW when file is uploaded or resolved', () => {
      const resolved = computeTransition(
        { ...baseSnapshot, status: 'BLOCKED', blockedReason: 'DATE_FOLDER_MISSING' },
        'FILE_RESOLVED',
        { actorId: 'sarath@leadersperformance.ae' }
      );
      expect(resolved.nextStatus).toBe('PENDING_REVIEW');
      expect(resolved.postUpdates.blockedReason).toBeNull();
    });

    it('Row 5-7: handles PENDING_REVIEW -> APPROVED, CHANGES_REQUESTED (comment required), REJECTED (comment required)', () => {
      const pending: PostStateSnapshot = { ...baseSnapshot, status: 'PENDING_REVIEW' };

      const approved = computeTransition(pending, 'APPROVE', {
        actorId: 'lionel@leadersperformance.ae',
        comment: 'Good to go',
      });
      expect(approved.nextStatus).toBe('APPROVED');
      expect(approved.postUpdates.approvedById).toBe('lionel@leadersperformance.ae');
      expect(approved.postUpdates.approvedAt).toBeInstanceOf(Date);
      expect(approved.reviewEvent?.action).toBe('APPROVED');

      // Comment required for REQUEST_CHANGES and REJECT
      expect(() =>
        computeTransition(pending, 'REQUEST_CHANGES', {
          actorId: 'lionel@leadersperformance.ae',
          comment: '   ',
        })
      ).toThrow(InvalidTransitionError);

      expect(() =>
        computeTransition(pending, 'REJECT', {
          actorId: 'lionel@leadersperformance.ae',
        })
      ).toThrow(InvalidTransitionError);

      const changes = computeTransition(pending, 'REQUEST_CHANGES', {
        actorId: 'lionel@leadersperformance.ae',
        comment: 'Tighten the opening line',
      });
      expect(changes.nextStatus).toBe('CHANGES_REQUESTED');
      expect(changes.reviewEvent?.action).toBe('CHANGES_REQUESTED');

      const rejected = computeTransition(pending, 'REJECT', {
        actorId: 'lionel@leadersperformance.ae',
        comment: 'Do not publish this week',
      });
      expect(rejected.nextStatus).toBe('REJECTED');
      expect(rejected.reviewEvent?.action).toBe('REJECTED');
    });

    it('Row 8-9: handles CHANGES_REQUESTED -> PENDING_REVIEW (revision + 1) and APPROVED -> PENDING_REVIEW on edit', () => {
      const resubmitted = computeTransition(
        { ...baseSnapshot, status: 'CHANGES_REQUESTED', revision: 1 },
        'RESUBMIT',
        { actorId: 'asad@leadersperformance.ae', comment: 'Revised opening line' }
      );
      expect(resubmitted.nextStatus).toBe('PENDING_REVIEW');
      expect(resubmitted.postUpdates.revision).toBe(2);
      expect(resubmitted.reviewEvent?.action).toBe('RESUBMITTED');

      const editedAfterApproval = computeTransition(
        {
          ...baseSnapshot,
          status: 'APPROVED',
          revision: 2,
          approvedById: 'lionel@leadersperformance.ae',
          approvedAt: new Date(),
        },
        'EDIT_CONTENT',
        { actorId: 'sarath@leadersperformance.ae', comment: 'Fixed typo in caption' }
      );
      expect(editedAfterApproval.nextStatus).toBe('PENDING_REVIEW');
      expect(editedAfterApproval.postUpdates.revision).toBe(3);
      expect(editedAfterApproval.postUpdates.approvedById).toBeNull();
      expect(editedAfterApproval.postUpdates.approvedAt).toBeNull();
    });

    it('Row 10-12: handles LOCK_FOR_PUBLISH within grace window, MARK_MISSED past grace window, and RESCHEDULE', () => {
      const approved: PostStateSnapshot = { ...baseSnapshot, status: 'APPROVED' };

      // Too early (before scheduledAt)
      expect(() =>
        computeTransition(approved, 'LOCK_FOR_PUBLISH', {
          now: new Date(scheduledTime.getTime() - 60_000),
        })
      ).toThrow(InvalidTransitionError);

      // Too late (past scheduledAt + 120m grace)
      expect(() =>
        computeTransition(approved, 'LOCK_FOR_PUBLISH', {
          now: new Date(scheduledTime.getTime() + 121 * 60_000),
          graceMinutes: 120,
        })
      ).toThrow(InvalidTransitionError);

      // Within window
      const locked = computeTransition(approved, 'LOCK_FOR_PUBLISH', {
        now: new Date(scheduledTime.getTime() + 5 * 60_000),
        graceMinutes: 120,
        lockedBy: 'publisher-worker-1',
      });
      expect(locked.nextStatus).toBe('PUBLISHING');
      expect(locked.postUpdates.lockedBy).toBe('publisher-worker-1');
      expect(locked.publishAttempt?.attemptNo).toBe(1);

      // MARK_MISSED requires now > scheduledAt + grace
      expect(() =>
        computeTransition(approved, 'MARK_MISSED', {
          now: new Date(scheduledTime.getTime() + 30 * 60_000),
          graceMinutes: 120,
        })
      ).toThrow(InvalidTransitionError);

      const missed = computeTransition(
        { ...baseSnapshot, status: 'PENDING_REVIEW' },
        'MARK_MISSED',
        {
          now: new Date(scheduledTime.getTime() + 125 * 60_000),
          graceMinutes: 120,
        }
      );
      expect(missed.nextStatus).toBe('MISSED');

      // RESCHEDULE from MISSED: unchanged content -> APPROVED, changed content -> PENDING_REVIEW
      const newSlot = new Date('2026-11-22T09:00:00.000Z');
      const rescheduledSame = computeTransition(
        { ...baseSnapshot, status: 'MISSED', revision: 2 },
        'RESCHEDULE',
        { newScheduledAt: newSlot, contentChanged: false }
      );
      expect(rescheduledSame.nextStatus).toBe('APPROVED');
      expect(rescheduledSame.postUpdates.scheduledAt).toEqual(newSlot);

      const rescheduledEdited = computeTransition(
        { ...baseSnapshot, status: 'MISSED', revision: 2 },
        'RESCHEDULE',
        { newScheduledAt: newSlot, contentChanged: true }
      );
      expect(rescheduledEdited.nextStatus).toBe('PENDING_REVIEW');
      expect(rescheduledEdited.postUpdates.revision).toBe(3);
    });

    it('Row 13-16: handles PUBLISHING -> PROCESSING -> PUBLISHED, RETRYABLE_ERROR backoff (1m, 5m, 15m), FATAL_ERROR, and ADMIN_RETRY', () => {
      const publishing: PostStateSnapshot = {
        ...baseSnapshot,
        status: 'PUBLISHING',
        attemptCount: 0,
        lockedAt: scheduledTime,
      };

      const processing = computeTransition(publishing, 'ASYNC_ACCEPTED', {
        processingRef: 'ig-container-98765',
      });
      expect(processing.nextStatus).toBe('PROCESSING');
      expect(processing.postUpdates.processingRef).toBe('ig-container-98765');
      expect(processing.postUpdates.attemptCount).toBe(1);

      const published = computeTransition(
        { ...publishing, status: 'PROCESSING', attemptCount: 1 },
        'PUBLISH_SUCCESS',
        {
          platformPostId: '17987654321',
          platformUrl: 'https://www.instagram.com/p/ABC123/',
        }
      );
      expect(published.nextStatus).toBe('PUBLISHED');
      expect(published.postUpdates.platformUrl).toBe('https://www.instagram.com/p/ABC123/');

      // Attempt 1 retryable error -> back to APPROVED with 1m backoff
      const now1 = new Date('2026-11-20T08:01:00.000Z');
      const retry1 = computeTransition(publishing, 'RETRYABLE_ERROR', {
        now: now1,
        maxAttempts: 3,
        httpStatus: 503,
        errorMessage: 'Upstream 503',
      });
      expect(retry1.nextStatus).toBe('APPROVED');
      expect(retry1.postUpdates.attemptCount).toBe(1);
      expect(retry1.postUpdates.nextAttemptAt?.getTime()).toBe(
        now1.getTime() + RETRY_BACKOFF_MS[0]
      );

      // Attempt 3 retryable error (attempts exhausted) -> FAILED
      const retryExhausted = computeTransition(
        { ...publishing, attemptCount: 2 },
        'RETRYABLE_ERROR',
        { now: now1, maxAttempts: 3, errorMessage: 'Still 503 after 3 tries' }
      );
      expect(retryExhausted.nextStatus).toBe('FAILED');
      expect(retryExhausted.postUpdates.attemptCount).toBe(3);

      // Fatal error -> FAILED immediately on first attempt
      const fatal = computeTransition(publishing, 'FATAL_ERROR', {
        httpStatus: 400,
        errorCode: 'INVALID_MEDIA',
        errorMessage: 'Unsupported aspect ratio',
      });
      expect(fatal.nextStatus).toBe('FAILED');

      // Admin retry from FAILED -> APPROVED with attemptCount reset to 0
      const adminRetry = computeTransition(
        { ...publishing, status: 'FAILED', attemptCount: 3, lastError: 'Still 503' },
        'ADMIN_RETRY',
        { actorId: 'asif@leadersperformance.ae' }
      );
      expect(adminRetry.nextStatus).toBe('APPROVED');
      expect(adminRetry.postUpdates.attemptCount).toBe(0);
      expect(adminRetry.postUpdates.lastError).toBeNull();
    });

    it('Row 17-18: handles CALENDAR_ROW_DELETED -> CANCELLED and MARK_MANUAL_DONE -> MANUAL_DONE', () => {
      const cancelled = computeTransition(
        { ...baseSnapshot, status: 'PENDING_REVIEW' },
        'CALENDAR_ROW_DELETED',
        { actorId: 'ingest-bot' }
      );
      expect(cancelled.nextStatus).toBe('CANCELLED');

      // Final states cannot be cancelled
      expect(() =>
        computeTransition(
          { ...baseSnapshot, status: 'PUBLISHED' },
          'CALENDAR_ROW_DELETED'
        )
      ).toThrow(InvalidTransitionError);

      // MANUAL mode post can be marked MANUAL_DONE when URL is provided
      expect(() =>
        computeTransition(
          { ...baseSnapshot, status: 'APPROVED', mode: 'AUTO' },
          'MARK_MANUAL_DONE',
          { platformUrl: 'https://www.tiktok.com/@lionel/video/123' }
        )
      ).toThrow(InvalidTransitionError);

      const manualDone = computeTransition(
        { ...baseSnapshot, status: 'APPROVED', mode: 'MANUAL' },
        'MARK_MANUAL_DONE',
        {
          actorId: 'sarath@leadersperformance.ae',
          platformUrl: 'https://www.tiktok.com/@lionel/video/123',
        }
      );
      expect(manualDone.nextStatus).toBe('MANUAL_DONE');
      expect(manualDone.postUpdates.platformUrl).toBe(
        'https://www.tiktok.com/@lionel/video/123'
      );
    });
  });

  describe('2. DB-Backed transition() Persistence & Audit Trail', () => {
    it('transitions a real Post in PostgreSQL through BLOCKED -> PENDING_REVIEW -> CHANGES_REQUESTED -> PENDING_REVIEW -> APPROVED and records ReviewEvents', async () => {
      const p1 = await transition(testPostId, 'FILE_RESOLVED', {
        actorId: 'sarath@leadersperformance.ae',
        comment: 'Uploaded missing quote image',
      });
      expect(p1.status).toBe('PENDING_REVIEW');
      expect(p1.blockedReason).toBeNull();

      const p2 = await transition(testPostId, 'REQUEST_CHANGES', {
        actorId: 'lionel@leadersperformance.ae',
        comment: 'Make the quote attribution bolder in caption',
      });
      expect(p2.status).toBe('CHANGES_REQUESTED');

      const p3 = await transition(testPostId, 'RESUBMIT', {
        actorId: 'sarath@leadersperformance.ae',
        comment: 'Updated caption formatting',
      });
      expect(p3.status).toBe('PENDING_REVIEW');
      expect(p3.revision).toBe(2);

      const p4 = await transition(testPostId, 'APPROVE', {
        actorId: 'lionel@leadersperformance.ae',
        comment: 'Approved for publishing',
      });
      expect(p4.status).toBe('APPROVED');
      expect(p4.approvedById).toBe('lionel@leadersperformance.ae');
      expect(p4.approvedAt).toBeTruthy();

      const events = await automationPrisma.reviewEvent.findMany({
        where: { postId: testPostId },
        orderBy: { createdAt: 'asc' },
      });
      expect(events.map((e) => e.action)).toEqual([
        'SUBMITTED',
        'CHANGES_REQUESTED',
        'RESUBMITTED',
        'APPROVED',
      ]);
    });
  });

  describe('3. StorageService Rules & Object Key Layout', () => {
    it('normalizes filenames to NFC and builds media/{yyyy}/{mm}/{asset_uuid}/{sanitised_original_name}', () => {
      const nfdName = 'Caf\u0065\u0301 Post #1 – Final.mp4';
      const nfc = normalizeFileNameNfc(nfdName);
      expect(nfc).toBe('Café Post #1 – Final.mp4');

      const sanitized = sanitizeFileNameForObjectKey(nfdName);
      expect(sanitized).toBe('Caf_Post_1_-_Final.mp4');

      const key = buildStorageObjectKey(
        '123e4567-e89b-12d3-a456-426614174000',
        nfdName,
        new Date('2026-11-07T10:00:00Z')
      );
      expect(key).toBe(
        'media/2026/11/123e4567-e89b-12d3-a456-426614174000/Caf_Post_1_-_Final.mp4'
      );
    });

    it('rejects full URLs in objectKey', () => {
      expect(() =>
        assertNotFullUrl(
          'https://tpyudbsbzrhhngulxyxp.supabase.co/storage/v1/object/public/test.mp4'
        )
      ).toThrow();
      expect(() =>
        assertNotFullUrl('media/2026/11/uuid/video.mp4')
      ).not.toThrow();
    });

    it('satisfies IStorageService contract with an in-memory implementation', async () => {
      const store = new Map<string, Buffer>();
      const mockStorage: IStorageService = {
        provider: 'memory',
        defaultBucket: 'social-media',
        async put({ bucket = 'social-media', objectKey, data }) {
          assertNotFullUrl(objectKey);
          store.set(`${bucket}:${objectKey}`, Buffer.from(data));
          return { storageProvider: 'memory', bucket, objectKey };
        },
        async get(objectKey, bucket = 'social-media') {
          return store.get(`${bucket}:${objectKey}`) || Buffer.alloc(0);
        },
        async signedUrl(objectKey, expiresInSeconds = 3600, bucket = 'social-media') {
          return `https://storage.example.local/${bucket}/${objectKey}?exp=${expiresInSeconds}`;
        },
        async signedUploadUrl(objectKey, bucket = 'social-media') {
          return {
            signedUrl: `https://storage.example.local/upload/${bucket}/${objectKey}`,
            token: 'mock-upload-token',
            path: objectKey,
          };
        },
        async delete(objectKey, bucket = 'social-media') {
          store.delete(`${bucket}:${objectKey}`);
        },
      };

      const loc = await mockStorage.put({
        objectKey: 'media/2026/11/uuid/slide-1.png',
        data: Buffer.from('hello-social-crm'),
        contentType: 'image/png',
      });
      expect(loc.bucket).toBe('social-media');
      const fetched = await mockStorage.get('media/2026/11/uuid/slide-1.png');
      expect(fetched.toString('utf8')).toBe('hello-social-crm');
    });
  });

  describe('4. AES-256-GCM Token Encryption', () => {
    it('encrypts and decrypts OAuth tokens and detects tampering', () => {
      const secretToken = 'ya29.a0AfH6SMBx-secret-oauth-token-value';
      const encrypted = encryptToken(secretToken);
      expect(encrypted).not.toContain(secretToken);
      expect(decryptToken(encrypted)).toBe(secretToken);

      const parts = encrypted.split(':');
      parts[2] = parts[2].slice(0, -2) + (parts[2].endsWith('aa') ? 'bb' : 'aa');
      expect(() => decryptToken(parts.join(':'))).toThrow();
    });
  });

  describe('5. Internal Key Auth & JobRun Logging (/internal/job-runs/*)', () => {
    it('rejects requests without a valid X-Internal-Key', async () => {
      const noHeader = await request(app)
        .post('/internal/job-runs/start')
        .send({ workflow: 'flow1-content-dump' });
      expect(noHeader.status).toBe(401);
      expect(noHeader.body.code).toBe('UNAUTHORIZED');

      const badHeader = await request(app)
        .post('/internal/job-runs/start')
        .set('X-Internal-Key', 'wrong-key')
        .send({ workflow: 'flow1-content-dump' });
      expect(badHeader.status).toBe(401);
    });

    it('starts and finishes a JobRun when X-Internal-Key is valid', async () => {
      const startRes = await request(app)
        .post('/internal/job-runs/start')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({
          workflow: 'flow1-content-dump',
          stats: { windowDays: 14 },
        });

      expect(startRes.status).toBe(201);
      expect(startRes.body.success).toBe(true);
      const jobId = startRes.body.data.id;
      createdJobRunIds.push(jobId);

      const finishRes = await request(app)
        .post('/internal/job-runs/finish')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({
          id: jobId,
          stats: { staged: 3, blocked: 1 },
        });

      expect(finishRes.status).toBe(200);
      expect(finishRes.body.data.finishedAt).toBeTruthy();
      expect(finishRes.body.data.stats).toEqual({ staged: 3, blocked: 1 });
    });
  });
});
