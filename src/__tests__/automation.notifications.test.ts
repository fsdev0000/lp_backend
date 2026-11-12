import express from 'express';
import request from 'supertest';
import { automationPrisma } from '../modules/automation/state/transition';
import { internalAutomationRouter } from '../modules/automation/internal.routes';
import { crmAutomationRouter } from '../modules/automation/crm.routes';
import { notificationSettingsService } from '../modules/automation/notifications/settings.service';
import { reminderService } from '../modules/automation/notifications/reminder.service';
import { notificationService, getRecipientLists } from '../modules/automation/notifications/notification.service';
import { generateCrmSessionToken } from '../utils/sessionToken';

jest.setTimeout(60000);

const INTERNAL_KEY = 'test-internal-key-notifications-32bytes';

function createTestApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/internal', internalAutomationRouter);
  app.use('/api/v1/social-crm', crmAutomationRouter);
  return app;
}

describe('Social CRM Notifications & Reminders (Tasks 1, 2, 3, 4)', () => {
  const app = createTestApp();
  const testRunSuffix = `notif_${Date.now()}`;

  let adminToken: string;
  let testPostId: string;

  beforeAll(async () => {
    process.env.INTERNAL_API_KEY = INTERNAL_KEY;
    process.env.EMAIL_APPROVER = 'lionel@leadersperformance.ae';
    process.env.REPORT_CC_EMAILS = 'danielle@eersteling.nl';
    process.env.DRY_RUN_EMAIL_OVERRIDE = 'true';
    process.env.TEST_EMAIL_RECIPIENT = 'asif@leadersperformance.ae';

    adminToken = generateCrmSessionToken({
      id: 'admin-asif-id',
      email: 'asif@leadersperformance.ae',
      name: 'Asif',
      role: 'admin',
    });

    // Create a dummy content item and post for testing
    const contentItem = await automationPrisma.contentItem.create({
      data: {
        sheetId: 'sheet-notifications-test',
        sheetTab: 'Nov 2026',
        rowNumber: 301,
        rowKey: `rk_notif_${testRunSuffix}`,
        rowHash: `rh_notif_${testRunSuffix}`,
        scheduledAt: new Date(Date.now() + 48 * 3600 * 1000),
        channelRaw: 'YouTube',
        contentType: 'Video',
        subject: `Test Video ${testRunSuffix}`,
        rawRow: {},
        lastSeenAt: new Date(),
      },
    });

    const post = await automationPrisma.post.create({
      data: {
        contentItemId: contentItem.id,
        platform: 'YOUTUBE',
        mode: 'AUTO',
        status: 'PENDING_REVIEW',
        scheduledAt: new Date(Date.now() + 48 * 3600 * 1000),
        title: `Test Post ${testRunSuffix}`,
        caption: 'Test Caption for Approval',
        idempotencyKey: `post_notif_${testRunSuffix}`,
        revision: 1,
      },
    });
    testPostId = post.id;
  });

  afterAll(async () => {
    try {
      await (automationPrisma as any).notificationReminder.deleteMany({
        where: { relatedItemId: testPostId },
      });
      await automationPrisma.notification.deleteMany({
        where: {
          OR: [
            { postId: testPostId },
            { dedupeKey: { contains: testRunSuffix } },
          ],
        },
      });
      await automationPrisma.post.deleteMany({
        where: { id: testPostId },
      });
      await automationPrisma.contentItem.deleteMany({
        where: { title: { contains: testRunSuffix } },
      });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Task 1: Approver Email & Task 2: Report CC (Safety Disabled During Testing)', () => {
    it('should disable Lionel & Danielle during testing phase and safely route to Asif', async () => {
      const recipients = getRecipientLists();
      expect(recipients.approver).toContain('asif@leadersperformance.ae');
      expect(recipients.reportCc).toContain('asif@leadersperformance.ae');
      expect(recipients.approver).not.toContain('lionel@leadersperformance.ae');
      expect(recipients.reportCc).not.toContain('danielle@eersteling.nl');
    });

    it('should route daily digest and inventory alerts to Asif in testing without sending to Danielle', async () => {
      const digestRes = await notificationService.queueDailyDigest({
        dateKey: `test-${testRunSuffix}`,
        subject: `Daily Digest ${testRunSuffix}`,
        body: 'Digest Body Content',
      });

      expect(digestRes.notification).toBeDefined();
      expect(digestRes.notification?.cc).toContain('asif@leadersperformance.ae');
      expect(digestRes.notification?.cc).not.toContain('danielle@eersteling.nl');

      const invRes = await notificationService.queueInventoryLow({
        dedupeSuffix: `test-${testRunSuffix}`,
        subject: `Inventory Alert ${testRunSuffix}`,
        body: 'Inventory Low Content',
      });

      expect(invRes.notification).toBeDefined();
      expect(invRes.notification?.cc).toContain('asif@leadersperformance.ae');
      expect(invRes.notification?.cc).not.toContain('danielle@eersteling.nl');
    });
  });

  describe('Task 3: Follow-Up Reminders State Machine', () => {
    it('should schedule Reminder 1 upon review request', async () => {
      const queueRes = await notificationService.queueReviewRequest({
        id: testPostId,
        platform: 'YOUTUBE',
        scheduledAt: new Date(Date.now() + 48 * 3600 * 1000),
        title: `Test Post ${testRunSuffix}`,
        caption: 'Test Caption',
        revision: 1,
      });

      expect(queueRes.notification).toBeDefined();

      const reminders = await reminderService.getReminderStatusForPost(testPostId);
      expect(reminders.length).toBeGreaterThanOrEqual(1);
      const rem = reminders[0];
      expect(rem.reminderCount).toBe(0);
      expect(rem.resolvedAt).toBeNull();
      expect(rem.nextReminderAt).toBeDefined();
    });

    it('should process due reminders and escalate count', async () => {
      // Artificially wind back nextReminderAt into the past
      await (automationPrisma as any).notificationReminder.updateMany({
        where: { relatedItemId: testPostId },
        data: { nextReminderAt: new Date(Date.now() - 1000) },
      });

      const procRes = await reminderService.processPendingReminders();
      expect(procRes.checked).toBeGreaterThanOrEqual(1);
      expect(procRes.remindersSent).toBeGreaterThanOrEqual(1);

      const reminders = await reminderService.getReminderStatusForPost(testPostId);
      const active = reminders.find((r) => r.relatedItemId === testPostId);
      expect(active?.reminderCount).toBe(1);
    });

    it('should auto-resolve all reminders when action (Approval) is taken on post', async () => {
      const resolvedCount = await reminderService.resolveRemindersForPost(testPostId, 'APPROVED');
      expect(resolvedCount).toBeGreaterThanOrEqual(1);

      const reminders = await reminderService.getReminderStatusForPost(testPostId);
      for (const r of reminders) {
        expect(r.resolvedAt).not.toBeNull();
      }
    });
  });

  describe('Task 4: Notification Settings & Reminders API Endpoints', () => {
    it('GET /api/v1/social-crm/settings/notifications returns settings', async () => {
      const res = await request(app)
        .get('/api/v1/social-crm/settings/notifications')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.approverEmails).toContain('asif@leadersperformance.ae');
      expect(res.body.data.reportCcEmails).toContain('asif@leadersperformance.ae');
      expect(res.body.data.dryRunTestingMode).toBe(true);
    });

    it('PUT /api/v1/social-crm/settings/notifications updates configuration', async () => {
      const res = await request(app)
        .put('/api/v1/social-crm/settings/notifications')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          reminderIntervalHours: [24, 48],
          maxReminders: 2,
          dryRunTestingMode: true,
          testSafetyEmail: 'asif@leadersperformance.ae',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.maxReminders).toBe(2);
    });

    it('POST /internal/reminders/process runs via internal key', async () => {
      const res = await request(app)
        .post('/internal/reminders/process')
        .set('X-Internal-Key', INTERNAL_KEY);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('checked');
    });

    it('GET /api/v1/social-crm/posts/:id/reminders returns reminders list', async () => {
      const res = await request(app)
        .get(`/api/v1/social-crm/posts/${testPostId}/reminders`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  describe('Testing Safety Guard (lionel and danielle emails false in testing)', () => {
    it('ensures dryRunTestingMode prevents sending live emails to Lionel or Danielle', async () => {
      const settings = await notificationSettingsService.getSettings();
      expect(settings.dryRunTestingMode).toBe(true);

      // Verify the settings enforce dry run
      expect(process.env.DRY_RUN_EMAIL_OVERRIDE).toBe('true');
    });
  });
});
