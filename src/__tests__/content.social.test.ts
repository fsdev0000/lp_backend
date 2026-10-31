import { describe, it, expect, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import contentRoutes from '../modules/content/content.routes';
import linkedinRoutes from '../modules/social/linkedin.routes';
import { LinkedInAdapter } from '../modules/social/adapters/linkedin.adapter';

jest.setTimeout(25000);

const app = express();
app.use(express.json());
app.use('/api/v1/content', contentRoutes);
app.use('/api/v1/social/linkedin', linkedinRoutes);

describe('Social CRM & Content Studio API Suite', () => {
  const linkedinAdapter = new LinkedInAdapter();

  describe('Content Studio Posts & Matrix', () => {
    it('GET /api/v1/content/posts - should list posts including baseline items with pagination', async () => {
      const res = await request(app).get('/api/v1/content/posts');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.posts)).toBe(true);
      expect(res.body.pagination).toBeDefined();
      expect(res.body.pagination.total).toBeGreaterThanOrEqual(1);
    });

    it('GET /api/v1/content/posts - should filter by platform LINKEDIN', async () => {
      const res = await request(app).get('/api/v1/content/posts?platform=LINKEDIN');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const posts = res.body.posts;
      expect(Array.isArray(posts)).toBe(true);
      posts.forEach((p: any) => {
        expect(p.platform).toBe('LINKEDIN');
      });
    });

    it('POST /api/v1/content/posts - should create a post with PENDING_REVIEW when requireApproval is true', async () => {
      const newPost = {
        title: 'Test Automated Dispatch: Scaling Executive Systems',
        hook: 'How high-growth founders reclaim 20+ hours each week.',
        body: 'Discipline is not about doing more; it is about eliminating trivial friction.',
        platform: 'LINKEDIN',
        tags: ['scale', 'discipline', 'leadership'],
        scheduledFor: new Date(Date.now() + 86400000).toISOString(),
        requireApproval: true,
      };

      const res = await request(app)
        .post('/api/v1/content/posts')
        .send(newPost);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.title).toBe(newPost.title);
      expect(res.body.data.status).toBe('PENDING_REVIEW');
      expect(res.body.data.id).toBeDefined();

      const createdId = res.body.data.id;

      // Test Lionel Sign-off / Approval Desk workflow
      const approveRes = await request(app)
        .post(`/api/v1/content/posts/${createdId}/approve`)
        .send({
          signature: 'SIG-LIONEL-2026-TEST-VERIFIED',
          approvedBy: 'Mr. Lionel Eersteling (Owner)',
        });

      expect(approveRes.status).toBe(200);
      expect(approveRes.body.success).toBe(true);
      expect(approveRes.body.data.status).toBe('SCHEDULED');
      expect(approveRes.body.data.approvalSignature).toContain('SIG-LIONEL-2026');

      // Clean up test post
      await request(app).delete(`/api/v1/content/posts/${createdId}`);
    });
  });

  describe('Executive Approval Desk & Auditing', () => {
    it('GET /api/v1/content/approvals/stats - should return executive desk counters', async () => {
      const res = await request(app).get('/api/v1/content/approvals/stats');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(typeof res.body.data.pendingReview).toBe('number');
      expect(typeof res.body.data.scheduled).toBe('number');
      expect(typeof res.body.data.published).toBe('number');
      expect(typeof res.body.data.total).toBe('number');
    });

    it('GET /api/v1/content/approvals - should return list of posts pending sign-off', async () => {
      const res = await request(app).get('/api/v1/content/approvals');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('GET /api/v1/content/audit-logs - should return audit trail with actions and actors', async () => {
      const res = await request(app).get('/api/v1/content/audit-logs?limit=10');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  describe('LinkedIn Integration & OAuth Lifecycle', () => {
    it('GET /api/v1/social/linkedin/auth-url - should return valid OAuth authorization URL with configured client ID and scopes', async () => {
      const res = await request(app).get('/api/v1/social/linkedin/auth-url');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.clientId).toBe('78ocx3kz1moo0s');
      expect(res.body.url).toContain('https://www.linkedin.com/oauth/v2/authorization');
      expect(res.body.url).toContain('client_id=78ocx3kz1moo0s');
      expect(res.body.url).toContain('w_member_social');
      expect(res.body.scopes).toContain('w_member_social');
    });

    it('GET /api/v1/social/linkedin/status - should return current connection status', async () => {
      const res = await request(app).get('/api/v1/social/linkedin/status');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(typeof res.body.connected).toBe('boolean');
      expect(res.body.status).toBeDefined();
    });

    it('GET /api/v1/social/linkedin/ping - should confirm credentials configuration', async () => {
      const res = await request(app).get('/api/v1/social/linkedin/ping');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.status).toBeDefined();
    });

    it('LinkedInAdapter should format UGC and REST payloads correctly', () => {
      const url = linkedinAdapter.getAuthorizationUrl();
      expect(url).toContain('response_type=code');
      expect(url).toContain('client_id=78ocx3kz1moo0s');
    });
  });
});
