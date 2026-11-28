import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  encryptToken,
  decryptToken,
  safeEncryptToken,
  safeDecryptToken,
  assertTokenEncryptionKeyConfigured,
} from '../modules/automation/crypto/tokenCrypto';
import { LinkedInAnalyticsAdapter, analyticsPrisma } from '../modules/analytics/adapters/linkedinAnalytics.adapter';
import { TikTokAdapter } from '../modules/social/adapters/tiktok.adapter';
import { LinkedInAdapter, socialPrisma } from '../modules/social/adapters/linkedin.adapter';
import { InstagramAdapter, prisma as instagramPrisma } from '../modules/social/adapters/instagram.adapter';
import { LinkedInPublishAdapter } from '../modules/automation/publisher/adapters/linkedin.adapter';
import { InstagramPublishAdapter } from '../modules/automation/publisher/adapters/instagram.adapter';
import { TikTokPublishAdapter } from '../modules/automation/publisher/adapters/tiktok.adapter';
import { YouTubePublishAdapter } from '../modules/automation/publisher/adapters/youtube.adapter';

const TEST_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('Token Encryption & Stored Token Decryption Suite', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  describe('1. Production Enforcement & tokenCrypto behavior', () => {
    it('throws in production when TOKEN_ENCRYPTION_KEY is unset', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.TOKEN_ENCRYPTION_KEY;

      expect(() => assertTokenEncryptionKeyConfigured()).toThrow(
        /TOKEN_ENCRYPTION_KEY environment variable is required in production/
      );

      expect(() => safeEncryptToken('plaintext-token')).toThrow(
        /TOKEN_ENCRYPTION_KEY environment variable is required in production/
      );
    });

    it('encrypts plaintext tokens into v1: format when key is configured', () => {
      const plaintext = 'test-oauth-token-secret-123';
      const encrypted = safeEncryptToken(plaintext);

      expect(encrypted).toBeDefined();
      expect(encrypted?.startsWith('v1:')).toBe(true);

      const decrypted = safeDecryptToken(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('is idempotent when token is already encrypted (v1:)', () => {
      const plaintext = 'test-token-456';
      const encrypted1 = safeEncryptToken(plaintext)!;
      const encrypted2 = safeEncryptToken(encrypted1);

      expect(encrypted2).toBe(encrypted1);
      expect(safeDecryptToken(encrypted2)).toBe(plaintext);
    });

    it('returns plaintext unchanged when safeDecryptToken encounters unencrypted token', () => {
      const rawPlaintext = 'legacy_unencrypted_token';
      expect(safeDecryptToken(rawPlaintext)).toBe(rawPlaintext);
    });
  });

  describe('2. LinkedIn Analytics Adapter decrypts stored connections', () => {
    it('decrypts stored v1: encrypted tokens in getActiveConnection', async () => {
      const plaintextToken = 'AQU9ZLw0YUy-linkedin-analytics-plaintext';
      const encToken = encryptToken(plaintextToken, TEST_KEY);

      jest.spyOn((analyticsPrisma as any).socialAccountConnection, 'findFirst').mockResolvedValue({
        id: 'conn-li-page',
        platform: 'LINKEDIN_PAGE',
        accountName: 'Leaders Performance',
        accountUrn: 'urn:li:organization:123456',
        accessToken: encToken,
        refreshToken: encToken,
        status: 'HEALTHY',
      });

      const adapter = new LinkedInAnalyticsAdapter();
      const activeConn = await (adapter as any).getActiveConnection('BUSINESS');

      expect(activeConn).toBeDefined();
      expect(activeConn.accessToken).toBe(plaintextToken);
      expect(activeConn.refreshToken).toBe(plaintextToken);
    });
  });

  describe('3. TikTok Adapter encrypts at rest and decrypts in memory', () => {
    it('encrypts tokens on saveConnection and returns decrypted tokens', async () => {
      const plainAccess = 'act.1oWR32m90Y3-tiktok-plaintext';
      const plainRefresh = 'rft.feiAouSzvoy-tiktok-refresh-plaintext';

      let storedData: any = null;
      jest.spyOn(socialPrisma.socialAccountConnection, 'upsert').mockImplementation(async ({ create }: any) => {
        storedData = create;
        return {
          id: 'conn-tiktok-1',
          ...create,
        };
      });

      const adapter = new TikTokAdapter();
      const saved = await adapter.saveConnection({
        accountName: 'Lionel Eersteling',
        accountUrn: 'open-id-123',
        accessToken: plainAccess,
        refreshToken: plainRefresh,
        expiresInSeconds: 86400,
      });

      // Database record must be encrypted with v1:
      expect(storedData).toBeDefined();
      expect(storedData.accessToken.startsWith('v1:')).toBe(true);
      expect(storedData.refreshToken.startsWith('v1:')).toBe(true);

      // Returned connection to application must be decrypted
      expect(saved.accessToken).toBe(plainAccess);
      expect(saved.refreshToken).toBe(plainRefresh);
    });

    it('decrypts stored v1: tokens in getActiveConnection', async () => {
      const plainAccess = 'act.tiktok-access-plain';
      const plainRefresh = 'rft.tiktok-refresh-plain';
      const encAccess = encryptToken(plainAccess, TEST_KEY);
      const encRefresh = encryptToken(plainRefresh, TEST_KEY);

      jest.spyOn(socialPrisma.socialAccountConnection, 'findUnique').mockResolvedValue({
        id: 'conn-tiktok-1',
        platform: 'TIKTOK',
        accountName: 'Lionel Eersteling',
        accountUrn: 'open-id-123',
        accessToken: encAccess,
        refreshToken: encRefresh,
        tokenExpiresAt: new Date(Date.now() + 86400000),
        status: 'HEALTHY',
      } as any);

      const adapter = new TikTokAdapter();
      const conn = await adapter.getActiveConnection(false);

      expect(conn).toBeDefined();
      expect(conn?.accessToken).toBe(plainAccess);
      expect(conn?.refreshToken).toBe(plainRefresh);
    });
  });

  describe('4. Publisher Adapters decrypt tokens before sending', () => {
    it('LinkedInPublishAdapter decrypts v1: tokens in headers and refresh', async () => {
      const plainToken = 'AQU-linkedin-publisher-plain';
      const encToken = encryptToken(plainToken, TEST_KEY);

      const mockFetch = jest.fn<any>().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'new-token', refresh_token: 'new-refresh' }),
      });

      const adapter = new LinkedInPublishAdapter(mockFetch);

      // Verify header decryption
      const headers = (adapter as any).getLinkedInHeaders(encToken);
      expect(headers.Authorization).toBe(`Bearer ${plainToken}`);

      // Verify refresh decryption
      await adapter.refreshToken({
        id: 'acc-1',
        platform: 'LINKEDIN',
        externalId: 'urn:li:person:123',
        refreshToken: encToken,
      });

      expect(mockFetch).toHaveBeenCalled();
      const fetchBody = mockFetch.mock.calls[0][1]?.body as string;
      expect(fetchBody).toContain(`refresh_token=${encodeURIComponent(plainToken)}`);
    });

    it('InstagramPublishAdapter decrypts v1: tokens in refresh', async () => {
      const plainRefresh = 'fb_exchange_token_plaintext';
      const encRefresh = encryptToken(plainRefresh, TEST_KEY);

      const mockFetch = jest.fn<any>().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'new-ig-token', expires_in: 5184000 }),
      });

      const adapter = new InstagramPublishAdapter(mockFetch);
      await adapter.refreshToken({
        id: 'acc-ig',
        platform: 'INSTAGRAM',
        externalId: 'ig-user-123',
        refreshToken: encRefresh,
      });

      expect(mockFetch).toHaveBeenCalled();
      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain(`fb_exchange_token=${encodeURIComponent(plainRefresh)}`);
    });

    it('TikTokPublishAdapter decrypts v1: tokens in refresh', async () => {
      const plainRefresh = 'tiktok_refresh_plaintext';
      const encRefresh = encryptToken(plainRefresh, TEST_KEY);

      const mockFetch = jest.fn<any>().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: { access_token: 'new-tt-token', refresh_token: 'new-tt-refresh', expires_in: 86400 },
        }),
      });

      const adapter = new TikTokPublishAdapter(mockFetch);
      await adapter.refreshToken({
        id: 'acc-tt',
        platform: 'TIKTOK',
        externalId: 'tt-user-123',
        refreshToken: encRefresh,
      });

      expect(mockFetch).toHaveBeenCalled();
      const fetchBody = mockFetch.mock.calls[0][1]?.body as string;
      expect(fetchBody).toContain(`refresh_token=${encodeURIComponent(plainRefresh)}`);
    });

    it('YouTubePublishAdapter decrypts v1: tokens in refresh', async () => {
      const plainRefresh = 'youtube_refresh_plaintext';
      const encRefresh = encryptToken(plainRefresh, TEST_KEY);

      const mockFetch = jest.fn<any>().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'new-yt-token', expires_in: 3600 }),
      });

      const adapter = new YouTubePublishAdapter(mockFetch);
      await adapter.refreshToken({
        id: 'acc-yt',
        platform: 'YOUTUBE',
        externalId: 'channel-123',
        refreshToken: encRefresh,
      });

      expect(mockFetch).toHaveBeenCalled();
      const fetchBody = mockFetch.mock.calls[0][1]?.body as string;
      expect(fetchBody).toContain(`refresh_token=${encodeURIComponent(plainRefresh)}`);
    });
  });
});
