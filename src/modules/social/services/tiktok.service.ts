import { randomBytes } from 'crypto';
import {
  isTikTokPublishingEnabled,
  TikTokAdapter,
  TIKTOK_DEFAULT_SCOPES,
  TIKTOK_PLATFORM,
} from '../adapters/tiktok.adapter';
import { isAllowedReturnToUrl } from '../config/linkedin.config';
import { socialPrisma } from '../adapters/linkedin.adapter';
import { verifyPostApprovalGuard } from '../../../utils/approvalSignature';

interface PendingTikTokOAuthState {
  codeVerifier: string;
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

export class TikTokService {
  private adapter = new TikTokAdapter();
  private static pendingStates = new Map<string, PendingTikTokOAuthState>();
  private static readonly STATE_TTL_MS = 15 * 60 * 1000;

  private static pruneExpiredStates() {
    const now = Date.now();
    for (const [key, entry] of this.pendingStates.entries()) {
      if (now - entry.createdAt > this.STATE_TTL_MS) {
        this.pendingStates.delete(key);
      }
    }
  }

  public async getAuthUrl(
    redirectUri?: string,
    state?: string,
    scopes?: string[],
    returnTo?: string,
    clientKeyOverride?: string
  ) {
    if (returnTo && !isAllowedReturnToUrl(returnTo)) {
      throw createHttpError(
        'Invalid return_to URL. Only approved Leaders Performance CRM URLs are permitted.',
        400
      );
    }

    TikTokService.pruneExpiredStates();
    const activeScopes = scopes && scopes.length > 0 ? scopes : TIKTOK_DEFAULT_SCOPES;
    const authState = state?.trim() || `tt_${randomBytes(16).toString('hex')}`;
    const { codeVerifier, codeChallenge } = this.adapter.generatePkcePair();

    const statePayload: PendingTikTokOAuthState = {
      codeVerifier,
      redirectUri,
      returnTo,
      scopes: activeScopes,
      createdAt: Date.now(),
    };

    TikTokService.pendingStates.set(authState, statePayload);

    // Item 9: Persist issued OAuth state & PKCE verifier to database so it survives container restarts
    try {
      await socialPrisma.systemConfig.upsert({
        where: { key: `tt_state_${authState}` },
        create: {
          key: `tt_state_${authState}`,
          value: JSON.stringify(statePayload),
        },
        update: {
          value: JSON.stringify(statePayload),
        },
      });
    } catch {
      // Memory store fallback if DB is temporarily unreachable
    }

    const url = this.adapter.getAuthorizationUrl(
      redirectUri,
      authState,
      activeScopes,
      codeChallenge,
      clientKeyOverride
    );
    return {
      url,
      state: authState,
      platform: TIKTOK_PLATFORM,
      clientKey:
        clientKeyOverride?.trim() ||
        process.env.TIKTOK_CLIENT_KEY?.trim() ||
        process.env.TIKTOK_SANDBOX_CLIENT_KEY?.trim() ||
        '',
      scopes: activeScopes,
    };
  }

