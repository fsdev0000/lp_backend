import { PrismaClient } from '@prisma/client';
import {
  ILinkedInAnalyticsAdapter,
  LinkedInAnalyticsData,
  LinkedInPostDetailRow,
} from './interfaces';
import { LiveErrorBoundary } from './liveErrorBoundary';
import { resolveWindow } from '../utils/dateRange';
import {
  getLinkedInApiVersion,
  getLinkedInVanityName,
  LINKEDIN_PAGE_PLATFORM,
} from '../../social/config/linkedin.config';

export const analyticsPrisma = new PrismaClient();

interface LinkedInCacheEntry {
  data: LinkedInAnalyticsData;
  cachedAt: number;
}

export class LinkedInAnalyticsAdapter implements ILinkedInAnalyticsAdapter {
  private static cache: Record<string, LinkedInCacheEntry> = {};
  private static postsCache: { data: LinkedInPostDetailRow[]; cachedAt: number } | null = null;
  private static resolvedOrgUrn: string | null = null;
  private readonly cacheTtlMs = 60 * 60 * 1000; // 1-hour cache for connected responses

  /**
   * Clears in-memory analytics and posts caches (e.g., upon OAuth connection or disconnect).
   */
  public static clearCache(): void {
    this.cache = {};
    this.postsCache = null;
    this.resolvedOrgUrn = null;
  }

  /**
   * Resolves the configured organization URN (urn:li:organization:<id>)
   */
  public getOrganizationUrn(connAccountUrn?: string | null): string | null {
    const raw =
      process.env.LINKEDIN_ORGANIZATION_URN?.trim() ||
      process.env.LINKEDIN_ORGANIZATION_ID?.trim() ||
      (connAccountUrn && connAccountUrn.startsWith('urn:li:organization:') ? connAccountUrn.trim() : '') ||
      LinkedInAnalyticsAdapter.resolvedOrgUrn ||
      '';

    if (!raw) return null;
    if (raw.startsWith('urn:li:organization:')) {
      return raw;
    }
    return `urn:li:organization:${raw}`;
  }

