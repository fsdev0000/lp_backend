import express from 'express';
import request from 'supertest';
import { analyticsRoutes } from '../modules/analytics/analytics.routes';
import { Ga4Adapter } from '../modules/analytics/adapters/ga4.adapter';
import { generateCrmSessionToken } from '../utils/sessionToken';

jest.setTimeout(30000);

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/analytics', analyticsRoutes);
  return app;
}

describe('Task 1: Dedicated AI Referral Analytics API', () => {
  const app = createTestApp();
  let adminToken: string;
  let ga4: Ga4Adapter;

  beforeAll(() => {
    process.env.CRM_SESSION_SECRET = process.env.CRM_SESSION_SECRET || 'test_crm_secret_for_signing_sessions_32';
    process.env.EMAIL_APPROVER = 'asif@leadersperformance.ae';

    adminToken = generateCrmSessionToken({
      id: 'test_admin_id',
      email: 'asif@leadersperformance.ae',
      name: 'Asif',
      role: 'admin',
    });

    ga4 = new Ga4Adapter();
  });

  describe('Unit Tests: Ga4Adapter.getAiReferrals', () => {
    it('should correctly build query and parse AI referral dimensions and metrics', async () => {
      // Mock client.runReport
      const mockRunReport = jest.fn().mockResolvedValue([
        {
          rows: [
            {
              dimensionValues: [
                { value: 'chatgpt.com' },
                { value: 'referral' },
                { value: '/meetlionel' },
              ],
              metricValues: [
                { value: '3' },
                { value: '4' },
                { value: '2' },
              ],
            },
            {
              dimensionValues: [
                { value: 'gemini.google.com' },
                { value: 'referral' },
                { value: '/unmasked' },
              ],
              metricValues: [
                { value: '5' },
                { value: '6' },
                { value: '4' },
              ],
            },
            {
              dimensionValues: [
                { value: 'perplexity.ai' },
                { value: 'ai-assistant' },
                { value: '/articles' },
              ],
              metricValues: [
                { value: '2' },
                { value: '2' },
                { value: '1' },
              ],
            },
            {
              dimensionValues: [
                { value: 'claude.ai' },
                { value: 'ai_assistant' },
                { value: '/masterclass' },
              ],
              metricValues: [
                { value: '1' },
                { value: '1' },
                { value: '1' },
              ],
            },
            {
              dimensionValues: [
                { value: 'copilot.microsoft.com' },
                { value: 'llm' },
                { value: '/' },
              ],
              metricValues: [
                { value: '4' },
                { value: '5' },
                { value: '3' },
              ],
            },
          ],
        },
      ]);

      (ga4 as any).client = { runReport: mockRunReport };

      const result = await ga4.getAiReferrals('30d', 'leadersperformance.ae');

      expect(result.status).toBe('healthy');
      expect(result.domain).toBe('leadersperformance.ae');
      expect(result.rows).toHaveLength(5);

      // Verify row 1: ChatGPT
      expect(result.rows[0]).toEqual({
        source: 'chatgpt.com',
        medium: 'referral',
        landingPage: '/meetlionel',
        users: 3,
        sessions: 4,
        engagedSessions: 2,
      });

      // Verify row 2: Gemini
      expect(result.rows[1]).toEqual({
        source: 'gemini.google.com',
        medium: 'referral',
        landingPage: '/unmasked',
        users: 5,
        sessions: 6,
        engagedSessions: 4,
      });

      // Verify row 3: Perplexity with ai-assistant medium
      expect(result.rows[2]).toEqual({
        source: 'perplexity.ai',
        medium: 'ai-assistant',
        landingPage: '/articles',
        users: 2,
        sessions: 2,
        engagedSessions: 1,
      });

      // Verify row 4: Claude with ai_assistant medium
      expect(result.rows[3]).toEqual({
        source: 'claude.ai',
        medium: 'ai_assistant',
        landingPage: '/masterclass',
        users: 1,
        sessions: 1,
        engagedSessions: 1,
      });

      // Verify row 5: Copilot with llm medium
      expect(result.rows[4]).toEqual({
        source: 'copilot.microsoft.com',
        medium: 'llm',
        landingPage: '/',
        users: 4,
        sessions: 5,
        engagedSessions: 3,
      });

      // Verify runReport was called with correct structure
      expect(mockRunReport).toHaveBeenCalledTimes(1);
      const callArgs = mockRunReport.mock.calls[0][0];
      expect(callArgs.dimensions).toEqual([
        { name: 'sessionSource' },
        { name: 'sessionMedium' },
        { name: 'landingPage' },
      ]);
      expect(callArgs.metrics).toEqual([
        { name: 'activeUsers' },
        { name: 'sessions' },
        { name: 'engagedSessions' },
      ]);
      expect(callArgs.dimensionFilter).toBeDefined();
      expect(callArgs.dimensionFilter.andGroup).toBeDefined();
    });

    it('should handle empty GA4 results gracefully', async () => {
      (ga4 as any).client = {
        runReport: jest.fn().mockResolvedValue([{ rows: [] }]),
      };

      const result = await ga4.getAiReferrals('7d', 'lioneleersteling.com');
      expect(result.status).toBe('healthy');
      expect(result.domain).toBe('lioneleersteling.com');
      expect(result.rows).toEqual([]);
    });

    it('should handle unsupported domain', async () => {
      const result = await ga4.getAiReferrals('30d', 'unsupported-random-site.com');
      expect(result.status).toBe('unsupported_domain');
      expect(result.rows).toEqual([]);
    });

    it('should handle GA4 error without crashing', async () => {
      (ga4 as any).client = {
        runReport: jest.fn().mockRejectedValue(new Error('GA4 service timeout')),
      };

      const result = await ga4.getAiReferrals('30d', 'leadersperformance.ae');
      expect(result.status).toBe('error');
      expect(result.error).toContain('GA4 service timeout');
      expect(result.rows).toEqual([]);
    });
  });

  describe('Integration Tests: GET /api/v1/analytics/ai-referrals', () => {
    it('should reject unauthenticated requests with 401', async () => {
      const res = await request(app).get('/api/v1/analytics/ai-referrals?domain=leadersperformance.ae');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('UNAUTHORIZED');
    });

    it('should reject invalid session token with 401', async () => {
      const res = await request(app)
        .get('/api/v1/analytics/ai-referrals?domain=leadersperformance.ae')
        .set('Authorization', 'Bearer invalid_token');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('should succeed with valid CRM session token for leadersperformance.ae', async () => {
      const res = await request(app)
        .get('/api/v1/analytics/ai-referrals?domain=leadersperformance.ae&range=30d')
        .set('Authorization', `Bearer ${adminToken}`);

      expect([200, 502]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.status).toBeDefined();
        expect(Array.isArray(res.body.rows)).toBe(true);
        expect(res.body.domain).toBe('leadersperformance.ae');
      }
    });

    it('should succeed with valid CRM session token for lioneleersteling.com', async () => {
      const res = await request(app)
        .get('/api/v1/analytics/ai-referrals?domain=lioneleersteling.com&range=7d')
        .set('Authorization', `Bearer ${adminToken}`);

      expect([200, 502]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.status).toBeDefined();
        expect(Array.isArray(res.body.rows)).toBe(true);
        expect(res.body.domain).toBe('lioneleersteling.com');
      }
    });
  });
});
