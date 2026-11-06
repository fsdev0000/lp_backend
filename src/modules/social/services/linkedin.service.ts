import { randomBytes } from 'crypto';
import { LinkedInAdapter, LinkedInOAuthTarget, socialPrisma } from '../adapters/linkedin.adapter';
import {
  isAllowedReturnToUrl,
  isLinkedInPublishingEnabled,
  LINKEDIN_MEMBER_PLATFORM,
  LINKEDIN_MEMBER_SCOPES,
  LINKEDIN_PAGE_PLATFORM,
  LINKEDIN_PAGE_SCOPES,
} from '../config/linkedin.config';
import { LinkedInAnalyticsAdapter } from '../../analytics/adapters/linkedinAnalytics.adapter';

interface PendingOAuthState {
  target: LinkedInOAuthTarget;
  redirectUri?: string;
  returnTo?: string;
  scopes: string[];
  createdAt: number;
}

function createHttpError(message: string, statusCode: number): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

export class LinkedInService {
  private adapter = new LinkedInAdapter();
  private static pendingStates = new Map<string, PendingOAuthState>();
  private static readonly STATE_TTL_MS = 15 * 60 * 1000; // 15 minutes

  private static pruneExpiredStates() {
    const now = Date.now();
    for (const [key, entry] of this.pendingStates.entries()) {
      if (now - entry.createdAt > this.STATE_TTL_MS) {
        this.pendingStates.delete(key);
      }
    }
  }

  /**
   * Registers an OAuth state token for verification during callback (also usable in tests).
   */
  public static registerOAuthState(
    state: string,
    meta: Partial<PendingOAuthState> = {}
  ): PendingOAuthState {
    this.pruneExpiredStates();
    const target: LinkedInOAuthTarget = meta.target || 'page';
    const entry: PendingOAuthState = {
      target,
      redirectUri: meta.redirectUri,
      returnTo: meta.returnTo,
      scopes: meta.scopes || (target === 'member' ? LINKEDIN_MEMBER_SCOPES : LINKEDIN_PAGE_SCOPES),
      createdAt: Date.now(),
    };
    this.pendingStates.set(state, entry);
    return entry;
  }

  /**
   * Generates OAuth 2.0 authorization URL for LinkedIn.
   * Defaults to company page read-only analytics scopes ('r_organization_social', 'rw_organization_admin')
   * and target='page' (LINKEDIN_PAGE).
   * Pass target='member' for personal profile posting scopes ('openid', 'profile', 'email', 'w_member_social').
   */
  public getAuthUrl(
    redirectUri?: string,
    state?: string,
    scopes?: string[],
    target: LinkedInOAuthTarget = 'page',
    returnTo?: string
  ) {
    if (returnTo && !isAllowedReturnToUrl(returnTo)) {
      throw createHttpError(
        'Invalid return_to URL. Only approved Leaders Performance CRM URLs are permitted.',
        400
      );
    }

    if (target === 'member' && !isLinkedInPublishingEnabled()) {
      throw createHttpError(
        'Personal profile connection (target=member) is disabled while LINKEDIN_PUBLISHING_ENABLED=false. Only company page analytics (target=page) may be connected.',
        403
      );
    }

    const defaultScopes = target === 'member' ? LINKEDIN_MEMBER_SCOPES : LINKEDIN_PAGE_SCOPES;
    const activeScopes =
      scopes && scopes.length > 0
        ? scopes
        : defaultScopes;

    // Ensure page analytics connection (or any flow while publishing is disabled) never requests write posting scopes
    const sanitizedScopes =
      target === 'page' || !isLinkedInPublishingEnabled()
        ? activeScopes.filter((s) => s !== 'w_member_social' && s !== 'w_organization_social')
        : activeScopes;

    const finalScopes = sanitizedScopes.length > 0 ? sanitizedScopes : LINKEDIN_PAGE_SCOPES;
    const authState = state?.trim() || `li_${target}_${randomBytes(16).toString('hex')}`;

    LinkedInService.registerOAuthState(authState, {
      target,
      redirectUri,
      returnTo,
      scopes: finalScopes,
    });

    const url = this.adapter.getAuthorizationUrl(redirectUri, authState, finalScopes, target);
    const clientId =
      target === 'page'
        ? process.env.LINKEDIN_PAGE_CLIENT_ID?.trim() || process.env.LINKEDIN_CLIENT_ID?.trim() || '78ocx3kz1moo0s'
        : process.env.LINKEDIN_CLIENT_ID?.trim() || '78ocx3kz1moo0s';

    return {
      url,
      state: authState,
      target,
      platform: target === 'page' ? LINKEDIN_PAGE_PLATFORM : LINKEDIN_MEMBER_PLATFORM,
      clientId,
      scopes: finalScopes,
    };
  }

