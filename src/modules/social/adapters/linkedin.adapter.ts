import { PrismaClient } from '@prisma/client';
import path from 'path';
import fs from 'fs';
import {
  DEFAULT_LINKEDIN_ORGANIZATION_ID,
  getLinkedInApiVersion,
  getLinkedInVanityName,
  isLinkedInPublishingEnabled,
  LINKEDIN_MEMBER_PLATFORM,
  LINKEDIN_MEMBER_SCOPES,
  LINKEDIN_PAGE_PLATFORM,
  LINKEDIN_PAGE_SCOPES,
  getLinkedInPageScopes,
} from '../config/linkedin.config';

export const socialPrisma = new PrismaClient();

export interface LinkedInTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
}

export interface LinkedInUserProfile {
  sub: string;
  name: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  email?: string;
  urn: string;
}

export interface LinkedInOrganizationProfile {
  id: string;
  urn: string;
  name: string;
  vanityName: string;
  logoUrl?: string | null;
}

export interface LinkedInPostPayload {
  text: string;
  title?: string;
  mediaUrl?: string;
  mediaType?: string;
}

export interface LinkedInPostResult {
  postId: string | null;
  postUrn: string | null;
  postUrl: string | null;
}

export interface LinkedInPostEngagement {
  urn: string;
  reactions: number;
  comments: number;
  reposts: number;
  impressions: number | null;
  clicks: number | null;
}

export type LinkedInOAuthTarget = 'page' | 'member';

function extractRealLinkedInUrn(raw?: string | null): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const decoded = decodeURIComponent(raw.trim());
  const match = decoded.match(/(urn:li:(?:share|ugcPost|activity):\d+)/);
  if (match && match[1]) {
    return match[1];
  }
  if (decoded.startsWith('urn:li:')) {
    return decoded;
  }
  return null;
}

export class LinkedInAdapter {
  private getCredentials(target: LinkedInOAuthTarget = 'page') {
    if (target === 'page') {
      return {
        clientId:
          process.env.LINKEDIN_PAGE_CLIENT_ID?.trim() ||
          process.env.LINKEDIN_CLIENT_ID?.trim() ||
          '78ocx3kz1moo0s',
        clientSecret:
          process.env.LINKEDIN_PAGE_CLIENT_SECRET?.trim() ||
          process.env.LINKEDIN_CLIENT_SECRET?.trim() ||
          '',
        redirectUri:
          process.env.LINKEDIN_PAGE_REDIRECT_URI?.trim() ||
          process.env.LINKEDIN_REDIRECT_URI?.trim() ||
          'https://staging.leadersperformance.ae/api/v1/social/linkedin/callback',
      };
    }

    return {
      clientId: process.env.LINKEDIN_CLIENT_ID?.trim() || '78ocx3kz1moo0s',
      clientSecret: process.env.LINKEDIN_CLIENT_SECRET?.trim() || '',
      redirectUri:
        process.env.LINKEDIN_REDIRECT_URI?.trim() ||
        'https://staging.leadersperformance.ae/api/v1/social/linkedin/callback',
    };
  }

