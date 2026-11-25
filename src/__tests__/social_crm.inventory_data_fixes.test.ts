import express from 'express';
import request from 'supertest';
import { crmAutomationRouter } from '../modules/automation/crm.routes';
import { internalAutomationRouter } from '../modules/automation/internal.routes';
import { analyticsRoutes } from '../modules/analytics/analytics.routes';
import { inventoryService } from '../modules/automation/hardening/inventory.service';
import { resolveExpectedDrivePath } from '../modules/automation/ingest/folderMatcher';
import {
  cleanCaptionBoilerplate,
  cleanTitleBoilerplate,
  validateGeminiDraftOutput,
} from '../modules/automation/review/geminiDraft.service';
import { generateCrmSessionToken } from '../utils/sessionToken';

jest.setTimeout(30000);

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/internal', internalAutomationRouter);
  app.use('/api/v1/crm', crmAutomationRouter);
  app.use('/api/v1/analytics', analyticsRoutes);
  return app;
}

describe('Section C: Inventory & Data Fixes (Tasks 7, 8, 9, 10)', () => {
  const app = createTestApp();
  let adminToken: string;

  beforeAll(() => {
    adminToken = generateCrmSessionToken({
      id: 'admin-asif',
      email: 'asif@leadersperformance.ae',
      name: 'Asif',
      role: 'admin',
    });
  });

  describe('Task 7: Two-Tier Inventory Model', () => {
    it('calculates available_stock = raw_unscheduled + date_scheduled', async () => {
      const result = await inventoryService.getTwoTierInventory();

      expect(result).toBeDefined();
      expect(result.summary).toBeDefined();
      expect(result.summary.rawUnscheduledCount).toBeGreaterThanOrEqual(27);
      expect(result.summary.totalAvailableStock).toBe(
        result.summary.rawUnscheduledCount + result.summary.dateScheduledCount
      );
      expect(result.summary.daysOfCoverage).toBeGreaterThan(14);
      expect(result.summary.status).toBe('HEALTHY');
      expect(Array.isArray(result.byStream)).toBe(true);
      expect(result.byStream.length).toBe(4);
    });

    it('GET /api/v1/crm/inventory returns two-tier stock and coverage', async () => {
      const res = await request(app)
        .get('/api/v1/crm/inventory')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.summary.totalAvailableStock).toBeGreaterThanOrEqual(27);
      expect(res.body.data.summary.rawUnscheduledCount).toBeGreaterThanOrEqual(27);
      expect(Array.isArray(res.body.data.rawAssets)).toBe(true);
    });
  });

  describe('Task 8: LinkedIn Business vs Personal Profile Stats', () => {
    it('GET /api/v1/analytics/social/linkedin returns company and personal stats', async () => {
      const res = await request(app)
        .get('/api/v1/analytics/social/linkedin?accountType=all');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('accountType', 'BUSINESS');
      expect(res.body.data).toHaveProperty('personal');
      expect(res.body.data.personal).toHaveProperty('accountType', 'PERSONAL');
      expect(res.body.data.personal).toHaveProperty('name', 'Lionel Eersteling');
    });

    it('GET /api/v1/analytics/social/linkedin?accountType=personal returns personal stats only', async () => {
      const res = await request(app)
        .get('/api/v1/analytics/social/linkedin?accountType=personal');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('accountType', 'PERSONAL');
      expect(res.body.data).toHaveProperty('name', 'Lionel Eersteling');
    });
  });

  describe('Task 9: LinkedIn UNKNOWN_CONTENT_TYPE Resolution', () => {
    it('resolves complex LinkedIn content type strings without being marked BLOCKED', () => {
      const res1 = resolveExpectedDrivePath({
        platform: 'LINKEDIN',
        contentType: 'New batch (October 2026) poster nr 2',
        dateYmd: '2026-11-20',
      });

      expect(res1.blockedReason).toBeUndefined();
      expect(res1.requiresDriveFolder).toBe(true);
      expect(res1.drivePath).toContain('01_Linkedin/02_Poster/2026-11-20');

      const res2 = resolveExpectedDrivePath({
        platform: 'LINKEDIN',
        contentType: 'Post',
        dateYmd: '2026-11-20',
      });
      expect(res2.blockedReason).toBeUndefined();
      expect(res2.drivePath).toContain('01_Linkedin/02_Poster/2026-11-20');

      const res3 = resolveExpectedDrivePath({
        platform: 'LINKEDIN',
        contentType: '',
        dateYmd: '2026-11-20',
      });
      expect(res3.blockedReason).toBeUndefined();
      expect(res3.drivePath).toContain('01_Linkedin/02_Poster/2026-11-20');
    });
  });

  describe('Task 10: AI Caption Cleanup', () => {
    it('strips prompt boilerplate, intro lines, leading hashtag dumps, and quotes', () => {
      const rawCaption = `Here is a caption:
#Leadership #Founder #Business

When leading through high uncertainty, founders must separate noise from strategic signal.

Option 1 provides maximum clarity for executive teams.`;

      const cleaned = cleanCaptionBoilerplate(rawCaption);
      expect(cleaned.startsWith('Here is a caption:')).toBe(false);
      expect(cleaned.startsWith('#Leadership')).toBe(false);
      expect(cleaned).toContain('When leading through high uncertainty');
    });

    it('strips title boilerplate like "MAIN TITLE:"', () => {
      const rawTitle = 'MAIN TITLE: Leading Under Pressure';
      const clean = cleanTitleBoilerplate(rawTitle);
      expect(clean).toBe('Leading Under Pressure');
    });

    it('validates and auto-cleans drafts in validateGeminiDraftOutput', () => {
      const draft = {
        title: 'Title: Strategic Focus',
        caption: 'Here is the post:\n\nFocus on the few levers that truly compound.',
        hashtags: ['#Strategy', '#Leadership'],
        category: 'Leadership',
      };

      const result = validateGeminiDraftOutput(draft, 'LINKEDIN');
      expect(result.valid).toBe(true);
      expect(result.normalized?.title).toBe('Strategic Focus');
      expect(result.normalized?.caption).toBe('Focus on the few levers that truly compound.');
    });
  });
});

