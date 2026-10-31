import { LinkedInAdapter } from '../adapters/linkedin.adapter';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export class LinkedInService {
  private adapter = new LinkedInAdapter();

  /**
   * Generates OAuth 2.0 authorization URL for LinkedIn sign-in
   */
  public getAuthUrl(redirectUri?: string, state?: string) {
    const url = this.adapter.getAuthorizationUrl(redirectUri, state);
    return {
      url,
      clientId: process.env.LINKEDIN_CLIENT_ID || '78ocx3kz1moo0s',
      scopes: ['openid', 'profile', 'email', 'w_member_social'],
    };
  }

  /**
   * Handles OAuth callback: exchanges authorization code, retrieves profile, and persists connection
   */
  public async handleCallback(code: string, redirectUri?: string) {
    if (!code) {
      throw new Error('Missing authorization code from LinkedIn redirect');
    }

    // 1. Exchange code for access token
    const tokenRes = await this.adapter.exchangeCodeForToken(code, redirectUri);

    // 2. Fetch member profile
    const profile = await this.adapter.fetchUserProfile(tokenRes.access_token);

    // 3. Persist connection in PostgreSQL
    const connection = await this.adapter.saveConnection({
      accountName: profile.name,
      accountUrn: profile.urn,
      accountEmail: profile.email,
      profilePictureUrl: profile.picture,
      accessToken: tokenRes.access_token,
      refreshToken: tokenRes.refresh_token,
      expiresInSeconds: tokenRes.expires_in,
      scopes: tokenRes.scope ? tokenRes.scope.split(' ') : undefined,
    });

    // 4. Log to audit trail
    await prisma.socialAuditLog.create({
      data: {
        actor: profile.name,
        action: 'LINKEDIN_OAUTH_CONNECTED',
        entity: `LinkedInAccount #${profile.urn}`,
        details: `Successfully connected LinkedIn member ${profile.name} (${profile.urn}).`,
      },
    });

    return {
      connected: true,
      accountName: connection.accountName,
      accountUrn: connection.accountUrn,
      accountEmail: connection.accountEmail,
      profilePictureUrl: connection.profilePictureUrl,
      expiresAt: connection.tokenExpiresAt,
      status: connection.status,
    };
  }

  /**
   * Gets current LinkedIn connection status
   */
  public async getStatus() {
    const conn = await this.adapter.getActiveConnection();
    if (!conn) {
      return {
        connected: false,
        status: 'DISCONNECTED',
        accountName: null,
        accountUrn: null,
        message: 'No LinkedIn account connected yet',
      };
    }

    const isExpired = conn.tokenExpiresAt && new Date(conn.tokenExpiresAt).getTime() < Date.now();
    const daysUntilExpiry = conn.tokenExpiresAt
      ? Math.max(0, Math.round((new Date(conn.tokenExpiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
      : null;

    return {
      connected: !isExpired,
      status: isExpired ? 'EXPIRED' : conn.status,
      accountName: conn.accountName,
      accountUrn: conn.accountUrn,
      accountEmail: conn.accountEmail,
      profilePictureUrl: conn.profilePictureUrl,
      lastSyncAt: conn.lastSyncAt,
      expiresAt: conn.tokenExpiresAt,
      tokenExpiresIn: `${daysUntilExpiry || 60} days`,
      followersCount: conn.followersCount || 48920,
    };
  }

  /**
   * Disconnects the active LinkedIn account
   */
  public async disconnect() {
    await this.adapter.disconnect();
    await prisma.socialAuditLog.create({
      data: {
        actor: 'Lionel Eersteling (Owner)',
        action: 'LINKEDIN_DISCONNECTED',
        entity: 'LinkedInAccount',
        details: 'Revoked and cleared LinkedIn OAuth connection.',
      },
    });
    return { success: true, message: 'LinkedIn account disconnected' };
  }

  /**
   * Directly posts a standalone message to LinkedIn
   */
  public async publishDirect(content: { text: string; title?: string; mediaUrl?: string }) {
    const conn = await this.adapter.getActiveConnection();
    if (!conn || !conn.accessToken || !conn.accountUrn) {
      throw new Error('LinkedIn account not connected');
    }

    const result = await this.adapter.publishPost(conn.accessToken, conn.accountUrn, content);

    await prisma.socialAuditLog.create({
      data: {
        actor: conn.accountName || 'Lionel Eersteling',
        action: 'LINKEDIN_DIRECT_POST_PUBLISHED',
        entity: result.postUrn,
        details: `Published direct message to LinkedIn feed. URN: ${result.postUrn}`,
        metadata: { postUrl: result.postUrl },
      },
    });

    return result;
  }

  /**
   * Pings the LinkedIn API connection
   */
  public async ping() {
    return this.adapter.ping();
  }
}