  public async handleCallback(code: string, state?: string, redirectUri?: string, returnTo?: string) {
    if (!code) {
      throw createHttpError('Missing authorization code from TikTok callback', 400);
    }

    if (!state) {
      throw createHttpError('Missing state parameter from TikTok callback', 400);
    }

    TikTokService.pruneExpiredStates();

    // Item 9: Look up issued state from memory or persistent DB (never accept arbitrary unissued states)
    let stateEntry = TikTokService.pendingStates.get(state);
    if (!stateEntry) {
      try {
        const dbEntry = await socialPrisma.systemConfig.findUnique({
          where: { key: `tt_state_${state}` },
        });
        if (dbEntry?.value) {
          stateEntry = JSON.parse(dbEntry.value);
        }
      } catch {
        // Fall through
      }
    }

    if (!stateEntry || Date.now() - stateEntry.createdAt > TikTokService.STATE_TTL_MS) {
      throw createHttpError('Invalid or expired TikTok OAuth state parameter', 400);
    }

    // Invalidate state immediately upon single use
    TikTokService.pendingStates.delete(state);
    try {
      await socialPrisma.systemConfig.delete({
        where: { key: `tt_state_${state}` },
      });
    } catch {
      // Ignore cleanup error
    }

    const effectiveReturnTo = returnTo || stateEntry.returnTo;
    if (effectiveReturnTo && !isAllowedReturnToUrl(effectiveReturnTo)) {
      throw createHttpError('Invalid return_to URL. Open redirects are not permitted.', 400);
    }

    const tokenRes = await this.adapter.exchangeCodeForToken(
      code,
      redirectUri || stateEntry.redirectUri,
      stateEntry.codeVerifier
    );

    const profile = await this.adapter.fetchUserProfile(tokenRes.access_token);
    const connection = await this.adapter.saveConnection({
      accountName: profile.displayName || `@${profile.username}`,
      accountUrn: profile.openId,
      profilePictureUrl: profile.avatarUrl,
      accessToken: tokenRes.access_token,
      refreshToken: tokenRes.refresh_token,
      expiresInSeconds: tokenRes.expires_in,
      scopes: tokenRes.scope ? tokenRes.scope.split(/[\s,]+/).filter(Boolean) : stateEntry.scopes,
      followersCount: profile.followerCount,
      metadata: {
        username: profile.username,
        profileUrl: `https://www.tiktok.com/@${profile.username}`,
        likesCount: profile.likesCount,
        followingCount: profile.followingCount,
        videoCount: profile.videoCount,
      },
    });

    try {
      await socialPrisma.socialAuditLog.create({
        data: {
          actor: profile.displayName,
          action: 'TIKTOK_OAUTH_CONNECTED',
          entity: `TikTokAccount #@${profile.username}`,
          details: `Connected TikTok account @${profile.username} (${profile.openId}).`,
        },
      });
    } catch {
      // Ignore audit log error if DB is unreachable
    }

    return {
      connected: true,
      platform: TIKTOK_PLATFORM,
      username: profile.username,
      profileUrl: `https://www.tiktok.com/@${profile.username}`,
      accountName: connection.accountName,
      accountUrn: connection.accountUrn,
      profilePictureUrl: connection.profilePictureUrl,
      followersCount: profile.followerCount,
      likesCount: profile.likesCount,
      videoCount: profile.videoCount,
      expiresAt: connection.tokenExpiresAt,
      status: connection.status,
      returnTo: effectiveReturnTo,
    };
  }

  public async getStatus() {
    const publishingEnabled = isTikTokPublishingEnabled();
    const envUsername = process.env.TIKTOK_USERNAME?.trim() || null;

    try {
      const conn = await this.adapter.getActiveConnection();
      if (!conn) {
        return {
          connected: false,
          publishingEnabled,
          status: 'DISCONNECTED',
          username: envUsername,
          profileUrl: envUsername ? `https://www.tiktok.com/@${envUsername}` : null,
          accountName: null,
          accountUrn: null,
          followersCount: null,
          message: 'TikTok account not connected yet',
        };
      }

      const meta = (conn.metadata as any) || {};
      const username = meta.username || conn.accountName || envUsername;
      const isExpired = Boolean(conn.tokenExpiresAt && new Date(conn.tokenExpiresAt).getTime() < Date.now());
      return {
        connected: !isExpired,
        publishingEnabled,
        status: isExpired ? 'EXPIRED' : conn.status,
        username,
        profileUrl: username ? `https://www.tiktok.com/@${username}` : null,
        accountName: conn.accountName,
        accountUrn: conn.accountUrn,
        profilePictureUrl: conn.profilePictureUrl,
        scopes: conn.scopes || [],
        followersCount: conn.followersCount ?? null,
        expiresAt: conn.tokenExpiresAt,
        lastSyncAt: conn.lastSyncAt,
      };
    } catch {
      return {
        connected: false,
        publishingEnabled,
        status: 'DISCONNECTED',
        username: envUsername,
        profileUrl: envUsername ? `https://www.tiktok.com/@${envUsername}` : null,
        accountName: null,
        accountUrn: null,
        followersCount: null,
        message: 'TikTok account not connected yet',
      };
    }
  }

