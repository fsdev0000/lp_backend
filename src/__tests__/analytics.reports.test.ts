import express from 'express';
import request from 'supertest';
import { analyticsRoutes } from '../modules/analytics/analytics.routes';
import { internalAutomationRouter } from '../modules/automation/internal.routes';
import { analyticsReportGeneratorService } from '../modules/analytics/services/analyticsReportGenerator.service';
import { notificationSettingsService } from '../modules/automation/notifications/settings.service';
import { generateCrmSessionToken } from '../utils/sessionToken';

jest.setTimeout(60000);

const INTERNAL_KEY = 'test-internal-key-reports-32bytes';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/internal', internalAutomationRouter);
  app.use('/api/v1/analytics', analyticsRoutes);
  return app;
}

describe('Section B: Automated Analytics & CRM Reports (Tasks 5 & 6)', () => {
  const app = createTestApp();
  let adminToken: string;

  beforeAll(() => {
    process.env.INTERNAL_API_KEY = INTERNAL_KEY;
    process.env.DRY_RUN_EMAIL_OVERRIDE = 'true';
    process.env.TEST_EMAIL_RECIPIENT = 'asif@leadersperformance.ae';
    process.env.EMAIL_APPROVER = 'asif@leadersperformance.ae';
    process.env.REPORT_CC_EMAILS = 'asif@leadersperformance.ae';

    adminToken = generateCrmSessionToken({
      id: 'admin_test_user_id',
      email: 'asif@leadersperformance.ae',
      name: 'Asif',
      role: 'admin',
    });
  });

  describe('Task 5: Data Aggregation & Document Generation', () => {
    it('should aggregate web analytics + Social CRM operational metrics', async () => {
      const data = await analyticsReportGeneratorService.collectReportData({
        range: '7d',
        domain: 'leadersperformance.ae',
        frequency: 'WEEKLY',
      });

      expect(data).toBeDefined();
      expect(data.domain).toBe('leadersperformance.ae');
      expect(data.kpis).toBeDefined();
      expect(typeof data.kpis.totalVisitors).toBe('number');
      expect(typeof data.kpis.inquiries).toBe('number');
      expect(typeof data.kpis.conversionRate).toBe('number');
      expect(data.socialCrm).toBeDefined();
      expect(typeof data.socialCrm.totalPosts).toBe('number');
      expect(typeof data.socialCrm.approvalRate).toBe('number');
      expect(Array.isArray(data.topPages)).toBe(true);
      expect(Array.isArray(data.trafficTrend)).toBe(true);
    });

    it('should compile an executive PDF report with gold branding', async () => {
      const data = await analyticsReportGeneratorService.collectReportData({
        range: '7d',
        domain: 'leadersperformance.ae',
      });
      const pdfBuffer = analyticsReportGeneratorService.generatePdfReport(data);

      expect(Buffer.isBuffer(pdfBuffer)).toBe(true);
      expect(pdfBuffer.length).toBeGreaterThan(1000);
      const pdfHeader = pdfBuffer.slice(0, 8).toString('utf-8');
      expect(pdfHeader).toContain('%PDF');
    });

    it('should generate an RFC 4180 CSV export with KPI and traffic data', async () => {
      const data = await analyticsReportGeneratorService.collectReportData({
        range: '7d',
        domain: 'leadersperformance.ae',
      });
      const csv = analyticsReportGeneratorService.generateCsvReport(data);

      expect(typeof csv).toBe('string');
      expect(csv).toContain('"Leaders Performance Analytics & Social CRM Report"');
      expect(csv).toContain('"KPI METRIC","VALUE","GROWTH / NOTE"');
      expect(csv).toContain('"Total Visitors"');
      expect(csv).toContain('"TOP VISITED PAGES"');
    });
  });

  describe('Task 6: On-Demand Report Export API Endpoints', () => {
    it('GET /api/v1/analytics/reports/export requires CRM authentication', async () => {
      const res = await request(app)
        .get('/api/v1/analytics/reports/export?domain=leadersperformance.ae&range=7d&format=pdf');

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Valid CRM session token is required');
    });

    it('GET /api/v1/analytics/reports/export?format=pdf streams valid PDF', async () => {
      const res = await request(app)
        .get('/api/v1/analytics/reports/export?domain=leadersperformance.ae&range=7d&format=pdf')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.headers['content-disposition']).toContain('.pdf');
      expect(res.body).toBeDefined();
    });

    it('GET /api/v1/analytics/reports/export?format=csv returns CSV file', async () => {
      const res = await request(app)
        .get('/api/v1/analytics/reports/export?domain=leadersperformance.ae&range=7d&format=csv')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.text).toContain('"Leaders Performance Analytics & Social CRM Report"');
    });

    it('GET /api/v1/analytics/reports/export?format=json returns structured JSON', async () => {
      const res = await request(app)
        .get('/api/v1/analytics/reports/export?domain=leadersperformance.ae&range=7d&format=json')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.kpis).toBeDefined();
      expect(res.body.data.socialCrm).toBeDefined();
    });

    it('GET /api/v1/analytics/reports/export?format=xlsx returns 400 UNSUPPORTED_FORMAT', async () => {
      const res = await request(app)
        .get('/api/v1/analytics/reports/export?domain=leadersperformance.ae&range=7d&format=xlsx')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('UNSUPPORTED_FORMAT');
    });

    it('POST /internal/reports/analytics triggers automated dispatch (safe during testing)', async () => {
      const res = await request(app)
        .post('/internal/reports/analytics')
        .set('X-Internal-Key', INTERNAL_KEY)
        .send({ frequency: 'WEEKLY', domain: 'leadersperformance.ae' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // In testing mode, ensure neither Lionel nor Danielle received emails
      const recipients = res.body.data.recipients || [];
      expect(recipients).toContain('asif@leadersperformance.ae');
      expect(recipients).not.toContain('lionel@leadersperformance.ae');
      expect(recipients).not.toContain('danielle@eersteling.nl');
    });
  });
});

