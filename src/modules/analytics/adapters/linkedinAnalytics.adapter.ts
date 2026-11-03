import { PrismaClient } from '@prisma/client';
import {
  ILinkedInAnalyticsAdapter,
  LinkedInAnalyticsData,
  LinkedInPostDetailRow,
} from './interfaces';
import { LiveErrorBoundary } from './liveErrorBoundary';
import { resolveWindow } from '../utils/dateRange';

const prisma = new PrismaClient();

interface LinkedInCacheEntry {
  data: LinkedInAnalyticsData;
  cachedAt: number;
}

export class LinkedInAnalyticsAdapter implements ILinkedInAnalyticsAdapter {
  private static cache: Record<string, LinkedInCacheEntry> = {};
  private static postsCache: { data: LinkedInPostDetailRow[]; cachedAt: number } | null = null;
  private readonly cacheTtlMs = 60 * 60 * 1000; // 1-hour cache to protect LinkedIn rate limits
  private readonly defaultApiVersion = '202401';

  /**
   * Resolves the configured organization URN (urn:li:organization:<id>)
   */
  public getOrganizationUrn(): string | null {
    const raw = process.env.LINKEDIN_ORGANIZATION_URN || process.env.LINKEDIN_ORGANIZATION_ID;
    if (!raw || !raw.trim()) return null;
    const clean = raw.trim();
    if (clean.startsWith('urn:li:organization:')) {
      return clean;
    }
    return `urn:li:organization:${clean}`;
  }

  /**
   * Retrieves active LinkedIn connection credentials from database
   */
  private async getActiveConnection() {
    try {
      return await prisma.socialAccountConnection.findUnique({
        where: { platform: 'LINKEDIN' },
      });
    } catch (e: any) {
      console.warn('[LinkedInAnalyticsAdapter] Database connection notice:', e?.message);
      return null;
    }
  }

