import { createHash, randomBytes } from 'crypto';
import { socialPrisma } from './linkedin.adapter';

export const TIKTOK_PLATFORM = 'TIKTOK';
export const TIKTOK_DEFAULT_SCOPES = [
  'user.info.basic',
  'user.info.profile',
  'user.info.stats',
  'video.list',
  'video.upload',
  'video.publish',
];

export function isTikTokPublishingEnabled(): boolean {
  return process.env.TIKTOK_PUBLISHING_ENABLED === 'true';
}

export interface TikTokTokenResponse {
  access_token: string;
  expires_in: number;
  open_id: string;
  refresh_token?: string;
  refresh_expires_in?: number;
  scope?: string;
  token_type?: string;
}

export interface TikTokUserProfile {
  openId: string;
  displayName: string;
  username: string;
  avatarUrl: string | null;
  bioDescription: string | null;
  profileDeepLink: string | null;
  isVerified: boolean;
  followerCount: number | null;
  followingCount: number | null;
  likesCount: number | null;
  videoCount: number | null;
}

export interface TikTokVideoItem {
  id: string;
  title: string;
  description: string;
  publishedAt: string;
  durationSeconds: number | null;
  coverImageUrl: string | null;
  shareUrl: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
}

export class TikTokAdapter {
  private getCredentials() {
    return {
      clientKey:
        process.env.TIKTOK_CLIENT_KEY?.trim() ||
        process.env.TIKTOK_SANDBOX_CLIENT_KEY?.trim() ||
        'sbawhyubzo4xr8qelx',
      clientSecret:
        process.env.TIKTOK_CLIENT_SECRET?.trim() ||
        process.env.TIKTOK_SANDBOX_CLIENT_SECRET?.trim() ||
        'v3vrynbj40NSJX8LF5Y5h0nRgi0bO6Zh',
      redirectUri:
        process.env.TIKTOK_REDIRECT_URI?.trim() ||
        'https://staging.leadersperformance.ae/api/v1/social/tiktok/callback',
      username: process.env.TIKTOK_USERNAME?.trim() || 'lioneleersteling',
    };
  }

  /**
   * Generates PKCE code_verifier and S256 code_challenge for TikTok OAuth v2
   */
  public generatePkcePair(): { codeVerifier: string; codeChallenge: string } {
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    return { codeVerifier, codeChallenge };
  }

  /**
   * Builds TikTok OAuth v2 authorization URL
   */
  public getAuthorizationUrl(
    redirectUri?: string,
    state?: string,
    scopes?: string[],
    codeChallenge?: string
  ): string {
    const creds = this.getCredentials();
    const uri = redirectUri || creds.redirectUri;
    const authState = state || `tt_${randomBytes(16).toString('hex')}`;
    const activeScopes = scopes && scopes.length > 0 ? scopes : TIKTOK_DEFAULT_SCOPES;
    const scopeParam = activeScopes.map((s) => s.trim()).join(',');

    let url =
      `https://www.tiktok.com/v2/auth/authorize/` +
      `?client_key=${encodeURIComponent(creds.clientKey)}` +
      `&response_type=code` +
      `&scope=${encodeURIComponent(scopeParam)}` +
      `&redirect_uri=${encodeURIComponent(uri)}` +
      `&state=${encodeURIComponent(authState)}`;

    if (codeChallenge) {
      url += `&code_challenge=${encodeURIComponent(codeChallenge)}&code_challenge_method=S256`;
    }

    return url;
  }

  /**
   * Exchanges authorization code for TikTok OAuth v2 access token
   */
  public async exchangeCodeForToken(
    code: string,
    redirectUri?: string,
    codeVerifier?: string
  ): Promise<TikTokTokenResponse> {
    const creds = this.getCredentials();
    const uri = redirectUri || creds.redirectUri;

    const params = new URLSearchParams({
      client_key: creds.clientKey,
      client_secret: creds.clientSecret,
      code: code.trim(),
      grant_type: 'authorization_code',
      redirect_uri: uri,
    });

    if (codeVerifier) {
      params.set('code_verifier', codeVerifier);
    }

    const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const data = (await res.json()) as any;
    if (!res.ok || data.error) {
      throw new Error(
        `TikTok OAuth error: ${data.error_description || data.error || `HTTP ${res.status}`}`
      );
    }

    return data as TikTokTokenResponse;
  }

  /**
   * Fetches @lioneleersteling profile and account statistics via TikTok Display API v2
   */
  public async fetchUserProfile(accessToken: string): Promise<TikTokUserProfile> {
    const creds = this.getCredentials();
    const fields = [
      'open_id',
      'union_id',
      'avatar_url',
      'display_name',
      'bio_description',
      'profile_deep_link',
      'is_verified',
      'follower_count',
      'following_count',
      'likes_count',
      'video_count',
    ].join(',');

    const res = await fetch(`https://open.tiktokapis.com/v2/user/info/?fields=${fields}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`TikTok UserInfo error ${res.status}: ${errText}`);
    }

    const json = (await res.json()) as any;
    const u = json?.data?.user || {};

    return {
      openId: u.open_id || creds.username,
      displayName: u.display_name || 'Lionel Eersteling',
      username: creds.username,
      avatarUrl: u.avatar_url || null,
      bioDescription: u.bio_description || null,
      profileDeepLink: u.profile_deep_link || `https://www.tiktok.com/@${creds.username}`,
      isVerified: Boolean(u.is_verified),
      followerCount: typeof u.follower_count === 'number' ? u.follower_count : null,
      followingCount: typeof u.following_count === 'number' ? u.following_count : null,
      likesCount: typeof u.likes_count === 'number' ? u.likes_count : null,
      videoCount: typeof u.video_count === 'number' ? u.video_count : null,
    };
  }

