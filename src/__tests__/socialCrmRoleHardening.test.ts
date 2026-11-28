import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import contentRoutes from '../modules/content/content.routes';
import instagramRoutes from '../modules/social/instagram.routes';
import linkedinRoutes from '../modules/social/linkedin.routes';
import { contentPrisma } from '../modules/content/services/content.service';
import { socialPrisma } from '../modules/social/adapters/linkedin.adapter';
import { InstagramAdapter } from '../modules/social/adapters/instagram.adapter';
import { generateCrmSessionToken } from '../utils/sessionToken';

process.env.CRM_SESSION_SECRET = 'test-crm-session-secret-xyz12345';
process.env.ADMIN_API_KEY = 'test-admin-api-key';
process.env.CRM_API_KEY = 'test-crm-api-key';

const app = express();
app.use(express.json());
app.use('/api/v1/content', contentRoutes);
app.use('/api/v1/social/instagram', instagramRoutes);
app.use('/api/v1/social/linkedin', linkedinRoutes);

describe('Social CRM Role Hardening Suite', () => {
  const mockPosts = new Map<string, any>();

  const superAdminToken = generateCrmSessionToken({
    id: 'usr-super-admin',
    email: 'superadmin@leadersperformance.ae',
    name: 'Super Admin',
    role: 'super_admin',
    workspaces: ['leaders_performance', 'lionel_eersteling'],
    roleVersion: 2,
  });

  const adminToken = generateCrmSessionToken({
    id: 'usr-admin',
    email: 'admin@leadersperformance.ae',
    name: 'Admin User',
    role: 'admin',
    workspaces: ['leaders_performance', 'lionel_eersteling'],
    roleVersion: 2,
  });

  const managerToken = generateCrmSessionToken({
    id: 'usr-manager',
    email: 'manager@leadersperformance.ae',
    name: 'Manager User',
    role: 'manager',
    workspaces: ['leaders_performance', 'lionel_eersteling'],
    roleVersion: 2,
  });

  const userAliceToken = generateCrmSessionToken({
    id: 'usr-alice',
    email: 'alice@leadersperformance.ae',
    name: 'Alice User',
    role: 'user',
    workspaces: ['leaders_performance'],
    roleVersion: 2,
  });

  const userBobToken = generateCrmSessionToken({
    id: 'usr-bob',
    email: 'bob@leadersperformance.ae',
    name: 'Bob User',
    role: 'user',
    workspaces: ['leaders_performance'],
    roleVersion: 2,
  });

  beforeEach(() => {
    process.env.CRM_SESSION_SECRET = 'test-crm-session-secret-xyz12345';
    process.env.ADMIN_API_KEY = 'test-admin-api-key';
    process.env.CRM_API_KEY = 'test-crm-api-key';
    process.env.LINKEDIN_PUBLISHING_ENABLED = 'false';

    mockPosts.clear();

    jest.spyOn(InstagramAdapter.prototype, 'disconnect').mockImplementation(async () => {});
    jest.spyOn(socialPrisma.socialAccountConnection, 'deleteMany').mockResolvedValue({ count: 1 } as any);
    jest.spyOn(socialPrisma.socialAuditLog, 'create').mockResolvedValue({} as any);

    jest.spyOn(contentPrisma.socialPost, 'findUnique').mockImplementation((async ({ where }: any) => {
      return mockPosts.get(where.id) || null;
    }) as any);

    jest.spyOn(contentPrisma.socialPost, 'delete').mockImplementation((async ({ where }: any) => {
      mockPosts.delete(where.id);
      return { id: where.id };
    }) as any);

    jest.spyOn(contentPrisma.socialAuditLog, 'create').mockResolvedValue({} as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('1. Instagram /disconnect Role Guard', () => {
    it('returns 403 Forbidden when a "user" tries to disconnect Instagram', async () => {
      const res = await request(app)
        .post('/api/v1/social/instagram/disconnect')
        .set('Authorization', `Bearer ${userAliceToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('FORBIDDEN_ROLE');
    });

    it('returns 403 Forbidden when a "manager" tries to disconnect Instagram', async () => {
      const res = await request(app)
        .post('/api/v1/social/instagram/disconnect')
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('FORBIDDEN_ROLE');
    });

    it('allows an "admin" to disconnect Instagram (returns 200)', async () => {
      const res = await request(app)
        .post('/api/v1/social/instagram/disconnect')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('allows a "super_admin" to disconnect Instagram (returns 200)', async () => {
      const res = await request(app)
        .post('/api/v1/social/instagram/disconnect')
        .set('Authorization', `Bearer ${superAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('2. LinkedIn /share Route Restriction', () => {
    it('returns 403 Forbidden when a "user" calls /linkedin/share', async () => {
      const res = await request(app)
        .post('/api/v1/social/linkedin/share')
        .set('Authorization', `Bearer ${userAliceToken}`)
        .send({ text: 'User post attempt' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN_ROLE');
    });

    it('returns 403 Forbidden when a "manager" calls /linkedin/share (route restricted to super_admin)', async () => {
      const res = await request(app)
        .post('/api/v1/social/linkedin/share')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ text: 'Manager post attempt' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN_ROLE');
    });

    it('allows "super_admin" past role check on /linkedin/share (kill switch check executes)', async () => {
      const res = await request(app)
        .post('/api/v1/social/linkedin/share')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ text: 'Super admin post attempt' });

      // Because LINKEDIN_PUBLISHING_ENABLED is false, controller returns 403 with kill-switch message, NOT FORBIDDEN_ROLE
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('LinkedIn publishing is currently disabled');
    });
  });

  describe('3. Post Deletion Ownership & Role Hardening', () => {
    beforeEach(() => {
      mockPosts.set('alice-draft', {
        id: 'alice-draft',
        title: 'Alice Draft Post',
        status: 'DRAFT',
        author: 'Alice User',
        workspace: 'leaders_performance',
      });

      mockPosts.set('bob-draft', {
        id: 'bob-draft',
        title: 'Bob Draft Post',
        status: 'DRAFT',
        author: 'bob@leadersperformance.ae',
        workspace: 'leaders_performance',
      });

      mockPosts.set('alice-pending', {
        id: 'alice-pending',
        title: 'Alice Pending Post',
        status: 'PENDING_REVIEW',
        author: 'Alice User',
        workspace: 'leaders_performance',
      });

      mockPosts.set('published-post', {
        id: 'published-post',
        title: 'Published Live Post',
        status: 'PUBLISHED',
        author: 'Alice User',
        workspace: 'leaders_performance',
      });
    });

    it('blocks a "user" with 403 when trying to delete another user\'s draft post', async () => {
      const res = await request(app)
        .delete('/api/v1/content/posts/bob-draft')
        .set('Authorization', `Bearer ${userAliceToken}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Forbidden: Users may only delete their own drafts');
      expect(mockPosts.has('bob-draft')).toBe(true);
    });

    it('blocks a "user" with 403 when trying to delete their own non-draft post (e.g. PENDING_REVIEW)', async () => {
      const res = await request(app)
        .delete('/api/v1/content/posts/alice-pending')
        .set('Authorization', `Bearer ${userAliceToken}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Forbidden: Users may only delete draft posts');
      expect(mockPosts.has('alice-pending')).toBe(true);
    });

    it('blocks a "user" with 403 when trying to delete a PUBLISHED post', async () => {
      const res = await request(app)
        .delete('/api/v1/content/posts/published-post')
        .set('Authorization', `Bearer ${userAliceToken}`);

      expect(res.status).toBe(403);
      expect(mockPosts.has('published-post')).toBe(true);
    });

    it('allows a "user" to delete their own DRAFT post (returns 200)', async () => {
      const res = await request(app)
        .delete('/api/v1/content/posts/alice-draft')
        .set('Authorization', `Bearer ${userAliceToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockPosts.has('alice-draft')).toBe(false);
    });

    it('allows a "manager" to delete any non-published post (draft or pending_review)', async () => {
      const res = await request(app)
        .delete('/api/v1/content/posts/alice-pending')
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockPosts.has('alice-pending')).toBe(false);
    });

    it('prevents a "manager" from deleting a PUBLISHED post with HTTP 400', async () => {
      const res = await request(app)
        .delete('/api/v1/content/posts/published-post')
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Cannot delete an already published post');
      expect(mockPosts.has('published-post')).toBe(true);
    });

    it('prevents a "super_admin" from deleting a PUBLISHED post with HTTP 400', async () => {
      const res = await request(app)
        .delete('/api/v1/content/posts/published-post')
        .set('Authorization', `Bearer ${superAdminToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Cannot delete an already published post');
      expect(mockPosts.has('published-post')).toBe(true);
    });

    it('denies post deletion with 403 when user role is missing', async () => {
      const contentService = new (require('../modules/content/services/content.service').ContentService)();
      await expect(contentService.deletePost('alice-draft', undefined, 'Unknown', undefined)).rejects.toMatchObject({
        statusCode: 403,
        message: 'Forbidden: User role is required to delete posts.',
      });

      expect(mockPosts.has('alice-draft')).toBe(true);
    });

    it('returns 403 on DELETE /api/v1/content/posts/:id when authenticated user has no role property', async () => {
      const appWithMissingRole = express();
      appWithMissingRole.use(express.json());
      appWithMissingRole.use((req, _res, next) => {
        (req as any).crmUser = { id: 'usr-norole', email: 'norole@leadersperformance.ae' };
        next();
      });
      const controller = new (require('../modules/content/controllers/content.controller').ContentController)();
      appWithMissingRole.delete('/api/v1/content/posts/:id', controller.deletePost);

      const res = await request(appWithMissingRole).delete('/api/v1/content/posts/alice-draft');
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Forbidden: User role is required to delete posts');
      expect(mockPosts.has('alice-draft')).toBe(true);
    });
  });
});