  /**
   * Dynamically resolves the organization URN by vanityName (lioneleersteling) if not set in env
   */
  private async resolveOrganizationUrnFromApi(token: string, connAccountUrn?: string | null): Promise<string | null> {
    const existing = this.getOrganizationUrn(connAccountUrn);
    if (existing && /^urn:li:organization:\d+$/.test(existing)) {
      return existing;
    }

    const vanityName = getLinkedInVanityName();
    const apiVersion = getLinkedInApiVersion();
    try {
      const url = `https://api.linkedin.com/rest/organizations?q=vanityName&vanityName=${encodeURIComponent(
        vanityName
      )}`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          'LinkedIn-Version': apiVersion,
          'X-Restli-Protocol-Version': '2.0.0',
        },
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        const orgId = data?.elements?.[0]?.id;
        if (orgId) {
          const urn = `urn:li:organization:${orgId}`;
          LinkedInAnalyticsAdapter.resolvedOrgUrn = urn;
          return urn;
        }
      }
    } catch {
      // Ignore network lookup failure and fall back to existing
    }

    return existing;
  }

  /**
   * Retrieves active LinkedIn Company Page connection ('LINKEDIN_PAGE') from database.
   * Item 9: Uses dedicated LINKEDIN_PAGE record with read-only scopes, separate from personal posting ('LINKEDIN').
   */
  private async getActiveConnection() {
    try {
      return await analyticsPrisma.socialAccountConnection.findUnique({
        where: { platform: LINKEDIN_PAGE_PLATFORM },
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
    const vanityName = getLinkedInVanityName();
    const apiVersion = getLinkedInApiVersion();

    // 1. Serve cached metrics ONLY if connected and within TTL
    if (!forceRefresh && LinkedInAnalyticsAdapter.cache[cacheKey]) {
      const cached = LinkedInAnalyticsAdapter.cache[cacheKey];
      if (cached.data.connected && now - cached.cachedAt < this.cacheTtlMs) {
        return {
          ...cached.data,
          isCached: true,
        };
      }
    }

    const conn = await this.getActiveConnection();
    const envToken =
      process.env.LINKEDIN_PAGE_ACCESS_TOKEN?.trim() ||
      process.env.LINKEDIN_ACCESS_TOKEN?.trim() ||
      '';
    const token = conn?.accessToken || envToken;
    const isTokenValid = Boolean(
      token && (conn?.tokenExpiresAt ? new Date(conn.tokenExpiresAt).getTime() > now : true)
    );

    const orgUrn = isTokenValid
      ? await this.resolveOrganizationUrnFromApi(token, conn?.accountUrn)
      : this.getOrganizationUrn(conn?.accountUrn);

    const isConnected = Boolean(isTokenValid && orgUrn);

    // Item 14: Never cache the "not connected" state so connecting the page shows live data immediately
    if (!isConnected || !orgUrn) {
      delete LinkedInAnalyticsAdapter.cache[cacheKey];
      return {
        organizationId: orgUrn ? orgUrn.replace(/^urn:li:organization:/, '') : null,
        organizationUrn: orgUrn,
        name: 'Leaders Performance',
        vanityName,
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
    }

    const startMs = new Date(`${win.startDate}T00:00:00Z`).getTime();
    const endMs = new Date(`${win.endDate}T23:59:59Z`).getTime();
    const headers = {
      Authorization: `Bearer ${token}`,
      'LinkedIn-Version': apiVersion,
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
      // Item 12: Use totalShareStatistics.engagement (or properly parenthesized fallback)
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
          const elements = sData.elements || [];
          let totalImp = 0;
          let totalClicks = 0;
          let totalInteractions = 0;
          let weightedEngagementSum = 0;
          let hasEngagementField = false;
          let hasStats = false;

          for (const item of elements) {
            const stats = item.totalShareStatistics;
            if (stats) {
              const imp = stats.uniqueImpressionsCount || stats.impressionCount || 0;
              const clk = stats.clickCount || 0;
              const likes = stats.likeCount || 0;
              const comments = stats.commentCount || 0;
              const shares = stats.shareCount || 0;

              totalImp += imp;
              totalClicks += clk;
              totalInteractions += likes + comments + shares;

              if (typeof stats.engagement === 'number') {
                hasEngagementField = true;
                weightedEngagementSum += imp > 0 ? stats.engagement * imp : stats.engagement;
              }
              hasStats = true;
            }
          }

          if (hasStats) {
            impressions = totalImp;
            clicks = totalClicks;
            if (
              elements.length === 1 &&
              typeof elements[0]?.totalShareStatistics?.engagement === 'number'
            ) {
              engagementRate = parseFloat((elements[0].totalShareStatistics.engagement * 100).toFixed(2));
            } else if (hasEngagementField && impressions > 0) {
              engagementRate = parseFloat(((weightedEngagementSum / impressions) * 100).toFixed(2));
            } else if (impressions > 0) {
              engagementRate = parseFloat((((totalClicks + totalInteractions) / impressions) * 100).toFixed(2));
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
        name: conn?.accountName || 'Leaders Performance',
        vanityName,
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
      if (LinkedInAnalyticsAdapter.cache[cacheKey] && LinkedInAnalyticsAdapter.cache[cacheKey].data.connected) {
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
        vanityName,
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
   * Retrieves the company page's recent posts with per-post performance metrics (newest first).
   * Item 10: Returns ONLY posts read from the LinkedIn page (never falls back to DB posts).
   * Item 11: Populates per-post impressions, clicks, reactions, comments, reposts, and engagementRate
   * via organizationalEntityShareStatistics with shares/ugcPosts params.
   */
  public async getPosts(forceRefresh = false): Promise<LinkedInPostDetailRow[]> {
    const now = Date.now();

    if (
      !forceRefresh &&
      LinkedInAnalyticsAdapter.postsCache &&
      now - LinkedInAnalyticsAdapter.postsCache.cachedAt < this.cacheTtlMs
    ) {
      return LinkedInAnalyticsAdapter.postsCache.data;
    }

    const conn = await this.getActiveConnection();
    const envToken =
      process.env.LINKEDIN_PAGE_ACCESS_TOKEN?.trim() ||
      process.env.LINKEDIN_ACCESS_TOKEN?.trim() ||
      '';
    const token = conn?.accessToken || envToken;
    const isTokenValid = Boolean(
      token && (conn?.tokenExpiresAt ? new Date(conn.tokenExpiresAt).getTime() > now : true)
    );

    if (!isTokenValid) {
      return [];
    }

    const orgUrn = await this.resolveOrganizationUrnFromApi(token, conn?.accountUrn);
    if (!orgUrn) {
      return [];
    }

    const apiVersion = getLinkedInApiVersion();
    const headers = {
      Authorization: `Bearer ${token}`,
      'LinkedIn-Version': apiVersion,
      'X-Restli-Protocol-Version': '2.0.0',
    };

    try {
      // 1. Query organization posts via LinkedIn REST API
      const postsUrl = `https://api.linkedin.com/rest/posts?author=${encodeURIComponent(
        orgUrn
      )}&q=author&count=20&sortBy=LAST_MODIFIED`;

      const postsRows: LinkedInPostDetailRow[] = [];
      const res = await fetch(postsUrl, { headers });

      if (res.ok) {
        const data = (await res.json()) as any;
        for (const item of data.elements || []) {
          const postUrn = String(item.id || '').trim();
          if (!postUrn.startsWith('urn:li:')) continue;

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
            mediaType: item.content?.media ? 'image' : item.content?.article ? 'article' : 'text',
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
        // Fallback to UGC Posts API for the organization page
        const ugcUrl = `https://api.linkedin.com/v2/ugcPosts?q=authors&authors=List(${encodeURIComponent(
          orgUrn
        )})&count=20`;
        const ugcRes = await fetch(ugcUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
            'LinkedIn-Version': apiVersion,
            'X-Restli-Protocol-Version': '2.0.0',
          },
        });

        if (ugcRes.ok) {
          const ugcData = (await ugcRes.json()) as any;
          for (const item of ugcData.elements || []) {
            const postUrn = String(item.id || '').trim();
            if (!postUrn.startsWith('urn:li:')) continue;

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

      if (postsRows.length === 0) {
        return [];
      }

      // 2. Item 11: Fetch per-post statistics via organizationalEntityShareStatistics with shares / ugcPosts params
      await this.enrichPostsWithShareStatistics(orgUrn, postsRows, headers);

      postsRows.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

      LinkedInAnalyticsAdapter.postsCache = {
        data: postsRows,
        cachedAt: now,
      };

      return postsRows;
    } catch (err: any) {
      console.warn('[LinkedInAnalyticsAdapter] getPosts notice:', err?.message);
      return [];
    }
  }

  /**
   * Queries organizationalEntityShareStatistics with shares=List(...) and ugcPosts=List(...)
   * to populate per-post impressions, clicks, reactions, comments, reposts, and engagementRate.
   */
  private async enrichPostsWithShareStatistics(
    orgUrn: string,
    postsRows: LinkedInPostDetailRow[],
    headers: Record<string, string>
  ): Promise<void> {
    try {
      const shareUrns = postsRows
        .map((p) => p.urn)
        .filter((urn) => urn.startsWith('urn:li:share:'));
      const ugcPostUrns = postsRows
        .map((p) => p.urn)
        .filter((urn) => urn.startsWith('urn:li:ugcPost:'));

      if (shareUrns.length === 0 && ugcPostUrns.length === 0) {
        return;
      }

      const params: string[] = [
        'q=organizationalEntity',
        `organizationalEntity=${encodeURIComponent(orgUrn)}`,
      ];
      if (shareUrns.length > 0) {
        params.push(`shares=List(${shareUrns.map((u) => encodeURIComponent(u)).join(',')})`);
      }
      if (ugcPostUrns.length > 0) {
        params.push(`ugcPosts=List(${ugcPostUrns.map((u) => encodeURIComponent(u)).join(',')})`);
      }

      const statsUrl = `https://api.linkedin.com/rest/organizationalEntityShareStatistics?${params.join('&')}`;
      const statsRes = await fetch(statsUrl, { headers });
      if (!statsRes.ok) {
        return;
      }

      const statsData = (await statsRes.json()) as any;
      const statsByUrn = new Map<string, any>();

      for (const el of statsData.elements || []) {
        const urn = el.share || el.ugcPost;
        if (urn && el.totalShareStatistics) {
          statsByUrn.set(urn, el.totalShareStatistics);
        }
      }

      for (const post of postsRows) {
        const st = statsByUrn.get(post.urn);
        if (!st) continue;

        const impressions =
          typeof st.impressionCount === 'number'
            ? st.impressionCount
            : typeof st.uniqueImpressionsCount === 'number'
            ? st.uniqueImpressionsCount
            : 0;
        const clicks = typeof st.clickCount === 'number' ? st.clickCount : 0;
        const reactions = typeof st.likeCount === 'number' ? st.likeCount : 0;
        const comments = typeof st.commentCount === 'number' ? st.commentCount : 0;
        const reposts = typeof st.shareCount === 'number' ? st.shareCount : 0;

        let engagementRate: number | null = null;
        if (typeof st.engagement === 'number') {
          engagementRate = parseFloat((st.engagement * 100).toFixed(2));
        } else if (impressions > 0) {
          engagementRate = parseFloat((((clicks + reactions + comments + reposts) / impressions) * 100).toFixed(2));
        }

        post.impressions = impressions;
        post.clicks = clicks;
        post.reactions = reactions;
        post.comments = comments;
        post.reposts = reposts;
        post.engagementRate = engagementRate;
        post.engagementRateFormatted = engagementRate !== null ? `${engagementRate}%` : null;
      }
    } catch (err: any) {
      console.warn('[LinkedInAnalyticsAdapter] Per-post share statistics notice:', err?.message);
    }
  }

  /**
   * Probes integration health and response latency
   */
  public async ping(): Promise<{ status: 'HEALTHY' | 'DEGRADED' | 'DOWN'; latencyMs: number; message: string }> {
    const start = Date.now();
    const conn = await this.getActiveConnection();
    const orgUrn = this.getOrganizationUrn(conn?.accountUrn);

    if (!conn) {
      return {
        status: 'DEGRADED',
        latencyMs: Date.now() - start,
        message: 'LinkedIn company page not connected via OAuth yet',
      };
    }

    if (!orgUrn) {
      return {
        status: 'DEGRADED',
        latencyMs: Date.now() - start,
        message: 'LinkedIn page connected, but LINKEDIN_ORGANIZATION_URN is not set in environment',
      };
    }

    try {
      const res = await fetch(
        `https://api.linkedin.com/v2/networkSizes/${encodeURIComponent(orgUrn)}?edgeType=CompanyFollowedByMember`,
        {
          headers: { Authorization: `Bearer ${conn.accessToken}` },
        }
      );
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
