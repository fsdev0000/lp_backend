import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import request from 'supertest';
import express, { Request, Response } from 'express';
import { generateCrmSessionToken } from '../utils/sessionToken';
import { requireCrmAuth, requireWorkspaceAuth } from '../middleware/crmRoleAuth';
import { requireCmsAdmin, authenticateCmsAdmin } from '../middleware/cmsAuth';
import { crmPostsService } from '../modules/automation/review/crmPosts.service';
import { crmPostsController } from '../modules/automation/controllers/crmPosts.controller';
import { automationPrisma } from '../modules/automation/state/transition';
import { ContentController } from '../modules/content/controllers/content.controller';

const TEST_SECRET = 'test-crm-session-secret-xyz12345';
process.env.CRM_SESSION_SECRET = TEST_SECRET;
process.env.ADMIN_API_KEY = 'test-admin-secret-key';
process.env.CRM_API_KEY = 'test-crm-secret-key';

describe('Hardening Brand Resolution, CMS Lockdown, and Calendar Workspace Suite', () => {
  beforeEach(() => {
    process.env.CRM_SESSION_SECRET = TEST_SECRET;
  });

  // Tokens
  const lionelOnlyManagerToken = generateCrmSessionToken({
    id: 'usr-lionel-mgr',
    email: 'lionel.mgr@leadersperformance.ae',
    name: 'Lionel Manager',
    role: 'manager',
    workspaces: ['lionel_eersteling'],
    roleVersion: 2,
  });

  const lpOnlyManagerToken = generateCrmSessionToken({
    id: 'usr-lp-mgr',
    email: 'lp.mgr@leadersperformance.ae',
    name: 'LP Manager',
    role: 'manager',
    workspaces: ['leaders_performance'],
    roleVersion: 2,
  });

  const superAdminToken = generateCrmSessionToken({
    id: 'usr-super-admin',
    email: 'superadmin@leadersperformance.ae',
    name: 'Super Admin',
    role: 'super_admin',
    workspaces: ['leaders_performance', 'lionel_eersteling'],
    roleVersion: 2,
  });

  const lionelOnlyUserToken = generateCrmSessionToken({
    id: 'usr-lionel-user',
    email: 'lionel.user@leadersperformance.ae',
    name: 'Lionel User',
    role: 'user',
    workspaces: ['lionel_eersteling'],
    roleVersion: 2,
  });

  /* ------------------------------------------------------------------------
   * 1. Analytics Brand Resolution & Workspace Guard
   * ------------------------------------------------------------------------ */
  describe('1. Analytics Brand Resolution & Workspace Guard', () => {
    let app: express.Express;

    beforeEach(() => {
      app = express();
      app.use(express.json());
      app.use('/api/v1/analytics', requireCrmAuth, requireWorkspaceAuth, (req: Request, res: Response) => {
        res.status(200).json({
          success: true,
          crmWorkspace: (req as any).crmWorkspace,
          crmDomain: (req as any).crmDomain,
          crmWebsite: (req as any).crmWebsite,
          queryDomain: req.query.domain,
          queryWorkspace: req.query.workspace,
        });
      });
    });

    it('resolves domain to lioneleersteling.com when Lionel-only manager queries ?workspace=lionel_eersteling', async () => {
      const res = await request(app)
        .get('/api/v1/analytics/overview?workspace=lionel_eersteling')
        .set('Authorization', `Bearer ${lionelOnlyManagerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.crmWorkspace).toBe('lionel_eersteling');
      expect(res.body.crmDomain).toBe('lioneleersteling.com');
      expect(res.body.queryDomain).toBe('lioneleersteling.com');
    });

    it('defaults domain to lioneleersteling.com when Lionel-only manager sends no parameters', async () => {
      const res = await request(app)
        .get('/api/v1/analytics/overview')
        .set('Authorization', `Bearer ${lionelOnlyManagerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.crmWorkspace).toBe('lionel_eersteling');
      expect(res.body.crmDomain).toBe('lioneleersteling.com');
      expect(res.body.queryDomain).toBe('lioneleersteling.com');
    });

    it('returns 403 FORBIDDEN_WORKSPACE when Lionel-only manager requests ?domain=leadersperformance.ae', async () => {
      const res = await request(app)
        .get('/api/v1/analytics/overview?domain=leadersperformance.ae')
        .set('Authorization', `Bearer ${lionelOnlyManagerToken}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN_WORKSPACE');
      expect(res.body.error).toContain('Access denied to workspace "leaders_performance"');
    });

    it('returns 403 FORBIDDEN_WORKSPACE when caller supplies conflicting brand parameters', async () => {
      const res = await request(app)
        .get('/api/v1/analytics/overview?workspace=lionel_eersteling&domain=leadersperformance.ae')
        .set('Authorization', `Bearer ${superAdminToken}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN_WORKSPACE');
      expect(res.body.error).toContain('Conflicting brand parameters');
    });
  });

  /* ------------------------------------------------------------------------
   * 2. CMS Brand Lockdown: Strictly leaders_performance
   * ------------------------------------------------------------------------ */
  describe('2. CMS Brand Lockdown', () => {
    let app: express.Express;

    beforeEach(() => {
      app = express();
      app.use(express.json());
      app.use('/api/v1/cms/admin', requireCmsAdmin, (_req: Request, res: Response) => {
        res.status(200).json({ success: true, message: 'CMS write authorized' });
      });
    });

    it('refuses Lionel-only manager with 403 even if they pass workspace=lionel_eersteling', async () => {
      const res = await request(app)
        .put('/api/v1/cms/admin/texts?workspace=lionel_eersteling')
        .set('Authorization', `Bearer ${lionelOnlyManagerToken}`)
        .send({ key: 'homepage.title', value: 'Updated title' });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('CMS texts belong to leadersperformance.ae');
    });

    it('allows a manager with leaders_performance workspace access', async () => {
      const res = await request(app)
        .put('/api/v1/cms/admin/texts')
        .set('Authorization', `Bearer ${lpOnlyManagerToken}`)
        .send({ key: 'homepage.title', value: 'Updated title' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('allows a Super Admin to write CMS texts', async () => {
      const res = await request(app)
        .put('/api/v1/cms/admin/texts')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ key: 'homepage.title', value: 'Updated title' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  /* ------------------------------------------------------------------------
   * 3. Calendar Post Workspace Checks (Actions by Post ID)
   * ------------------------------------------------------------------------ */
  describe('3. Calendar Post Workspace Checks', () => {
    const lpPost = {
      id: 'cal-post-lp-1',
      platform: 'LINKEDIN',
      title: 'Leaders Performance Post',
      caption: 'LP Caption',
      workspace: 'leaders_performance',
      status: 'PENDING_REVIEW',
      scheduledAt: new Date(),
      revision: 1,
      media: [],
      revisions: [],
      reviewEvents: [],
      attempts: [],
      contentItem: {
        channelRaw: 'LinkedIn Business',
      },
    };

    const lionelPost = {
      id: 'cal-post-le-1',
      platform: 'INSTAGRAM',
      title: 'Lionel Post',
      caption: 'Lionel Caption',
      workspace: 'lionel_eersteling',
      status: 'PENDING_REVIEW',
      scheduledAt: new Date(),
      revision: 1,
      media: [],
      revisions: [],
      reviewEvents: [],
      attempts: [],
      contentItem: {
        channelRaw: 'Instagram',
      },
    };

    beforeEach(() => {
      jest.spyOn(automationPrisma.post, 'findUnique').mockImplementation((async ({ where }: any) => {
        if (where.id === 'cal-post-lp-1') return lpPost as any;
        if (where.id === 'cal-post-le-1') return lionelPost as any;
        return null;
      }) as any);
    });

    it('blocks Lionel-only manager on getPostDetail for Leaders Performance post with 403', async () => {
      await expect(
        crmPostsService.getPostDetail('cal-post-lp-1', {
          id: 'usr-lionel-mgr',
          email: 'lionel.mgr@leadersperformance.ae',
          role: 'manager',
          workspaces: ['lionel_eersteling'],
        })
      ).rejects.toMatchObject({
        statusCode: 403,
        code: 'FORBIDDEN_WORKSPACE',
      });
    });

    it('blocks Lionel-only user on getCaptionFileContent for Leaders Performance post with 403', async () => {
      await expect(
        crmPostsService.getCaptionFileContent('cal-post-lp-1', undefined, {
          id: 'usr-lionel-user',
          email: 'lionel.user@leadersperformance.ae',
          role: 'user',
          workspaces: ['lionel_eersteling'],
        })
      ).rejects.toMatchObject({
        statusCode: 403,
        code: 'FORBIDDEN_WORKSPACE',
      });
    });

    it('blocks Lionel-only manager on updatePost for Leaders Performance post with 403', async () => {
      await expect(
        crmPostsService.updatePost(
          'cal-post-lp-1',
          { title: 'New Title' },
          {
            id: 'usr-lionel-mgr',
            email: 'lionel.mgr@leadersperformance.ae',
            role: 'manager',
            workspaces: ['lionel_eersteling'],
          }
        )
      ).rejects.toMatchObject({
        statusCode: 403,
        code: 'FORBIDDEN_WORKSPACE',
      });
    });

    it('blocks Lionel-only manager on addComment for Leaders Performance post with 403', async () => {
      await expect(
        crmPostsService.addComment(
          'cal-post-lp-1',
          {
            id: 'usr-lionel-mgr',
            email: 'lionel.mgr@leadersperformance.ae',
            role: 'manager',
            workspaces: ['lionel_eersteling'],
          },
          'Unauthorized comment'
        )
      ).rejects.toMatchObject({
        statusCode: 403,
        code: 'FORBIDDEN_WORKSPACE',
      });
    });

    it('blocks Lionel-only manager on adminRetryPost for Leaders Performance post with 403', async () => {
      await expect(
        crmPostsService.adminRetryPost('cal-post-lp-1', {
          id: 'usr-lionel-mgr',
          email: 'lionel.mgr@leadersperformance.ae',
          role: 'manager',
          workspaces: ['lionel_eersteling'],
        })
      ).rejects.toMatchObject({
        statusCode: 403,
        code: 'FORBIDDEN_WORKSPACE',
      });
    });

    it('blocks Lionel-only manager on markManualDone for Leaders Performance post with 403', async () => {
      await expect(
        crmPostsService.markManualDone(
          'cal-post-lp-1',
          {
            id: 'usr-lionel-mgr',
            email: 'lionel.mgr@leadersperformance.ae',
            role: 'manager',
            workspaces: ['lionel_eersteling'],
          },
          'https://linkedin.com/post/123'
        )
      ).rejects.toMatchObject({
        statusCode: 403,
        code: 'FORBIDDEN_WORKSPACE',
      });
    });

    it('allows Lionel-only manager to access Lionel Eersteling post detail', async () => {
      const post = await crmPostsService.getPostDetail('cal-post-le-1', {
        id: 'usr-lionel-mgr',
        email: 'lionel.mgr@leadersperformance.ae',
        role: 'manager',
        workspaces: ['lionel_eersteling'],
      });

      expect(post).toBeDefined();
      expect(post.id).toBe('cal-post-le-1');
    });
  });

  /* ------------------------------------------------------------------------
   * 4. Content Actions Refuse Requests Without Signed-In CRM User
   * ------------------------------------------------------------------------ */
  describe('4. Content Actions Refuse Requests Without Signed-In CRM User', () => {
    let app: express.Express;
    const controller = new ContentController();

    beforeEach(() => {
      app = express();
      app.use(express.json());
      app.post('/api/v1/content/posts/:id/approve', controller.approvePost);
      app.post('/api/v1/content/posts/:id/reject', controller.rejectPost);
      app.post('/api/v1/content/posts/:id/publish-now', controller.publishNow);
      app.delete('/api/v1/content/posts/:id', controller.deletePost);
    });

    it('refuses approvePost with 401 when there is no signed-in user', async () => {
      const res = await request(app).post('/api/v1/content/posts/test-post-1/approve');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
      expect(res.body.error).toContain('Authentication required');
    });

    it('refuses rejectPost with 401 when there is no signed-in user', async () => {
      const res = await request(app).post('/api/v1/content/posts/test-post-1/reject');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
      expect(res.body.error).toContain('Authentication required');
    });

    it('refuses publishNow with 401 when there is no signed-in user', async () => {
      const res = await request(app).post('/api/v1/content/posts/test-post-1/publish-now');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
      expect(res.body.error).toContain('Authentication required');
    });

    it('refuses deletePost with 401 when there is no signed-in user', async () => {
      const res = await request(app).delete('/api/v1/content/posts/test-post-1');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
      expect(res.body.error).toContain('Authentication required');
    });
  });
});
