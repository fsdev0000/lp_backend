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
  it('GET /api/v1/analytics/overview returns HTTP 200 with complete schema and Dubai window ISO dates', async () => {
    const start = Date.now();
    const res = await request(app).get('/api/v1/analytics/overview?range=7d&domain=leadersperformance.ae');
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('startDate');
    expect(res.body.data).toHaveProperty('endDate');
    expect(res.body.data.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.body.data.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.body.data.domain).toBe('leadersperformance.ae');

    expect(res.body.data).toHaveProperty('metrics');
    expect(res.body.data.metrics).toHaveProperty('totalAudience');
    expect(res.body.data.metrics).toHaveProperty('highIntentLeads');
    expect(res.body.data.metrics).toHaveProperty('avgConversionRate');
    expect(res.body.data.metrics).toHaveProperty('pipelineValueEur');
    expect(res.body.data.metrics).toHaveProperty('realtimeActiveVisitors');
    expect(res.body.data).toHaveProperty('trafficHistory');
    expect(Array.isArray(res.body.data.trafficHistory)).toBe(true);
    expect(res.body.data.trafficHistory.length).toBe(7);
    expect(res.body.data.trafficHistory[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.body.data).toHaveProperty('topCampaigns');
    expect(Array.isArray(res.body.data.topCampaigns)).toBe(true);

    // Test range=all has null growth metrics
    const allRes = await request(app).get('/api/v1/analytics/overview?range=all');
    expect(allRes.status).toBe(200);
    expect(allRes.body.data.metrics.totalAudienceGrowth).toBeNull();
    expect(allRes.body.data.metrics.highIntentLeadsGrowth).toBeNull();
    expect(allRes.body.data.metrics.pipelineValueGrowth).toBeNull();

    // Warm request latency test (verifying < 500ms)
    const warmStart = Date.now();
    const warmRes = await request(app).get('/api/v1/analytics/overview?range=30d');
    const warmElapsed = Date.now() - warmStart;
    expect(warmRes.status).toBe(200);
    expect(warmElapsed).toBeLessThan(500);
  });

  it('GET /api/v1/analytics/channels returns all 4 cross-platform channels with dynamic range metrics', async () => {
    const res = await request(app).get('/api/v1/analytics/channels?range=7d');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(4);

    const channelIds = res.body.data.map((c: any) => c.id);
    expect(channelIds).toContain('linkedin');
    expect(channelIds).toContain('youtube');
    expect(channelIds).toContain('instagram');
    expect(channelIds).toContain('tiktok');

    const yt = res.body.data.find((c: any) => c.id === 'youtube');
    expect(yt.connected).toBe(true);
    expect(typeof yt.followers).toBe('number');
    expect(typeof yt.postsInRange).toBe('number');
    expect(typeof yt.websiteVisitors).toBe('number');
    expect(typeof yt.leads).toBe('number');
    expect(typeof yt.pipelineValueEur).toBe('number');
    expect(yt.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(yt.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const linkedin = res.body.data.find((c: any) => c.id === 'linkedin');
    expect(linkedin.connected).toBe(false);
    expect(linkedin.followers).toBeNull();
    expect(linkedin.postsInRange).toBeNull();
    expect(linkedin.engagementRate).toBeNull();
    expect(typeof linkedin.websiteVisitors).toBe('number');
  });

  it('GET /api/v1/analytics/social/youtube returns live YouTube channel stats and recent videos', async () => {
    const res = await request(app).get('/api/v1/analytics/social/youtube');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('channelId');
    expect(res.body.data).toHaveProperty('title');
    expect(res.body.data).toHaveProperty('subscriberCount');
    expect(res.body.data).toHaveProperty('viewCount');
    expect(res.body.data).toHaveProperty('videoCount');
    expect(res.body.data).toHaveProperty('longVideoCount');
    expect(res.body.data).toHaveProperty('shortsCount');
    expect(res.body.data).toHaveProperty('isFallback');
    expect(res.body.data.isFallback).toBe(false);
    expect(res.body.data).toHaveProperty('recentVideos');
    expect(Array.isArray(res.body.data.recentVideos)).toBe(true);
  });

  it('GET /api/v1/analytics/social/youtube/videos returns categorized public videos and shorts', async () => {
    // 1. Long videos
    const longRes = await request(app).get('/api/v1/analytics/social/youtube/videos?type=videos');
    expect(longRes.status).toBe(200);
    expect(longRes.body.success).toBe(true);
    expect(Array.isArray(longRes.body.data.videos)).toBe(true);
    expect(longRes.body.data.videos.length).toBeGreaterThan(0);
    const firstLong = longRes.body.data.videos[0];
    expect(firstLong).toHaveProperty('videoId');
    expect(firstLong).toHaveProperty('title');
    expect(firstLong).toHaveProperty('thumbnail');
    expect(firstLong).toHaveProperty('publishedAt');
    expect(firstLong).toHaveProperty('durationSeconds');
    expect(typeof firstLong.durationSeconds).toBe('number');
    expect(firstLong).toHaveProperty('viewCount');
    expect(firstLong).toHaveProperty('likeCount');
    expect(firstLong).toHaveProperty('commentCount');
    expect(firstLong.watchTimeMinutes).toBeNull();
    expect(firstLong.watchUrl).toContain('https://www.youtube.com/watch?v=');

    // 2. Shorts
    const shortsRes = await request(app).get('/api/v1/analytics/social/youtube/videos?type=shorts');
    expect(shortsRes.status).toBe(200);
    expect(shortsRes.body.success).toBe(true);
    expect(Array.isArray(shortsRes.body.data.videos)).toBe(true);
    expect(shortsRes.body.data.videos.length).toBeGreaterThan(0);
  });

  it('GET /api/v1/analytics/social/youtube/playlists returns public playlists with item counts and timestamps', async () => {
    const res = await request(app).get('/api/v1/analytics/social/youtube/playlists');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.playlists)).toBe(true);
    expect(res.body.data.playlists.length).toBeGreaterThan(0);

    const firstPl = res.body.data.playlists[0];
    expect(firstPl).toHaveProperty('playlistId');
    expect(firstPl).toHaveProperty('title');
    expect(firstPl).toHaveProperty('thumbnail');
    expect(firstPl).toHaveProperty('itemCount');
    expect(typeof firstPl.itemCount).toBe('number');
    expect(firstPl).toHaveProperty('lastUpdated');
    expect(firstPl.viewCount).toBeNull();
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
    expect(res.body.data.totals.clicks).toBeGreaterThanOrEqual(0);
    expect(res.body.data.totals.impressions).toBeGreaterThanOrEqual(0);

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
    const res = await request(app).get('/api/v1/analytics/reports-snapshot?range=30d&domain=leadersperformance.ae');
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
    expect(res.body.data).toHaveProperty('geographicHierarchy');
    expect(Array.isArray(res.body.data.geographicHierarchy)).toBe(true);

    // Verify domain isolation for Lionel Eersteling does not return Leaders Performance numbers
    const leRes = await request(app).get('/api/v1/analytics/reports-snapshot?range=30d&domain=lioneleersteling.com');
    expect(leRes.status).toBe(200);
    expect(leRes.body.success).toBe(true);
    // Since lioneleersteling.com has 0 traffic on this property, it should return 0 rather than LP's active users
    expect(leRes.body.data.summary.activeUsers).not.toBe(res.body.data.summary.activeUsers);
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


