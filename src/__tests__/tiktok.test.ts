import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import tiktokRoutes from '../modules/social/tiktok.routes';
import { TikTokService } from '../modules/social/services/tiktok.service';
import { TikTokAdapter } from '../modules/social/adapters/tiktok.adapter';
import { socialPrisma } from '../modules/social/adapters/linkedin.adapter';

const app = express();
app.use(express.json());
app.use('/api/v1/social/tiktok', tiktokRoutes);

const TEST_API_KEY = 'test-tiktok-api-key-2026';

describe('TikTok Integration Security & Publishing Suite', () => {
  const service = new TikTokService();
  const adapter = new TikTokAdapter();

  beforeAll(() => {
    process.env.ADMIN_API_KEY = TEST_API_KEY;
    process.env.TIKTOK_PUBLISHING_ENABLED = 'false';
    process.env.TIKTOK_CLIENT_KEY = 'mock_tiktok_client_key';
    process.env.TIKTOK_CLIENT_SECRET = 'mock_tiktok_client_secret';
  });

  beforeEach(() => {
    jest.spyOn(socialPrisma.systemConfig, 'upsert').mockResolvedValue({} as any);
    jest.spyOn(socialPrisma.systemConfig, 'findUnique').mockResolvedValue(null);
    jest.spyOn(socialPrisma.systemConfig, 'delete').mockResolvedValue({} as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('Item 9: rejects unauthenticated GET /api/v1/social/tiktok/auth-url with HTTP 401', async () => {
    const res = await request(app).get('/api/v1/social/tiktok/auth-url');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('Item 9: generates auth-url with valid issued state when authenticated', async () => {
    const res = await request(app)
      .get('/api/v1/social/tiktok/auth-url')
      .set('x-api-key', TEST_API_KEY)
      .set('Accept', 'application/json');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.url).toContain('https://www.tiktok.com/v2/auth/authorize/');
    expect(res.body.state).toMatch(/^tt_/);
  });

  it('Item 9: rejects unissued state in handleCallback with HTTP 400', async () => {
    await expect(
      service.handleCallback('mock_code', 'tt_unissued_arbitrary_attacker_state')
    ).rejects.toThrow('Invalid or expired TikTok OAuth state parameter');
  });

  it('Item 8: rejects /publish with HTTP 403 while TIKTOK_PUBLISHING_ENABLED is false', async () => {
    const res = await request(app)
      .post('/api/v1/social/tiktok/publish')
      .set('x-api-key', TEST_API_KEY)
      .send({
        title: 'Unauthorized test reel',
        videoUrl: 'https://staging.leadersperformance.ae/uploads/video.mp4',
        mode: 'DRAFT',
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('TIKTOK_PUBLISHING_ENABLED=false');
  });

  it('Item 4: getAnalytics returns real performance7d structure with zero fake numbers', async () => {
    jest.spyOn(TikTokAdapter.prototype, 'getActiveConnection').mockResolvedValue({
      accessToken: 'mock_token',
      refreshToken: 'mock_refresh',
      tokenExpiresAt: new Date(Date.now() + 86400000),
    } as any);

    jest.spyOn(TikTokAdapter.prototype, 'fetchUserProfile').mockResolvedValue({
      openId: 'user_123',
      displayName: 'Lionel Eersteling',
      username: 'lioneleersteling',
      avatarUrl: null,
      bioDescription: null,
      profileDeepLink: null,
      isVerified: false,
      followerCount: 48886,
      followingCount: 33,
      likesCount: 753777,
      videoCount: 1192,
    });

    jest.spyOn(TikTokAdapter.prototype, 'fetchVideos').mockResolvedValue([
      {
        id: 'vid-1',
        title: 'Recent reel',
        description: 'Recent reel',
        publishedAt: new Date().toISOString(),
        durationSeconds: 15,
        coverImageUrl: null,
        shareUrl: null,
        views: 250,
        likes: 15,
        comments: 2,
        shares: 4,
      },
    ]);

    const analytics = await service.getAnalytics();
    expect(analytics.connected).toBe(true);
    expect(analytics.performance7d).toBeDefined();
    // Real aggregations only
    expect(analytics.performance7d!.videoViews).toBe(250);
    expect(analytics.performance7d!.likes).toBe(15);
    expect(analytics.performance7d!.comments).toBe(2);
    expect(analytics.performance7d!.shares).toBe(4);
    // Verified no fake properties
    expect((analytics.performance7d as any).videoViewsGrowth).toBeUndefined();
    expect((analytics.performance7d as any).profileViews).toBeUndefined();
    expect((analytics.performance7d as any).trafficSources).toBeUndefined();
    expect((analytics.performance7d as any).estimatedRewards).toBeUndefined();
  });
});
