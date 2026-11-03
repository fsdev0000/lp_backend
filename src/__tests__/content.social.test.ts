import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import contentRoutes from '../modules/content/content.routes';
import linkedinRoutes from '../modules/social/linkedin.routes';
import { analyticsRoutes } from '../modules/analytics/analytics.routes';
import { LinkedInAdapter, socialPrisma } from '../modules/social/adapters/linkedin.adapter';
import { ContentService, contentPrisma } from '../modules/content/services/content.service';
import { LinkedInSchedulerJob } from '../modules/content/jobs/linkedinSchedulerJob';
import {
  LinkedInAnalyticsAdapter,
  analyticsPrisma,
} from '../modules/analytics/adapters/linkedinAnalytics.adapter';
import { LinkedInAnalyticsSyncJob } from '../modules/analytics/jobs/linkedinAnalyticsSyncJob';
import { getLinkedInApiVersion } from '../modules/social/config/linkedin.config';

jest.setTimeout(45000);

const app = express();
app.use(express.json());
app.use('/api/v1/content', contentRoutes);
app.use('/api/v1/social/linkedin', linkedinRoutes);
app.use('/api/v1/analytics', analyticsRoutes);

const TEST_API_KEY = process.env.ARTICLES_API_KEY || 'b8f9c1a2d4e7465b90a3f8c2e1d5b';

