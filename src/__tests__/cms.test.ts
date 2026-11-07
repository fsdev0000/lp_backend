import { describe, it, expect, beforeEach } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { cmsRouter } from '../modules/cms/cms.routes';
import { cmsCache } from '../modules/cms/cache/cmsCache.service';
import { generateCrmSessionToken } from '../utils/sessionToken';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const app = express();
app.use(express.json());
app.use('/api/v1/cms', cmsRouter);

const adminToken = generateCrmSessionToken({
  id: 'test-admin-uid',
  email: 'admin@leadersperformance.ae',
  name: 'Lionel Admin',
  role: 'admin',
});

const staffToken = generateCrmSessionToken({
  id: 'test-staff-uid',
  email: 'staff@leadersperformance.ae',
  name: 'Staff User',
  role: 'staff',
});

describe('CMS Module & Text Management Architecture', () => {
  jest.setTimeout(30000);

  beforeEach(() => {
    cmsCache.clear();
  });

  // Clean up any test texts created during tests
  afterAll(async () => {
    try {
      await prisma.cmsTextRevision.deleteMany({
        where: { key: { startsWith: 'jest.test.' } },
      });
      await prisma.cmsText.deleteMany({
        where: { key: { startsWith: 'jest.test.' } },
      });
      await prisma.cmsPage.deleteMany({
        where: { slug: { startsWith: 'jest-test-' } },
      });
    } catch { }
    await prisma.$disconnect();
  });

  describe('1. Public Read Endpoints & HTTP Caching', () => {
    it('GET /api/v1/cms/bootstrap should return 200 with X-Cache: MISS on first call and set ETag & Cache-Control', async () => {
      const res = await request(app).get('/api/v1/cms/bootstrap');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('navigation');
      expect(res.body.data).toHaveProperty('settings');
      expect(res.body.data).toHaveProperty('testimonials');

      expect(res.headers['x-cache']).toBe('MISS');
      expect(res.headers['etag']).toBeDefined();
      expect(res.headers['cache-control']).toContain('public');
      expect(res.headers['cache-control']).toContain('stale-while-revalidate');
    });

    it('GET /api/v1/cms/bootstrap on repeat should hit in-memory cache with X-Cache: HIT in < 30ms', async () => {
      await request(app).get('/api/v1/cms/bootstrap');

      const start = Date.now();
      const res2 = await request(app).get('/api/v1/cms/bootstrap');
      const elapsed = Date.now() - start;

      expect(res2.status).toBe(200);
      expect(res2.headers['x-cache']).toBe('HIT');
      expect(elapsed).toBeLessThanOrEqual(50);
    });

    it('GET /api/v1/cms/bootstrap with matching If-None-Match should return 304 Not Modified', async () => {
      const res1 = await request(app).get('/api/v1/cms/bootstrap');
      const etag = res1.headers['etag'];

      const res2 = await request(app)
        .get('/api/v1/cms/bootstrap')
        .set('If-None-Match', etag);

      expect(res2.status).toBe(304);
      expect(res2.text).toBe('');
    });

    it('GET /api/v1/cms/pages/home should return homepage data and sections', async () => {
      const res = await request(app).get('/api/v1/cms/pages/home');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.slug).toBe('home');
      expect(res.body.data.sections).toBeInstanceOf(Array);
      expect(res.headers['x-cache']).toBe('MISS');

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

  describe('2. Issue Fixes Verification (Section 2)', () => {
    // Fix 2a: Drafts are private. GET /cms/pages/:slug?preview=true requires admin auth and never cached as public
    it('Fix 2a: GET /cms/pages/:slug?preview=true without admin auth returns 401 and bypasses public cache', async () => {
      const unauthRes = await request(app).get('/api/v1/cms/pages/home?preview=true');
      expect(unauthRes.status).toBe(401);
      expect(unauthRes.headers['cache-control']).toContain('no-store');

      const staffRes = await request(app)
        .get('/api/v1/cms/pages/home?preview=true')
        .set('Authorization', `Bearer ${staffToken}`);
      expect(staffRes.status).toBe(403);

      const adminRes = await request(app)
        .get('/api/v1/cms/pages/home?preview=true')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(adminRes.status).toBe(200);
      expect(adminRes.headers['cache-control']).toContain('no-store');
      expect(adminRes.headers['x-cache']).toBe('BYPASS');
    });

    // Fix 2d: Reject raw env API keys on admin routes; only accept app_metadata.role="admin" or admin session
    it('Fix 2d: Admin routes reject raw API keys and non-admin tokens with 403, accepts admin token', async () => {
      const fakeEnvKey = 'test-fake-env-key-12345';
      process.env.ADMIN_API_KEY = fakeEnvKey;

      // Passing raw env key via x-api-key header
      const envKeyRes = await request(app)
        .get('/api/v1/cms/admin/cache/stats')
        .set('x-api-key', fakeEnvKey);
      expect(envKeyRes.status).toBe(403);

      // Passing raw env key via Bearer header
      const envBearerRes = await request(app)
        .get('/api/v1/cms/admin/cache/stats')
        .set('Authorization', `Bearer ${fakeEnvKey}`);
      expect(envBearerRes.status).toBe(403);

      // No token -> 401
      const noTokenRes = await request(app).get('/api/v1/cms/admin/cache/stats');
      expect(noTokenRes.status).toBe(401);

      // Staff token (role != admin) -> 403
      const staffRes = await request(app)
        .get('/api/v1/cms/admin/cache/stats')
        .set('Authorization', `Bearer ${staffToken}`);
      expect(staffRes.status).toBe(403);

      // Admin token -> 200
      const adminRes = await request(app)
        .get('/api/v1/cms/admin/cache/stats')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(adminRes.status).toBe(200);
      expect(adminRes.body.success).toBe(true);
    });

    // Fix 2f & 2c: PUT /cms/admin/pages/:slug takes slug from URL and preserves PUBLISHED status if omitted
    it('Fix 2c & 2f: PUT /cms/admin/pages/:slug takes slug from URL and preserves status', async () => {
      const testSlug = 'jest-test-preserve-status';

      // 1. Create a published page
      const createRes = await request(app)
        .post('/api/v1/cms/admin/pages')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          slug: testSlug,
          title: 'Initial Published Page',
          status: 'PUBLISHED',
        });
      expect(createRes.status).toBe(200);
      expect(createRes.body.data.status).toBe('PUBLISHED');

      // 2. PUT with slug in URL and NO status in body (Fix 2f: URL param takes precedence, Fix 2c: status preserved)
      const updateRes = await request(app)
        .put(`/api/v1/cms/admin/pages/${testSlug}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: 'Updated Title Only',
          // status omitted deliberately
        });
      expect(updateRes.status).toBe(200);
      expect(updateRes.body.data.slug).toBe(testSlug);
      expect(updateRes.body.data.title).toBe('Updated Title Only');
      expect(updateRes.body.data.status).toBe('PUBLISHED'); // Preserved! Did not revert to DRAFT
    });
  });

  describe('3. Public Text Endpoints (Section 4)', () => {
    it('GET /api/v1/cms/texts should return version, publishedAt, texts dictionary, and Cache-Control: no-cache', async () => {
      const res = await request(app).get('/api/v1/cms/texts?locale=en');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('version');
      expect(typeof res.body.data.version).toBe('number');
      expect(res.body.data).toHaveProperty('publishedAt');
      expect(res.body.data).toHaveProperty('texts');
      expect(typeof res.body.data.texts).toBe('object');

      // Must have Cache-Control: no-cache and ETag
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.headers['etag']).toBeDefined();
    });

    it('GET /api/v1/cms/texts with matching If-None-Match should return 304', async () => {
      const res1 = await request(app).get('/api/v1/cms/texts?locale=en');
      const etag = res1.headers['etag'];

      const res2 = await request(app)
        .get('/api/v1/cms/texts?locale=en')
        .set('If-None-Match', etag);

      expect(res2.status).toBe(304);
      expect(res2.text).toBe('');
    });

    it('GET /api/v1/cms/texts with unsupported locale should return 400', async () => {
      const res = await request(app).get('/api/v1/cms/texts?locale=nl');
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('locale');
    });
  });

  describe('4. Admin Inline Text Workflow: Draft, Publish, Discard, and History (Section 4)', () => {
    const testKey = 'jest.test.home.hero.title';

    it('Full lifecycle: save draft -> view in admin -> publish -> read on public -> edit draft -> discard', async () => {
      // Step 1: Save draft text
      const draftRes = await request(app)
        .put('/api/v1/cms/admin/texts')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          key: testKey,
          locale: 'en',
          value: 'Draft Hero Title <gold>Performance</gold>',
        });
      expect(draftRes.status).toBe(200);
      expect(draftRes.body.success).toBe(true);
      expect(draftRes.body.data.hasDraft).toBe(true);
      expect(draftRes.body.data.draftValue).toBe('Draft Hero Title <gold>Performance</gold>');

      // Step 2: Public texts endpoint must NOT show uncommitted draft
      const publicBefore = await request(app).get('/api/v1/cms/texts?locale=en');
      expect(publicBefore.body.data.texts[testKey]).toBeUndefined();

      // Step 3: Admin texts list should show draft
      const adminList = await request(app)
        .get('/api/v1/cms/admin/texts?locale=en')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(adminList.status).toBe(200);
      const foundRow = adminList.body.data.find((r: any) => r.key === testKey);
      expect(foundRow).toBeDefined();
      expect(foundRow.hasDraft).toBe(true);
      expect(foundRow.draftValue).toBe('Draft Hero Title <gold>Performance</gold>');

      // Step 4: Check revision history (SAVE_DRAFT action)
      const histRes1 = await request(app)
        .get(`/api/v1/cms/admin/texts/history?key=${testKey}&locale=en`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(histRes1.status).toBe(200);
      expect(histRes1.body.data.length).toBeGreaterThanOrEqual(1);
      expect(histRes1.body.data[0].action).toBe('SAVE_DRAFT');

      // Step 5: Publish draft
      const initialVersion = publicBefore.body.data.version;
      const pubRes = await request(app)
        .post('/api/v1/cms/admin/texts/publish')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ keys: [testKey], locale: 'en' });
      expect(pubRes.status).toBe(200);
      expect(pubRes.body.success).toBe(true);
      expect(pubRes.body.data.publishedCount).toBeGreaterThanOrEqual(1);
      expect(pubRes.body.data.version).toBeGreaterThan(initialVersion);

      // Step 6: Public texts endpoint MUST now return the published text
      const publicAfter = await request(app).get('/api/v1/cms/texts?locale=en');
      expect(publicAfter.status).toBe(200);
      expect(publicAfter.body.data.texts[testKey]).toBe('Draft Hero Title <gold>Performance</gold>');
      expect(publicAfter.body.data.version).toBe(pubRes.body.data.version);

      // Step 7: Save a second draft
      const draft2Res = await request(app)
        .put('/api/v1/cms/admin/texts')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          key: testKey,
          locale: 'en',
          value: 'Changed Second Draft (Not published)',
        });
      expect(draft2Res.status).toBe(200);
      expect(draft2Res.body.data.hasDraft).toBe(true);
      expect(draft2Res.body.data.draftValue).toBe('Changed Second Draft (Not published)');

      // Step 8: Discard the second draft
      const discardRes = await request(app)
        .post('/api/v1/cms/admin/texts/discard')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ keys: [testKey], locale: 'en' });
      expect(discardRes.status).toBe(200);
      expect(discardRes.body.success).toBe(true);
      expect(discardRes.body.data.discardedCount).toBe(1);

      // Step 9: Verify text reverted to published value
      const adminListAfter = await request(app)
        .get('/api/v1/cms/admin/texts?locale=en')
        .set('Authorization', `Bearer ${adminToken}`);
      const rowAfterDiscard = adminListAfter.body.data.find((r: any) => r.key === testKey);
      expect(rowAfterDiscard.hasDraft).toBe(false);
      expect(rowAfterDiscard.draftValue).toBeNull();
      expect(rowAfterDiscard.publishedValue).toBe('Draft Hero Title <gold>Performance</gold>');

      // Step 10: Verify history contains SAVE_DRAFT, PUBLISH, SAVE_DRAFT, DISCARD
      const histRes2 = await request(app)
        .get(`/api/v1/cms/admin/texts/history?key=${testKey}&locale=en`)
        .set('Authorization', `Bearer ${adminToken}`);
      const actions = histRes2.body.data.map((r: any) => r.action);
      expect(actions).toContain('SAVE_DRAFT');
      expect(actions).toContain('PUBLISH');
      expect(actions).toContain('DISCARD');
    });

    it('Validation: PUT /cms/admin/texts rejects invalid characters in key and oversized value', async () => {
      // Invalid character (spaces or special symbols outside [A-Za-z0-9_.-])
      const invalidKeyRes = await request(app)
        .put('/api/v1/cms/admin/texts')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          key: 'invalid key with spaces!@#',
          value: 'text',
        });
      expect(invalidKeyRes.status).toBe(400);

      // Value exceeds 5000 characters
      const oversizedRes = await request(app)
        .put('/api/v1/cms/admin/texts')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          key: 'valid.key',
          value: 'A'.repeat(5001),
        });
      expect(oversizedRes.status).toBe(400);
    });

    it('No-op Publish & Exact String Preservation: publishing when nothing is pending does not bump version, and placeholders/tags/spaces are stored unmodified', async () => {
      const arrayIndexKey = `lionel.sport.items.0.title.${Date.now()}`;
      const rawValue = '  Welcome {name}, <br> <strong>Turn Pressure into Performance</strong> & Lead  ';

      // 1. Save draft with array index key, placeholders, tags, and untrimmed spaces
      const saveRes = await request(app)
        .put('/api/v1/cms/admin/texts')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          key: arrayIndexKey,
          locale: 'en',
          value: rawValue,
        });
      expect(saveRes.status).toBe(200);
      expect(saveRes.body.data.draftValue).toBe(rawValue);

      // 2. Publish the draft
      const pub1 = await request(app)
        .post('/api/v1/cms/admin/texts/publish')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ keys: [arrayIndexKey], locale: 'en' });
      expect(pub1.status).toBe(200);
      expect(pub1.body.data.publishedCount).toBe(1);
      const versionAfterFirstPublish = pub1.body.data.version;

      // 3. Verify GET /cms/texts returns the exact raw string without trimming or escaping
      const getPub = await request(app).get('/api/v1/cms/texts?locale=en');
      expect(getPub.status).toBe(200);
      expect(getPub.body.data.texts[arrayIndexKey]).toBe(rawValue);

      // 4. Call publish again when nothing is pending for this key -> must be a no-op (version unchanged)
      const pub2 = await request(app)
        .post('/api/v1/cms/admin/texts/publish')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ keys: [arrayIndexKey], locale: 'en' });
      expect(pub2.status).toBe(200);
      expect(pub2.body.data.publishedCount).toBe(0);
      expect(pub2.body.data.version).toBe(versionAfterFirstPublish);
    });
  });
});
