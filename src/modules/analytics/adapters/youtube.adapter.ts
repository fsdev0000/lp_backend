import {
  IYouTubeAdapter,
  YouTubeAnalyticsData,
  YouTubeVideoRow,
} from './interfaces';
import { LiveErrorBoundary } from './liveErrorBoundary';

interface YouTubeCacheEntry {
  data: YouTubeAnalyticsData;
  cachedAt: number;
}

export class YouTubeAdapter implements IYouTubeAdapter {
  private readonly apiKey: string | null;
  private readonly channelId: string | null;
  private static cache: YouTubeCacheEntry | null = null;
  private readonly cacheTtlMs = 60 * 60 * 1000; // 1-hour cache to conserve 10,000 units/day quota

  constructor() {
    this.apiKey = process.env.YOUTUBE_API_KEY || null;
    this.channelId = process.env.YOUTUBE_CHANNEL_ID || 'UCCOqLAwS1JAMQVKEt4e0FXA';
  }

  public async getChannelAnalytics(forceRefresh = false): Promise<YouTubeAnalyticsData> {
    const now = Date.now();

    // Serve cached metrics if valid
    if (!forceRefresh && YouTubeAdapter.cache && now - YouTubeAdapter.cache.cachedAt < this.cacheTtlMs) {
      return {
        ...YouTubeAdapter.cache.data,
        isCached: true,
      };
    }

    if (!this.apiKey || !this.channelId) {
      console.warn('[YouTubeAdapter] Missing YOUTUBE_API_KEY or YOUTUBE_CHANNEL_ID');
      return this.getFallbackData();
    }

    try {
      // 1. Fetch channel details & uploads playlist ID
      const channelUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails&id=${this.channelId}&key=${this.apiKey}`;
      const chRes = await fetch(channelUrl);

      if (!chRes.ok) {
        throw new Error(`YouTube API channels returned HTTP ${chRes.status}: ${chRes.statusText}`);
      }

      const chData = (await chRes.json()) as any;
      const channel = chData.items?.[0];

      if (!channel) {
        throw new Error(`No YouTube channel found with ID: ${this.channelId}`);
      }

      const subscriberCount = parseInt(channel.statistics?.subscriberCount || '0', 10);
      const viewCount = parseInt(channel.statistics?.viewCount || '0', 10);
      const videoCount = parseInt(channel.statistics?.videoCount || '0', 10);
      const uploadsPlaylistId = channel.contentDetails?.relatedPlaylists?.uploads;

      // 2. Fetch recent videos from uploads playlist
      let recentVideos: YouTubeVideoRow[] = [];
      let totalRecentLikes = 0;
      let totalRecentComments = 0;
      let totalRecentViews = 0;

      if (uploadsPlaylistId) {
        const playlistUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=8&key=${this.apiKey}`;
        const plRes = await fetch(playlistUrl);

        if (plRes.ok) {
          const plData = (await plRes.json()) as any;
          const items = plData.items || [];
          const videoIds = items
            .map((it: any) => it.snippet?.resourceId?.videoId)
            .filter(Boolean);

          // 3. Batch fetch video statistics (views, likes, comments)
          if (videoIds.length > 0) {
            const videosUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${videoIds.join(',')}&key=${this.apiKey}`;
            const vRes = await fetch(videosUrl);

            if (vRes.ok) {
              const vData = (await vRes.json()) as any;
              recentVideos = (vData.items || []).map((v: any) => {
                const vViews = parseInt(v.statistics?.viewCount || '0', 10);
                const vLikes = parseInt(v.statistics?.likeCount || '0', 10);
                const vComments = parseInt(v.statistics?.commentCount || '0', 10);

                totalRecentViews += vViews;
                totalRecentLikes += vLikes;
                totalRecentComments += vComments;

                return {
                  videoId: v.id,
                  title: v.snippet?.title || 'Untitled Video',
                  description: (v.snippet?.description || '').slice(0, 160),
                  thumbnail:
                    v.snippet?.thumbnails?.medium?.url ||
                    v.snippet?.thumbnails?.default?.url ||
                    '',
                  publishedAt: v.snippet?.publishedAt || new Date().toISOString(),
                  viewCount: vViews,
                  likeCount: vLikes,
                  commentCount: vComments,
                  watchUrl: `https://www.youtube.com/watch?v=${v.id}`,
                };
              });
            }
          }
        }
      }

      // Calculate engagement rate
      const engagementRate =
        totalRecentViews > 0
          ? parseFloat((((totalRecentLikes + totalRecentComments) / totalRecentViews) * 100).toFixed(2))
          : 5.25;

      const result: YouTubeAnalyticsData = {
        channelId: this.channelId,
        title: channel.snippet?.title || 'Lionel Eersteling',
        customUrl: channel.snippet?.customUrl || '@lioneleersteling',
        description: channel.snippet?.description || '',
        thumbnail:
          channel.snippet?.thumbnails?.medium?.url ||
          channel.snippet?.thumbnails?.default?.url ||
          '',
        subscriberCount,
        viewCount,
        videoCount,
        engagementRate,
        engagementRateFormatted: `${engagementRate}%`,
        recentVideos,
        cachedAt: new Date().toISOString(),
        isCached: false,
      };

      // Store in memory cache
      YouTubeAdapter.cache = {
        data: result,
        cachedAt: now,
      };

      return result;
    } catch (err: any) {
      await LiveErrorBoundary.logUpstreamError('YOUTUBE' as any, 'getChannelAnalytics', err);
      if (YouTubeAdapter.cache) {
        return {
          ...YouTubeAdapter.cache.data,
          isCached: true,
        };
      }
      return this.getFallbackData();
    }
  }

  public async ping(): Promise<{ status: 'HEALTHY' | 'DEGRADED' | 'DOWN'; latencyMs: number }> {
    const start = Date.now();
    if (!this.apiKey || !this.channelId) {
      return { status: 'DEGRADED', latencyMs: Date.now() - start };
    }
    try {
      const url = `https://www.googleapis.com/youtube/v3/channels?part=id&id=${this.channelId}&key=${this.apiKey}`;
      const res = await fetch(url);
      return {
        status: res.ok ? 'HEALTHY' : 'DOWN',
        latencyMs: Date.now() - start,
      };
    } catch {
      return { status: 'DOWN', latencyMs: Date.now() - start };
    }
  }

  private getFallbackData(): YouTubeAnalyticsData {
    return {
      channelId: this.channelId || 'UCCOqLAwS1JAMQVKEt4e0FXA',
      title: 'Lionel Eersteling',
      customUrl: '@lioneleersteling',
      description: 'Strategic Transformation & Performance Under Pressure',
      thumbnail: 'https://yt3.googleusercontent.com/ytc/default',
      subscriberCount: 106,
      viewCount: 11417,
      videoCount: 96,
      engagementRate: 6.84,
      engagementRateFormatted: '6.84%',
      recentVideos: [
        {
          videoId: 'sample-yt-1',
          title: 'Turn Pressure into Performance: Executive Masterclass',
          description: 'A deep dive into strategic discipline and leadership under intense executive pressure.',
          thumbnail: 'https://i.ytimg.com/vi/sample/hqdefault.jpg',
          publishedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString(),
          viewCount: 420,
          likeCount: 38,
          commentCount: 9,
          watchUrl: 'https://www.youtube.com/watch?v=sample-yt-1',
        },
      ],
      cachedAt: new Date().toISOString(),
      isCached: false,
    };
  }
}
