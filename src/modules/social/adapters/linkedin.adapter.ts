import { PrismaClient } from '@prisma/client';
import path from 'path';
import fs from 'fs';

const prisma = new PrismaClient();

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

export interface LinkedInPostPayload {
  text: string;
  title?: string;
  mediaUrl?: string;
  mediaType?: string;
}

export interface LinkedInPostResult {
  postId: string;
  postUrn: string;
  postUrl: string;
}

export class LinkedInAdapter {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly defaultRedirectUri: string;

  constructor() {
    this.clientId = process.env.LINKEDIN_CLIENT_ID || '78ocx3kz1moo0s';
    this.clientSecret = process.env.LINKEDIN_CLIENT_SECRET || '';
    this.defaultRedirectUri =
      process.env.LINKEDIN_REDIRECT_URI || 'https://staging.leadersperformance.ae/api/v1/social/linkedin/callback';
  }

  /**
   * Generates LinkedIn OAuth 2.0 Authorization URL
   */
  public getAuthorizationUrl(redirectUri?: string, state?: string, customScopes?: string[]): string {
    const uri = redirectUri || this.defaultRedirectUri;
    const authState = state || `state_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const baseScopes = ['openid', 'profile', 'email', 'w_member_social'];
    const activeScopes = customScopes && customScopes.length > 0 ? customScopes : baseScopes;
    const scopes = activeScopes.join('%20');

    return (
      `https://www.linkedin.com/oauth/v2/authorization` +
      `?response_type=code` +
      `&client_id=${encodeURIComponent(this.clientId)}` +
      `&redirect_uri=${encodeURIComponent(uri)}` +
      `&state=${encodeURIComponent(authState)}` +
      `&scope=${scopes}`
    );
  }

  /**
   * Exchanges authorization code for an OAuth access token
   */
  public async exchangeCodeForToken(code: string, redirectUri?: string): Promise<LinkedInTokenResponse> {
    const uri = redirectUri || this.defaultRedirectUri;
    const tokenUrl = 'https://www.linkedin.com/oauth/v2/accessToken';

    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code.trim(),
      client_id: this.clientId,
      client_secret: this.clientSecret,
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
   * Retrieves member profile via OpenID UserInfo endpoint
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

    // Local file fallback
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
    if (process.env.LINKEDIN_PUBLISHING_ENABLED !== 'true') {
      console.log('[LinkedInAdapter] Safety gate: LINKEDIN_PUBLISHING_ENABLED is off. Returning simulated image URN.');
      return `urn:li:image:safety-dry-run-${Date.now()}`;
    }

    const { buffer, contentType } = await this.getMediaBuffer(mediaUrl);

    // Step 1: Initialize Image Upload
    const initRes = await fetch('https://api.linkedin.com/rest/images?action=initializeUpload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202401',
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
    if (process.env.LINKEDIN_PUBLISHING_ENABLED !== 'true') {
      console.log('[LinkedInAdapter] Safety gate: LINKEDIN_PUBLISHING_ENABLED is off. Returning simulated video URN.');
      return `urn:li:video:safety-dry-run-${Date.now()}`;
    }

    const { buffer } = await this.getMediaBuffer(mediaUrl);
    const fileSizeBytes = buffer.length;

    // Step 1: Initialize Video Upload
    const initRes = await fetch('https://api.linkedin.com/rest/videos?action=initializeUpload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202401',
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
        'LinkedIn-Version': '202401',
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
   * Publishes an authoritative post to LinkedIn using the REST API (with UGC fallback)
   */
  public async publishPost(
    accessToken: string,
    authorUrn: string,
    content: LinkedInPostPayload
  ): Promise<LinkedInPostResult> {
    const cleanUrn = authorUrn.startsWith('urn:li:person:') || authorUrn.startsWith('urn:li:organization:')
      ? authorUrn
      : `urn:li:person:${authorUrn}`;
    const commentary = `${content.title ? content.title + '\n\n' : ''}${content.text}`;
    const mediaType = (content.mediaType || 'article').toLowerCase();

    // Safety gate: verify publishing switch
    if (process.env.LINKEDIN_PUBLISHING_ENABLED !== 'true') {
      console.log('[LinkedInAdapter] Safety gate: LINKEDIN_PUBLISHING_ENABLED is not "true". Post dispatch simulated.');
      const simulatedPostUrn = `urn:li:share:safety-dry-run-${Date.now()}`;
      return {
        postId: simulatedPostUrn,
        postUrn: simulatedPostUrn,
        postUrl: `https://www.linkedin.com/feed/update/${encodeURIComponent(simulatedPostUrn)}`,
      };
    }

    // Upload image or video to LinkedIn first if provided
    let assetUrn: string | null = null;
    if (content.mediaUrl) {
      if (mediaType === 'image') {
        assetUrn = await this.uploadImageToLinkedIn(accessToken, cleanUrn, content.mediaUrl);
      } else if (mediaType === 'video') {
        assetUrn = await this.uploadVideoToLinkedIn(accessToken, cleanUrn, content.mediaUrl);
      }
    }

    // 1. Primary: Try modern LinkedIn Posts REST API
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
        // Send the asset URN in content.media.id
        body.content = {
          media: {
            id: assetUrn,
          },
        };
      } else if (content.mediaUrl && mediaType === 'article') {
        // Links stay as they are (article card)
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
          'LinkedIn-Version': '202401',
          'X-Restli-Protocol-Version': '2.0.0',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (res.ok || res.status === 201) {
        const postUrn = res.headers.get('x-restli-id') || res.headers.get('location') || `urn:li:share:${Date.now()}`;
        const postUrl = `https://www.linkedin.com/feed/update/${encodeURIComponent(postUrn)}`;
        return {
          postId: postUrn,
          postUrn,
          postUrl,
        };
      }
      console.warn('[LinkedInAdapter] REST API failed with status', res.status, await res.text(), '- attempting UGC Posts API fallback');
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
        'X-Restli-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(ugcPayload),
    });

    if (!ugcRes.ok && ugcRes.status !== 201) {
      const errText = await ugcRes.text();
      throw new Error(`LinkedIn UGC Posts API error ${ugcRes.status}: ${errText}`);
    }

    const ugcData = (await ugcRes.json()) as any;
    const postUrn = ugcData.id || `urn:li:share:${Date.now()}`;
    const postUrl = `https://www.linkedin.com/feed/update/${encodeURIComponent(postUrn)}`;

    return {
      postId: postUrn,
      postUrn,
      postUrl,
    };
  }

  /**
   * Retrieves active LinkedIn connection state from database
   */
  public async getActiveConnection() {
    return prisma.socialAccountConnection.findUnique({
      where: { platform: 'LINKEDIN' },
    });
  }

  /**
   * Saves or updates LinkedIn account connection
   */
  public async saveConnection(data: {
    accountName: string;
    accountUrn: string;
    accountEmail?: string;
    profilePictureUrl?: string;
    accessToken: string;
    refreshToken?: string;
    expiresInSeconds: number;
    scopes?: string[];
    followersCount?: number | null;
  }) {
    const expiresAt = new Date(Date.now() + (data.expiresInSeconds || 5184000) * 1000); // Defaults ~60 days

    return prisma.socialAccountConnection.upsert({
      where: { platform: 'LINKEDIN' },
      create: {
        platform: 'LINKEDIN',
        accountName: data.accountName,
        accountUrn: data.accountUrn,
        accountEmail: data.accountEmail || null,
        profilePictureUrl: data.profilePictureUrl || null,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken || null,
        tokenExpiresAt: expiresAt,
        scopes: data.scopes || ['openid', 'profile', 'email', 'w_member_social'],
        status: 'HEALTHY',
        lastSyncAt: new Date(),
        followersCount: data.followersCount !== undefined ? data.followersCount : null,
      },
      update: {
        accountName: data.accountName,
        accountUrn: data.accountUrn,
        accountEmail: data.accountEmail || null,
        profilePictureUrl: data.profilePictureUrl || null,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken || undefined,
        tokenExpiresAt: expiresAt,
        scopes: data.scopes || ['openid', 'profile', 'email', 'w_member_social'],
        status: 'HEALTHY',
        lastSyncAt: new Date(),
      },
    });
  }

  /**
   * Disconnects LinkedIn account
   */
  public async disconnect(): Promise<void> {
    await prisma.socialAccountConnection.deleteMany({
      where: { platform: 'LINKEDIN' },
    });
  }

  /**
   * Probes integration health and response latency
   */
  public async ping(): Promise<{ status: 'HEALTHY' | 'DEGRADED' | 'DOWN'; latencyMs: number; message: string }> {
    const start = Date.now();
    try {
      const conn = await this.getActiveConnection();

      if (!conn) {
        return {
          status: 'DEGRADED',
          latencyMs: Date.now() - start,
          message: 'LinkedIn app configured but account not connected via OAuth yet',
        };
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
