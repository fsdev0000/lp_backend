import express from 'express';
import request from 'supertest';
import { notificationsRouter } from '../api/routes/notifications.routes';
import { inboxService } from '../modules/automation/notifications/inbox.service';
import { generateCrmSessionToken } from '../utils/sessionToken';
import { automationPrisma } from '../modules/automation/state/transition';

jest.setTimeout(30000);

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/notifications', notificationsRouter);
  return app;
}

describe('CRM In-App Notification Feed & Service Suite', () => {
  const app = createTestApp();
  const testApiKey = 'test-api-key-secret-12345';
  let userAToken: string;
  let userBToken: string;

  beforeAll(() => {
    process.env.ADMIN_API_KEY = testApiKey;

    userAToken = generateCrmSessionToken({
      id: 'user_a_test_id',
      email: 'usera@leadersperformance.ae',
      name: 'User A',
      role: 'editor',
    });

    userBToken = generateCrmSessionToken({
      id: 'user_b_test_id',
      email: 'userb@leadersperformance.ae',
      name: 'User B',
      role: 'approver',
    });
  });

  afterAll(async () => {
    // Clean up test notifications created in this test run
    await automationPrisma.crmInboxNotification.deleteMany({
      where: {
        dedupeKey: { startsWith: 'TEST_SUITE:' },
      },
    });
  });

  describe('1. Authentication & Endpoint Access Control', () => {
    it('returns 401 when calling GET /api/v1/notifications without authentication', async () => {
      const res = await request(app).get('/api/v1/notifications');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('returns 403 when calling GET /api/v1/notifications with API key only', async () => {
      const res = await request(app)
        .get('/api/v1/notifications')
        .set('x-api-key', testApiKey);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('API key cannot access personal notification inboxes');
    });

    it('returns 200 with data array when calling with valid CRM session token', async () => {
      const res = await request(app)
        .get('/api/v1/notifications')
        .set('Authorization', `Bearer ${userAToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  describe('2. Feed Isolation & Deduplication', () => {
    it('notifies specific recipients and ensures each user sees only their own rows', async () => {
      const dedupeKeyA = `TEST_SUITE:ISOLATION_A:${Date.now()}`;
      const dedupeKeyB = `TEST_SUITE:ISOLATION_B:${Date.now()}`;

      // Create notification targeting only User A
      await inboxService.notify({
        category: 'LEAD',
        type: 'PRESSURE_SCAN_SUBMITTED',
        title: 'User A Exclusive Notice',
        message: 'This should only be visible to User A',
        dedupeKey: dedupeKeyA,
        recipients: ['usera@leadersperformance.ae'],
      });

      // Create notification targeting only User B
      await inboxService.notify({
        category: 'APPROVAL',
        type: 'REVIEW_REQUEST',
        title: 'User B Exclusive Notice',
        message: 'This should only be visible to User B',
        dedupeKey: dedupeKeyB,
        recipients: ['userb@leadersperformance.ae'],
      });

      // User A feed
      const resA = await request(app)
        .get('/api/v1/notifications')
        .set('Authorization', `Bearer ${userAToken}`);
      expect(resA.status).toBe(200);
      const itemsA = resA.body.data;
      const foundInA = itemsA.find((i: any) => i.title === 'User A Exclusive Notice');
      const shouldNotBeInA = itemsA.find((i: any) => i.title === 'User B Exclusive Notice');
      expect(foundInA).toBeDefined();
      expect(shouldNotBeInA).toBeUndefined();

      // User B feed
      const resB = await request(app)
        .get('/api/v1/notifications')
        .set('Authorization', `Bearer ${userBToken}`);
      expect(resB.status).toBe(200);
      const itemsB = resB.body.data;
      const foundInB = itemsB.find((i: any) => i.title === 'User B Exclusive Notice');
      const shouldNotBeInB = itemsB.find((i: any) => i.title === 'User A Exclusive Notice');
      expect(foundInB).toBeDefined();
      expect(shouldNotBeInB).toBeUndefined();
    });

    it('prevents duplicate notification rows on repeated events with identical dedupeKey', async () => {
      const repeatedDedupeKey = `TEST_SUITE:REPEAT:${Date.now()}`;

      const firstCall = await inboxService.notify({
        category: 'APPROVAL',
        type: 'REVIEW_REQUEST',
        title: 'Repeat Test',
        message: 'Attempt 1',
        dedupeKey: repeatedDedupeKey,
        recipients: ['usera@leadersperformance.ae'],
      });
      expect(firstCall.createdCount).toBe(1);

      const secondCall = await inboxService.notify({
        category: 'APPROVAL',
        type: 'REVIEW_REQUEST',
        title: 'Repeat Test',
        message: 'Attempt 2',
        dedupeKey: repeatedDedupeKey,
        recipients: ['usera@leadersperformance.ae'],
      });
      expect(secondCall.createdCount).toBe(0); // Deduplicated
    });
  });

  describe('3. Mark Read and Mark All Read Operations', () => {
    it('marks a single notification as read and returns 404 for another user item', async () => {
      const dedupeKey = `TEST_SUITE:READ_TEST:${Date.now()}`;
      await inboxService.notify({
        category: 'SYSTEM',
        type: 'TOKEN_EXPIRING',
        title: 'Single Read Test',
        message: 'To be marked read',
        dedupeKey,
        recipients: ['usera@leadersperformance.ae'],
      });

      const listRes = await request(app)
        .get('/api/v1/notifications')
        .set('Authorization', `Bearer ${userAToken}`);
      const targetItem = listRes.body.data.find((i: any) => i.title === 'Single Read Test');
      expect(targetItem).toBeDefined();
      expect(targetItem.read).toBe(false);

      // User B cannot mark User A item as read (returns 404)
      const userBAttempt = await request(app)
        .post(`/api/v1/notifications/${targetItem.id}/read`)
        .set('Authorization', `Bearer ${userBToken}`);
      expect(userBAttempt.status).toBe(404);

      // User A marks their own item as read
      const userAAttempt = await request(app)
        .post(`/api/v1/notifications/${targetItem.id}/read`)
        .set('Authorization', `Bearer ${userAToken}`);
      expect(userAAttempt.status).toBe(200);
      expect(userAAttempt.body.success).toBe(true);

      // Verify read state
      const verifyRes = await request(app)
        .get('/api/v1/notifications')
        .set('Authorization', `Bearer ${userAToken}`);
      const updated = verifyRes.body.data.find((i: any) => i.id === targetItem.id);
      expect(updated.read).toBe(true);
    });

    it('marks all caller notifications as read with POST /api/v1/notifications/read-all', async () => {
      const dedupeKey1 = `TEST_SUITE:READ_ALL_1:${Date.now()}`;
      const dedupeKey2 = `TEST_SUITE:READ_ALL_2:${Date.now()}`;

      await inboxService.notify({
        category: 'LEAD',
        type: 'CONTACT_FORM_SUBMITTED',
        title: 'Bulk Read 1',
        message: 'Message 1',
        dedupeKey: dedupeKey1,
        recipients: ['usera@leadersperformance.ae'],
      });

      await inboxService.notify({
        category: 'LEAD',
        type: 'CONTACT_FORM_SUBMITTED',
        title: 'Bulk Read 2',
        message: 'Message 2',
        dedupeKey: dedupeKey2,
        recipients: ['usera@leadersperformance.ae'],
      });

      const readAllRes = await request(app)
        .post('/api/v1/notifications/read-all')
        .set('Authorization', `Bearer ${userAToken}`);
      expect(readAllRes.status).toBe(200);
      expect(readAllRes.body.success).toBe(true);
      expect(readAllRes.body.data.count).toBeGreaterThanOrEqual(2);

      const verifyRes = await request(app)
        .get('/api/v1/notifications')
        .set('Authorization', `Bearer ${userAToken}`);
      const unreadCount = verifyRes.body.data.filter((i: any) => !i.read).length;
      expect(unreadCount).toBe(0);
    });
  });

  describe('4. Retention Housekeeping', () => {
    it('executes deleteOldNotifications without errors', async () => {
      const count = await inboxService.deleteOldNotifications(90);
      expect(typeof count).toBe('number');
    });
  });
});