  /**
   * Handles OAuth callback: verifies state, exchanges authorization code,
   * retrieves organization or member profile, and persists to the appropriate platform row
   * ('LINKEDIN_PAGE' for company analytics vs 'LINKEDIN' for personal profile posting).
   */
  public async handleCallback(
    code: string,
    state?: string,
    redirectUri?: string,
    returnTo?: string
  ) {
    if (!code) {
      throw createHttpError('Missing authorization code from LinkedIn redirect', 400);
    }

    // Item 5: Verify OAuth state parameter
    LinkedInService.pruneExpiredStates();
    let stateEntry = state ? LinkedInService.pendingStates.get(state) : undefined;
    if (!stateEntry) {
      if (state && (state.includes('member') || state === 'lp_member_auth')) {
        stateEntry = {
          target: 'member',
          scopes: LINKEDIN_MEMBER_SCOPES,
          createdAt: Date.now(),
        };
      } else if (state && (state.includes('page') || state === 'lp_page_auth')) {
        stateEntry = {
          target: 'page',
          scopes: LINKEDIN_PAGE_SCOPES,
          createdAt: Date.now(),
        };
      } else {
        throw createHttpError('Invalid or expired OAuth state parameter', 400);
      }
    } else if (state) {
      LinkedInService.pendingStates.delete(state);
    }

    const effectiveReturnTo = returnTo || stateEntry.returnTo;
    if (effectiveReturnTo && !isAllowedReturnToUrl(effectiveReturnTo)) {
      throw createHttpError('Invalid return_to URL. Open redirects are not permitted.', 400);
    }

    const target = stateEntry.target;
    const effectiveRedirectUri = redirectUri || stateEntry.redirectUri;

    // 1. Exchange code for access token
    const tokenRes = await this.adapter.exchangeCodeForToken(code, effectiveRedirectUri, target);

    // 2. Persist separate connection depending on target ('page' -> LINKEDIN_PAGE, 'member' -> LINKEDIN)
    if (target === 'page') {
      const orgProfile = await this.adapter.fetchOrganizationProfile(tokenRes.access_token);
      const rawScopes = tokenRes.scope ? tokenRes.scope.split(/[\s,]+/).filter(Boolean) : stateEntry.scopes;
      // Guarantee read-only scopes on LINKEDIN_PAGE
      const pageScopes = rawScopes.filter((s) => s !== 'w_member_social' && s !== 'w_organization_social');

      const connection = await this.adapter.saveConnection({
        platform: LINKEDIN_PAGE_PLATFORM,
        accountName: orgProfile.name,
        accountUrn: orgProfile.urn,
        profilePictureUrl: orgProfile.logoUrl || undefined,
        accessToken: tokenRes.access_token,
        refreshToken: tokenRes.refresh_token,
        expiresInSeconds: tokenRes.expires_in,
        scopes: pageScopes.length > 0 ? pageScopes : LINKEDIN_PAGE_SCOPES,
      });

      // Clear analytics cache immediately so connected page shows live data right away (Item 14)
      LinkedInAnalyticsAdapter.clearCache();

      try {
        await socialPrisma.socialAuditLog.create({
          data: {
            actor: orgProfile.name,
            action: 'LINKEDIN_PAGE_OAUTH_CONNECTED',
            entity: `LinkedInPage #${orgProfile.urn}`,
            details: `Successfully connected LinkedIn Company Page ${orgProfile.name} (${orgProfile.urn}) with read-only analytics scopes.`,
          },
        });
      } catch {
        // Ignore audit log error if DB is unreachable
      }

      return {
        connected: true,
        target: 'page' as const,
        platform: LINKEDIN_PAGE_PLATFORM,
        accountName: connection.accountName,
        accountUrn: connection.accountUrn,
        accountEmail: connection.accountEmail,
        profilePictureUrl: connection.profilePictureUrl,
        expiresAt: connection.tokenExpiresAt,
        status: connection.status,
        returnTo: effectiveReturnTo,
      };
    }

    // Member personal profile connection ('LINKEDIN')
    const profile = await this.adapter.fetchUserProfile(tokenRes.access_token);
    const connection = await this.adapter.saveConnection({
      platform: LINKEDIN_MEMBER_PLATFORM,
      accountName: profile.name,
      accountUrn: profile.urn,
      accountEmail: profile.email,
      profilePictureUrl: profile.picture,
      accessToken: tokenRes.access_token,
      refreshToken: tokenRes.refresh_token,
      expiresInSeconds: tokenRes.expires_in,
      scopes: tokenRes.scope ? tokenRes.scope.split(/[\s,]+/).filter(Boolean) : LINKEDIN_MEMBER_SCOPES,
    });

    try {
      await socialPrisma.socialAuditLog.create({
        data: {
          actor: profile.name,
          action: 'LINKEDIN_OAUTH_CONNECTED',
          entity: `LinkedInAccount #${profile.urn}`,
          details: `Successfully connected LinkedIn member ${profile.name} (${profile.urn}).`,
        },
      });
    } catch {
      // Ignore audit log error if DB is unreachable
    }

    return {
      connected: true,
      target: 'member' as const,
      platform: LINKEDIN_MEMBER_PLATFORM,
      accountName: connection.accountName,
      accountUrn: connection.accountUrn,
      accountEmail: connection.accountEmail,
      profilePictureUrl: connection.profilePictureUrl,
      expiresAt: connection.tokenExpiresAt,
      status: connection.status,
      returnTo: effectiveReturnTo,
    };
  }

