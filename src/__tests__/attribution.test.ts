import { describe, it, expect, afterAll } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { attributionRouter } from '../api/routes/attribution';
import { PrismaClient } from '@prisma/client';

const app = express();
app.use(express.json());
app.use('/api/v1/attribution', attributionRouter);

const prisma = new PrismaClient();

describe('Attribution API Endpoints', () => {
  jest.setTimeout(30000);

  afterAll(async () => {
    try {
      await prisma.$executeRawUnsafe(
        `DELETE FROM attribution_visits WHERE landing_page LIKE '%test-landing%' OR anonymous_id = 'test-anon-123';`
      );
    } catch {}
    await prisma.$disconnect();
  });

  it('GET /api/v1/attribution/options should return the standardized lead source options', async () => {
    const res = await request(app).get('/api/v1/attribution/options');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.options)).toBe(true);
    expect(res.body.options).toContain('Google / Search');
    expect(res.body.options).toContain('LinkedIn');
    expect(res.body.options).toContain('YouTube');
    expect(res.body.options).toContain('Instagram');
    expect(res.body.options).toContain('Referral / Someone recommended me');
    expect(res.body.options).toContain('Event / Conference');
    expect(res.body.options).toContain('Other');
  });

  it('POST /api/v1/attribution/visit should return 400 when landingPage is missing', async () => {
    const res = await request(app)
      .post('/api/v1/attribution/visit')
      .send({
        module: 'masterclass',
      });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('POST /api/v1/attribution/visit should record external visitor arrival with IP, location, UTMs and PostgreSQL storage', async () => {
    const res = await request(app)
      .post('/api/v1/attribution/visit')
      .set('x-forwarded-for', '185.190.141.1')
      .set('cf-ipcountry', 'AE')
      .send({
        anonymousId: 'test-anon-123',
        module: 'masterclass',
        landingPage: '/masterclass?utm_source=linkedin&utm_campaign=q4_launch#test-landing',
        referrer: 'https://www.linkedin.com/',
        utm_source: 'linkedin',
        utm_medium: 'social',
        utm_campaign: 'q4_launch',
        utm_content: 'banner_a',
        timezone: 'Asia/Dubai',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.visitId).toBeDefined();
    expect(res.body.tracked.module).toBe('masterclass');
    expect(res.body.tracked.ip).toBe('185.190.141.1');
    expect(res.body.tracked.country).toBe('AE');

    // Verify row was persisted in PostgreSQL
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT * FROM attribution_visits WHERE id = $1 LIMIT 1;`,
      res.body.visitId
    );
    expect(rows.length).toBe(1);
    expect(rows[0].module).toBe('masterclass');
    expect(rows[0].utm_source).toBe('linkedin');
    expect(rows[0].country).toBe('AE');
    expect(rows[0].ip_address).toBe('185.190.141.1');
  });

  it('syncLeadAttribution should succeed gracefully with ZERO attribution data provided (100% backward compatible)', async () => {
    const { syncLeadAttribution } = await import('../services/attributionService');

    // Call without any attribution, without howDidYouHear, without anonymousId
    const res = await syncLeadAttribution({
      email: 'legacy-lead-no-attribution@leadersperformance.ae',
      leadName: 'Legacy Test User',
      leadForm: 'contact',
      // attribution and howDidYouHear are completely omitted
    });

    // Should not throw or crash
    expect(res === null || typeof res === 'string').toBe(true);
  });
});

