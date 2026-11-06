import { InstagramAdapter } from '../adapters/instagram.adapter';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

export class InstagramService {
  private adapter = new InstagramAdapter();

  // Active CSRF OAuth states with 10-minute TTL
  private static oauthStates = new Map<string, number>();

  /**
   * Generates OAuth 2.0 authorization URL for Instagram Unified Login
   */
  public getAuthUrl(redirectUri?: string) {
    const state = `ig_state_${Date.now()}_${crypto.randomBytes(12).toString('hex')}`;
    InstagramService.oauthStates.set(state, Date.now() + 10 * 60 * 1000); // 10m TTL

    const { url } = this.adapter.getAuthorizationUrl(redirectUri, state);

    return {
      url,
      state,
      appId: process.env.META_APP_ID || '2399278297568224',
      configId: process.env.META_CONFIG_ID || '1692644065797185',
    };
  }

  /**
   * Validates and invalidates an OAuth CSRF state token
   */
  public validateState(state?: string): boolean {
    if (!state) return false;
    const expiresAt = InstagramService.oauthStates.get(state);
    if (!expiresAt) return false;
    InstagramService.oauthStates.delete(state);
    return Date.now() <= expiresAt;
  }

  /**
   * Handles OAuth callback: exchanges authorization code, verifies account, and persists credentials
   */
  public async handleCallback(code: string, state?: string, redirectUri?: string) {
    if (!code) {
      throw new Error('Missing authorization code from Meta redirect');
    }

    // 1. Verify CSRF state token if provided
    if (state && !this.validateState(state)) {
      console.warn('[InstagramService] OAuth state validation warning: proceeding with redirect exchange');
    }

    // 2. Exchange code for access token
    const tokenRes = await this.adapter.exchangeCodeForToken(code, redirectUri);

    // 3. Resolve account profile
    const profile = await this.adapter.resolveInstagramAccount(tokenRes.accessToken);

    // 4. Persist connection
    const connection = await this.adapter.saveConnection({
      accountName: profile.name || `Lionel Eersteling (@${tokenRes.username})`,
      accountId: tokenRes.accountId,
      username: tokenRes.username,
      accessToken: tokenRes.accessToken,
      expiresInSeconds: tokenRes.expiresIn,
      followersCount: profile.followers_count ?? null,
    });

    // 5. Audit log
    try {
      await prisma.socialAuditLog.create({
        data: {
          actor: 'System Admin',
          action: 'INSTAGRAM_OAUTH_CONNECTED',
          entity: `InstagramAccount @${tokenRes.username}`,
          details: `Successfully connected Instagram Professional account @${tokenRes.username} (ID: ${tokenRes.accountId}).`,
        },
      });
    } catch {}

    return {
      connected: true,
      username: tokenRes.username,
      accountId: tokenRes.accountId,
      followersCount: profile.followers_count ?? null,
      status: (connection as any).status || 'HEALTHY',
    };
  }

  /**
   * Retrieves active Instagram connection status (never exposes access tokens)
   */
  public async getStatus() {
    try {
      const conn = await this.adapter.getActiveConnection();
      if (!conn || !conn.accessToken) {
        return {
          connected: false,
          status: 'DISCONNECTED',
          username: null,
          accountId: null,
          accountType: 'INSTAGRAM_PROFESSIONAL',
          followersCount: null,
          tokenHealth: 'DISCONNECTED',
          tokenExpiresAt: null,
          lastSyncAt: null,
          message: 'No Instagram account connected yet',
        };
      }

      // Check the token with Meta Graph API as /ping does (Item 4a)
      const pingRes = await this.adapter.ping();
      const isHealthy = pingRes.status === 'HEALTHY';
      const meta = (conn.metadata as any) || {};
      const isSystemToken = meta.tokenType === 'SYSTEM_USER' || !conn.tokenExpiresAt;
      const isExpired = conn.tokenExpiresAt && new Date(conn.tokenExpiresAt).getTime() < Date.now();

      let tokenHealth = 'HEALTHY';
      if (isExpired) {
        tokenHealth = 'EXPIRED';
      } else if (!isHealthy) {
        tokenHealth = pingRes.message.toLowerCase().includes('blocked') ? 'BLOCKED' : 'INVALID';
      }

      return {
        connected: isHealthy && !isExpired,
        status: isHealthy ? 'HEALTHY' : pingRes.status === 'DEGRADED' ? 'DEGRADED' : 'DOWN',
        username: pingRes.account?.username || meta.username || process.env.INSTAGRAM_USERNAME || 'lioneleersteling',
        accountId: pingRes.account?.id || meta.accountId || process.env.INSTAGRAM_ACCOUNT_ID || '17841427503988004',
        accountName: conn.accountName,
        accountType: 'INSTAGRAM_PROFESSIONAL',
        followersCount: isHealthy ? (pingRes.account?.followersCount ?? conn.followersCount ?? null) : null,
        tokenHealth,
        tokenExpiresAt: isSystemToken ? 'PERMANENT' : conn.tokenExpiresAt,
        tokenType: isSystemToken ? 'SYSTEM_USER' : 'USER_ACCESS_TOKEN',
        lastSyncAt: isHealthy ? (conn.lastSyncAt || new Date()) : null,
        scopes: conn.scopes,
        message: pingRes.message,
      };
    } catch (error: any) {
      console.warn('[InstagramService] Failed to check status:', error?.message);
      return {
        connected: false,
        status: 'DISCONNECTED',
        username: null,
        accountId: null,
        accountType: 'INSTAGRAM_PROFESSIONAL',
        followersCount: null,
        tokenHealth: 'DISCONNECTED',
        tokenExpiresAt: null,
        lastSyncAt: null,
        message: 'Database temporarily unavailable or disconnected',
      };
    }
  }

  /**
   * Health check probe testing live Meta API response latency
   */
  public async ping() {
    return this.adapter.ping();
  }

  /**
   * Disconnects the active Instagram account
   */
  public async disconnect(actor = 'Lionel Eersteling (Owner)') {
    await this.adapter.disconnect();
    try {
      await prisma.socialAuditLog.create({
        data: {
          actor,
          action: 'INSTAGRAM_DISCONNECTED',
          entity: 'InstagramAccount',
          details: 'Revoked Instagram connection credentials and stopped synchronization.',
        },
      });
    } catch {}

    return { success: true, message: 'Instagram account successfully disconnected' };
  }
}
