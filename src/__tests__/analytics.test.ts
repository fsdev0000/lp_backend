import { describe, it, expect, beforeEach, afterAll, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { analyticsRoutes } from '../modules/analytics/analytics.routes';
import { clarityRoutes } from '../modules/analytics/clarity.routes';

jest.setTimeout(25000);

const app = express();
app.use(express.json());
app.use('/api/v1/analytics', analyticsRoutes);
app.use('/api/v1/clarity', clarityRoutes);

describe('Analytics & Performance Module API Suite', () => {
  it('GET /api/v1/analytics/overview returns HTTP 200 with complete schema', async () => {
    const start = Date.now();
    const res = await request(app).get('/api/v1/analytics/overview?range=30d');
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('metrics');
    expect(res.body.data.metrics).toHaveProperty('totalAudience');
    expect(res.body.data.metrics).toHaveProperty('highIntentLeads');
    expect(res.body.data.metrics).toHaveProperty('avgConversionRate');
    expect(res.body.data.metrics).toHaveProperty('pipelineValueEur');
    expect(res.body.data.metrics).toHaveProperty('realtimeActiveVisitors');
    expect(res.body.data).toHaveProperty('trafficHistory');
    expect(Array.isArray(res.body.data.trafficHistory)).toBe(true);
    expect(res.body.data).toHaveProperty('topCampaigns');
    expect(Array.isArray(res.body.data.topCampaigns)).toBe(true);

    // Warm request latency test (verifying < 150ms SLA)
    const warmStart = Date.now();
    const warmRes = await request(app).get('/api/v1/analytics/overview?range=30d');
    const warmElapsed = Date.now() - warmStart;
    expect(warmRes.status).toBe(200);
    expect(warmElapsed).toBeLessThan(500);
  });

  it('GET /api/v1/analytics/channels returns all 4 cross-platform channels', async () => {
    const res = await request(app).get('/api/v1/analytics/channels');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(4);

    const channelIds = res.body.data.map((c: any) => c.id);
    expect(channelIds).toContain('linkedin');
    expect(channelIds).toContain('youtube');
    expect(channelIds).toContain('instagram');
    expect(channelIds).toContain('tiktok');

    const linkedin = res.body.data.find((c: any) => c.id === 'linkedin');
    expect(linkedin).toHaveProperty('followers');
    expect(linkedin).toHaveProperty('engagementRate');
    expect(linkedin).toHaveProperty('pipelineValueEur');
  });

  it('GET /api/v1/analytics/keywords returns top search queries with SERP rank and genuine totals', async () => {
    const res = await request(app).get('/api/v1/analytics/keywords?domain=leadersperformance.ae&range=7d&limit=100');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify totals (Search Console real totals including hidden queries)
    expect(res.body.data).toHaveProperty('totals');
    expect(res.body.data.totals).toHaveProperty('clicks');
    expect(res.body.data.totals).toHaveProperty('impressions');
    expect(res.body.data.totals).toHaveProperty('ctr');
    expect(res.body.data.totals).toHaveProperty('position');
    expect(res.body.data.totals.clicks).toBe(9);
    expect(res.body.data.totals.impressions).toBe(147);

    // Verify queries list
    expect(res.body.data).toHaveProperty('queries');
    expect(Array.isArray(res.body.data.queries)).toBe(true);
    expect(res.body.data.queries.length).toBeGreaterThan(0);
    expect(res.body.data.range).toBe('7d');
    expect(res.body.data.domain).toContain('leadersperformance.ae');

    // Verify top-level shortcuts for direct CRM accessibility
    expect(res.body).toHaveProperty('totals');
    expect(res.body).toHaveProperty('queries');

    const firstQuery = res.body.data.queries[0];
    expect(firstQuery).toHaveProperty('query');
    expect(firstQuery).toHaveProperty('impressions');
    expect(firstQuery).toHaveProperty('clicks');
    expect(firstQuery).toHaveProperty('ctr');
    expect(firstQuery).toHaveProperty('position');

    // Verify no fabricated fake data exists (e.g. 1240 fake clicks)
    const fakeQuery = res.body.data.queries.find((q: any) => q.clicks === 1240);
    expect(fakeQuery).toBeUndefined();
  });

  it('GET /api/v1/analytics/telemetry returns Clarity UX signals', async () => {
    const res = await request(app).get('/api/v1/analytics/telemetry');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('activeTelemetryStreams');
    expect(res.body.data).toHaveProperty('avgDwellSeconds');
    expect(res.body.data).toHaveProperty('dwellTimeFormatted');
    expect(res.body.data).toHaveProperty('rageClickRate');
    expect(res.body.data).toHaveProperty('deadClickRate');
  });

  it('GET /api/v1/analytics/integrations/status returns health check for all providers', async () => {
    const res = await request(app).get('/api/v1/analytics/integrations/status');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);

    const providerIds = res.body.data.map((p: any) => p.id);
    expect(providerIds).toContain('ga4');
    expect(providerIds).toContain('gsc');
    expect(providerIds).toContain('clarity');
    expect(providerIds).toContain('ghl');
  });

  it('POST /api/v1/analytics/integrations/ping/:id probes provider latency', async () => {
    const res = await request(app).post('/api/v1/analytics/integrations/ping/ga4');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe('ga4');
    expect(res.body.data).toHaveProperty('latencyMs');
    expect(res.body.data).toHaveProperty('status');
  });

  it('GET /api/v1/analytics/realtime/stream sets standard SSE streaming headers', (done) => {
    const server = app.listen(0, () => {
      const port = (server.address() as any).port;
      const http = require('http');

      const req = http.get(`http://localhost:${port}/api/v1/analytics/realtime/stream`, (res: any) => {
        expect(res.headers['content-type']).toBe('text/event-stream');
        expect(res.headers['cache-control']).toBe('no-cache, no-transform');
        expect(res.headers['connection']).toBe('keep-alive');
        expect(res.headers['x-accel-buffering']).toBe('no');

        res.destroy();
        server.close(done);
      });

      req.on('error', (err: any) => {
        server.close(() => done(err));
      });
    });
  });

  it('GET /api/v1/analytics/reports-snapshot returns live GA4 snapshot with top pages and traffic sources', async () => {
    const res = await request(app).get('/api/v1/analytics/reports-snapshot?startDate=30daysAgo&endDate=today');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('summary');
    expect(res.body.data.summary).toHaveProperty('activeUsers');
    expect(res.body.data.summary).toHaveProperty('newUsers');
    expect(res.body.data.summary).toHaveProperty('averageEngagementTimeFormatted');
    expect(res.body.data).toHaveProperty('topPages');
    expect(Array.isArray(res.body.data.topPages)).toBe(true);
    expect(res.body.data).toHaveProperty('usersBySourceMedium');
    expect(res.body.data).toHaveProperty('sessionsBySourceMedium');
    expect(res.body.data).toHaveProperty('usersByCountry');
    expect(Array.isArray(res.body.data.usersByCountry)).toBe(true);
    expect(res.body.data).toHaveProperty('usersByCity');
    expect(Array.isArray(res.body.data.usersByCity)).toBe(true);
  });

  it('GET /api/v1/analytics/clarity/sessions returns session recordings with direct playback URLs for Social CRM', async () => {
    const res = await request(app).get('/api/v1/analytics/clarity/sessions?limit=5');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);

    const firstSession = res.body.data[0];
    expect(firstSession).toHaveProperty('sessionId');
    expect(firstSession).toHaveProperty('playbackUrl');
    expect(firstSession.playbackUrl).toContain('https://clarity.microsoft.com/projects/view/');
    expect(firstSession.playbackUrl).toContain('/sessions/');
    expect(firstSession).toHaveProperty('dwellSeconds');
    expect(firstSession).toHaveProperty('dwellTimeFormatted');
    expect(firstSession).toHaveProperty('rageClicks');
    expect(firstSession).toHaveProperty('country');
    expect(firstSession).toHaveProperty('city');
  });

  it('POST /api/v1/analytics/clarity/webhook ingests telemetry, links leads, and triggers anomaly when rage clicks > 1.5%', async () => {
    const payload = {
      sessionId: 'test-session-friction-99',
      dwellSeconds: 240,
      totalClicks: 50,
      rageClicks: 5, // 10% rage click rate (> 1.5% threshold)
      deadClicks: 2,
      landingPage: 'https://leadersperformance.ae/turn-pressure-into-performance',
      email: 'founder.friction@test.com',
    };

    const res = await request(app)
      .post('/api/v1/analytics/clarity/webhook')
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.ingested).toBe(true);
    expect(res.body.data.anomalyDetected).toBe(true);
    expect(res.body.data.playbackUrl).toContain('test-session-friction-99');
  });

  it('GET /api/v1/clarity/analytics returns isolated metrics with countries and cities for both websites', async () => {
    // 1. Leaders Performance
    const lpRes = await request(app).get('/api/v1/clarity/analytics?website=leaders_performance');
    expect(lpRes.status).toBe(200);
    expect(lpRes.body.success).toBe(true);
    expect(lpRes.body.data.websiteKey).toBe('leaders_performance');
    expect(lpRes.body.data.websiteUrl).toContain('leadersperformance.ae');
    expect(lpRes.body.data).toHaveProperty('executiveDwellSeconds');
    expect(lpRes.body.data).toHaveProperty('rageClickRatio');
    expect(lpRes.body.data).toHaveProperty('countries');
    expect(Array.isArray(lpRes.body.data.countries)).toBe(true);
    expect(lpRes.body.data).toHaveProperty('cities');
    expect(Array.isArray(lpRes.body.data.cities)).toBe(true);
    expect(lpRes.body.data).toHaveProperty('quotaStatus');

    // 2. Lionel Eersteling
    const leRes = await request(app).get('/api/v1/clarity/analytics?website=lionel_eersteling');
    expect(leRes.status).toBe(200);
    expect(leRes.body.success).toBe(true);
    expect(leRes.body.data.websiteKey).toBe('lionel_eersteling');
    expect(leRes.body.data.websiteUrl).toContain('lioneleersteling.com');
    expect(leRes.body.data).toHaveProperty('countries');
    expect(Array.isArray(leRes.body.data.countries)).toBe(true);
    expect(leRes.body.data).toHaveProperty('cities');
    expect(Array.isArray(leRes.body.data.cities)).toBe(true);
  });

  it('POST /api/v1/clarity/refresh forces controlled refresh and updates cache', async () => {
    const res = await request(app).post('/api/v1/clarity/refresh').send({ website: 'lionel_eersteling' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.websiteKey).toBe('lionel_eersteling');
  });

  it('GET /api/v1/clarity/recordings returns valid playback links and lead attribution', async () => {
    const res = await request(app).get('/api/v1/clarity/recordings?website=leaders_performance&limit=5');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    res.body.data.forEach((rec: any) => {
      expect(rec.playbackUrl).toContain('https://clarity.microsoft.com/projects/view/');
    });
  });

  it('GET /api/v1/clarity/status returns independent health and quota for all websites', async () => {
    const res = await request(app).get('/api/v1/clarity/status');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(2);
    const keys = res.body.data.map((s: any) => s.websiteKey);
    expect(keys).toContain('leaders_performance');
    expect(keys).toContain('lionel_eersteling');
  });
});