  /**
   * Retrieves organization analytics for a given time window (7d, 30d, 90d, all)
   */
  public async getCompanyAnalytics(range = '7d', forceRefresh = false): Promise<LinkedInAnalyticsData> {
    const win = resolveWindow(range, 1);
    const now = Date.now();
    const cacheKey = win.range;

    // 1. Serve cached metrics if within TTL and not force refreshing
    if (!forceRefresh && LinkedInAnalyticsAdapter.cache[cacheKey]) {
      const cached = LinkedInAnalyticsAdapter.cache[cacheKey];
      if (now - cached.cachedAt < this.cacheTtlMs) {
        return {
          ...cached.data,
          isCached: true,
        };
      }
    }

    const orgUrn = this.getOrganizationUrn();
    const conn = await this.getActiveConnection();
    const envToken = process.env.LINKEDIN_ACCESS_TOKEN?.trim() || '';
    const token = conn?.accessToken || envToken;

    const isConnected = !!(token && orgUrn && (conn?.tokenExpiresAt ? new Date(conn.tokenExpiresAt).getTime() > now : true));

    // If company page is not connected or organization is not configured, return clean null-state schema
    if (!isConnected || !orgUrn) {
      const emptyResult: LinkedInAnalyticsData = {
        organizationId: orgUrn ? orgUrn.replace(/^urn:li:organization:/, '') : null,
        organizationUrn: orgUrn,
        name: 'Leaders Performance',
        vanityName: 'leaders-performance',
        description: null,
        logoUrl: null,
        connected: false,
        followers: null,
        followerGrowth: null,
        followerGrowthFormatted: null,
        impressions: null,
        clicks: null,
        engagementRate: null,
        engagementRateFormatted: null,
        pageViews: null,
        uniquePageViews: null,
        postsInRange: null,
        recentPosts: [],
        range: win.range,
        startDate: win.startDate,
        endDate: win.endDate,
        cachedAt: new Date().toISOString(),
        isCached: false,
        isFallback: false,
      };

      LinkedInAnalyticsAdapter.cache[cacheKey] = {
        data: emptyResult,
        cachedAt: now,
      };

      return emptyResult;
    }

    const startMs = new Date(`${win.startDate}T00:00:00Z`).getTime();
    const endMs = new Date(`${win.endDate}T23:59:59Z`).getTime();
    const headers = {
      Authorization: `Bearer ${token}`,
      'Linkedin-Version': this.defaultApiVersion,
      'X-Restli-Protocol-Version': '2.0.0',
    };

    try {
      // 2. Fetch Follower Statistics & Network Size (Total Followers + Growth)
      let followers: number | null = null;
      let followerGrowth: number | null = null;

      try {
        const followerStatsUrl = `https://api.linkedin.com/rest/organizationalEntityFollowerStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(
          orgUrn
        )}&timeIntervals=(timeGranularityType:DAY,timeRange:(start:${startMs},end:${endMs}))`;

        const fRes = await fetch(followerStatsUrl, { headers });
        if (fRes.ok) {
          const fData = (await fRes.json()) as any;
          let netGains = 0;
          let hasGains = false;

          for (const item of fData.elements || []) {
            const gains = item.followerGains;
            if (gains) {
              const organic = gains.organicFollowerGain || 0;
              const paid = gains.paidFollowerGain || 0;
              netGains += organic + paid;
              hasGains = true;
            }
          }
          if (hasGains) followerGrowth = netGains;
        }

        // Also fetch total followers from networkSizes
        const networkUrl = `https://api.linkedin.com/v2/networkSizes/${encodeURIComponent(
          orgUrn
        )}?edgeType=CompanyFollowedByMember`;
        const netRes = await fetch(networkUrl, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (netRes.ok) {
          const netData = (await netRes.json()) as any;
          if (typeof netData.firstDegreeSize === 'number') {
            followers = netData.firstDegreeSize;
          }
        }
      } catch (err: any) {
        console.warn('[LinkedInAnalyticsAdapter] Follower stats notice:', err?.message);
      }

      // 3. Fetch Share Statistics (Impressions, Clicks, Engagement Rate)
      let impressions: number | null = null;
      let clicks: number | null = null;
      let engagementRate: number | null = null;

      try {
        const shareStatsUrl = `https://api.linkedin.com/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(
          orgUrn
        )}&timeIntervals=(timeGranularityType:DAY,timeRange:(start:${startMs},end:${endMs}))`;

        const sRes = await fetch(shareStatsUrl, { headers });
        if (sRes.ok) {
          const sData = (await sRes.json()) as any;
          let totalImp = 0;
          let totalClicks = 0;
          let totalEngagements = 0;
          let hasStats = false;

          for (const item of sData.elements || []) {
            const stats = item.totalShareStatistics;
            if (stats) {
              totalImp += stats.uniqueImpressionsCount || stats.impressionCount || 0;
              totalClicks += stats.clickCount || 0;
              totalEngagements += stats.likeCount || 0 + (stats.commentCount || 0) + (stats.shareCount || 0);
              hasStats = true;
            }
          }

          if (hasStats) {
            impressions = totalImp;
            clicks = totalClicks;
            if (impressions > 0) {
              engagementRate = parseFloat(((totalClicks + totalEngagements) / impressions * 100).toFixed(2));
            }
          }
        }
      } catch (err: any) {
        console.warn('[LinkedInAnalyticsAdapter] Share stats notice:', err?.message);
      }

      // 4. Fetch Page Statistics (Page Views & Unique Visitors)
      let pageViews: number | null = null;
      let uniquePageViews: number | null = null;

      try {
        const pageStatsUrl = `https://api.linkedin.com/rest/organizationPageStatistics?q=organization&organization=${encodeURIComponent(
          orgUrn
        )}&timeIntervals=(timeGranularityType:DAY,timeRange:(start:${startMs},end:${endMs}))`;

        const pRes = await fetch(pageStatsUrl, { headers });
        if (pRes.ok) {
          const pData = (await pRes.json()) as any;
          let views = 0;
          let uViews = 0;
          let hasPageStats = false;

          for (const item of pData.elements || []) {
            const v = item.views?.allPageViews;
            if (v) {
              views += v.pageViews || 0;
              uViews += v.uniquePageViews || 0;
              hasPageStats = true;
            }
          }

          if (hasPageStats) {
            pageViews = views;
            uniquePageViews = uViews;
          }
        }
      } catch (err: any) {
        console.warn('[LinkedInAnalyticsAdapter] Page stats notice:', err?.message);
      }

      // 5. Fetch Page Posts to derive postsInRange
      const recentPosts = await this.getPosts(forceRefresh).catch(() => []);
      const postsInRange = recentPosts.filter((p) => {
        const pDate = p.publishedAt ? p.publishedAt.slice(0, 10) : '';
        return pDate >= win.startDate && pDate <= win.endDate;
      }).length;

      const result: LinkedInAnalyticsData = {
        organizationId: orgUrn.replace(/^urn:li:organization:/, ''),
        organizationUrn: orgUrn,
        name: 'Leaders Performance',
        vanityName: 'leaders-performance',
        description: 'Executive Coaching, High-Performance Systems & Sovereign Leadership.',
        logoUrl: conn?.profilePictureUrl || null,
        connected: true,
        followers,
        followerGrowth,
        followerGrowthFormatted:
          followerGrowth !== null ? (followerGrowth >= 0 ? `+${followerGrowth}` : `${followerGrowth}`) : null,
        impressions,
        clicks,
        engagementRate,
        engagementRateFormatted: engagementRate !== null ? `${engagementRate}%` : null,
        pageViews,
        uniquePageViews,
        postsInRange,
        recentPosts: recentPosts.slice(0, 10),
        range: win.range,
        startDate: win.startDate,
        endDate: win.endDate,
        cachedAt: new Date().toISOString(),
        isCached: false,
        isFallback: false,
      };

      LinkedInAnalyticsAdapter.cache[cacheKey] = {
        data: result,
        cachedAt: now,
      };

      return result;
    } catch (err: any) {
      await LiveErrorBoundary.logUpstreamError('LINKEDIN' as any, 'getCompanyAnalytics', err);
      if (LinkedInAnalyticsAdapter.cache[cacheKey]) {
        return {
          ...LinkedInAnalyticsAdapter.cache[cacheKey].data,
          isCached: true,
          isFallback: true,
        };
      }

      return {
        organizationId: orgUrn ? orgUrn.replace(/^urn:li:organization:/, '') : null,
        organizationUrn: orgUrn,
        name: 'Leaders Performance',
        vanityName: 'leaders-performance',
        description: null,
        logoUrl: null,
        connected: isConnected,
        followers: null,
        followerGrowth: null,
        followerGrowthFormatted: null,
        impressions: null,
        clicks: null,
        engagementRate: null,
        engagementRateFormatted: null,
        pageViews: null,
        uniquePageViews: null,
        postsInRange: null,
        recentPosts: [],
        range: win.range,
        startDate: win.startDate,
        endDate: win.endDate,
        cachedAt: new Date().toISOString(),
        isCached: false,
        isFallback: true,
      };
    }
  }

  /**
   * Retrieves the page's recent posts with performance metrics (newest first)
   */
  public async getPosts(forceRefresh = false): Promise<LinkedInPostDetailRow[]> {
    const now = Date.now();

    if (!forceRefresh && LinkedInAnalyticsAdapter.postsCache && now - LinkedInAnalyticsAdapter.postsCache.cachedAt < this.cacheTtlMs) {
      return LinkedInAnalyticsAdapter.postsCache.data;
    }

    const orgUrn = this.getOrganizationUrn();
    const conn = await this.getActiveConnection();

    if (!conn || !conn.accessToken || !orgUrn) {
      // If live company page is not connected, query any published LinkedIn posts stored in database
      const dbPosts = await this.getFallbackDbPosts();
      return dbPosts;
    }

    const token = conn.accessToken;
    const headers = {
      Authorization: `Bearer ${token}`,
      'Linkedin-Version': this.defaultApiVersion,
      'X-Restli-Protocol-Version': '2.0.0',
    };

    try {
      // 1. Query organization posts via LinkedIn REST API
      const postsUrl = `https://api.linkedin.com/rest/posts?author=${encodeURIComponent(
        orgUrn
      )}&q=author&count=20&sortBy=LAST_MODIFIED`;

      let postsRows: LinkedInPostDetailRow[] = [];
      const res = await fetch(postsUrl, { headers });

      if (res.ok) {
        const data = (await res.json()) as any;
        for (const item of data.elements || []) {
          const postUrn = item.id || '';
          const commentary = item.commentary || item.title || '';
          const publishedAt = item.publishedAt ? new Date(item.publishedAt).toISOString() : new Date().toISOString();
          const cleanUrl = `https://www.linkedin.com/feed/update/${encodeURIComponent(postUrn)}`;

          postsRows.push({
            id: postUrn,
            urn: postUrn,
            title: item.title || (commentary.length > 60 ? `${commentary.substring(0, 57)}...` : commentary),
            text: commentary,
            publishedAt,
            mediaUrl: item.content?.article?.thumbnail || item.content?.media?.id || null,
            mediaType: item.content?.media ? 'image' : 'text',
            impressions: null,
            clicks: null,
            reactions: null,
            comments: null,
            reposts: null,
            engagementRate: null,
            engagementRateFormatted: null,
            url: cleanUrl,
          });
        }
      } else {
        // Fallback to UGC Posts API
        const ugcUrl = `https://api.linkedin.com/v2/ugcPosts?q=authors&authors=List(${encodeURIComponent(orgUrn)})&count=20`;
        const ugcRes = await fetch(ugcUrl, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (ugcRes.ok) {
          const ugcData = (await ugcRes.json()) as any;
          for (const item of ugcData.elements || []) {
            const postUrn = item.id || '';
            const shareContent = item.specificContent?.['com.linkedin.ugc.ShareContent'];
            const text = shareContent?.shareCommentary?.text || '';
            const createdAt = item.created?.time ? new Date(item.created.time).toISOString() : new Date().toISOString();

            postsRows.push({
              id: postUrn,
              urn: postUrn,
              title: text.length > 60 ? `${text.substring(0, 57)}...` : text,
              text,
              publishedAt: createdAt,
              mediaUrl: shareContent?.media?.[0]?.originalUrl || null,
              mediaType: shareContent?.shareMediaCategory || 'text',
              impressions: null,
              clicks: null,
              reactions: null,
              comments: null,
              reposts: null,
              engagementRate: null,
              engagementRateFormatted: null,
              url: `https://www.linkedin.com/feed/update/${encodeURIComponent(postUrn)}`,
            });
          }
        }
      }

      // If remote returned posts, sort newest first and cache
      if (postsRows.length > 0) {
        postsRows.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

        LinkedInAnalyticsAdapter.postsCache = {
          data: postsRows,
          cachedAt: now,
        };

        return postsRows;
      }

      // Otherwise return database published posts
      return this.getFallbackDbPosts();
    } catch (err: any) {
      console.warn('[LinkedInAnalyticsAdapter] getPosts notice:', err?.message);
      return this.getFallbackDbPosts();
    }
  }

  /**
   * Helper to fetch published LinkedIn posts from the database when offline or not yet connected
   */
  private async getFallbackDbPosts(): Promise<LinkedInPostDetailRow[]> {
    try {
      const posts = await prisma.socialPost.findMany({
        where: {
          platform: 'LINKEDIN',
          status: 'PUBLISHED',
        },
        orderBy: { publishedAt: 'desc' },
        take: 20,
      });

      return posts.map((p) => {
        const metrics: any = p.metrics || {};
        const impressions = typeof metrics.impressions === 'number' ? metrics.impressions : null;
        const reactions = typeof metrics.reactions === 'number' ? metrics.reactions : null;
        const reposts = typeof metrics.reposts === 'number' ? metrics.reposts : null;
        const clicks = typeof metrics.clicks === 'number' ? metrics.clicks : null;
        const comments = typeof metrics.comments === 'number' ? metrics.comments : null;

        let engagementRate: number | null = null;
        if (impressions && impressions > 0 && reactions !== null) {
          engagementRate = parseFloat((((reactions + (comments || 0) + (reposts || 0)) / impressions) * 100).toFixed(2));
        }

        return {
          id: p.id,
          urn: p.platformPostId || `urn:li:share:${p.id}`,
          title: p.title,
          text: p.hook ? `${p.hook}\n\n${p.body || ''}` : p.body || p.title,
          publishedAt: (p.publishedAt || p.createdAt).toISOString(),
          mediaUrl: p.mediaUrl,
          mediaType: p.mediaType,
          impressions,
          clicks,
          reactions,
          comments,
          reposts,
          engagementRate,
          engagementRateFormatted: engagementRate !== null ? `${engagementRate}%` : null,
          url: p.platformPostUrl || (p.platformPostId ? `https://www.linkedin.com/feed/update/${encodeURIComponent(p.platformPostId)}` : null),
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * Probes integration health and response latency
   */
  public async ping(): Promise<{ status: 'HEALTHY' | 'DEGRADED' | 'DOWN'; latencyMs: number; message: string }> {
    const start = Date.now();
    const orgUrn = this.getOrganizationUrn();
    const conn = await this.getActiveConnection();

    if (!conn) {
      return {
        status: 'DEGRADED',
        latencyMs: Date.now() - start,
        message: 'LinkedIn account not connected via OAuth yet',
      };
    }

    if (!orgUrn) {
      return {
        status: 'DEGRADED',
        latencyMs: Date.now() - start,
        message: 'LinkedIn account connected, but LINKEDIN_ORGANIZATION_URN is not set in environment',
      };
    }

    try {
      const res = await fetch(`https://api.linkedin.com/v2/networkSizes/${encodeURIComponent(orgUrn)}?edgeType=CompanyFollowedByMember`, {
        headers: { Authorization: `Bearer ${conn.accessToken}` },
      });
      const latencyMs = Date.now() - start;

      if (res.ok) {
        return { status: 'HEALTHY', latencyMs, message: `Connected to LinkedIn Organization: ${orgUrn}` };
      }
      return { status: 'DEGRADED', latencyMs, message: `Organization check returned HTTP ${res.status}` };
    } catch (err: any) {
      return { status: 'DOWN', latencyMs: Date.now() - start, message: err?.message || 'Connection error' };
    }
  }
}