  public async getAnalytics() {
    const envUsername = process.env.TIKTOK_USERNAME?.trim() || null;
    const conn = await this.adapter.getActiveConnection();

    if (!conn || !conn.accessToken) {
      return {
        connected: false,
        username: envUsername,
        profileUrl: envUsername ? `https://www.tiktok.com/@${envUsername}` : null,
        displayName: null,
        followers: null,
        following: null,
        likes: null,
        videoCount: null,
        videos: [],
      };
    }

    let profile: any;
    let videos: any[] = [];

    try {
      [profile, videos] = await Promise.all([
        this.adapter.fetchUserProfile(conn.accessToken),
        this.adapter.fetchVideos(conn.accessToken, 20),
      ]);
    } catch (apiErr: any) {
      // Item 7: Reactive token refresh if API returned 401 / expired token
      if (conn.refreshToken) {
        try {
          console.log('[TikTokService] API call failed, refreshing access token...');
          const refreshed = await this.adapter.refreshAccessToken(conn.refreshToken);
          const expiresAt = new Date(Date.now() + (refreshed.expires_in || 86400) * 1000);
          await this.adapter.saveConnection({
            accountName: conn.accountName || (envUsername ? `@${envUsername}` : 'tiktok_user'),
            accountUrn: conn.accountUrn || (envUsername ? `tiktok:${envUsername}` : 'tiktok:unknown'),
            accessToken: refreshed.access_token,
            refreshToken: refreshed.refresh_token || conn.refreshToken,
            expiresInSeconds: refreshed.expires_in,
          });
          [profile, videos] = await Promise.all([
            this.adapter.fetchUserProfile(refreshed.access_token),
            this.adapter.fetchVideos(refreshed.access_token, 20),
          ]);
        } catch {
          throw apiErr;
        }
      } else {
        throw apiErr;
      }
    }

    // Aggregate real 7-day video performance from public videos (Item 4: Never show fake numbers)
    const nowMs = Date.now();
    const sevenDaysAgoMs = nowMs - 7 * 24 * 60 * 60 * 1000;
    const recent7dVideos = (videos || []).filter((v) => new Date(v.publishedAt).getTime() >= sevenDaysAgoMs);

    const calcViews7d = recent7dVideos.reduce((acc, v) => acc + (v.views || 0), 0);
    const calcLikes7d = recent7dVideos.reduce((acc, v) => acc + (v.likes || 0), 0);
    const calcComments7d = recent7dVideos.reduce((acc, v) => acc + (v.comments || 0), 0);
    const calcShares7d = recent7dVideos.reduce((acc, v) => acc + (v.shares || 0), 0);

    return {
      connected: true,
      username: profile.username,
      profileUrl: `https://www.tiktok.com/@${profile.username}`,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
      followers: profile.followerCount,
      following: profile.followingCount,
      likes: profile.likesCount,
      videoCount: profile.videoCount,
      performance7d: {
        timeframe: 'Last 7 days',
        recentVideosCount: recent7dVideos.length,
        videoViews: calcViews7d,
        likes: calcLikes7d,
        comments: calcComments7d,
        shares: calcShares7d,
      },
      videos,
    };
  }

  public async publishDirect(payload: {
    postId?: string;
    title: string;
    videoUrl: string;
    privacyLevel?: string;
    mode?: 'DIRECT' | 'DRAFT';
    approvalSignature?: string;
    approvedBy?: string;
  }) {
    // Item 8: Strict kill switch
    if (!isTikTokPublishingEnabled()) {
      throw createHttpError(
        'TikTok publishing is currently disabled (TIKTOK_PUBLISHING_ENABLED=false).',
        403
      );
    }

    const mode = payload.mode === 'DRAFT' ? 'DRAFT' : 'DIRECT';

    // Item 8: Direct publishing to feed must pass Content Studio & Executive Approval Guard
    if (mode === 'DIRECT') {
      const postPayload = {
        id: payload.postId || `draft-${Date.now()}`,
        title: payload.title,
        hook: null,
        body: payload.title,
        platform: 'TIKTOK',
        mediaUrl: payload.videoUrl,
        status: 'APPROVED',
        approvalSignature: payload.approvalSignature || '',
        approvedBy: payload.approvedBy || 'Lionel Eersteling (Owner)',
      };

      const guard = verifyPostApprovalGuard(postPayload);
      if (!guard.isValid) {
        throw createHttpError(
          `TikTok direct publishing aborted by executive guard: ${guard.reason}`,
          400
        );
      }
    }

    const conn = await this.adapter.getActiveConnection();
    if (!conn || !conn.accessToken) {
      throw createHttpError('TikTok account is not connected', 400);
    }

    return this.adapter.publishVideo(conn.accessToken, {
      ...payload,
      mode,
    });
  }

  public async disconnect() {
    await this.adapter.disconnect();
    return { success: true, message: 'TikTok account disconnected' };
  }
}