  /**
   * Generates LinkedIn OAuth 2.0 Authorization URL.
   * Defaults to company page read-only analytics scopes (r_organization_social, rw_organization_admin).
   */
  public getAuthorizationUrl(
    redirectUri?: string,
    state?: string,
    customScopes?: string[],
    target: LinkedInOAuthTarget = 'page'
  ): string {
    const creds = this.getCredentials(target);
    const uri = redirectUri || creds.redirectUri;
    const authState = state || `state_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const defaultScopes = target === 'member' ? LINKEDIN_MEMBER_SCOPES : getLinkedInPageScopes();
    const activeScopes = customScopes && customScopes.length > 0 ? customScopes : defaultScopes;
    const scopes = activeScopes.map((s) => encodeURIComponent(s.trim())).join('%20');

    return (
      `https://www.linkedin.com/oauth/v2/authorization` +
      `?response_type=code` +
      `&client_id=${encodeURIComponent(creds.clientId)}` +
      `&redirect_uri=${encodeURIComponent(uri)}` +
      `&state=${encodeURIComponent(authState)}` +
      `&scope=${scopes}`
    );
  }

  /**
   * Exchanges authorization code for an OAuth access token
   */
  public async exchangeCodeForToken(
    code: string,
    redirectUri?: string,
    target: LinkedInOAuthTarget = 'page'
  ): Promise<LinkedInTokenResponse> {
    const creds = this.getCredentials(target);
    const uri = redirectUri || creds.redirectUri;
    const tokenUrl = 'https://www.linkedin.com/oauth/v2/accessToken';

    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code.trim(),
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      redirect_uri: uri,
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[LinkedInAdapter] Token exchange failed:', response.status, errText);
      throw new Error(`LinkedIn OAuth error ${response.status}: ${errText}`);
    }

    return (await response.json()) as LinkedInTokenResponse;
  }

  /**
   * Refreshes an expired or expiring LinkedIn OAuth access token using the stored refresh token
   */
  public async refreshAccessToken(
    refreshToken: string,
    target: LinkedInOAuthTarget = 'member'
  ): Promise<LinkedInTokenResponse> {
    const creds = this.getCredentials(target);
    const tokenUrl = 'https://www.linkedin.com/oauth/v2/accessToken';

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken.trim(),
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[LinkedInAdapter] Token refresh failed:', response.status, errText);
      throw new Error(`LinkedIn token refresh error ${response.status}: ${errText}`);
    }

    return (await response.json()) as LinkedInTokenResponse;
  }

  /**
   * Internally resolves a valid LinkedIn DB connection, automatically refreshing the access token
   * and persisting the updated token to the database if expired or expiring within 5 minutes.
   */
  public async ensureValidConnection(target: LinkedInOAuthTarget = 'member', forceRefresh = false) {
    const conn =
      target === 'page' ? await this.getActivePageConnection() : await this.getActiveConnection();
    if (!conn) return null;

    const now = Date.now();
    const bufferMs = 5 * 60 * 1000; // 5-minute safety buffer
    const isExpiringOrExpired = Boolean(
      conn.tokenExpiresAt && new Date(conn.tokenExpiresAt).getTime() - now <= bufferMs
    );

    if ((forceRefresh || isExpiringOrExpired) && conn.refreshToken) {
      try {
        const refreshed = await this.refreshAccessToken(conn.refreshToken, target);
        const platform = target === 'page' ? LINKEDIN_PAGE_PLATFORM : LINKEDIN_MEMBER_PLATFORM;
        const updatedConn = await this.saveConnection({
          platform,
          accountName: conn.accountName || 'Lionel Eersteling',
          accountUrn: conn.accountUrn || '',
          accountEmail: conn.accountEmail || undefined,
          profilePictureUrl: conn.profilePictureUrl || undefined,
          accessToken: refreshed.access_token,
          refreshToken: refreshed.refresh_token || conn.refreshToken,
          expiresInSeconds: refreshed.expires_in || 5184000,
          refreshTokenExpiresIn: refreshed.refresh_token_expires_in,
          scopes: refreshed.scope ? refreshed.scope.split(/[\s,]+/).filter(Boolean) : conn.scopes,
          followersCount: conn.followersCount,
          metadata:
            conn.metadata && typeof conn.metadata === 'object' && !Array.isArray(conn.metadata)
              ? { ...(conn.metadata as Record<string, any>), lastTokenRefreshAt: new Date().toISOString() }
              : { lastTokenRefreshAt: new Date().toISOString() },
        });

        try {
          await socialPrisma.socialAuditLog.create({
            data: {
              actor: 'System Auth Manager',
              action: 'LINKEDIN_TOKEN_REFRESHED',
              entity: `LinkedInConnection #${platform}`,
              details: `Automatically refreshed LinkedIn ${target} OAuth token and persisted to database.`,
            },
          });
        } catch {
          // Ignore audit log write failure
        }

        return updatedConn;
      } catch (err: any) {
        console.warn(`[LinkedInAdapter] Auto-refresh notice for ${target}:`, err?.message);
      }
    }

    return conn;
  }

  /**
   * Retrieves member profile via OpenID UserInfo endpoint (used only for personal profile target='member')
   */
  public async fetchUserProfile(accessToken: string): Promise<LinkedInUserProfile> {
    const url = 'https://api.linkedin.com/v2/userinfo';
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[LinkedInAdapter] Failed to fetch user info:', response.status, errText);
      throw new Error(`LinkedIn UserInfo error ${response.status}: ${errText}`);
    }

    const data = (await response.json()) as any;
    const sub = data.sub;
    const urn = `urn:li:person:${sub}`;

    return {
      sub,
      name: data.name || `${data.given_name || ''} ${data.family_name || ''}`.trim() || 'Lionel Eersteling',
      given_name: data.given_name,
      family_name: data.family_name,
      picture: data.picture,
      email: data.email,
      urn,
    };
  }

  /**
   * Resolves the LinkedIn Company Page organization profile for Community Management API connections
   * without requiring OpenID scopes.
   */
  public async fetchOrganizationProfile(accessToken: string): Promise<LinkedInOrganizationProfile> {
    const apiVersion = getLinkedInApiVersion();
    const vanityName = getLinkedInVanityName();
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'LinkedIn-Version': apiVersion,
      'X-Restli-Protocol-Version': '2.0.0',
    };

    const configuredRaw =
      process.env.LINKEDIN_ORGANIZATION_URN?.trim() ||
      process.env.LINKEDIN_ORGANIZATION_ID?.trim() ||
      DEFAULT_LINKEDIN_ORGANIZATION_ID;
    const configuredId = configuredRaw ? configuredRaw.replace(/^urn:li:organization:/, '') : null;

    // 1. Try lookup by vanityName (lioneleersteling)
    try {
      const vanityUrl = `https://api.linkedin.com/rest/organizations?q=vanityName&vanityName=${encodeURIComponent(
        vanityName
      )}`;
      const res = await fetch(vanityUrl, { headers });
      if (res.ok) {
        const data = (await res.json()) as any;
        const org = data.elements?.[0];
        if (org && org.id) {
          const id = String(org.id);
          return {
            id,
            urn: `urn:li:organization:${id}`,
            name: org.localizedName || 'Leaders Performance',
            vanityName: org.vanityName || vanityName,
            logoUrl: null,
          };
        }
      }
    } catch (err: any) {
      console.warn('[LinkedInAdapter] Organization lookup by vanityName notice:', err?.message);
    }

    // 2. Try organizationAcls to discover administered organization URN
    try {
      const aclUrl = 'https://api.linkedin.com/rest/organizationAcls?q=roleAssignee';
      const aclRes = await fetch(aclUrl, { headers });
      if (aclRes.ok) {
        const aclData = (await aclRes.json()) as any;
        const firstOrgUrn: string | undefined = aclData.elements?.find((el: any) =>
          typeof el.organization === 'string' && el.organization.startsWith('urn:li:organization:')
        )?.organization;
        if (firstOrgUrn) {
          const id = firstOrgUrn.replace(/^urn:li:organization:/, '');
          return {
            id,
            urn: firstOrgUrn,
            name: 'Leaders Performance',
            vanityName,
            logoUrl: null,
          };
        }
      }
    } catch (err: any) {
      console.warn('[LinkedInAdapter] Organization ACL lookup notice:', err?.message);
    }

    // 3. Fallback to configured LINKEDIN_ORGANIZATION_URN / LINKEDIN_ORGANIZATION_ID if present
    if (configuredId) {
      return {
        id: configuredId,
        urn: `urn:li:organization:${configuredId}`,
        name: 'Leaders Performance',
        vanityName,
        logoUrl: null,
      };
    }

    return {
      id: vanityName,
      urn: `urn:li:organization:${vanityName}`,
      name: 'Leaders Performance',
      vanityName,
      logoUrl: null,
    };
  }

  /**
   * Helper to retrieve media buffer from URL or local file path
   */
  private async getMediaBuffer(mediaUrl: string): Promise<{ buffer: Buffer; contentType: string }> {
    if (mediaUrl.startsWith('http://') || mediaUrl.startsWith('https://')) {
      const res = await fetch(mediaUrl);
      if (!res.ok) {
        throw new Error(`Failed to download media from ${mediaUrl}: HTTP ${res.status}`);
      }
      const arrayBuffer = await res.arrayBuffer();
      const contentType = res.headers.get('content-type') || 'application/octet-stream';
      return { buffer: Buffer.from(arrayBuffer), contentType };
    }

    const relative = mediaUrl.startsWith('/') ? mediaUrl.slice(1) : mediaUrl;
    const localPath = path.resolve(process.cwd(), relative);
    if (fs.existsSync(localPath)) {
      const buffer = fs.readFileSync(localPath);
      const ext = path.extname(localPath).toLowerCase();
      let contentType = 'application/octet-stream';
      if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
      else if (ext === '.png') contentType = 'image/png';
      else if (ext === '.gif') contentType = 'image/gif';
      else if (ext === '.mp4') contentType = 'video/mp4';
      return { buffer, contentType };
    }

    throw new Error(`Media not found at ${mediaUrl}`);
  }

  /**
   * Uploads an image to LinkedIn using the 2-step REST Images API
   * Step 1: initializeUpload -> Step 2: PUT binary
   */
  public async uploadImageToLinkedIn(accessToken: string, authorUrn: string, mediaUrl: string): Promise<string> {
    if (!isLinkedInPublishingEnabled()) {
      const err: any = new Error(
        'LinkedIn publishing is disabled (LINKEDIN_PUBLISHING_ENABLED=false). Image upload blocked.'
      );
      err.statusCode = 403;
      throw err;
    }

    const apiVersion = getLinkedInApiVersion();
    const { buffer, contentType } = await this.getMediaBuffer(mediaUrl);

    // Step 1: Initialize Image Upload
    const initRes = await fetch('https://api.linkedin.com/rest/images?action=initializeUpload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': apiVersion,
        'X-Restli-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        initializeUploadRequest: {
          owner: authorUrn,
        },
      }),
    });

    if (!initRes.ok) {
      const err = await initRes.text();
      throw new Error(`LinkedIn Images initializeUpload error ${initRes.status}: ${err}`);
    }

    const initData = (await initRes.json()) as any;
    const uploadUrl = initData.value?.uploadUrl;
    const imageUrn = initData.value?.image;

    if (!uploadUrl || !imageUrn) {
      throw new Error('LinkedIn did not return uploadUrl or image URN in initializeUpload response');
    }

    // Step 2: Upload Image Binary
    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType || 'image/jpeg',
      },
      body: buffer as any,
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.text();
      throw new Error(`LinkedIn Image binary upload error ${uploadRes.status}: ${err}`);
    }

    return imageUrn;
  }

  /**
   * Uploads a video to LinkedIn using the 3-step REST Videos API
   * Step 1: initializeUpload -> Step 2: PUT binary chunks -> Step 3: finalizeUpload
   */
  public async uploadVideoToLinkedIn(accessToken: string, authorUrn: string, mediaUrl: string): Promise<string> {
    if (!isLinkedInPublishingEnabled()) {
      const err: any = new Error(
        'LinkedIn publishing is disabled (LINKEDIN_PUBLISHING_ENABLED=false). Video upload blocked.'
      );
      err.statusCode = 403;
      throw err;
    }

    const apiVersion = getLinkedInApiVersion();
    const { buffer } = await this.getMediaBuffer(mediaUrl);
    const fileSizeBytes = buffer.length;

    // Step 1: Initialize Video Upload
    const initRes = await fetch('https://api.linkedin.com/rest/videos?action=initializeUpload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': apiVersion,
        'X-Restli-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        initializeUploadRequest: {
          owner: authorUrn,
          fileSizeBytes,
          uploadCaptions: false,
          uploadThumbnail: false,
        },
      }),
    });

    if (!initRes.ok) {
      const err = await initRes.text();
      throw new Error(`LinkedIn Videos initializeUpload error ${initRes.status}: ${err}`);
    }

    const initData = (await initRes.json()) as any;
    const instructions = initData.value?.uploadInstructions;
    const videoUrn = initData.value?.video;
    const uploadToken = initData.value?.uploadToken || '';

    if (!instructions || !instructions.length || !videoUrn) {
      throw new Error('LinkedIn did not return uploadInstructions or video URN');
    }

    const uploadedPartIds: string[] = [];

    // Step 2: Upload Part Binary
    for (const instruction of instructions) {
      const chunk = buffer.subarray(instruction.firstByte, instruction.lastByte + 1);
      const uploadRes = await fetch(instruction.uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
        },
        body: chunk as any,
      });

      if (!uploadRes.ok) {
        const err = await uploadRes.text();
        throw new Error(`LinkedIn Video part upload error ${uploadRes.status}: ${err}`);
      }

      const etag = uploadRes.headers.get('etag') || uploadRes.headers.get('ETag') || '';
      if (etag) {
        uploadedPartIds.push(etag);
      }
    }

    // Step 3: Finalize Video Upload
    const finalizeRes = await fetch('https://api.linkedin.com/rest/videos?action=finalizeUpload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': apiVersion,
        'X-Restli-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        finalizeUploadRequest: {
          video: videoUrn,
          uploadToken,
          uploadedPartIds,
        },
      }),
    });

    if (!finalizeRes.ok) {
      const err = await finalizeRes.text();
      throw new Error(`LinkedIn Videos finalizeUpload error ${finalizeRes.status}: ${err}`);
    }

    return videoUrn;
  }

  /**
   * Publishes an authoritative post to LinkedIn using the REST API (with UGC fallback).
   * Enforces LINKEDIN_PUBLISHING_ENABLED kill switch and never fabricates fake urn:li:share:<timestamp> IDs.
   */
  public async publishPost(
    accessToken: string,
    authorUrn: string,
    content: LinkedInPostPayload
  ): Promise<LinkedInPostResult> {
    if (!isLinkedInPublishingEnabled()) {
      const err: any = new Error(
        'LinkedIn publishing is currently disabled (LINKEDIN_PUBLISHING_ENABLED=false).'
      );
      err.statusCode = 403;
      throw err;
    }

    const apiVersion = getLinkedInApiVersion();
    const cleanUrn =
      authorUrn.startsWith('urn:li:person:') || authorUrn.startsWith('urn:li:organization:')
        ? authorUrn
        : `urn:li:person:${authorUrn}`;
    const commentary = `${content.title ? content.title + '\n\n' : ''}${content.text}`;
    const mediaType = (content.mediaType || 'article').toLowerCase();

    // Upload image or video to LinkedIn first if provided
    let assetUrn: string | null = null;
    if (content.mediaUrl) {
      if (mediaType === 'image') {
        assetUrn = await this.uploadImageToLinkedIn(accessToken, cleanUrn, content.mediaUrl);
      } else if (mediaType === 'video') {
        assetUrn = await this.uploadVideoToLinkedIn(accessToken, cleanUrn, content.mediaUrl);
      }
    }

    // 1. Primary: Modern LinkedIn Posts REST API
    try {
      const restUrl = 'https://api.linkedin.com/rest/posts';
      const body: any = {
        author: cleanUrn,
        commentary,
        visibility: 'PUBLIC',
        distribution: {
          feedDistribution: 'MAIN_FEED',
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
      };

      if (assetUrn) {
        body.content = {
          media: {
            id: assetUrn,
          },
        };
      } else if (content.mediaUrl && mediaType === 'article') {
        body.content = {
          article: {
            source: content.mediaUrl,
            title: content.title || 'Leaders Performance Executive Thought Leadership',
            description: content.text.slice(0, 200),
          },
        };
      }

      const res = await fetch(restUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'LinkedIn-Version': apiVersion,
          'X-Restli-Protocol-Version': '2.0.0',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (res.ok || res.status === 201) {
        let bodyId: string | null = null;
        try {
          const text = await res.text();
          if (text) {
            const parsed = JSON.parse(text);
            bodyId = parsed?.id || null;
          }
        } catch {
          // Empty 201 response body is normal for LinkedIn REST Posts API
        }

        const postUrn =
          extractRealLinkedInUrn(res.headers.get('x-restli-id')) ||
          extractRealLinkedInUrn(res.headers.get('x-linkedin-id')) ||
          extractRealLinkedInUrn(res.headers.get('location')) ||
          extractRealLinkedInUrn(bodyId);

        const postUrl = postUrn ? `https://www.linkedin.com/feed/update/${encodeURIComponent(postUrn)}` : null;
        return {
          postId: postUrn,
          postUrn,
          postUrl,
        };
      }
      console.warn(
        '[LinkedInAdapter] REST API failed with status',
        res.status,
        await res.text(),
        '- attempting UGC Posts API fallback'
      );
    } catch (err: any) {
      console.warn('[LinkedInAdapter] REST API error, trying UGC fallback:', err?.message);
    }

    // 2. Secondary fallback: LinkedIn v2 UGC Posts API
    const ugcUrl = 'https://api.linkedin.com/v2/ugcPosts';
    const ugcPayload: any = {
      author: cleanUrn,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: {
            text: commentary,
          },
          shareMediaCategory: assetUrn
            ? mediaType === 'video'
              ? 'VIDEO'
              : 'IMAGE'
            : content.mediaUrl
              ? 'ARTICLE'
              : 'NONE',
          ...(assetUrn
            ? {
              media: [
                {
                  status: 'READY',
                  media: assetUrn,
                  title: {
                    text: content.title || 'Leaders Performance Executive Thought Leadership',
                  },
                },
              ],
            }
            : content.mediaUrl
              ? {
                media: [
                  {
                    status: 'READY',
                    originalUrl: content.mediaUrl,
                    title: {
                      text: content.title || 'Leaders Performance Executive Advisory',
                    },
                  },
                ],
              }
              : {}),
        },
      },
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
      },
    };

    const ugcRes = await fetch(ugcUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': apiVersion,
        'X-Restli-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(ugcPayload),
    });

    if (!ugcRes.ok && ugcRes.status !== 201) {
      const errText = await ugcRes.text();
      throw new Error(`LinkedIn UGC Posts API error ${ugcRes.status}: ${errText}`);
    }

    let ugcId: string | null = null;
    try {
      const ugcData = (await ugcRes.json()) as any;
      ugcId = ugcData?.id || null;
    } catch {
      // Ignore empty JSON body
    }

    // Item 6e: Never save a fake urn:li:share:<timestamp> when LinkedIn doesn't return the post ID
    const postUrn =
      extractRealLinkedInUrn(ugcId) ||
      extractRealLinkedInUrn(ugcRes.headers.get('x-restli-id')) ||
      extractRealLinkedInUrn(ugcRes.headers.get('x-linkedin-id')) ||
      extractRealLinkedInUrn(ugcRes.headers.get('location'));

    const postUrl = postUrn ? `https://www.linkedin.com/feed/update/${encodeURIComponent(postUrn)}` : null;

    return {
      postId: postUrn,
      postUrn,
      postUrl,
    };
  }

  /**
   * Retrieves active personal member LinkedIn connection ('LINKEDIN') for publishing.
   * Item 9: Never reads 'LINKEDIN_PAGE' or LINKEDIN_ACCESS_TOKEN env var so connecting the page
   * for analytics can NEVER give the scheduler or publisher a token it can post with.
   */
  public async getActiveConnection() {
    try {
      const conn = await socialPrisma.socialAccountConnection.findUnique({
        where: { platform: LINKEDIN_MEMBER_PLATFORM },
      });
      if (conn) return conn;
    } catch {
      // Ignore DB offline error
    }
    return null;
  }

  /**
   * Retrieves active company page LinkedIn connection ('LINKEDIN_PAGE') for read-only analytics.
   */
  public async getActivePageConnection() {
    try {
      const conn = await socialPrisma.socialAccountConnection.findUnique({
        where: { platform: LINKEDIN_PAGE_PLATFORM },
      });
      if (conn) return conn;
    } catch {
      // Ignore DB offline error
    }
    return null;
  }

  /**
   * Fetches social actions / engagement (reactions, comments, reposts) for a published LinkedIn post URN
   */
  public async fetchPostEngagement(
    accessToken: string,
    postUrn: string
  ): Promise<LinkedInPostEngagement> {
    const apiVersion = getLinkedInApiVersion();
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'LinkedIn-Version': apiVersion,
      'X-Restli-Protocol-Version': '2.0.0',
    };

    try {
      const metaRes = await fetch(
        `https://api.linkedin.com/rest/socialMetadata/${encodeURIComponent(postUrn)}`,
        { headers }
      );
      if (metaRes.ok) {
        const data = (await metaRes.json()) as any;
        let reactions = 0;
        if (data?.reactionSummaries && typeof data.reactionSummaries === 'object') {
          for (const val of Object.values(data.reactionSummaries) as any[]) {
            reactions += typeof val?.count === 'number' ? val.count : 0;
          }
        }
        const comments = typeof data?.commentSummary?.count === 'number' ? data.commentSummary.count : 0;
        return {
          urn: postUrn,
          reactions,
          comments,
          reposts: 0,
          impressions: null,
          clicks: null,
        };
      }
    } catch {
      // Fallback to v2 socialActions
    }

    try {
      const actionsRes = await fetch(
        `https://api.linkedin.com/v2/socialActions/${encodeURIComponent(postUrn)}`,
        { headers }
      );
      if (actionsRes.ok) {
        const data = (await actionsRes.json()) as any;
        const reactions = typeof data?.likesSummary?.totalLikes === 'number' ? data.likesSummary.totalLikes : 0;
        const comments =
          typeof data?.commentsSummary?.totalFirstLevelComments === 'number'
            ? data.commentsSummary.totalFirstLevelComments
            : 0;
        return {
          urn: postUrn,
          reactions,
          comments,
          reposts: 0,
          impressions: null,
          clicks: null,
        };
      }
    } catch {
      // Ignore network failure
    }

    return {
      urn: postUrn,
      reactions: 0,
      comments: 0,
      reposts: 0,
      impressions: null,
      clicks: null,
    };
  }

  /**
   * Saves or updates LinkedIn account connection (either 'LINKEDIN' for member posting or 'LINKEDIN_PAGE' for company analytics).
   */
  public async saveConnection(data: {
    platform?: typeof LINKEDIN_MEMBER_PLATFORM | typeof LINKEDIN_PAGE_PLATFORM;
    accountName: string;
    accountUrn: string;
    accountEmail?: string;
    profilePictureUrl?: string;
    accessToken: string;
    refreshToken?: string;
    expiresInSeconds: number;
    refreshTokenExpiresIn?: number;
    scopes?: string[];
    followersCount?: number | null;
    metadata?: Record<string, any> | null;
  }) {
    const platform = data.platform || LINKEDIN_MEMBER_PLATFORM;
    const defaultScopes = platform === LINKEDIN_PAGE_PLATFORM ? getLinkedInPageScopes() : LINKEDIN_MEMBER_SCOPES;
    const expiresAt = new Date(Date.now() + (data.expiresInSeconds || 5184000) * 1000);
    const refreshExpiresAt = data.refreshTokenExpiresIn
      ? new Date(Date.now() + data.refreshTokenExpiresIn * 1000)
      : undefined;

    return socialPrisma.socialAccountConnection.upsert({
      where: { platform },
      create: {
        platform,
        accountName: data.accountName,
        accountUrn: data.accountUrn,
        accountEmail: data.accountEmail || null,
        profilePictureUrl: data.profilePictureUrl || null,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken || null,
        tokenExpiresAt: expiresAt,
        ...(refreshExpiresAt ? { refreshTokenExpiresAt: refreshExpiresAt } : {}),
        scopes: data.scopes || defaultScopes,
        status: 'HEALTHY',
        lastSyncAt: new Date(),
        followersCount: data.followersCount !== undefined ? data.followersCount : null,
        ...(data.metadata !== undefined ? { metadata: data.metadata as any } : {}),
      },
      update: {
        accountName: data.accountName,
        accountUrn: data.accountUrn,
        accountEmail: data.accountEmail || null,
        profilePictureUrl: data.profilePictureUrl || null,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken || undefined,
        tokenExpiresAt: expiresAt,
        ...(refreshExpiresAt ? { refreshTokenExpiresAt: refreshExpiresAt } : {}),
        scopes: data.scopes || defaultScopes,
        status: 'HEALTHY',
        lastSyncAt: new Date(),
        ...(data.followersCount !== undefined ? { followersCount: data.followersCount } : {}),
        ...(data.metadata !== undefined ? { metadata: data.metadata as any } : {}),
      },
    });
  }

  /**
   * Disconnects LinkedIn account(s)
   */
  public async disconnect(target?: LinkedInOAuthTarget | 'all'): Promise<void> {
    if (target === 'page') {
      await socialPrisma.socialAccountConnection.deleteMany({
        where: { platform: LINKEDIN_PAGE_PLATFORM },
      });
      return;
    }
    if (target === 'member') {
      await socialPrisma.socialAccountConnection.deleteMany({
        where: { platform: LINKEDIN_MEMBER_PLATFORM },
      });
      return;
    }
    await socialPrisma.socialAccountConnection.deleteMany({
      where: { platform: { in: [LINKEDIN_MEMBER_PLATFORM, LINKEDIN_PAGE_PLATFORM] } },
    });
  }

  /**
   * Probes integration health and response latency
   */
  public async ping(): Promise<{ status: 'HEALTHY' | 'DEGRADED' | 'DOWN'; latencyMs: number; message: string }> {
    const start = Date.now();
    try {
      const pageConn = await this.getActivePageConnection();
      const memberConn = await this.getActiveConnection();
      const conn = pageConn || memberConn;

      if (!conn) {
        return {
          status: 'DEGRADED',
          latencyMs: Date.now() - start,
          message: 'LinkedIn app configured but account not connected via OAuth yet',
        };
      }

      if (conn.platform === LINKEDIN_PAGE_PLATFORM && conn.accountUrn) {
        const res = await fetch(
          `https://api.linkedin.com/v2/networkSizes/${encodeURIComponent(
            conn.accountUrn
          )}?edgeType=CompanyFollowedByMember`,
          {
            headers: { Authorization: `Bearer ${conn.accessToken}` },
          }
        );
        const latencyMs = Date.now() - start;
        if (res.ok) {
          return { status: 'HEALTHY', latencyMs, message: `Connected page as ${conn.accountName}` };
        }
        return { status: 'DEGRADED', latencyMs, message: `Page token validation returned HTTP ${res.status}` };
      }

      const res = await fetch('https://api.linkedin.com/v2/userinfo', {
        headers: { Authorization: `Bearer ${conn.accessToken}` },
      });
      const latencyMs = Date.now() - start;

      if (res.ok) {
        return { status: 'HEALTHY', latencyMs, message: `Connected as ${conn.accountName}` };
      }
      return { status: 'DEGRADED', latencyMs, message: `Token validation returned HTTP ${res.status}` };
    } catch (err: any) {
      return { status: 'DEGRADED', latencyMs: Date.now() - start, message: err?.message || 'Connection error' };
    }
  }
}