describe('Social CRM & Content Studio API Suite (Checklist Items 1–15)', () => {
  const linkedinAdapter = new LinkedInAdapter();
  const mockPosts = new Map<string, any>();
  const mockConnections = new Map<string, any>();
  const mockAuditLogs: any[] = [];

  beforeEach(() => {
    process.env.LINKEDIN_PUBLISHING_ENABLED = 'false';
    LinkedInAnalyticsAdapter.clearCache();
    LinkedInSchedulerJob.resetState();
    mockPosts.clear();
    mockConnections.clear();
    mockAuditLogs.length = 0;

    // Mock contentPrisma
    jest.spyOn(contentPrisma.socialPost, 'deleteMany').mockResolvedValue({ count: 0 } as any);
    jest.spyOn(contentPrisma.socialAuditLog, 'deleteMany').mockResolvedValue({ count: 0 } as any);
    jest.spyOn(contentPrisma.socialPost, 'count').mockImplementation((async ({ where }: any = {}) => {
      const items = Array.from(mockPosts.values()).filter((p) => {
        if (where?.platform && p.platform !== where.platform) return false;
        if (where?.status && p.status !== where.status) return false;
        return true;
      });
      return items.length;
    }) as any);

    jest.spyOn(contentPrisma.socialPost, 'findMany').mockImplementation((async ({ where }: any = {}) => {
      return Array.from(mockPosts.values()).filter((p) => {
        if (where?.platform && p.platform !== where.platform) return false;
        if (where?.status && p.status !== where.status) return false;
        if (where?.approvalSignature?.not === null && !p.approvalSignature) return false;
        if (where?.scheduledFor?.lte && (!p.scheduledFor || new Date(p.scheduledFor) > where.scheduledFor.lte)) {
          return false;
        }
        return true;
      });
    }) as any);

    jest.spyOn(contentPrisma.socialPost, 'findUnique').mockImplementation((async ({ where }: any) => {
      return mockPosts.get(where.id) || null;
    }) as any);

    jest.spyOn(contentPrisma.socialPost, 'create').mockImplementation((async ({ data }: any) => {
      const id = data.id || `post-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const record = {
        id,
        ...data,
        approvalSignature: data.approvalSignature ?? null,
        approvedBy: data.approvedBy ?? null,
        approvedAt: data.approvedAt ?? null,
        rejectionReason: data.rejectionReason ?? null,
        platformPostId: data.platformPostId ?? null,
        platformPostUrl: data.platformPostUrl ?? null,
        metadata: data.metadata ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockPosts.set(id, record);
      return record;
    }) as any);

    jest.spyOn(contentPrisma.socialPost, 'update').mockImplementation((async ({ where, data }: any) => {
      const existing = mockPosts.get(where.id);
      if (!existing) throw new Error(`Not found: ${where.id}`);
      const updated = { ...existing, ...data, updatedAt: new Date() };
      mockPosts.set(where.id, updated);
      return updated;
    }) as any);

    jest.spyOn(contentPrisma.socialPost, 'delete').mockImplementation((async ({ where }: any) => {
      const existing = mockPosts.get(where.id);
      mockPosts.delete(where.id);
      return existing;
    }) as any);

    jest.spyOn(contentPrisma.socialAuditLog, 'create').mockImplementation((async ({ data }: any) => {
      const entry = { id: `audit-${mockAuditLogs.length + 1}`, timestamp: new Date(), ...data };
      mockAuditLogs.unshift(entry);
      return entry;
    }) as any);

    jest.spyOn(contentPrisma.socialAuditLog, 'findMany').mockImplementation((async () => {
      return mockAuditLogs;
    }) as any);

    // Mock socialPrisma & analyticsPrisma socialAccountConnection
    jest.spyOn(socialPrisma.socialAccountConnection, 'findUnique').mockImplementation((async ({ where }: any) => {
      return mockConnections.get(where.platform) || null;
    }) as any);
    jest.spyOn(analyticsPrisma.socialAccountConnection, 'findUnique').mockImplementation((async ({ where }: any) => {
      return mockConnections.get(where.platform) || null;
    }) as any);
    jest.spyOn(socialPrisma.socialAccountConnection, 'upsert').mockImplementation((async ({ where, create, update }: any) => {
      const existing = mockConnections.get(where.platform);
      const saved = existing ? { ...existing, ...update } : { id: `conn-${where.platform}`, ...create };
      mockConnections.set(where.platform, saved);
      return saved;
    }) as any);
    jest.spyOn(socialPrisma.socialAccountConnection, 'deleteMany').mockImplementation((async ({ where }: any) => {
      if (where?.platform?.in) {
        for (const p of where.platform.in) mockConnections.delete(p);
      } else if (where?.platform) {
        mockConnections.delete(where.platform);
      }
      return { count: 1 };
    }) as any);
    jest.spyOn(socialPrisma.socialAuditLog, 'create').mockResolvedValue({ id: 'audit-social' } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Section A: Posting Safety, Auth, Kill Switch & Workflow Rules (Items 1–6)', () => {
    it('Item 2: /api/v1/content/* and /api/v1/social/linkedin/* require login (return 401 with no token)', async () => {
      const endpoints = [
        request(app).get('/api/v1/content/posts'),
        request(app).post('/api/v1/content/posts/123/approve'),
        request(app).post('/api/v1/content/posts/123/publish-now'),
        request(app).delete('/api/v1/content/posts/123'),
        request(app).get('/api/v1/social/linkedin/auth-url'),
        request(app).get('/api/v1/social/linkedin/status'),
        request(app).post('/api/v1/social/linkedin/share'),
        request(app).post('/api/v1/social/linkedin/disconnect'),
      ];

      for (const reqPromise of endpoints) {
        const res = await reqPromise;
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
      }
    });

    it('Item 1: Kill switch LINKEDIN_PUBLISHING_ENABLED=false returns 403 on publish-now & /share, and status returns publishingEnabled', async () => {
      process.env.LINKEDIN_PUBLISHING_ENABLED = 'false';

      const statusRes = await request(app)
        .get('/api/v1/social/linkedin/status')
        .set('x-api-key', TEST_API_KEY);
      expect(statusRes.status).toBe(200);
      expect(statusRes.body.publishingEnabled).toBe(false);

      const shareRes = await request(app)
        .post('/api/v1/social/linkedin/share')
        .set('x-api-key', TEST_API_KEY)
        .send({ text: 'Test direct share' });
      expect(shareRes.status).toBe(403);

      const pubNowRes = await request(app)
        .post('/api/v1/content/posts/any-id/publish-now')
        .set('x-api-key', TEST_API_KEY);
      expect(pubNowRes.status).toBe(403);
    });

    it('Item 3: Seed posts (post-101..105) and in-memory fallback are completely removed', async () => {
      expect((ContentService as any).fallbackPosts).toBeUndefined();

      const res = await request(app)
        .get('/api/v1/content/posts')
        .set('x-api-key', TEST_API_KEY);
      expect(res.status).toBe(200);
      expect(res.body.posts).toEqual([]);
      expect(res.body.pagination.total).toBe(0);
    });

    it('Item 6a, 6b, 6c: Workflow rules for approve, edit reset to PENDING_REVIEW, and publish-now requiring approval', async () => {
      // Create a DRAFT post (requireApproval: false)
      const draftRes = await request(app)
        .post('/api/v1/content/posts')
        .set('x-api-key', TEST_API_KEY)
        .send({
          title: 'Draft Post',
          body: 'Initial content',
          platform: 'LINKEDIN',
          requireApproval: false,
        });
      expect(draftRes.status).toBe(201);
      const postId = draftRes.body.data.id;
      expect(draftRes.body.data.status).toBe('DRAFT');

      // 6a: Approving a DRAFT post must fail with 400 (must be PENDING_REVIEW)
      const badApprove = await request(app)
        .post(`/api/v1/content/posts/${postId}/approve`)
        .set('x-api-key', TEST_API_KEY)
        .send({});
      expect(badApprove.status).toBe(400);
      expect(badApprove.body.error).toContain('PENDING_REVIEW');

      // 6b: publish-now on unapproved post when publishing is enabled must fail with 400 (never self-signs)
      process.env.LINKEDIN_PUBLISHING_ENABLED = 'true';
      const unapprovedPub = await request(app)
        .post(`/api/v1/content/posts/${postId}/publish-now`)
        .set('x-api-key', TEST_API_KEY);
      expect(unapprovedPub.status).toBe(400);
      expect(unapprovedPub.body.error).toContain('approval');
      process.env.LINKEDIN_PUBLISHING_ENABLED = 'false';

      // Submit for review -> PENDING_REVIEW
      const reqRev = await request(app)
        .post(`/api/v1/content/posts/${postId}/request-approval`)
        .set('x-api-key', TEST_API_KEY);
      expect(reqRev.status).toBe(200);
      expect(reqRev.body.data.status).toBe('PENDING_REVIEW');

      // Approve while publishing is off -> SCHEDULED (never publishes, tags approvedWhilePublishingDisabled)
      const approveRes = await request(app)
        .post(`/api/v1/content/posts/${postId}/approve`)
        .set('x-api-key', TEST_API_KEY)
        .send({ approvedBy: 'Lionel Eersteling' });
      expect(approveRes.status).toBe(200);
      expect(approveRes.body.data.status).toBe('SCHEDULED');
      expect(approveRes.body.data.approvalSignature).toBeTruthy();
      expect(approveRes.body.data.metadata?.approvedWhilePublishingDisabled).toBe(true);

      // 6c: Editing an approved/scheduled post clears approvalSignature and sends it back to PENDING_REVIEW
      const editRes = await request(app)
        .put(`/api/v1/content/posts/${postId}`)
        .set('x-api-key', TEST_API_KEY)
        .send({ title: 'Edited Title After Approval' });
      expect(editRes.status).toBe(200);
      expect(editRes.body.data.status).toBe('PENDING_REVIEW');
      expect(editRes.body.data.approvalSignature).toBeNull();
      expect(editRes.body.data.approvedBy).toBeNull();
    });

    it('Item 4 & 6d: Old approvals at go-live are marked FAILED (needs re-approval) instead of auto-publishing, and non-LinkedIn posts are ignored', async () => {
      // Create and approve a LinkedIn post with a past scheduledFor date while publishing is off
      const createRes = await request(app)
        .post('/api/v1/content/posts')
        .set('x-api-key', TEST_API_KEY)
        .send({
          title: 'Old Approved Post Before Go-Live',
          platform: 'LINKEDIN',
          scheduledFor: new Date(Date.now() - 3600_000).toISOString(),
          requireApproval: true,
        });
      const liPostId = createRes.body.data.id;

      await request(app)
        .post(`/api/v1/content/posts/${liPostId}/approve`)
        .set('x-api-key', TEST_API_KEY)
        .send({});

      // Create a YouTube post that is SCHEDULED in the past
      const ytRes = await request(app)
        .post('/api/v1/content/posts')
        .set('x-api-key', TEST_API_KEY)
        .send({
          title: 'YouTube Scheduled Teaser',
          platform: 'YOUTUBE',
          scheduledFor: new Date(Date.now() - 3600_000).toISOString(),
          requireApproval: true,
        });
      const ytPostId = ytRes.body.data.id;
      await request(app)
        .post(`/api/v1/content/posts/${ytPostId}/approve`)
        .set('x-api-key', TEST_API_KEY)
        .send({});

      // Turn publishing ON and run scheduler tick
      process.env.LINKEDIN_PUBLISHING_ENABLED = 'true';
      await LinkedInSchedulerJob.tick();

      // Old LinkedIn post must be marked FAILED with signature cleared (not published!)
      const liPost = mockPosts.get(liPostId);
      expect(liPost.status).toBe('FAILED');
      expect(liPost.approvalSignature).toBeNull();
      expect(liPost.rejectionReason).toContain('needs re-approval');

      // YouTube post must NOT be marked PUBLISHED
      const ytPost = mockPosts.get(ytPostId);
      expect(ytPost.status).toBe('SCHEDULED');
    });

    it('Item 5: OAuth callback verifies state and blocks open redirects in return_to', async () => {
      // Missing state -> 400
      const noState = await request(app).get('/api/v1/social/linkedin/callback?code=abc123');
      expect(noState.status).toBe(400);
      expect(noState.body.error).toContain('state');

      // Invalid/unregistered state -> 400
      const badState = await request(app).get('/api/v1/social/linkedin/callback?code=abc123&state=forged_state');
      expect(badState.status).toBe(400);
      expect(badState.body.error).toContain('Invalid or expired OAuth state');

      // Open redirect in auth-url or callback -> 400
      const openRedirAuth = await request(app)
        .get('/api/v1/social/linkedin/auth-url?return_to=https://evil.example.com/phish')
        .set('x-api-key', TEST_API_KEY);
      expect(openRedirAuth.status).toBe(400);

      const validAuth = await request(app)
        .get('/api/v1/social/linkedin/auth-url')
        .set('x-api-key', TEST_API_KEY);
      const validState = validAuth.body.state;

      const openRedirCallback = await request(app).get(
        `/api/v1/social/linkedin/callback?code=abc123&state=${validState}&return_to=https://evil.example.com`
      );
      expect(openRedirCallback.status).toBe(400);
      expect(openRedirCallback.body.error).toContain('return_to');
    });

    it('Item 6e: When LinkedIn does not return a post ID, no fake urn:li:share:<timestamp> is saved', async () => {
      process.env.LINKEDIN_PUBLISHING_ENABLED = 'true';

      const fetchSpy = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
        ok: true,
        status: 201,
        headers: {
          get: () => null,
        },
        text: async () => '',
        json: async () => ({}),
      } as any);

      const res = await linkedinAdapter.publishPost('token', 'urn:li:person:123', {
        title: 'No Header ID Post',
        text: 'Testing missing header',
      });

      expect(res.postUrn).toBeNull();
      expect(res.postId).toBeNull();
      expect(res.postUrl).toBeNull();
      fetchSpy.mockRestore();
    });
  });

  describe('Section B: Company Page Analytics, Scopes, API Version & Separate Connection (Items 7–14)', () => {
    it('Items 7, 8, 9: /social/linkedin/auth-url requests organization read-only scopes for LINKEDIN_PAGE and uses single LINKEDIN_API_VERSION', async () => {
      const res = await request(app)
        .get('/api/v1/social/linkedin/auth-url')
        .set('x-api-key', TEST_API_KEY);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.platform).toBe('LINKEDIN_PAGE');
      expect(res.body.scopes).toEqual(['r_organization_social', 'rw_organization_admin']);
      expect(res.body.url).toContain('r_organization_social');
      expect(res.body.url).toContain('rw_organization_admin');
      expect(res.body.url).not.toContain('w_member_social');

      expect(getLinkedInApiVersion()).toBe(process.env.LINKEDIN_API_VERSION || '202504');
      expect(getLinkedInApiVersion()).not.toBe('202401');
    });

    it('Item 9: Connecting LINKEDIN_PAGE for analytics never gives LinkedInAdapter (personal posting) a token', async () => {
      mockConnections.set('LINKEDIN_PAGE', {
        id: 'conn-page',
        platform: 'LINKEDIN_PAGE',
        accountName: 'Leaders Performance',
        accountUrn: 'urn:li:organization:105948392',
        accessToken: 'page_readonly_token',
        scopes: ['r_organization_social', 'rw_organization_admin'],
        status: 'HEALTHY',
      });

      const postingConn = await linkedinAdapter.getActiveConnection();
      expect(postingConn).toBeNull();
    });

    it('Items 10, 13, 14: Disconnected analytics returns vanityName="lioneleersteling", isCached=false (not cached), and /posts returns [] without DB fallback', async () => {
      // Seed a PUBLISHED post into mockPosts to prove /analytics/social/linkedin/posts never falls back to DB
      mockPosts.set('db-post-1', {
        id: 'db-post-1',
        title: 'Personal Profile DB Post',
        platform: 'LINKEDIN',
        status: 'PUBLISHED',
        platformPostId: 'urn:li:share:999',
        publishedAt: new Date(),
        createdAt: new Date(),
      });

      const res1 = await request(app).get('/api/v1/analytics/social/linkedin?range=7d');
      expect(res1.status).toBe(200);
      expect(res1.body.data.connected).toBe(false);
      expect(res1.body.data.vanityName).toBe('lioneleersteling');
      expect(res1.body.data.isCached).toBe(false);
      expect(res1.body.data.followers).toBeNull();

      // Call a second time: disconnected state must NOT be cached (isCached remains false)
      const res2 = await request(app).get('/api/v1/analytics/social/linkedin?range=7d');
      expect(res2.body.data.isCached).toBe(false);

      // /analytics/social/linkedin/posts must return [] and never fall back to DB posts
      const postsRes = await request(app).get('/api/v1/analytics/social/linkedin/posts');
      expect(postsRes.status).toBe(200);
      expect(postsRes.body.posts).toEqual([]);
    });

    it('Items 11 & 12: Connected LINKEDIN_PAGE populates per-post share statistics and computes company engagementRate accurately', async () => {
      mockConnections.set('LINKEDIN_PAGE', {
        id: 'conn-page',
        platform: 'LINKEDIN_PAGE',
        accountName: 'Leaders Performance',
        accountUrn: 'urn:li:organization:105948392',
        accessToken: 'page_readonly_token',
        scopes: ['r_organization_social', 'rw_organization_admin'],
        status: 'HEALTHY',
      });

      const fetchSpy = jest.spyOn(global, 'fetch' as any).mockImplementation(async (input: any) => {
        const url = String(input);
        if (url.includes('organizationalEntityFollowerStatistics')) {
          return {
            ok: true,
            json: async () => ({
              elements: [{ followerGains: { organicFollowerGain: 12, paidFollowerGain: 3 } }],
            }),
          } as any;
        }
        if (url.includes('networkSizes')) {
          return {
            ok: true,
            json: async () => ({ firstDegreeSize: 1450 }),
          } as any;
        }
        if (url.includes('organizationalEntityShareStatistics') && url.includes('shares=List')) {
          // Per-post share statistics (Item 11)
          return {
            ok: true,
            json: async () => ({
              elements: [
                {
                  share: 'urn:li:share:777888999',
                  totalShareStatistics: {
                    impressionCount: 1000,
                    clickCount: 25,
                    likeCount: 40,
                    commentCount: 10,
                    shareCount: 5,
                    engagement: 0.08,
                  },
                },
              ],
            }),
          } as any;
        }
        if (url.includes('organizationalEntityShareStatistics')) {
          // Company-level share statistics (Item 12)
          return {
            ok: true,
            json: async () => ({
              elements: [
                {
                  totalShareStatistics: {
                    impressionCount: 2000,
                    clickCount: 50,
                    likeCount: 80,
                    commentCount: 20,
                    shareCount: 10,
                    engagement: 0.08,
                  },
                },
              ],
            }),
          } as any;
        }
        if (url.includes('organizationPageStatistics')) {
          return {
            ok: true,
            json: async () => ({
              elements: [{ views: { allPageViews: { pageViews: 320, uniquePageViews: 210 } } }],
            }),
          } as any;
        }
        if (url.includes('/rest/posts')) {
          return {
            ok: true,
            json: async () => ({
              elements: [
                {
                  id: 'urn:li:share:777888999',
                  commentary: 'Sovereign leadership starts with physiological mastery.',
                  publishedAt: Date.now() - 86400_000,
                },
              ],
            }),
          } as any;
        }
        return { ok: false, status: 404, text: async () => '' } as any;
      });

      const analyticsRes = await request(app).get('/api/v1/analytics/social/linkedin?range=7d');
      expect(analyticsRes.status).toBe(200);
      const data = analyticsRes.body.data;
      expect(data.connected).toBe(true);
      expect(data.vanityName).toBe('lioneleersteling');
      expect(data.followers).toBe(1450);
      expect(data.followerGrowth).toBe(15);
      expect(data.impressions).toBe(2000);
      expect(data.clicks).toBe(50);
      expect(data.engagementRate).toBe(8);
      expect(data.engagementRateFormatted).toBe('8%');
      expect(data.pageViews).toBe(320);
      expect(data.uniquePageViews).toBe(210);

      // Verify per-post stats (Item 11)
      expect(data.recentPosts.length).toBe(1);
      const post = data.recentPosts[0];
      expect(post.urn).toBe('urn:li:share:777888999');
      expect(post.impressions).toBe(1000);
      expect(post.clicks).toBe(25);
      expect(post.reactions).toBe(40);
      expect(post.comments).toBe(10);
      expect(post.reposts).toBe(5);
      expect(post.engagementRate).toBe(8);

      fetchSpy.mockRestore();
    });

    it('Item 14: LinkedInAnalyticsSyncJob warms 7d, 30d, 90d, all, and posts', async () => {
      const adapterInstance = (LinkedInAnalyticsSyncJob as any).adapter as LinkedInAnalyticsAdapter;
      const spyCompany = jest
        .spyOn(adapterInstance, 'getCompanyAnalytics')
        .mockResolvedValue({ connected: true, followers: 100, impressions: 500 } as any);
      const spyPosts = jest.spyOn(adapterInstance, 'getPosts').mockResolvedValue([]);

      await LinkedInAnalyticsSyncJob.runSync();

      expect(spyCompany).toHaveBeenCalledWith('7d', true);
      expect(spyCompany).toHaveBeenCalledWith('30d', true);
      expect(spyCompany).toHaveBeenCalledWith('90d', true);
      expect(spyCompany).toHaveBeenCalledWith('all', true);
      expect(spyPosts).toHaveBeenCalledWith(true);
    });
  });
});
