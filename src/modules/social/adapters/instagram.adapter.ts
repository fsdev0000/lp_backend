import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

export interface InstagramTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
}

export interface InstagramAccountProfile {
  id: string;
  username: string;
  name?: string;
  biography?: string;
  profile_picture_url?: string;
  followers_count?: number;
  follows_count?: number;
  media_count?: number;
}

export class InstagramAdapter {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly configId: string;
  private readonly defaultRedirectUri: string;
  private readonly accountId: string;
  private readonly envAccessToken: string;

  // In-memory connection fallback for resiliency
  private static memoryConnection: any = null;

  constructor() {
    this.appId = process.env.META_APP_ID || '2399278297568224';
    this.appSecret = process.env.META_APP_SECRET || '';
    this.configId = process.env.META_CONFIG_ID || '1692644065797185';
    this.defaultRedirectUri =
      process.env.META_REDIRECT_URI ||
      'https://staging.leadersperformance.ae/api/v1/integrations/instagram/callback';
    this.accountId =
      process.env.INSTAGRAM_ACCOUNT_ID ||
      process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID ||
      '17841427503988004';
    this.envAccessToken = process.env.INSTAGRAM_ACCESS_TOKEN || '';
  }

  /**
   * Generates Meta OAuth 2.0 Authorization URL with Unified Login
   */
  public getAuthorizationUrl(redirectUri?: string, state?: string): { url: string; state: string } {
    const uri = redirectUri || this.defaultRedirectUri;
    const authState = state || crypto.randomBytes(16).toString('hex');

    // Use Unified Login with config_id as configured in Meta Developer Portal
    let url =
      `https://www.facebook.com/v21.0/dialog/oauth` +
      `?client_id=${encodeURIComponent(this.appId)}` +
      `&redirect_uri=${encodeURIComponent(uri)}` +
      `&state=${encodeURIComponent(authState)}` +
      `&response_type=code`;

    if (this.configId) {
      url += `&config_id=${encodeURIComponent(this.configId)}`;
    } else {
      const scopes = [
        'instagram_basic',
        'instagram_manage_insights',
        'instagram_content_publish',
        'instagram_manage_comments',
        'pages_show_list',
        'pages_read_engagement',
      ].join(',');
      url += `&scope=${encodeURIComponent(scopes)}`;
    }

    return { url, state: authState };
  }

  /**
   * Exchanges authorization code for long-lived access token
   */
  public async exchangeCodeForToken(code: string, redirectUri?: string): Promise<{
    accessToken: string;
    accountId: string;
    username: string;
    expiresIn?: number;
  }> {
    const uri = redirectUri || this.defaultRedirectUri;
    const tokenUrl =
      `https://graph.facebook.com/v21.0/oauth/access_token` +
      `?client_id=${encodeURIComponent(this.appId)}` +
      `&client_secret=${encodeURIComponent(this.appSecret)}` +
      `&redirect_uri=${encodeURIComponent(uri)}` +
      `&code=${encodeURIComponent(code.trim())}`;

    const res = await fetch(tokenUrl);
    if (!res.ok) {
      const err = await res.text();
      console.error('[InstagramAdapter] Code exchange failed:', res.status, err);
      throw new Error(`Meta OAuth error ${res.status}: ${err}`);
    }

    const tokenData = (await res.json()) as any;
    const shortLivedToken = tokenData.access_token;

    // Exchange for long-lived token (60 days)
    const longLivedUrl =
      `https://graph.facebook.com/v21.0/oauth/access_token` +
      `?grant_type=fb_exchange_token` +
      `&client_id=${encodeURIComponent(this.appId)}` +
      `&client_secret=${encodeURIComponent(this.appSecret)}` +
      `&fb_exchange_token=${encodeURIComponent(shortLivedToken)}`;

    let finalToken = shortLivedToken;
    let expiresIn = tokenData.expires_in || 5184000;

    try {
      const longRes = await fetch(longLivedUrl);
      if (longRes.ok) {
        const longData = (await longRes.json()) as any;
        finalToken = longData.access_token || finalToken;
        expiresIn = longData.expires_in || expiresIn;
      }
    } catch (e: any) {
      console.warn('[InstagramAdapter] Long-lived exchange notice:', e?.message);
    }

    // Resolve Instagram Business Account ID
    const accountProfile = await this.resolveInstagramAccount(finalToken);

    return {
      accessToken: finalToken,
      accountId: accountProfile.id,
      username: accountProfile.username,
      expiresIn,
    };
  }

  /**
   * Resolves Instagram account details from access token
   */
  public async resolveInstagramAccount(token: string): Promise<InstagramAccountProfile> {
    // 1. Direct probe with configured account ID
    try {
      const directUrl = `https://graph.facebook.com/v21.0/${this.accountId}?fields=id,username,name,biography,profile_picture_url,followers_count,follows_count,media_count&access_token=${token}`;
      const res = await fetch(directUrl);
      if (res.ok) {
        return (await res.json()) as InstagramAccountProfile;
      }
    } catch {}

    // 2. Discover via linked Facebook Pages
    const pagesUrl = `https://graph.facebook.com/v21.0/me/accounts?fields=id,name,access_token,instagram_business_account{id,username,name,biography,profile_picture_url,followers_count}&access_token=${token}`;
    const pagesRes = await fetch(pagesUrl);
    if (pagesRes.ok) {
      const data = (await pagesRes.json()) as any;
      const pages = data.data || [];
      for (const page of pages) {
        if (page.instagram_business_account) {
          return {
            id: page.instagram_business_account.id,
            username: page.instagram_business_account.username || 'lioneleersteling',
            name: page.instagram_business_account.name,
            profile_picture_url: page.instagram_business_account.profile_picture_url,
            followers_count: page.instagram_business_account.followers_count,
          };
        }
      }
    }

    // Default fallback to configured details
    return {
      id: this.accountId,
      username: process.env.INSTAGRAM_USERNAME || 'lioneleersteling',
    };
  }