  /**
   * Lists recent TikTok videos with performance metrics via TikTok Display API v2
   */
  public async fetchVideos(accessToken: string, maxCount = 20): Promise<TikTokVideoItem[]> {
    const fields = [
      'id',
      'title',
      'video_description',
      'duration',
      'cover_image_url',
      'embed_link',
      'share_url',
      'create_time',
      'view_count',
      'like_count',
      'comment_count',
      'share_count',
    ].join(',');

    const res = await fetch(`https://open.tiktokapis.com/v2/video/list/?fields=${fields}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        max_count: Math.min(20, Math.max(1, maxCount)),
      }),
    });

    if (!res.ok) {
      return [];
    }

    const json = (await res.json()) as any;
    const videos: any[] = json?.data?.videos || [];

    return videos.map((v) => ({
      id: String(v.id || ''),
      title: v.title || v.video_description || '',
      description: v.video_description || v.title || '',
      publishedAt: v.create_time
        ? new Date(Number(v.create_time) * 1000).toISOString()
        : new Date().toISOString(),
      durationSeconds: typeof v.duration === 'number' ? v.duration : null,
      coverImageUrl: v.cover_image_url || null,
      shareUrl: v.share_url || null,
      views: typeof v.view_count === 'number' ? v.view_count : null,
      likes: typeof v.like_count === 'number' ? v.like_count : null,
      comments: typeof v.comment_count === 'number' ? v.comment_count : null,
      shares: typeof v.share_count === 'number' ? v.share_count : null,
    }));
  }

  /**
   * Publishes a video to @lioneleersteling via TikTok Content Posting API (PULL_FROM_URL).
   * Blocked by TIKTOK_PUBLISHING_ENABLED kill switch while false.
   */
  public async publishVideo(
    accessToken: string,
    payload: { title: string; videoUrl: string; privacyLevel?: string }
  ): Promise<{ publishId: string | null }> {
    if (!isTikTokPublishingEnabled()) {
      const err: any = new Error(
        'TikTok publishing is currently disabled (TIKTOK_PUBLISHING_ENABLED=false).'
      );
      err.statusCode = 403;
      throw err;
    }

    const res = await fetch('https://open.tiktokapis.com/v2/post/publish/video/init/', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({
        post_info: {
          title: payload.title.slice(0, 2200),
          privacy_level: payload.privacyLevel || 'PUBLIC_TO_EVERYONE',
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false,
        },
        source_info: {
          source: 'PULL_FROM_URL',
          video_url: payload.videoUrl,
        },
      }),
    });

    const json = (await res.json()) as any;
    if (!res.ok || (json?.error?.code && json.error.code !== 'ok')) {
      throw new Error(
        `TikTok Content Posting API error: ${
          json?.error?.message || json?.error?.code || `HTTP ${res.status}`
        }`
      );
    }

    return {
      publishId: json?.data?.publish_id || null,
    };
  }

  public async getActiveConnection() {
    try {
      return await socialPrisma.socialAccountConnection.findUnique({
        where: { platform: TIKTOK_PLATFORM },
      });
    } catch {
      return null;
    }
  }

  public async saveConnection(data: {
    accountName: string;
    accountUrn: string;
    profilePictureUrl?: string | null;
    accessToken: string;
    refreshToken?: string;
    expiresInSeconds: number;
    scopes?: string[];
    followersCount?: number | null;
    metadata?: any;
  }) {
    const expiresAt = new Date(Date.now() + (data.expiresInSeconds || 86400) * 1000);
    return socialPrisma.socialAccountConnection.upsert({
      where: { platform: TIKTOK_PLATFORM },
      create: {
        platform: TIKTOK_PLATFORM,
        accountName: data.accountName,
        accountUrn: data.accountUrn,
        profilePictureUrl: data.profilePictureUrl || null,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken || null,
        tokenExpiresAt: expiresAt,
        scopes: data.scopes || TIKTOK_DEFAULT_SCOPES,
        status: 'HEALTHY',
        lastSyncAt: new Date(),
        followersCount: data.followersCount ?? null,
        metadata: data.metadata || null,
      },
      update: {
        accountName: data.accountName,
        accountUrn: data.accountUrn,
        profilePictureUrl: data.profilePictureUrl || null,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken || undefined,
        tokenExpiresAt: expiresAt,
        scopes: data.scopes || TIKTOK_DEFAULT_SCOPES,
        status: 'HEALTHY',
        lastSyncAt: new Date(),
        followersCount: data.followersCount ?? undefined,
        metadata: data.metadata || undefined,
      },
    });
  }

  public async disconnect(): Promise<void> {
    await socialPrisma.socialAccountConnection.deleteMany({
      where: { platform: TIKTOK_PLATFORM },
    });
  }
}

