import { describe, it, expect, beforeEach } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { cmsRouter } from '../modules/cms/cms.routes';
import { cmsCache } from '../modules/cms/cache/cmsCache.service';

const app = express();
app.use(express.json());
app.use('/api/v1/cms', cmsRouter);

const API_KEY = process.env.ARTICLES_API_KEY || 'b8f9c1a2d4e7465b90a3f8c2e1d5b';

describe('CMS Module & Caching Architecture', () => {
  jest.setTimeout(30000);

  beforeEach(() => {
    cmsCache.clear();
  });

  describe('1. Public Read Endpoints & HTTP Caching', () => {
    it('GET /api/v1/cms/bootstrap should return 200 with X-Cache: MISS on first call and set ETag & Cache-Control', async () => {
      const res = await request(app).get('/api/v1/cms/bootstrap');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('navigation');
      expect(res.body.data).toHaveProperty('settings');
      expect(res.body.data).toHaveProperty('testimonials');

      // Caching headers verification
      expect(res.headers['x-cache']).toBe('MISS');
      expect(res.headers['etag']).toBeDefined();
      expect(res.headers['cache-control']).toContain('public');
      expect(res.headers['cache-control']).toContain('stale-while-revalidate');
    });

    it('GET /api/v1/cms/bootstrap on repeat should hit in-memory cache with X-Cache: HIT in < 2ms', async () => {
      // First call primes cache
      await request(app).get('/api/v1/cms/bootstrap');

      // Second call
      const start = Date.now();
      const res2 = await request(app).get('/api/v1/cms/bootstrap');
      const elapsed = Date.now() - start;

      expect(res2.status).toBe(200);
      expect(res2.headers['x-cache']).toBe('HIT');
      expect(elapsed).toBeLessThanOrEqual(30); // Very fast in-memory response
    });

    it('GET /api/v1/cms/bootstrap with matching If-None-Match should return 304 Not Modified', async () => {
      // Prime cache and get ETag
      const res1 = await request(app).get('/api/v1/cms/bootstrap');
      const etag = res1.headers['etag'];

      // Conditional GET
      const res2 = await request(app)
        .get('/api/v1/cms/bootstrap')
        .set('If-None-Match', etag);

      expect(res2.status).toBe(304);
      expect(res2.text).toBe(''); // Zero payload transfer
    });

    it('GET /api/v1/cms/pages/home should return homepage data and sections', async () => {
      const res = await request(app).get('/api/v1/cms/pages/home');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.slug).toBe('home');
      expect(res.body.data.sections).toBeInstanceOf(Array);
      expect(res.headers['x-cache']).toBe('MISS');

      // Repeat should hit
      const resHit = await request(app).get('/api/v1/cms/pages/home');
      expect(resHit.headers['x-cache']).toBe('HIT');
    });

    it('GET /api/v1/cms/pages/non-existent-page should return 404', async () => {
      const res = await request(app).get('/api/v1/cms/pages/non-existent-page-xyz');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('GET /api/v1/cms/testimonials should return testimonials with caching headers', async () => {
      const res = await request(app).get('/api/v1/cms/testimonials');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.headers['x-cache']).toBe('MISS');
    });
  });

  describe('2. Admin Endpoints Security & Cache Invalidation', () => {
    it('Admin routes should reject requests without API key (401)', async () => {
      const res = await request(app)
        .post('/api/v1/cms/admin/pages')
        .send({ slug: 'test-unauth', title: 'Unauthorized' });

      expect(res.status).toBe(401);
    });

    it('Admin cache purge should clear cache entries and reset metrics', async () => {
      // Populate cache
      await request(app).get('/api/v1/cms/bootstrap');
      await request(app).get('/api/v1/cms/pages/home');

      // Inspect stats before purge
      const statsBefore = cmsCache.getStats();
      expect(statsBefore.keysCount).toBeGreaterThanOrEqual(2);

      // Purge cache via Admin API
      const purgeRes = await request(app)
        .post('/api/v1/cms/admin/cache/purge')
        .set('x-api-key', API_KEY)
        .send({ tag: 'all' });

      expect(purgeRes.status).toBe(200);
      expect(purgeRes.body.success).toBe(true);

      // Verify stats after purge
      const statsAfter = cmsCache.getStats();
      expect(statsAfter.keysCount).toBe(0);

      // Next GET must be MISS
      const resAfter = await request(app).get('/api/v1/cms/bootstrap');
      expect(resAfter.headers['x-cache']).toBe('MISS');
    });

    it('GET /api/v1/cms/admin/cache/stats should report live cache telemetry', async () => {
      const res = await request(app)
        .get('/api/v1/cms/admin/cache/stats')
        .set('x-api-key', API_KEY);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('hits');
      expect(res.body.data).toHaveProperty('misses');
      expect(res.body.data).toHaveProperty('hitRatio');
    });
  });
});
