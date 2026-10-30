import {
  IYouTubeAdapter,
  YouTubeAnalyticsData,
  YouTubeVideoRow,
  YouTubeVideoDetailRow,
  YouTubePlaylistRow,
} from './interfaces';
import { LiveErrorBoundary } from './liveErrorBoundary';

interface YouTubeCacheEntry {
  data: YouTubeAnalyticsData;
  cachedAt: number;
}

function parseIsoDuration(durationStr: string): number {
  if (!durationStr) return 0;
  const match = durationStr.match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const days = parseInt(match[1] || '0', 10);
  const hours = parseInt(match[2] || '0', 10);
  const minutes = parseInt(match[3] || '0', 10);
  const seconds = parseInt(match[4] || '0', 10);
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

export class YouTubeAdapter implements IYouTubeAdapter {
  private readonly apiKey: string | null;
  private readonly channelId: string | null;
  private static cache: YouTubeCacheEntry | null = null;
  private static videosCache: { [type: string]: { data: YouTubeVideoDetailRow[]; cachedAt: number } } = {};
  private static playlistsCache: { data: YouTubePlaylistRow[]; cachedAt: number } | null = null;
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
      if (YouTubeAdapter.cache) {
        return {
          ...YouTubeAdapter.cache.data,
          isCached: true,
          isFallback: true,
        };
      }
      throw new Error('Missing YOUTUBE_API_KEY or YOUTUBE_CHANNEL_ID in environment');
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

      // 2. Fetch longVideoCount and shortsCount via auto playlists (UULF... and UUSH...)
      const idWithoutUC = (this.channelId || '').replace(/^UC/, '');
      const [longVideoCount, shortsCount] = await Promise.all([
        this.fetchAutoPlaylistCount(`UULF${idWithoutUC}`),
        this.fetchAutoPlaylistCount(`UUSH${idWithoutUC}`),
      ]);

      // 3. Fetch recent videos from uploads playlist
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

          // 4. Batch fetch video statistics (views, likes, comments)
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

      // Calculate engagement rate (null when 0 views)
      let engagementRate: number | null = null;
      let engagementRateFormatted: string | null = null;

      if (totalRecentViews > 0) {
        engagementRate = parseFloat((((totalRecentLikes + totalRecentComments) / totalRecentViews) * 100).toFixed(2));
        engagementRateFormatted = `${engagementRate}%`;
      }

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
        longVideoCount,
        shortsCount,
        engagementRate,
        engagementRateFormatted,
        recentVideos,
        cachedAt: new Date().toISOString(),
        isCached: false,
        isFallback: false,
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
          isFallback: true,
        };
      }
      throw err;
    }
  }

  public async getVideos(type: 'videos' | 'shorts' = 'videos', forceRefresh = false): Promise<YouTubeVideoDetailRow[]> {
    const now = Date.now();
    const cacheKey = type;

    if (!forceRefresh && YouTubeAdapter.videosCache[cacheKey] && now - YouTubeAdapter.videosCache[cacheKey].cachedAt < this.cacheTtlMs) {
      return YouTubeAdapter.videosCache[cacheKey].data;
    }

    if (!this.apiKey || !this.channelId) {
      if (YouTubeAdapter.videosCache[cacheKey]) {
        return YouTubeAdapter.videosCache[cacheKey].data;
      }
      throw new Error('Missing YOUTUBE_API_KEY or YOUTUBE_CHANNEL_ID in environment');
    }

    const idWithoutUC = (this.channelId || '').replace(/^UC/, '');
    const playlistId = type === 'shorts' ? `UUSH${idWithoutUC}` : `UULF${idWithoutUC}`;

    try {
      const allVideoIds: string[] = [];
      let nextPageToken: string | undefined = undefined;

      // Page through playlistItems.list with maxResults=50
      do {
        const pageParam: string = nextPageToken ? `&pageToken=${nextPageToken}` : '';
        const url: string = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${playlistId}&maxResults=50${pageParam}&key=${this.apiKey}`;
        const res: Response = await fetch(url);

        if (!res.ok) {
          throw new Error(`YouTube API playlistItems returned HTTP ${res.status}: ${res.statusText}`);
        }

        const data: any = await res.json();
        const items = data.items || [];
        for (const it of items) {
          const vid = it.snippet?.resourceId?.videoId;
          if (vid) {
            allVideoIds.push(vid);
          }
        }
        nextPageToken = data.nextPageToken;
      } while (nextPageToken);

      // Batch fetch video details in chunks of 50
      const videos: YouTubeVideoDetailRow[] = [];
      const chunkSize = 50;
      for (let i = 0; i < allVideoIds.length; i += chunkSize) {
        const chunk = allVideoIds.slice(i, i + chunkSize);
        const videosUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${chunk.join(',')}&key=${this.apiKey}`;
        const vRes = await fetch(videosUrl);

        if (vRes.ok) {
          const vData = (await vRes.json()) as any;
          for (const v of vData.items || []) {
            videos.push({
              videoId: v.id,
              title: v.snippet?.title || 'Untitled Video',
              thumbnail:
                v.snippet?.thumbnails?.medium?.url ||
                v.snippet?.thumbnails?.high?.url ||
                v.snippet?.thumbnails?.default?.url ||
                '',
              publishedAt: v.snippet?.publishedAt || new Date().toISOString(),
              durationSeconds: parseIsoDuration(v.contentDetails?.duration || ''),
              viewCount: parseInt(v.statistics?.viewCount || '0', 10),
              likeCount: parseInt(v.statistics?.likeCount || '0', 10),
              commentCount: parseInt(v.statistics?.commentCount || '0', 10),
              watchTimeMinutes: null,
              watchUrl: `https://www.youtube.com/watch?v=${v.id}`,
            });
          }
        }
      }

      // Sort newest first
      videos.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

      YouTubeAdapter.videosCache[cacheKey] = {
        data: videos,
        cachedAt: now,
      };

      return videos;
    } catch (err: any) {
      await LiveErrorBoundary.logUpstreamError('YOUTUBE' as any, 'getVideos', err);
      if (YouTubeAdapter.videosCache[cacheKey]) {
        return YouTubeAdapter.videosCache[cacheKey].data;
      }
      throw err;
    }
  }

  public async getPlaylists(forceRefresh = false): Promise<YouTubePlaylistRow[]> {
    const now = Date.now();

    if (!forceRefresh && YouTubeAdapter.playlistsCache && now - YouTubeAdapter.playlistsCache.cachedAt < this.cacheTtlMs) {
      return YouTubeAdapter.playlistsCache.data;
    }

    if (!this.apiKey || !this.channelId) {
      if (YouTubeAdapter.playlistsCache) {
        return YouTubeAdapter.playlistsCache.data;
      }
      throw new Error('Missing YOUTUBE_API_KEY or YOUTUBE_CHANNEL_ID in environment');
    }

    try {
      const url = `https://www.googleapis.com/youtube/v3/playlists?channelId=${this.channelId}&part=snippet,contentDetails&maxResults=50&key=${this.apiKey}`;
      const res = await fetch(url);

      if (!res.ok) {
        throw new Error(`YouTube API playlists returned HTTP ${res.status}: ${res.statusText}`);
      }

      const data = (await res.json()) as any;
      const rawPlaylists = data.items || [];

      // For each playlist, find newest snippet.publishedAt across its items
      const playlists: YouTubePlaylistRow[] = await Promise.all(
        rawPlaylists.map(async (pl: any) => {
          let lastUpdated: string | null = pl.snippet?.publishedAt || null;

          try {
            const itemsUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${pl.id}&maxResults=50&key=${this.apiKey}`;
            const itRes = await fetch(itemsUrl);
            if (itRes.ok) {
              const itData = (await itRes.json()) as any;
              const dates = (itData.items || [])
                .map((it: any) => it.snippet?.publishedAt)
                .filter(Boolean) as string[];

              if (dates.length > 0) {
                dates.sort((a, b) => new Date(b).getTime() - new Date(a).getTime());
                lastUpdated = dates[0];
              }
            }
          } catch {
            // Keep default lastUpdated
          }

          return {
            playlistId: pl.id,
            title: pl.snippet?.title || 'Untitled Playlist',
            thumbnail:
              pl.snippet?.thumbnails?.medium?.url ||
              pl.snippet?.thumbnails?.high?.url ||
              pl.snippet?.thumbnails?.default?.url ||
              '',
            itemCount: parseInt(pl.contentDetails?.itemCount || '0', 10),
            lastUpdated,
            viewCount: null,
          };
        })
      );

      YouTubeAdapter.playlistsCache = {
        data: playlists,
        cachedAt: now,
      };

      return playlists;
    } catch (err: any) {
      await LiveErrorBoundary.logUpstreamError('YOUTUBE' as any, 'getPlaylists', err);
      if (YouTubeAdapter.playlistsCache) {
        return YouTubeAdapter.playlistsCache.data;
      }
      throw err;
    }
  }

  private async fetchAutoPlaylistCount(playlistId: string): Promise<number | null> {
    if (!this.apiKey) return null;
    try {
      const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=id&playlistId=${playlistId}&maxResults=1&key=${this.apiKey}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = (await res.json()) as any;
      return typeof data.pageInfo?.totalResults === 'number' ? data.pageInfo.totalResults : null;
    } catch {
      return null;
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
}
