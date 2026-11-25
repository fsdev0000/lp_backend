import express from 'express';
import request from 'supertest';
import { automationPrisma } from '../modules/automation/state/transition';
import { internalAutomationRouter } from '../modules/automation/internal.routes';
import { crmAutomationRouter } from '../modules/automation/crm.routes';
import { generateCrmSessionToken } from '../utils/sessionToken';

jest.setTimeout(90000);

const INTERNAL_KEY = 'test-internal-key-hardening-32bytes';

function createTestApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/internal', internalAutomationRouter);
  app.use('/api/v1/social-crm', crmAutomationRouter);
  return app;
}

describe('Step 5: Hardening (Digest, Maintenance, Flow 3 Inventory Check, Error Alert, Accounts)', () => {
  const app = createTestApp();
  const testRunSuffix = `hardening_${Date.now()}`;

  let adminToken: string;
  let testAccountId: string;

  beforeAll(async () => {
    process.env.INTERNAL_API_KEY = INTERNAL_KEY;
    process.env.TOKEN_ENCRYPTION_KEY =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    process.env.EMAIL_APPROVER = 'lionel@leadersperformance.ae';
    process.env.EMAIL_EDITORS = 'sarath@leadersperformance.ae,asad@leadersperformance.ae';
    process.env.EMAIL_ADMIN = 'asif@leadersperformance.ae';
    process.env.EMAIL_INFO = 'info@leadersperformance.ae';

    adminToken = generateCrmSessionToken({
      id: 'admin-asif-id',
      email: 'asif@leadersperformance.ae',
      name: 'Asif',
      role: 'admin',
    });

    const account = await automationPrisma.socialAccount.create({
      data: {
        platform: 'YOUTUBE',
        externalId: `yt-hardening-${testRunSuffix}`,
        label: `YT Hardening ${testRunSuffix}`,
        isActive: true,
        tokenExpiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), // expires in 3 days (<7d)
      },
    });
    testAccountId = account.id;
  });

  afterAll(async () => {
    await automationPrisma.notification.deleteMany({
      where: {
        OR: [
          { dedupeKey: { contains: testRunSuffix } },
          { dedupeKey: { startsWith: 'DAILY_DIGEST:' } },
          { dedupeKey: { startsWith: 'INVENTORY_LOW:' } },
          { dedupeKey: { startsWith: 'JOB_FAILED:' } },
          { dedupeKey: { startsWith: 'TOKEN_EXPIRING:' } },
        ],
      },
    });
    await automationPrisma.mediaAsset.deleteMany({
      where: { driveFileId: { contains: testRunSuffix } },
    });
    await automationPrisma.post.deleteMany({
      where: { idempotencyKey: { contains: testRunSuffix } },
    });
    await automationPrisma.contentItem.deleteMany({
      where: { rowKey: { contains: testRunSuffix } },
    });
    await automationPrisma.channelAlias.deleteMany({
      where: { alias: { contains: testRunSuffix.toLowerCase() } },
    });
    await automationPrisma.socialAccount.deleteMany({
      where: { externalId: { contains: testRunSuffix } },
    });
    await automationPrisma.jobRun.deleteMany({
      where: { workflow: { contains: testRunSuffix } },
    });
  });

  test('1. Daily Digest (GET /internal/digest) flags BLOCKED < 7d as URGENT, includes PENDING_REVIEW < 48h & expiring accounts, and queues DAILY_DIGEST', async () => {
    const now = new Date();
    const in3Days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const ciUrgentBlocked = await automationPrisma.contentItem.create({
      data: {
        sheetId: 'sheet-hardening',
        sheetTab: 'Nov 2026',
        rowNumber: 101,
        rowKey: `rk_urgent_blocked_${testRunSuffix}`,
        rowHash: `rh_urgent_blocked_${testRunSuffix}`,
        scheduledAt: in3Days,
        channelRaw: 'YouTube',
        contentType: 'Video',
        subject: 'Urgent Blocked Post',
        rawRow: {},
        lastSeenAt: now,
      },
    });

    await automationPrisma.post.create({
      data: {
        contentItemId: ciUrgentBlocked.id,
        accountId: testAccountId,
        platform: 'YOUTUBE',
        mode: 'AUTO',
        scheduledAt: in3Days,
        status: 'BLOCKED',
        blockedReason: `Missing video file in date folder (${testRunSuffix})`,
        idempotencyKey: `idem_urgent_blocked_${testRunSuffix}`,
      },
    });

    const ciPending48h = await automationPrisma.contentItem.create({
      data: {
        sheetId: 'sheet-hardening',
        sheetTab: 'Nov 2026',
        rowNumber: 102,
        rowKey: `rk_pending_48h_${testRunSuffix}`,
        rowHash: `rh_pending_48h_${testRunSuffix}`,
        scheduledAt: in24Hours,
        channelRaw: 'YouTube',
        contentType: 'Shorts',
        subject: 'Pending Post Due Soon',
        rawRow: {},
        lastSeenAt: now,
      },
    });

    await automationPrisma.post.create({
      data: {
        contentItemId: ciPending48h.id,
        accountId: testAccountId,
        platform: 'YOUTUBE',
        mode: 'AUTO',
        scheduledAt: in24Hours,
        status: 'PENDING_REVIEW',
        title: 'Pending Post Due Soon',
        idempotencyKey: `idem_pending_48h_${testRunSuffix}`,
      },
    });

    const res = await request(app)
      .get('/internal/digest?queueEmail=true')
      .set('X-Internal-Key', INTERNAL_KEY);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const data = res.body.data;
    expect(data.urgentBlockedPosts.length).toBeGreaterThanOrEqual(1);
    expect(
      data.urgentBlockedPosts.some(
        (p: any) =>
          p.blockedReason === `Missing video file in date folder (${testRunSuffix})` &&
          p.isUrgent === true
      )
    ).toBe(true);

    expect(data.pendingWithin48h.length).toBeGreaterThanOrEqual(1);
    expect(
      data.expiringAccountsWithin7d.some((a: any) => a.accountId === testAccountId)
    ).toBe(true);
    expect(data.notificationId).toBeDefined();
  });

  test('2. Maintenance (POST /internal/maintenance/run) deletes expired MediaAssets, cancels unseenRuns >= 2 posts (Edge Case #7), and cleans old JobRuns', async () => {
    const now = new Date();
    const in10Days = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000);

    // 1) Create ContentItem with unseenRuns = 2 and a PENDING_REVIEW post -> should become CANCELLED
    const ciUnseen = await automationPrisma.contentItem.create({
      data: {
        sheetId: 'sheet-hardening',
        sheetTab: 'Nov 2026',
        rowNumber: 201,
        rowKey: `rk_unseen_${testRunSuffix}`,
        rowHash: `rh_unseen_${testRunSuffix}`,
        scheduledAt: in10Days,
        channelRaw: 'YouTube',
        contentType: 'Video',
        subject: 'Removed From Calendar Row',
        rawRow: {},
        lastSeenAt: now,
        unseenRuns: 2,
      },
    });

    const postToCancel = await automationPrisma.post.create({
      data: {
        contentItemId: ciUnseen.id,
        accountId: testAccountId,
        platform: 'YOUTUBE',
        mode: 'AUTO',
        scheduledAt: in10Days,
        status: 'PENDING_REVIEW',
        idempotencyKey: `idem_unseen_${testRunSuffix}`,
      },
    });

    // 2) Create expired MediaAsset
    const objectKey = `media/2026/11/test/expired_${testRunSuffix}.mp4`;
    const mediaAsset = await automationPrisma.mediaAsset.create({
      data: {
        driveFileId: `drive_expired_${testRunSuffix}`,
        checksumMd5: `md5_${testRunSuffix}`,
        fileName: 'expired.mp4',
        mimeType: 'video/mp4',
        sizeBytes: BigInt(19),
        bucket: 'social-media',
        objectKey,
        status: 'READY',
        deleteAfter: new Date(now.getTime() - 60 * 1000), // expired 1 minute ago
      },
    });

    // 3) Create old JobRun (> 90 days ago)
    const oldDate = new Date(now.getTime() - 95 * 24 * 60 * 60 * 1000);
    const oldJobRun = await automationPrisma.jobRun.create({
      data: {
        workflow: `old_workflow_${testRunSuffix}`,
        startedAt: oldDate,
        finishedAt: oldDate,
      },
    });

    const res = await request(app)
      .post('/internal/maintenance/run')
      .set('X-Internal-Key', INTERNAL_KEY)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify post was transitioned to CANCELLED
    const updatedPost = await automationPrisma.post.findUnique({
      where: { id: postToCancel.id },
    });
    expect(updatedPost?.status).toBe('CANCELLED');

    // Verify MediaAsset objectKey and deleteAfter were cleared
    const checkAsset = await automationPrisma.mediaAsset.findUnique({
      where: { id: mediaAsset.id },
    });
    expect(checkAsset?.objectKey).toBeNull();
    expect(checkAsset?.deleteAfter).toBeNull();

    // Verify old JobRun was deleted
    const checkOldJob = await automationPrisma.jobRun.findUnique({
      where: { id: oldJobRun.id },
    });
    expect(checkOldJob).toBeNull();
  });

  test('3. Flow 3 Inventory Check (POST /internal/inventory/check) detects missing content, marks < 14d streams URGENT, checks 04_Newsletter_Article, skips manual channels, and sends nothing when 100% ready', async () => {
    const baseNow = new Date('2026-11-01T08:30:00Z');

    // Case A: Missing content within 14 days -> URGENT stream + INVENTORY_LOW queued
    const resMissing = await request(app)
      .post('/internal/inventory/check')
      .set('X-Internal-Key', INTERNAL_KEY)
      .send({
        now: baseNow.toISOString(),
        isManualRun: true,
        rows: [
          // 1) Ready YouTube video on 2026-11-05 (4 days out)
          {
            dateYmd: '2026-11-05',
            channelRaw: 'YouTube',
            contentType: 'Video',
            subject: 'Ready YT Video',
          },
          // 2) Missing YouTube video on 2026-11-10 (9 days out -> < 14 days ready -> URGENT)
          {
            dateYmd: '2026-11-10',
            channelRaw: 'YouTube',
            contentType: 'Video',
            subject: 'Missing YT Video',
          },
          // 3) Newsletter article (04_Newsletter_Article) with missing .docx
          {
            dateYmd: '2026-11-12',
            channelRaw: 'LinkedIn Newsletter',
            contentType: 'Newsletter',
            subject: 'Leadership Newsletter',
          },
          // 4) Manual channel (Medium) -> must be ignored by Flow 3
          {
            dateYmd: '2026-11-08',
            channelRaw: 'Medium',
            contentType: 'Article',
            subject: 'Medium Blog Post',
          },
        ],
        folderListings: [
          {
            drivePath: '07_Social_media/03_Youtube/2026-11-05',
            folderFound: true,
            files: [
              { id: 'f1', name: 'episode1.mp4', mimeType: 'video/mp4' },
              {
                id: 'f2',
                name: 'caption.docx',
                mimeType:
                  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              },
            ],
          },
          {
            drivePath: '07_Social_media/03_Youtube/2026-11-10',
            folderFound: false,
            files: [],
          },
          {
            drivePath: '07_Social_media/01_Linkedin/04_Newsletter_Article/2026-11-12',
            folderFound: true,
            files: [
              { id: 'f3', name: 'cover.png', mimeType: 'image/png' },
              // missing .docx!
            ],
          },
        ],
      });

    expect(resMissing.status).toBe(200);
    expect(resMissing.body.success).toBe(true);

    const checkA = resMissing.body.data;
    // Medium row is ignored, so 3 planned posts (2 YouTube + 1 Newsletter), 1 ready, 2 missing
    expect(checkA.totalPlannedPosts).toBe(3);
    expect(checkA.totalReadyPosts).toBe(1);
    expect(checkA.missingContent.length).toBe(2);
    expect(checkA.emailQueued).toBe(true);

    const ytLongFormStream = checkA.coveragePerStream.find((s: any) =>
      s.streamPath.includes('03_Youtube')
    );
    expect(ytLongFormStream).toBeDefined();
    expect(ytLongFormStream.readyUntil).toBe('2026-11-05');
    expect(ytLongFormStream.isUrgent).toBe(true);

    // Case B: All planned rows are 100% ready -> emailQueued must be false
    const resReady = await request(app)
      .post('/internal/inventory/check')
      .set('X-Internal-Key', INTERNAL_KEY)
      .send({
        now: baseNow.toISOString(),
        isManualRun: true,
        rows: [
          {
            dateYmd: '2026-11-05',
            channelRaw: 'YouTube',
            contentType: 'Video',
            subject: 'Ready YT Video',
          },
        ],
        folderListings: [
          {
            drivePath: '07_Social_media/03_Youtube/2026-11-05',
            folderFound: true,
            files: [
              { id: 'f1', name: 'episode1.mp4', mimeType: 'video/mp4' },
              {
                id: 'f2',
                name: 'caption.docx',
                mimeType:
                  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              },
            ],
          },
        ],
      });

    expect(resReady.status).toBe(200);
    expect(resReady.body.data.missingContent.length).toBe(0);
    expect(resReady.body.data.emailQueued).toBe(false);
  });

  test('4. Error Alert (POST /internal/job-runs/error-alert) logs failed JobRun and queues JOB_FAILED to Asif', async () => {
    const res = await request(app)
      .post('/internal/job-runs/error-alert')
      .set('X-Internal-Key', INTERNAL_KEY)
      .send({
        workflowName: `Flow 1 Content Dump (${testRunSuffix})`,
        failedNode: 'Stage Post in lp_backend',
        errorMessage: 'Connection timeout to Google Drive',
        executionId: `exec_${testRunSuffix}`,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.jobRun.workflow).toContain(testRunSuffix);
    expect(res.body.data.jobRun.error).toContain('[Stage Post in lp_backend] Connection timeout');
    expect(res.body.data.notification.type).toBe('JOB_FAILED');
    expect(res.body.data.notification.recipients).toContain('asif@leadersperformance.ae');
  });

  test('5. Accounts & Settings API (/api/v1/social-crm/accounts) encrypts tokens at rest and creates ChannelAlias', async () => {
    const connectRes = await request(app)
      .post('/api/v1/social-crm/accounts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        platform: 'LINKEDIN',
        externalId: `urn:li:organization:${testRunSuffix}`,
        label: `Leaders Performance Page (${testRunSuffix})`,
        accessToken: 'plain-secret-access-token',
        refreshToken: 'plain-secret-refresh-token',
        tokenExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
      });

    expect(connectRes.status).toBe(200);
    expect(connectRes.body.success).toBe(true);
    const createdAccountId = connectRes.body.data.account.id;

    // Verify encrypted token in DB is not plaintext
    const dbAccount = await automationPrisma.socialAccount.findUnique({
      where: { id: createdAccountId },
    });
    expect(dbAccount?.tokenEncrypted).toBeDefined();
    expect(dbAccount?.tokenEncrypted).toMatch(/^v1:/);
    expect(dbAccount?.tokenEncrypted).not.toContain('plain-secret-access-token');

    // Also create a ChannelAlias
    const aliasRes = await request(app)
      .post('/api/v1/social-crm/accounts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        alias: `LI Company ${testRunSuffix}`,
        platform: 'LINKEDIN',
        mode: 'AUTO',
        accountId: createdAccountId,
      });

    expect(aliasRes.status).toBe(200);
    expect(aliasRes.body.data.channelAlias.alias).toBe(`li company ${testRunSuffix.toLowerCase()}`);

    // Verify GET /api/v1/social-crm/accounts lists accounts without exposing tokenEncrypted
    const listRes = await request(app)
      .get('/api/v1/social-crm/accounts')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(listRes.status).toBe(200);
    const listed = listRes.body.data.accounts.find((a: any) => a.id === createdAccountId);
    expect(listed).toBeDefined();
    expect(listed.tokenEncrypted).toBeUndefined();
  });
});
