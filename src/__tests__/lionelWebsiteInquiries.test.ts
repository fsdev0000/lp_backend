import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { lionelWebsiteRoutes } from '../modules/lionelWebsite/lionelWebsite.routes';
import { analyticsRoutes } from '../modules/analytics/analytics.routes';
import { generateCrmSessionToken } from '../utils/sessionToken';

jest.setTimeout(30000);

const prisma = new PrismaClient();

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/le', lionelWebsiteRoutes);
  app.use('/api/v1/analytics', analyticsRoutes);
  return app;
}

describe('Lionel Eersteling Website Inquiries & Per-Campaign Inquiries (Tasks 1 & 2)', () => {
  const app = createTestApp();
  let adminToken: string;
  const createdVisitIds: string[] = [];
  const testEmail = `marcus.vanton.${Date.now()}@vantonholdings.ae`;

  beforeAll(() => {
    process.env.CRM_SESSION_SECRET =
      process.env.CRM_SESSION_SECRET || 'test_crm_secret_for_signing_sessions_32';
    process.env.EMAIL_APPROVER = 'asif@leadersperformance.ae';

    adminToken = generateCrmSessionToken({
      id: 'test_admin_id',
      email: 'asif@leadersperformance.ae',
      name: 'Asif',
      role: 'admin',
    });
  });

  afterAll(async () => {
    if (createdVisitIds.length > 0) {
      await prisma.systemConfig
        .deleteMany({
          where: { key: { in: createdVisitIds.map((id) => `le_website_inquiry_${id}`) } },
        })
        .catch(() => {});
      await prisma.attributionVisit
        .deleteMany({
          where: { id: { in: createdVisitIds } },
        })
        .catch(() => {});
    }
    await prisma.$disconnect();
  });

  it('should reject invalid LE contact submissions with 400', async () => {
    const res = await request(app).post('/api/v1/le/contact').send({
      first_name: 'A',
      email: 'not-an-email',
      message: '',
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('should store an LE contact-form submission with UTM campaign and surface it in Overview & Campaign Inquiries', async () => {
    const postRes = await request(app)
      .post('/api/v1/le/contact')
      .send({
        first_name: 'Marcus',
        last_name: 'Vanton',
        company: 'Vanton Holdings',
        role: 'Founder & Managing Partner',
        email: testEmail,
        phone: '+971 50 555 0199',
        how_did_you_hear: 'LinkedIn',
        preferred_contact_method: 'Email',
        message: 'Preparing for cross-border leadership expansion and executive alignment.',
        utm_source: 'linkedin',
        utm_medium: 'social',
        utm_campaign: 'le_advisory_q4',
        landing_page: 'https://lioneleersteling.com/contact?utm_campaign=le_advisory_q4&utm_source=linkedin',
        skipGhlUpsert: true,
        skipEmailNotification: true,
      });

    expect(postRes.status).toBe(200);
    expect(postRes.body.success).toBe(true);
    expect(postRes.body.inquiryId).toBeDefined();
    createdVisitIds.push(postRes.body.inquiryId);

    // 1. Verify GET /api/v1/le/inquiries lists the inquiry
    const listRes = await request(app)
      .get('/api/v1/le/inquiries')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(listRes.status).toBe(200);
    expect(listRes.body.success).toBe(true);
    expect(listRes.body.domain).toBe('lioneleersteling.com');
    const foundInList = listRes.body.inquiries.find((i: any) => i.email === testEmail);
    expect(foundInList).toBeDefined();
    expect(foundInList.name).toBe('Marcus Vanton');
    expect(foundInList.company).toBe('Vanton Holdings');
    expect(foundInList.utmCampaign).toBe('le_advisory_q4');

    // 2. Verify Overview for domain=lioneleersteling.com includes the inquiry in highIntentLeads, recentLeads, and topCampaigns
    const overviewLeRes = await request(app)
      .get('/api/v1/analytics/overview?domain=lioneleersteling.com&range=30d')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(overviewLeRes.status).toBe(200);
    const leOverview = overviewLeRes.body.data;
    expect(leOverview.domain).toBe('lioneleersteling.com');
    expect(leOverview.metrics.highIntentLeads).toBeGreaterThanOrEqual(1);

    const recentMatch = leOverview.recentLeads.find((l: any) => l.id === postRes.body.inquiryId);
    expect(recentMatch).toBeDefined();
    expect(recentMatch.name).toBe('Marcus Vanton');
    expect(recentMatch.company).toBe('Vanton Holdings');
    expect(recentMatch.source).toBe('form');

    const campaignMatch = leOverview.topCampaigns.find(
      (c: any) => c.campaign === 'le_advisory_q4'
    );
    expect(campaignMatch).toBeDefined();
    expect(campaignMatch.leads).toBeGreaterThanOrEqual(1);
    expect(campaignMatch.clicks).toBeGreaterThanOrEqual(1);

    // 3. Verify strict isolation: leadersperformance.ae recentLeads and campaigns do NOT contain the LE inquiry
    const overviewLpRes = await request(app)
      .get('/api/v1/analytics/overview?domain=leadersperformance.ae&range=30d')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(overviewLpRes.status).toBe(200);
    const lpOverview = overviewLpRes.body.data;
    const leakedRecent = lpOverview.recentLeads.find((l: any) => l.id === postRes.body.inquiryId);
    expect(leakedRecent).toBeUndefined();

    const leakedCampaign = lpOverview.topCampaigns.find(
      (c: any) => c.campaign === 'le_advisory_q4'
    );
    expect(leakedCampaign).toBeUndefined();
  });
});
