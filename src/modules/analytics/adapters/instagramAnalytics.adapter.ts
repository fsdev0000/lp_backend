import { PrismaClient } from '@prisma/client';
import {
  IInstagramAnalyticsAdapter,
  InstagramAnalyticsData,
  InstagramPostDetailRow,
} from './interfaces';
import { InstagramAdapter } from '../../social/adapters/instagram.adapter';
import { resolveWindow } from '../utils/dateRange';

const prisma = new PrismaClient();

interface CacheEntry<T> {
  data: T;
  cachedAt: number;
}

export class InstagramAnalyticsAdapter implements IInstagramAnalyticsAdapter {
  private readonly adapter = new InstagramAdapter();
  private readonly accountId: string;
  private readonly defaultToken: string;

  private static accountCache: Record<string, CacheEntry<InstagramAnalyticsData>> = {};
  private static postsCache: CacheEntry<InstagramPostDetailRow[]> | null = null;
  private static readonly CACHE_TTL_MS = 60 * 60 * 1000; // 1-hour cache TTL

  constructor() {
    this.accountId =
      process.env.INSTAGRAM_ACCOUNT_ID ||
      process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID ||
      '17841427503988004';
    this.defaultToken = process.env.INSTAGRAM_ACCESS_TOKEN || '';
  }

  /**
   * Retrieves account analytics for the requested date window
   */
  public async getAccountAnalytics(
    range = '7d',
    forceRefresh = false
  ): Promise<InstagramAnalyticsData> {
    const win = resolveWindow(range, 1);
    const now = Date.now();
    const cached = InstagramAnalyticsAdapter.accountCache[range];

    if (!forceRefresh && cached && now - cached.cachedAt < InstagramAnalyticsAdapter.CACHE_TTL_MS) {
      return {
        ...cached.data,
        isCached: true,
        isFallback: false,
      };
    }

    const conn = await this.adapter.getActiveConnection();
    const token = conn?.accessToken || this.defaultToken;
    const accountId = (conn?.metadata as any)?.accountId || this.accountId;

    if (!conn || !token) {
      return this.buildDisconnectedResponse(range, win.startDate, win.endDate);
    }

    try {
      // 1. Fetch live account vitals
      const profileUrl = `https://graph.facebook.com/v21.0/${accountId}?fields=id,username,name,biography,profile_picture_url,followers_count,follows_count,media_count&access_token=${token}`;
      const profileRes = await fetch(profileUrl);

      if (!profileRes.ok) {
        throw new Error(`Meta Graph API returned HTTP ${profileRes.status}`);
      }

      const profile = (await profileRes.json()) as any;
      const followers = typeof profile.followers_count === 'number' ? profile.followers_count : null;
      const postsCount = typeof profile.media_count === 'number' ? profile.media_count : null;

      // 2. Fetch recent media in range
      const posts = await this.getPosts(forceRefresh);
      const postsInRange = posts.filter((p) => {
        const pubDate = p.publishedAt.slice(0, 10);
        return pubDate >= win.startDate && pubDate <= win.endDate;
      });

      // 3. Compute Engagement Rate if data is available
      let engagementRate: number | null = null;
      let engagementRateFormatted: string | null = null;

      if (postsInRange.length > 0 && followers && followers > 0) {
        let totalInteractions = 0;
        let countedPosts = 0;
        for (const p of postsInRange) {
          if (p.likes !== null || p.comments !== null) {
            totalInteractions += (p.likes || 0) + (p.comments || 0);
            countedPosts += 1;
          }
        }
        if (countedPosts > 0) {
          const rawRate = (totalInteractions / (countedPosts * followers)) * 100;
          engagementRate = Number(rawRate.toFixed(2));
          engagementRateFormatted = `${engagementRate}%`;
        }
      }

      // 4. Query Insights metrics (strict null if permission not granted on token)
      let reach: number | null = null;
      let impressions: number | null = null;
      let profileViews: number | null = null;
      let followerGrowth: number | null = null;
      let followerGrowthFormatted: string | null = null;

      try {
        const startUnix = Math.floor(new Date(`${win.startDate}T00:00:00Z`).getTime() / 1000);
        const endUnix = Math.floor(new Date(`${win.endDate}T23:59:59Z`).getTime() / 1000);

        const insightsUrl = `https://graph.facebook.com/v21.0/${accountId}/insights?metric=reach,impressions,profile_views&period=day&since=${startUnix}&until=${endUnix}&access_token=${token}`;
        const insightsRes = await fetch(insightsUrl);

        if (insightsRes.ok) {
          const insData = (await insightsRes.json()) as any;
          const rows = insData.data || [];
          for (const row of rows) {
            const sum = (row.values || []).reduce((acc: number, v: any) => acc + (v.value || 0), 0);
            if (row.name === 'reach') reach = sum;
            if (row.name === 'impressions') impressions = sum;
            if (row.name === 'profile_views') profileViews = sum;
          }
        }
      } catch (e: any) {
        console.warn('[InstagramAnalyticsAdapter] Insights query notice:', e?.message);
      }

      const result: InstagramAnalyticsData = {
        accountId: profile.id || accountId,
        username: profile.username || 'lioneleersteling',
        name: profile.name || 'Lionel Eersteling | Founder Performance',
        profilePictureUrl: profile.profile_picture_url || null,
        biography: profile.biography || null,
        connected: true,
        followers,
        followerGrowth,
        followerGrowthFormatted,
        reach,
        impressions,
        profileViews,
        engagementRate,
        engagementRateFormatted,
        postsCount,
        postsInRange: postsInRange.length,
        recentPosts: posts.slice(0, 10),
        range,
        startDate: win.startDate,
        endDate: win.endDate,
        cachedAt: new Date(now).toISOString(),
        isCached: false,
        isFallback: false,
      };

      // Persist in memory cache
      InstagramAnalyticsAdapter.accountCache[range] = {
        data: result,
        cachedAt: now,
      };

      // Persist snapshot to database asynchronously
      this.persistSnapshot(result).catch(() => {});

      return result;
    } catch (err: any) {
      console.warn('[InstagramAnalyticsAdapter] Failed to fetch live data:', err?.message);

      if (cached) {
        return {
          ...cached.data,
          isCached: true,
          isFallback: true,
        };
      }

      return this.buildDisconnectedResponse(range, win.startDate, win.endDate, true);
    }
  }