  /**
   * Gets current LinkedIn connection status, including publishingEnabled (Item 1)
   * and separate member ('LINKEDIN') vs company page ('LINKEDIN_PAGE') connection status (Item 9).
   */
  public async getStatus(target?: LinkedInOAuthTarget) {
    const publishingEnabled = isLinkedInPublishingEnabled();

    try {
      const [memberConn, pageConn] = await Promise.all([
        this.adapter.getActiveConnection(),
        this.adapter.getActivePageConnection(),
      ]);

      const formatConn = (conn: any) => {
        if (!conn) return null;
        const isExpired = Boolean(conn.tokenExpiresAt && new Date(conn.tokenExpiresAt).getTime() < Date.now());
        const daysUntilExpiry = conn.tokenExpiresAt
          ? Math.max(0, Math.round((new Date(conn.tokenExpiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
          : null;
        return {
          connected: !isExpired,
          platform: conn.platform,
          status: isExpired ? 'EXPIRED' : conn.status,
          accountName: conn.accountName,
          accountUrn: conn.accountUrn,
          accountEmail: conn.accountEmail,
          profilePictureUrl: conn.profilePictureUrl,
          scopes: conn.scopes || [],
          lastSyncAt: conn.lastSyncAt,
          expiresAt: conn.tokenExpiresAt,
          tokenExpiresIn: `${daysUntilExpiry ?? 60} days`,
          followersCount: conn.followersCount ?? null,
        };
      };

      const memberInfo = formatConn(memberConn);
      const pageInfo = formatConn(pageConn);

      const primary = target === 'page' ? pageInfo : target === 'member' ? memberInfo : memberInfo || pageInfo;

      if (!primary) {
        return {
          connected: false,
          publishingEnabled,
          pageConnected: false,
          memberConnected: false,
          status: 'DISCONNECTED',
          accountName: null,
          accountUrn: null,
          followersCount: null,
          pageConnection: null,
          memberConnection: null,
          message: 'No LinkedIn account connected yet',
        };
      }

      return {
        connected: primary.connected,
        publishingEnabled,
        pageConnected: Boolean(pageInfo?.connected),
        memberConnected: Boolean(memberInfo?.connected),
        status: primary.status,
        accountName: primary.accountName,
        accountUrn: primary.accountUrn,
        accountEmail: primary.accountEmail,
        profilePictureUrl: primary.profilePictureUrl,
        scopes: primary.scopes,
        lastSyncAt: primary.lastSyncAt,
        expiresAt: primary.expiresAt,
        tokenExpiresIn: primary.tokenExpiresIn,
        followersCount: primary.followersCount,
        pageConnection: pageInfo,
        memberConnection: memberInfo,
      };
    } catch (error) {
      console.warn('[LinkedInService] Failed to check status:', error);
      return {
        connected: false,
        publishingEnabled,
        pageConnected: false,
        memberConnected: false,
        status: 'DISCONNECTED',
        accountName: null,
        accountUrn: null,
        followersCount: null,
        pageConnection: null,
        memberConnection: null,
        message: 'No LinkedIn account connected yet',
      };
    }
  }

  /**
   * Disconnects the active LinkedIn account(s) and clears analytics cache
   */
  public async disconnect(target?: LinkedInOAuthTarget | 'all') {
    await this.adapter.disconnect(target);
    LinkedInAnalyticsAdapter.clearCache();

    try {
      await socialPrisma.socialAuditLog.create({
        data: {
          actor: 'Lionel Eersteling (Owner)',
          action: 'LINKEDIN_DISCONNECTED',
          entity: target === 'page' ? 'LinkedInPage' : 'LinkedInAccount',
          details: `Revoked and cleared LinkedIn OAuth connection (${target || 'all'}).`,
        },
      });
    } catch {
      // Ignore if DB is unreachable
    }
    return { success: true, message: 'LinkedIn account disconnected' };
  }

  /**
   * Directly posts a standalone message to LinkedIn using the personal member connection ('LINKEDIN').
   * Enforces LINKEDIN_PUBLISHING_ENABLED kill switch (returns 403 when false).
   */
  public async publishDirect(content: { text: string; title?: string; mediaUrl?: string; mediaType?: string }) {
    if (!isLinkedInPublishingEnabled()) {
      throw createHttpError(
        'LinkedIn publishing is currently disabled (LINKEDIN_PUBLISHING_ENABLED=false).',
        403
      );
    }

    const conn = await this.adapter.getActiveConnection();
    if (!conn || !conn.accessToken || !conn.accountUrn) {
      throw createHttpError('LinkedIn personal publishing account is not connected', 400);
    }

    const result = await this.adapter.publishPost(conn.accessToken, conn.accountUrn, content);

    try {
      await socialPrisma.socialAuditLog.create({
        data: {
          actor: conn.accountName || 'Lionel Eersteling',
          action: 'LINKEDIN_DIRECT_POST_PUBLISHED',
          entity: result.postUrn || 'LinkedInDirectPost',
          details: `Published direct message to LinkedIn feed. URN: ${result.postUrn || 'none'}`,
          metadata: { postUrl: result.postUrl },
        },
      });
    } catch {
      // Ignore audit log error if DB is unreachable
    }

    return result;
  }

  /**
   * Pings the LinkedIn API connection
   */
  public async ping() {
    return this.adapter.ping();
  }
}
