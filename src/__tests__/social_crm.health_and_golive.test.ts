import express from 'express';
import request from 'supertest';
import { crmHealthService } from '../modules/automation/monitoring/crmHealth.service';
import { crmAutomationRouter } from '../modules/automation/crm.routes';
import { internalAutomationRouter } from '../modules/automation/internal.routes';
import { PublisherService } from '../modules/automation/publisher/publisher.service';
import { generateCrmSessionToken } from '../utils/sessionToken';
import { automationPrisma } from '../modules/automation/state/transition';

jest.setTimeout(60000);

const INTERNAL_KEY = 'test-internal-key-health-32bytes';

function createTestApp() {
  const app = express();
  app.use(express.json());

  const crmHealthHandler = async (_req: express.Request, res: express.Response) => {
    try {
      const report = await crmHealthService.getHealthStatus();
      const code = report.status === 'UNHEALTHY' ? 503 : 200;
      res.status(code).json(report);
    } catch (err: any) {
      res.status(500).json({ status: 'UNHEALTHY', error: err?.message });
    }
  };

  app.get('/crm/health', crmHealthHandler);
  app.get('/api/v1/crm/health', crmHealthHandler);
  app.use('/internal', internalAutomationRouter);
  app.use('/api/v1/social-crm', crmAutomationRouter);
  return app;
}

describe('Sections D & E: Infrastructure & Go-Live (Tasks 11, 12, 13, 14, 15)', () => {
  const app = createTestApp();
  const testSuffix = `hg_${Date.now()}`;
  let adminToken: string;
  let testPostId: string;

  beforeAll(async () => {
    process.env.INTERNAL_API_KEY = INTERNAL_KEY;
    process.env.DRY_RUN_EMAIL_OVERRIDE = 'true';
    process.env.TEST_EMAIL_RECIPIENT = 'asif@leadersperformance.ae';

    adminToken = generateCrmSessionToken({
      id: 'admin-health-test',
      email: 'asif@leadersperformance.ae',
      name: 'Asif Admin',
      role: 'admin',
    });

    // Create a dummy approved post to test publisher feature flags
    const ci = await automationPrisma.contentItem.create({
      data: {
        sheetId: 'sheet-health-test',
        sheetTab: 'Nov 2026',
        rowNumber: 401,
        rowKey: `rk_health_${testSuffix}`,
        rowHash: `rh_health_${testSuffix}`,
        scheduledAt: new Date(Date.now() - 5 * 60 * 1000), // Due 5 min ago
        channelRaw: 'YouTube',
        contentType: 'Video',
        subject: `Health Test Item ${testSuffix}`,
        rawRow: {},
        lastSeenAt: new Date(),
      },
    });

    const post = await automationPrisma.post.create({
      data: {
        contentItemId: ci.id,
        platform: 'YOUTUBE',
        mode: 'AUTO',
        status: 'APPROVED',
        scheduledAt: new Date(Date.now() - 5 * 60 * 1000),
        title: `Health Approved Post ${testSuffix}`,
        caption: 'Caption for Health Test',
        idempotencyKey: `post_health_${testSuffix}`,
        revision: 1,
      },
    });
    testPostId = post.id;
  });

  afterAll(async () => {
    try {
      await automationPrisma.postTransition.deleteMany({
        where: { postId: testPostId },
      });
      await automationPrisma.notification.deleteMany({
        where: { postId: testPostId },
      });
      await automationPrisma.post.deleteMany({
        where: { id: testPostId },
      });
      await automationPrisma.contentItem.deleteMany({
        where: { subject: { contains: testSuffix } },
      });
    } catch {
      // Ignore cleanup
    }
  });

  describe('Task 13: System Health Status Endpoint (GET /crm/health)', () => {
    it('should return complete health report including database, platforms, flows, and flags', async () => {
      const res = await request(app).get('/crm/health');

      expect([200, 503]).toContain(res.status);
      expect(res.body).toBeDefined();
      expect(res.body).toHaveProperty('status');
      expect(['HEALTHY', 'DEGRADED', 'UNHEALTHY']).toContain(res.body.status);
      expect(res.body.database).toBeDefined();
      expect(res.body.database.status).toBe('UP');
      expect(typeof res.body.database.latencyMs).toBe('number');

      // Verify platforms status structure
      expect(res.body.platforms).toBeDefined();
      expect(res.body.platforms.youtube).toBeDefined();
      expect(res.body.platforms.instagram).toBeDefined();
      expect(res.body.platforms.tiktok).toBeDefined();
      expect(res.body.platforms.linkedin).toBeDefined();

      // Verify n8n flows structure
      expect(res.body.n8nFlows).toBeDefined();
      expect(res.body.n8nFlows.flow1_content_dump).toBeDefined();
      expect(res.body.n8nFlows.flow2_publisher).toBeDefined();

      // Verify feature flags attached
      expect(res.body.publishingFlags).toBeDefined();
    });

    it('GET /api/v1/social-crm/health returns health status for authenticated CRM user', async () => {
      const res = await request(app)
        .get('/api/v1/social-crm/health')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBeDefined();
    });
  });

  describe('Task 12: 5-Minute Health Daemon Run', () => {
    it('should execute runHealthCheck() without throwing and check for platform/system anomalies', async () => {
      const checkRes = await crmHealthService.runHealthCheck();
      expect(checkRes).toBeDefined();
      expect(typeof checkRes.status).toBe('string');
      expect(typeof checkRes.alertsDispatched).toBe('number');
    });
  });

  describe('Task 14: Per-Platform Auto-Publish Feature Flags', () => {
    it('GET /api/v1/social-crm/settings/publishing-flags retrieves current flags', async () => {
      const res = await request(app)
        .get('/api/v1/social-crm/settings/publishing-flags')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('youtube');
      expect(res.body.data).toHaveProperty('instagram');
      expect(res.body.data).toHaveProperty('tiktok');
      expect(res.body.data).toHaveProperty('linkedin');
      expect(res.body.data).toHaveProperty('dryRunGlobal');
    });

    it('PUT /api/v1/social-crm/settings/publishing-flags updates toggles safely', async () => {
      const res = await request(app)
        .put('/api/v1/social-crm/settings/publishing-flags')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          youtube: true,
          instagram: true,
          tiktok: false,
          linkedin: false,
          dryRunGlobal: true,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.youtube).toBe(true);
      expect(res.body.data.tiktok).toBe(false);
      expect(res.body.data.linkedin).toBe(false);
      expect(res.body.data.dryRunGlobal).toBe(true);
    });

    it('should enforce dryRun mode in Publisher when dryRunGlobal is active', async () => {
      await automationPrisma.post.update({
        where: { id: testPostId },
        data: {
          status: 'APPROVED',
          platformPostId: null,
          publishedAt: null,
        },
      });

      const publisher = new PublisherService();
      const outcome = await publisher.publishSinglePost(testPostId);

      expect(outcome).toBeDefined();
      expect(outcome.status).toBe('PUBLISHED');
      // In dry run, post is safely staged to DB with synthetic platformPostId prefix
      expect(outcome.post.platformPostId).toMatch(/^staged_db_/);
      expect(outcome.post.publishedAt).toBeDefined();
    });
  });
});