  /**
   * Retrieves recent Instagram media posts and Reels
   */
  public async getPosts(forceRefresh = false): Promise<InstagramPostDetailRow[]> {
    const now = Date.now();
    if (!forceRefresh && InstagramAnalyticsAdapter.postsCache && now - InstagramAnalyticsAdapter.postsCache.cachedAt < InstagramAnalyticsAdapter.CACHE_TTL_MS) {
      return InstagramAnalyticsAdapter.postsCache.data;
    }

    const conn = await this.adapter.getActiveConnection();
    const token = conn?.accessToken || this.defaultToken;
    const accountId = (conn?.metadata as any)?.accountId || this.accountId;

    if (!conn || !token) {
      return [];
    }

    try {
      const mediaUrl = `https://graph.facebook.com/v21.0/${accountId}/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count&limit=30&access_token=${token}`;
      const res = await fetch(mediaUrl);

      if (!res.ok) {
        throw new Error(`Media fetch returned HTTP ${res.status}`);
      }

      const json = (await res.json()) as any;
      const rawPosts = json.data || [];

      const posts: InstagramPostDetailRow[] = rawPosts.map((m: any) => ({
        id: m.id,
        caption: m.caption || null,
        mediaType: m.media_type || 'IMAGE',
        mediaUrl: m.media_url || null,
        thumbnailUrl: m.thumbnail_url || m.media_url || null,
        permalink: m.permalink || `https://www.instagram.com/p/${m.id}/`,
        publishedAt: m.timestamp || new Date().toISOString(),
        likes: typeof m.like_count === 'number' ? m.like_count : null,
        comments: typeof m.comments_count === 'number' ? m.comments_count : null,
        reach: null, // Populated via insights when permission granted
        impressions: null,
        saved: null,
        shares: null,
        engagementRate: null,
        engagementRateFormatted: null,
      }));

      // Sort newest first
      posts.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

      InstagramAnalyticsAdapter.postsCache = {
        data: posts,
        cachedAt: now,
      };

      // Persist snapshots in background
      this.persistMediaSnapshots(posts).catch(() => {});

      return posts;
    } catch (err: any) {
      console.warn('[InstagramAnalyticsAdapter] Failed to fetch media:', err?.message);
      return InstagramAnalyticsAdapter.postsCache?.data || [];
    }
  }

  /**
   * Health check probe
   */
  public async ping() {
    return this.adapter.ping();
  }

  private buildDisconnectedResponse(
    range: string,
    startDate: string,
    endDate: string,
    isFallback = false
  ): InstagramAnalyticsData {
    return {
      accountId: this.accountId,
      username: process.env.INSTAGRAM_USERNAME || 'lioneleersteling',
      name: 'Lionel Eersteling | Founder Performance',
      profilePictureUrl: null,
      biography: null,
      connected: false,
      followers: null,
      followerGrowth: null,
      followerGrowthFormatted: null,
      reach: null,
      impressions: null,
      profileViews: null,
      engagementRate: null,
      engagementRateFormatted: null,
      postsCount: null,
      postsInRange: null,
      recentPosts: [],
      range,
      startDate,
      endDate,
      cachedAt: new Date().toISOString(),
      isCached: false,
      isFallback,
    };
  }

  private async persistSnapshot(data: InstagramAnalyticsData) {
    try {
      await prisma.instagramAnalyticsSnapshot.create({
        data: {
          followersCount: data.followers || 0,
          followsCount: 0,
          mediaCount: data.postsCount || 0,
          impressions: data.impressions,
          reach: data.reach,
          profileViews: data.profileViews,
          engagementRate: data.engagementRate,
          dateRange: data.range,
          rawMetrics: data as any,
        },
      });
    } catch (e: any) {
      console.warn('[InstagramAnalyticsAdapter] Snapshot write notice:', e?.message);
    }
  }

  private async persistMediaSnapshots(posts: InstagramPostDetailRow[]) {
    try {
      for (const p of posts.slice(0, 10)) {
        await prisma.instagramMediaSnapshot.upsert({
          where: { mediaId: p.id },
          create: {
            mediaId: p.id,
            mediaType: p.mediaType,
            caption: p.caption,
            permalink: p.permalink,
            mediaUrl: p.mediaUrl,
            thumbnailUrl: p.thumbnailUrl,
            likeCount: p.likes || 0,
            commentsCount: p.comments || 0,
            publishedAt: new Date(p.publishedAt),
            lastSyncedAt: new Date(),
          },
          update: {
            likeCount: p.likes || 0,
            commentsCount: p.comments || 0,
            lastSyncedAt: new Date(),
          },
        });
      }
    } catch (e: any) {
      console.warn('[InstagramAnalyticsAdapter] Media snapshot notice:', e?.message);
    }
  }
}
