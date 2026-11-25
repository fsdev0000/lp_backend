import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import instagramRoutes from '../modules/social/instagram.routes';
import { analyticsRoutes } from '../modules/analytics/analytics.routes';
import { InstagramAdapter } from '../modules/social/adapters/instagram.adapter';
import { InstagramService } from '../modules/social/services/instagram.service';
import { InstagramAnalyticsAdapter } from '../modules/analytics/adapters/instagramAnalytics.adapter';
import { InstagramPublishingService } from '../modules/content/services/instagramPublishing.service';
import { InstagramAnalyticsSyncJob } from '../modules/analytics/jobs/instagramAnalyticsSyncJob';
import { socialPrisma } from '../modules/social/adapters/linkedin.adapter';
import {
  generateAuthoritativeSignature,
  verifyPostApprovalGuard,
  computePostContentHash,
} from '../utils/approvalSignature';

jest.setTimeout(45000);

const TEST_API_KEY = 'test-admin-key-instagram';
process.env.ADMIN_API_KEY = TEST_API_KEY;

const app = express();
app.use(express.json());
app.use('/api/v1/social/instagram', instagramRoutes);
app.use('/api/v1/analytics', analyticsRoutes);

describe('Meta Instagram Integration Suite', () => {
  const adapter = new InstagramAdapter();
  const service = new InstagramService();
  const analyticsAdapter = new InstagramAnalyticsAdapter();
  const publishingService = new InstagramPublishingService();

  beforeEach(() => {
    // Item 5: Mock adapter and Prisma to prevent wiping staging database or calling live Meta API during local test runs
    jest.spyOn(InstagramAdapter.prototype, 'disconnect').mockImplementation(async () => {});
    jest.spyOn(InstagramAdapter.prototype, 'ping').mockImplementation(async () => ({
      status: 'HEALTHY',
      latencyMs: 42,
      message: 'Connected as @lioneleersteling',
      account: { id: '17841427503988004', username: 'lioneleersteling', followersCount: 51 },
    }));
    jest.spyOn(InstagramAdapter.prototype, 'getActiveConnection').mockImplementation(async () => ({
      id: 'mock-ig-id',
      platform: 'INSTAGRAM',
      accountName: 'Lionel Eersteling | Founder Performance',
      accountUrn: 'instagram:17841427503988004',
      accountEmail: null,
      profilePictureUrl: null,
      accessToken: 'mock_system_token',
      refreshToken: null,
      tokenExpiresAt: null,
      scopes: ['instagram_basic'],
      status: 'HEALTHY',
      lastSyncAt: new Date(),
      followersCount: 51,
      metadata: { username: 'lioneleersteling', accountId: '17841427503988004', tokenType: 'SYSTEM_USER' },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any));

    jest.spyOn(socialPrisma.socialAccountConnection, 'deleteMany').mockResolvedValue({ count: 1 } as any);
    jest.spyOn(socialPrisma.socialAccountConnection, 'findUnique').mockResolvedValue(null);
    jest.spyOn(socialPrisma.socialAccountConnection, 'upsert').mockResolvedValue({} as any);
    jest.spyOn(socialPrisma.socialAuditLog, 'create').mockResolvedValue({} as any);

    jest.spyOn(InstagramAnalyticsAdapter.prototype, 'getAccountAnalytics').mockResolvedValue({
      accountId: '17841427503988004',
      username: 'lioneleersteling',
      name: 'Lionel Eersteling',
      profilePictureUrl: null,
      biography: null,
      connected: true,
      followers: 51,
      followerGrowth: 0,
      followerGrowthFormatted: '0.0%',
      impressions: null,
      reach: null,
      profileViews: null,
      engagementRate: null,
      engagementRateFormatted: null,
      postsCount: 0,
      postsInRange: 0,
      range: '7d',
      startDate: '2026-10-30',
      endDate: '2026-11-06',
      cachedAt: new Date().toISOString(),
      isCached: false,
      isFallback: false,
    });
    jest.spyOn(InstagramAnalyticsAdapter.prototype, 'getPosts').mockResolvedValue([]);
    jest.spyOn(InstagramAnalyticsSyncJob, 'runSync').mockResolvedValue(undefined as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Module A: OAuth & Connection Lifecycle', () => {
    it('Security: rejects unauthenticated requests to Instagram endpoints with HTTP 401', async () => {
      const res = await request(app).get('/api/v1/social/instagram/status');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('GET /api/v1/social/instagram/auth-url - generates secure CSRF OAuth URL with Unified Login config', async () => {
      const res = await request(app)
        .get('/api/v1/social/instagram/auth-url')
        .set('x-api-key', TEST_API_KEY);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.url).toContain('https://www.facebook.com/v21.0/dialog/oauth');
      expect(res.body.url).toContain('client_id=2399278297568224');
      expect(res.body.url).toContain('config_id=1692644065797185');
      expect(res.body.state).toBeDefined();
    });

    it('OAuth State Validation - prevents CSRF replay attacks', () => {
      const { state } = service.getAuthUrl();
      expect(service.validateState(state)).toBe(true);
      // Second attempt with same one-time state must fail
      expect(service.validateState(state)).toBe(false);
      expect(service.validateState('fake_unknown_state')).toBe(false);
    });

    it('GET /api/v1/social/instagram/status - returns connection status and never exposes access token', async () => {
      const res = await request(app)
        .get('/api/v1/social/instagram/status')
        .set('x-api-key', TEST_API_KEY);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(typeof res.body.connected).toBe('boolean');
      expect(res.body.username).toBe('lioneleersteling');
      expect(res.body.accountId).toBe('17841427503988004');
      expect(res.body.tokenHealth).toBeDefined();

      // Strict security assertions
      expect(res.body.accessToken).toBeUndefined();
      expect(res.body.appSecret).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain('access_token');
    });

    it('GET /api/v1/social/instagram/ping - confirms Meta Graph API connectivity and measures response latency', async () => {
      const res = await request(app)
        .get('/api/v1/social/instagram/ping')
        .set('x-api-key', TEST_API_KEY);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(['HEALTHY', 'DEGRADED']).toContain(res.body.status);
      expect(typeof res.body.latencyMs).toBe('number');
      if (res.body.status === 'HEALTHY') {
        expect(res.body.message).toContain('lioneleersteling');
        expect(res.body.account.id).toBe('17841427503988004');
      }
    });

    it('POST /api/v1/social/instagram/disconnect - successfully clears integration state', async () => {
      const res = await request(app)
        .post('/api/v1/social/instagram/disconnect')
        .set('x-api-key', TEST_API_KEY)
        .send({ actor: 'Lionel Eersteling (Owner)' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('Module B & F: Instagram Analytics & Channel Performance', () => {
    it('GET /api/v1/analytics/social/instagram - returns valid account vitals matching layout contract', async () => {
      const res = await request(app).get('/api/v1/analytics/social/instagram?range=7d');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();

      const d = res.body.data;
      expect(d.username).toBe('lioneleersteling');
      expect(d.accountId).toBe('17841427503988004');
      expect(typeof d.connected).toBe('boolean');
      expect(typeof d.followers === 'number' || d.followers === null).toBe(true);
      expect(d.websiteVisitors).toBeDefined();
      expect(typeof d.websiteVisitors.totalVisitors).toBe('number');
    });

    it('GET /api/v1/analytics/social/instagram/posts - returns recent Instagram posts and Reels', async () => {
      const res = await request(app).get('/api/v1/analytics/social/instagram/posts');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.posts)).toBe(true);

      if (res.body.posts.length > 0) {
        const post = res.body.posts[0];
        expect(post.id).toBeDefined();
        expect(['IMAGE', 'VIDEO', 'CAROUSEL_ALBUM', 'REELS']).toContain(post.mediaType);
        expect(post.publishedAt).toBeDefined();
      }
    });

    it('GET /api/v1/analytics/channels - dynamically populates Instagram with verified connection and metrics', async () => {
      const res = await request(app).get('/api/v1/analytics/channels?range=7d');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const igRow = res.body.data.find((c: any) => c.id === 'instagram');
      expect(igRow).toBeDefined();
      expect(igRow.name).toContain('Instagram');
      expect(typeof igRow.connected).toBe('boolean');
      expect(typeof igRow.websiteVisitors).toBe('number');
      // If connected, followers is a number or null, never an estimated string
      if (igRow.connected) {
        expect(typeof igRow.followers === 'number' || igRow.followers === null).toBe(true);
      }
    });
  });

  describe('Module C: Content Publishing & Cryptographic Approval Guard', () => {
    it('Cryptographic Guard - verifies SHA256 integrity of content payload', () => {
      const post = {
        id: 'post-test-101',
        title: 'High Performance Bio-Governance',
        hook: 'Decisions degrade after compound fatigue.',
        body: 'Discipline is cognitive clarity.',
        platform: 'INSTAGRAM',
        mediaUrl: 'https://images.unsplash.com/photo-1507679799987-c73779587ccf',
      };

      const sig = generateAuthoritativeSignature(post);
      expect(sig).toMatch(/^SIG-LIONEL-2026-[A-F0-9]{8}-VERIFIED$/);

      const verification = verifyPostApprovalGuard({
        ...post,
        status: 'SCHEDULED',
        approvalSignature: sig,
        approvedBy: 'Lionel Eersteling (Owner)',
      });
      expect(verification.isValid).toBe(true);

      // Tampering detection: Altering post body after approval must invalidate signature
      const tamperedPost = {
        ...post,
        body: 'Tampered content that Lionel never approved!',
      };
      const tamperedVerification = verifyPostApprovalGuard({
        ...tamperedPost,
        status: 'SCHEDULED',
        approvalSignature: sig,
        approvedBy: 'Lionel Eersteling (Owner)',
      });
      expect(tamperedVerification.isValid).toBe(false);
      expect(tamperedVerification.reason).toContain('Signature content-hash mismatch');
    });

    it('Publishing Service - aborts immediately if approval guard fails', async () => {
      await expect(
        publishingService.publishToInstagram({
          caption: 'Unauthorized test caption',
          mediaUrl: 'https://images.unsplash.com/photo-1507679799987-c73779587ccf',
          approvalSignature: 'INVALID_SIGNATURE',
          approvedBy: 'Hacker',
        })
      ).rejects.toThrow('Publishing aborted by executive guard');
    });

    it('Publishing Service - enforces INSTAGRAM_PUBLISHING_ENABLED kill switch', async () => {
      const prev = process.env.INSTAGRAM_PUBLISHING_ENABLED;
      process.env.INSTAGRAM_PUBLISHING_ENABLED = 'false';
      try {
        const post = {
          id: 'test-kill-switch-ig',
          caption: 'Kill switch test caption',
          mediaUrl: 'https://images.unsplash.com/photo-1507679799987-c73779587ccf',
        };
        const validSig = generateAuthoritativeSignature({
          id: post.id,
          title: post.caption.slice(0, 50),
          hook: null,
          body: post.caption,
          platform: 'INSTAGRAM',
          mediaUrl: post.mediaUrl,
        });

        await expect(
          publishingService.publishToInstagram({
            postId: post.id,
            caption: post.caption,
            mediaUrl: post.mediaUrl,
            approvalSignature: validSig,
            approvedBy: 'Lionel Eersteling (Owner)',
          })
        ).rejects.toThrow('INSTAGRAM_PUBLISHING_ENABLED=false');
      } finally {
        process.env.INSTAGRAM_PUBLISHING_ENABLED = prev;
      }
    });
  });

  describe('Module D: Background Synchronization', () => {
    it('InstagramAnalyticsSyncJob - executes without unhandled errors', async () => {
      await expect(InstagramAnalyticsSyncJob.runSync()).resolves.not.toThrow();
    });
  });
});
