import { describe, it, expect, beforeEach } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { requireApiKey } from '../middleware/apiKeyAuth';

describe('requireApiKey Service Key Scoping & Boundary Enforcement', () => {
  const ADMIN_KEY = 'test-admin-secret-key-12345';
  const CRM_KEY = 'test-crm-secret-key-67890';
  const ARTICLES_KEY = 'test-articles-secret-key-abcde';
  const NEWSLETTER_KEY = 'test-newsletter-secret-key-fghij';
  const NEWSLETTER_SEND_KEY = 'test-newsletter-send-secret-key-klmno';

  let app: express.Express;

  beforeEach(() => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    process.env.CRM_API_KEY = CRM_KEY;
    process.env.ARTICLES_API_KEY = ARTICLES_KEY;
    process.env.NEWSLETTER_API_KEY = NEWSLETTER_KEY;
    process.env.NEWSLETTER_SEND_API_KEY = NEWSLETTER_SEND_KEY;

    app = express();
    app.use(express.json());

    // CRM, Content, and Social routes protected by requireApiKey
    app.use('/api/v1/content', requireApiKey, (req, res) => {
      res.status(200).json({ success: true, route: 'content', user: req.crmUser });
    });
    app.use('/api/v1/social/linkedin', requireApiKey, (req, res) => {
      res.status(200).json({ success: true, route: 'linkedin', user: req.crmUser });
    });
    app.use('/api/v1/social/instagram', requireApiKey, (req, res) => {
      res.status(200).json({ success: true, route: 'instagram', user: req.crmUser });
    });
    app.use('/api/v1/social/tiktok', requireApiKey, (req, res) => {
      res.status(200).json({ success: true, route: 'tiktok', user: req.crmUser });
    });

    // Dedicated domain routes
    app.use('/api/v1/articles', requireApiKey, (req, res) => {
      res.status(200).json({ success: true, route: 'articles', user: req.crmUser });
    });
    app.use('/api/v1/newsletter', requireApiKey, (req, res) => {
      res.status(200).json({ success: true, route: 'newsletter', user: req.crmUser });
    });
  });

  describe('Condition 1: ARTICLES_API_KEY and NEWSLETTER keys get 403 on CRM & social routes', () => {
    it('blocks ARTICLES_API_KEY on /api/v1/content with 403 Forbidden', async () => {
      const res = await request(app)
        .get('/api/v1/content/posts')
        .set('x-api-key', ARTICLES_KEY);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Forbidden: Service API key is not authorized');
    });

    it('blocks ARTICLES_API_KEY on /api/v1/social/linkedin with 403 Forbidden', async () => {
      const res = await request(app)
        .post('/api/v1/social/linkedin/share')
        .set('x-api-key', ARTICLES_KEY)
        .send({ text: 'Unauthorized post' });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Forbidden: Service API key is not authorized');
    });

    it('blocks ARTICLES_API_KEY on /api/v1/social/instagram with 403 Forbidden', async () => {
      const res = await request(app)
        .post('/api/v1/social/instagram/disconnect')
        .set('x-api-key', ARTICLES_KEY);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Forbidden: Service API key is not authorized');
    });

    it('blocks ARTICLES_API_KEY on /api/v1/social/tiktok with 403 Forbidden', async () => {
      const res = await request(app)
        .post('/api/v1/social/tiktok/publish')
        .set('x-api-key', ARTICLES_KEY)
        .send({ text: 'Unauthorized post' });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Forbidden: Service API key is not authorized');
    });

    it('blocks NEWSLETTER_API_KEY on /api/v1/content with 403 Forbidden', async () => {
      const res = await request(app)
        .get('/api/v1/content/posts')
        .set('x-api-key', NEWSLETTER_KEY);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Forbidden: Service API key is not authorized');
    });

    it('blocks NEWSLETTER_SEND_API_KEY on /api/v1/social/linkedin with 403 Forbidden', async () => {
      const res = await request(app)
        .get('/api/v1/social/linkedin/status')
        .set('x-api-key', NEWSLETTER_SEND_KEY);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Forbidden: Service API key is not authorized');
    });

    it('allows ARTICLES_API_KEY on /api/v1/articles without setting super_admin', async () => {
      const res = await request(app)
        .get('/api/v1/articles/some-slug')
        .set('x-api-key', ARTICLES_KEY);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // Service key must NOT be granted CRM super_admin
      expect(res.body.user).toBeUndefined();
    });

    it('allows NEWSLETTER_API_KEY on /api/v1/newsletter without setting super_admin', async () => {
      const res = await request(app)
        .get('/api/v1/newsletter/campaigns')
        .set('x-api-key', NEWSLETTER_KEY);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.user).toBeUndefined();
    });
  });

  describe('Condition 2: ADMIN_API_KEY and CRM_API_KEY still work as super_admin', () => {
    it('grants super_admin on /api/v1/content with ADMIN_API_KEY via x-api-key header', async () => {
      const res = await request(app)
        .get('/api/v1/content/posts')
        .set('x-api-key', ADMIN_KEY);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.user).toBeDefined();
      expect(res.body.user.role).toBe('super_admin');
    });

    it('grants super_admin on /api/v1/social/linkedin with CRM_API_KEY via x-api-key header', async () => {
      const res = await request(app)
        .get('/api/v1/social/linkedin/status')
        .set('x-api-key', CRM_KEY);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.user.role).toBe('super_admin');
    });

    it('grants super_admin on /api/v1/social/instagram with ADMIN_API_KEY via Bearer auth', async () => {
      const res = await request(app)
        .get('/api/v1/social/instagram/status')
        .set('Authorization', `Bearer ${ADMIN_KEY}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.user.role).toBe('super_admin');
    });
  });

  describe('Condition 3: Keys in the URL stay refused (401 Unauthorized)', () => {
    it('refuses ?api_key= on /api/v1/content/posts with 401 Unauthorized', async () => {
      const res = await request(app).get(`/api/v1/content/posts?api_key=${ADMIN_KEY}`);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Unauthorized: Valid x-api-key header or Bearer token is required');
    });

    it('refuses ?apiKey= on /api/v1/social/linkedin/status with 401 Unauthorized', async () => {
      const res = await request(app).get(`/api/v1/social/linkedin/status?apiKey=${CRM_KEY}`);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('refuses ?token= on /api/v1/social/instagram/status with 401 Unauthorized', async () => {
      const res = await request(app).get(`/api/v1/social/instagram/status?token=${ADMIN_KEY}`);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('refuses ?api_key= on /api/v1/social/tiktok/status with 401 Unauthorized', async () => {
      const res = await request(app).get(`/api/v1/social/tiktok/status?api_key=${ADMIN_KEY}`);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });
  });
});
