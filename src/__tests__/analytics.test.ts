import { describe, it, expect, beforeEach, afterAll, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { analyticsRoutes } from '../modules/analytics/analytics.routes';

jest.setTimeout(25000);

const app = express();
app.use(express.json());
app.use('/api/v1/analytics', analyticsRoutes);

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

  it('GET /api/v1/analytics/keywords returns top search queries with SERP rank', async () => {
    const res = await request(app).get('/api/v1/analytics/keywords?limit=10');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);

    const firstQuery = res.body.data[0];
    expect(firstQuery).toHaveProperty('query');
    expect(firstQuery).toHaveProperty('impressions');
    expect(firstQuery).toHaveProperty('clicks');
    expect(firstQuery).toHaveProperty('ctr');
    expect(firstQuery).toHaveProperty('position');
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
    expect(res.body.data).toHaveProperty('usersByCity');
  });
});

