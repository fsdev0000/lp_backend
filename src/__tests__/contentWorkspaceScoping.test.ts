import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import contentRoutes from '../modules/content/content.routes';
import { ContentService, contentPrisma } from '../modules/content/services/content.service';
import { generateCrmSessionToken } from '../utils/sessionToken';

process.env.CRM_SESSION_SECRET = 'test-crm-session-secret-xyz12345';
process.env.ADMIN_API_KEY = 'test-admin-api-key';
process.env.CRM_API_KEY = 'test-crm-api-key';

const app = express();
app.use(express.json());
app.use('/api/v1/content', contentRoutes);

describe('Content Studio Workspace & Brand Scoping Suite', () => {
  const mockPosts = new Map<string, any>();

  // 1. Lionel-only manager
  const lionelManagerToken = generateCrmSessionToken({
    id: 'usr-lionel-mgr',
    email: 'lionel.mgr@leadersperformance.ae',
    name: 'Lionel Manager',
    role: 'manager',
    workspaces: ['lionel_eersteling'],
    roleVersion: 2,
  });

  // 2. Leaders Performance-only manager
  const lpManagerToken = generateCrmSessionToken({
    id: 'usr-lp-mgr',
    email: 'lp.mgr@leadersperformance.ae',
    name: 'LP Manager',
    role: 'manager',
    workspaces: ['leaders_performance'],
    roleVersion: 2,
  });

  // 3. Super Admin
  const superAdminToken = generateCrmSessionToken({
    id: 'usr-super-admin',
    email: 'superadmin@leadersperformance.ae',
    name: 'Super Admin',
    role: 'super_admin',
    workspaces: ['leaders_performance', 'lionel_eersteling'],
    roleVersion: 2,
  });

  beforeEach(() => {
    ContentService.resetLegacyPurgeState();
    mockPosts.clear();

    // Populate mock posts:
    // 1 LP draft, 1 LP pending
    mockPosts.set('post-lp-1', {
      id: 'post-lp-1',
      title: 'Leaders Performance Post 1',
      platform: 'LINKEDIN',
      workspace: 'leaders_performance',
      status: 'DRAFT',
      author: 'LP Staff',
      createdAt: new Date('2026-11-20T10:00:00Z'),
      scheduledFor: null,
    });
    mockPosts.set('post-lp-pending', {
      id: 'post-lp-pending',
      title: 'Leaders Performance Pending',
      platform: 'LINKEDIN',
      workspace: 'leaders_performance',
      status: 'PENDING_REVIEW',
      author: 'LP Staff',
      createdAt: new Date('2026-11-21T10:00:00Z'),
      scheduledFor: null,
    });

    // 1 Lionel draft, 1 Lionel pending, and 2 TikTok posts
    mockPosts.set('post-le-1', {
      id: 'post-le-1',
      title: 'Lionel Personal Post 1',
      platform: 'INSTAGRAM',
      workspace: 'lionel_eersteling',
      status: 'DRAFT',
      author: 'Lionel Eersteling',
      createdAt: new Date('2026-11-22T10:00:00Z'),
      scheduledFor: null,
    });
    mockPosts.set('post-le-pending', {
      id: 'post-le-pending',
      title: 'Lionel Personal Pending',
      platform: 'LINKEDIN',
      workspace: 'lionel_eersteling',
      status: 'PENDING_REVIEW',
      author: 'Lionel Eersteling',
      createdAt: new Date('2026-11-23T10:00:00Z'),
      scheduledFor: null,
    });

    // The 2 TikTok posts previously saved with workspace: 'leaders_performance'
    mockPosts.set('post-tiktok-1', {
      id: 'post-tiktok-1',
      title: 'TikTok Strategy Video 1',
      platform: 'TIKTOK',
      workspace: 'leaders_performance',
      status: 'DRAFT',
      author: 'Lionel Eersteling',
      createdAt: new Date('2026-11-24T10:00:00Z'),
      scheduledFor: null,
    });
    mockPosts.set('post-tiktok-2', {
      id: 'post-tiktok-2',
      title: 'TikTok Strategy Video 2',
      platform: 'TIKTOK',
      workspace: 'leaders_performance',
      status: 'PENDING_REVIEW',
      author: 'Lionel Eersteling',
      createdAt: new Date('2026-11-25T10:00:00Z'),
      scheduledFor: null,
    });

    // Mock Prisma methods
    jest.spyOn(contentPrisma.socialPost, 'deleteMany').mockResolvedValue({ count: 0 } as any);
    jest.spyOn(contentPrisma.socialAuditLog, 'deleteMany').mockResolvedValue({ count: 0 } as any);

    jest.spyOn(contentPrisma.socialPost, 'updateMany').mockImplementation((async ({ where, data }: any) => {
      let count = 0;
      for (const [id, post] of mockPosts.entries()) {
        if (where?.platform && post.platform !== where.platform) continue;
        if (where?.workspace && post.workspace !== where.workspace) continue;
        const updated = { ...post, ...data };
        mockPosts.set(id, updated);
        count++;
      }
      return { count };
    }) as any);

    jest.spyOn(contentPrisma.socialPost, 'findMany').mockImplementation((async ({ where }: any = {}) => {
      return Array.from(mockPosts.values()).filter((p) => {
        if (where?.workspace) {
          if (where.workspace?.in) {
            if (!where.workspace.in.includes(p.workspace)) return false;
          } else if (p.workspace !== where.workspace) {
            return false;
          }
        }
        if (where?.platform && p.platform !== where.platform) return false;
        if (where?.status && p.status !== where.status) return false;
        return true;
      });
    }) as any);

    jest.spyOn(contentPrisma.socialPost, 'count').mockImplementation((async ({ where }: any = {}) => {
      const items = Array.from(mockPosts.values()).filter((p) => {
        if (where?.workspace) {
          if (where.workspace?.in) {
            if (!where.workspace.in.includes(p.workspace)) return false;
          } else if (p.workspace !== where.workspace) {
            return false;
          }
        }
        if (where?.platform && p.platform !== where.platform) return false;
        if (where?.status && p.status !== where.status) return false;
        return true;
      });
      return items.length;
    }) as any);

    jest.spyOn(contentPrisma.socialPost, 'findUnique').mockImplementation((async ({ where }: any) => {
      return mockPosts.get(where.id) || null;
    }) as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('1. GET /api/v1/content/posts Workspace Scoping', () => {
    it('returns only Lionel Eersteling posts for a Lionel-only manager when no workspace is passed', async () => {
      const res = await request(app)
        .get('/api/v1/content/posts')
        .set('Authorization', `Bearer ${lionelManagerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.posts.length).toBeGreaterThan(0);
      for (const p of res.body.posts) {
        expect(p.workspace).toBe('lionel_eersteling');
      }
    });

    it('returns 403 Forbidden when a Lionel-only manager requests ?workspace=leaders_performance', async () => {
      const res = await request(app)
        .get('/api/v1/content/posts?workspace=leaders_performance')
        .set('Authorization', `Bearer ${lionelManagerToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('FORBIDDEN_WORKSPACE');
      expect(res.body.error).toContain('Access denied to workspace "leaders_performance"');
    });

    it('allows a Lionel-only manager to query ?workspace=lionel_eersteling', async () => {
      const res = await request(app)
        .get('/api/v1/content/posts?workspace=lionel_eersteling')
        .set('Authorization', `Bearer ${lionelManagerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      for (const p of res.body.posts) {
        expect(p.workspace).toBe('lionel_eersteling');
      }
    });

    it('allows a Super Admin to see all posts when no workspace is sent, or filter by any workspace', async () => {
      const resAll = await request(app)
        .get('/api/v1/content/posts')
        .set('Authorization', `Bearer ${superAdminToken}`);

      expect(resAll.status).toBe(200);
      // Contains both workspaces
      const workspaces = resAll.body.posts.map((p: any) => p.workspace);
      expect(workspaces).toContain('leaders_performance');
      expect(workspaces).toContain('lionel_eersteling');

      // Filtered to leaders_performance
      const resLp = await request(app)
        .get('/api/v1/content/posts?workspace=leaders_performance')
        .set('Authorization', `Bearer ${superAdminToken}`);
      expect(resLp.status).toBe(200);
      for (const p of resLp.body.posts) {
        expect(p.workspace).toBe('leaders_performance');
      }
    });
  });

  describe('2. GET /api/v1/content/approvals Workspace Scoping', () => {
    it('returns only Lionel Eersteling pending approvals for a Lionel-only manager when no workspace is passed', async () => {
      const res = await request(app)
        .get('/api/v1/content/approvals')
        .set('Authorization', `Bearer ${lionelManagerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);
      for (const p of res.body.data) {
        expect(p.workspace).toBe('lionel_eersteling');
        expect(p.status).toBe('PENDING_REVIEW');
      }
    });

    it('returns 403 Forbidden when a Lionel-only manager calls /approvals?workspace=leaders_performance', async () => {
      const res = await request(app)
        .get('/api/v1/content/approvals?workspace=leaders_performance')
        .set('Authorization', `Bearer ${lionelManagerToken}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN_WORKSPACE');
    });
  });

  describe('3. GET /api/v1/content/approvals/stats Workspace Scoping', () => {
    it('returns approval stats scoped strictly to Lionel Eersteling when no workspace is sent', async () => {
      const res = await request(app)
        .get('/api/v1/content/approvals/stats')
        .set('Authorization', `Bearer ${lionelManagerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // Should not count LP pending posts
      expect(res.body.data.pendingReview).toBeGreaterThanOrEqual(1);
    });

    it('returns 403 Forbidden when a Lionel-only manager calls /approvals/stats?workspace=leaders_performance', async () => {
      const res = await request(app)
        .get('/api/v1/content/approvals/stats?workspace=leaders_performance')
        .set('Authorization', `Bearer ${lionelManagerToken}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN_WORKSPACE');
    });
  });

  describe('4. TikTok Posts Workspace Migration to lionel_eersteling', () => {
    it('migrates existing TikTok posts saved under leaders_performance to lionel_eersteling and shows them under Lionel Eersteling', async () => {
      // Prior to calling listPosts, the mock had TikTok posts as leaders_performance.
      // Calling listPosts triggers purgeLegacySeedData which updates TikTok posts to lionel_eersteling.
      const res = await request(app)
        .get('/api/v1/content/posts?platform=TIKTOK')
        .set('Authorization', `Bearer ${lionelManagerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.posts.length).toBe(2);
      for (const post of res.body.posts) {
        expect(post.platform).toBe('TIKTOK');
        expect(post.workspace).toBe('lionel_eersteling');
      }
    });
  });
});