  /**
   * Retrieves active Instagram connection from PostgreSQL or preconfigured System Token
   */
  public async getActiveConnection() {
    try {
      const conn = await prisma.socialAccountConnection.findUnique({
        where: { platform: 'INSTAGRAM' },
      });
      if (conn && conn.accessToken) {
        return conn;
      }
    } catch (e: any) {
      console.warn('[InstagramAdapter] DB getActiveConnection notice:', e?.message);
    }

    // Check in-memory store
    if (InstagramAdapter.memoryConnection) {
      return InstagramAdapter.memoryConnection;
    }

    // Fall back to preconfigured Environment System User token
    if (this.envAccessToken) {
      const systemConnection = {
        platform: 'INSTAGRAM',
        accountName: 'Lionel Eersteling | Founder Performance',
        accountUrn: `instagram:${this.accountId}`,
        accountEmail: null,
        profilePictureUrl: null,
        accessToken: this.envAccessToken,
        refreshToken: null,
        tokenExpiresAt: null, // System user tokens do not expire
        scopes: [
          'instagram_basic',
          'instagram_content_publish',
          'instagram_manage_comments',
          'instagram_manage_messages',
          'ads_management',
        ],
        status: 'INITIALIZED',
        lastSyncAt: null,
        followersCount: null,
        metadata: {
          username: process.env.INSTAGRAM_USERNAME || 'lioneleersteling',
          accountId: this.accountId,
          tokenType: 'SYSTEM_USER',
        },
      };

      InstagramAdapter.memoryConnection = systemConnection;
      return systemConnection;
    }

    return null;
  }

  /**
   * Saves or updates Instagram connection in database
   */
  public async saveConnection(data: {
    accountName: string;
    accountId: string;
    username: string;
    accessToken: string;
    refreshToken?: string;
    expiresInSeconds?: number;
    scopes?: string[];
    followersCount?: number | null;
  }) {
    const expiresAt = data.expiresInSeconds
      ? new Date(Date.now() + data.expiresInSeconds * 1000)
      : null;

    const payload = {
      platform: 'INSTAGRAM',
      accountName: data.accountName,
      accountUrn: `instagram:${data.accountId}`,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || null,
      tokenExpiresAt: expiresAt,
      scopes: data.scopes || ['instagram_basic', 'instagram_content_publish', 'instagram_manage_insights'],
      status: 'HEALTHY',
      lastSyncAt: new Date(),
      followersCount: data.followersCount !== undefined ? data.followersCount : null,
      metadata: {
        username: data.username,
        accountId: data.accountId,
        tokenType: expiresAt ? 'USER_TOKEN' : 'SYSTEM_USER',
      },
    };

    try {
      const saved = await prisma.socialAccountConnection.upsert({
        where: { platform: 'INSTAGRAM' },
        create: payload,
        update: payload,
      });
      InstagramAdapter.memoryConnection = saved;
      return saved;
    } catch (e: any) {
      console.warn('[InstagramAdapter] DB saveConnection notice:', e?.message);
      InstagramAdapter.memoryConnection = payload;
      return payload;
    }
  }

  /**
   * Disconnects the Instagram integration
   */
  public async disconnect(): Promise<void> {
    InstagramAdapter.memoryConnection = null;
    try {
      await prisma.socialAccountConnection.deleteMany({
        where: { platform: 'INSTAGRAM' },
      });
    } catch (e: any) {
      console.warn('[InstagramAdapter] DB disconnect notice:', e?.message);
    }
  }

  /**
   * Probes live Meta Graph API connectivity and verifies account access
   */
  public async ping(): Promise<{
    status: 'HEALTHY' | 'DEGRADED' | 'DOWN';
    latencyMs: number;
    message: string;
    account?: { id: string; username: string; followersCount?: number };
  }> {
    const start = Date.now();
    try {
      const conn = await this.getActiveConnection();
      if (!conn || !conn.accessToken) {
        return {
          status: 'DEGRADED',
          latencyMs: Date.now() - start,
          message: 'Instagram app configured but account not connected via OAuth or token yet',
        };
      }

      const accountId = (conn.metadata as any)?.accountId || this.accountId;
      const url = `https://graph.facebook.com/v21.0/${accountId}?fields=id,username,followers_count,media_count&access_token=${conn.accessToken}`;

      const res = await fetch(url);
      const latencyMs = Date.now() - start;

      if (res.ok) {
        const data = (await res.json()) as any;
        return {
          status: 'HEALTHY',
          latencyMs,
          message: `Connected as @${data.username}`,
          account: {
            id: data.id,
            username: data.username,
            followersCount: data.followers_count,
          },
        };
      }

      const err = await res.json().catch(() => ({}));
      return {
        status: 'DEGRADED',
        latencyMs,
        message: err?.error?.message || `Meta Graph API returned HTTP ${res.status}`,
      };
    } catch (err: any) {
      return {
        status: 'DOWN',
        latencyMs: Date.now() - start,
        message: err?.message || 'Failed to reach Meta Graph API',
      };
    }
  }
}
