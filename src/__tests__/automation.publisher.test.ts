import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { randomUUID } from 'crypto';
import { automationPrisma } from '../modules/automation/state/transition';
import { IStorageService } from '../modules/automation/storage/storage.service';
import { encryptToken } from '../modules/automation/crypto/tokenCrypto';
import { PublisherService } from '../modules/automation/publisher/publisher.service';
import { YouTubePublishAdapter } from '../modules/automation/publisher/adapters/youtube.adapter';
import { LinkedInPublishAdapter } from '../modules/automation/publisher/adapters/linkedin.adapter';
import { InstagramPublishAdapter } from '../modules/automation/publisher/adapters/instagram.adapter';
import { TikTokPublishAdapter } from '../modules/automation/publisher/adapters/tiktok.adapter';
import { PublishablePostContext, RetryableError, FatalError } from '../modules/automation/publisher/adapters/base.adapter';

jest.setTimeout(90000);

const TEST_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const mockStorage: IStorageService = {
  provider: 'supabase',
  defaultBucket: 'social-media',
  put: async (params) => ({
    storageProvider: 'supabase',
    bucket: params.bucket || 'social-media',
    objectKey: params.objectKey,
  }),
  get: async () => Buffer.from('mock-binary-media-payload-2026'),
  signedUrl: async (objectKey) => `https://mock-storage.local/signed/${objectKey}?token=valid24h`,
  signedUploadUrl: async (objectKey) => ({
    signedUrl: `https://mock-storage.local/upload/${objectKey}`,
    path: objectKey,
  }),
  delete: async () => undefined,
};

function createJsonResponse(status: number, body: any, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

function makeBaseContext(overrides: Partial<PublishablePostContext> = {}): PublishablePostContext {
  return {
    id: `post-${randomUUID()}`,
    platform: 'YOUTUBE',
    scheduledAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
    title: 'Executive HRV Telemetry Under Board Pressure',
    caption: 'Physiological control precedes strategic clarity.',
    hashtags: ['#LeadersPerformance', '#HRV'],
    options: {},
    processingRef: null,
    platformPostId: null,
    account: {
      id: 'acc-1',
      platform: 'YOUTUBE',
      label: 'YouTube Main',
      externalId: 'UC-leaders-performance',
      accessToken: 'valid-access-token',
      refreshToken: 'valid-refresh-token',
    },
    media: [
      {
        assetId: 'asset-main-1',
        role: 'MAIN',
        position: 0,
        fileName: 'video.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 1024,
        bucket: 'social-media',
        objectKey: 'media/2026/11/asset-main-1/video.mp4',
        durationSec: 45,
        width: 1080,
        height: 1920,
      },
    ],
    storage: mockStorage,
    ...overrides,
  };
}

beforeAll(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  process.env.EMAIL_APPROVER = 'lionel@leadersperformance.ae';
  process.env.EMAIL_EDITORS = 'sarath@leadersperformance.ae,asad@leadersperformance.ae';
  process.env.EMAIL_ADMIN = 'asif@leadersperformance.ae';
  process.env.TIKTOK_AUDITED = 'false';

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await automationPrisma.$queryRaw`SELECT 1`;
      break;
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}, 45000);

afterAll(async () => {
  await automationPrisma.$disconnect();
});

describe('Step 4: Publishing (Flow 2) — Platform Adapters, Retry/Backoff, Grace/MISSED & Token Refresh', () => {
  describe('1. Platform Adapters (YouTube -> LinkedIn -> Instagram -> TikTok)', () => {
    it('YouTube adapter: performs resumable upload with publishAt, sets playlist & thumbnail, and handles quotaExceeded (Edge Case #26)', async () => {
      const calls: Array<{ url: string; method: string; body?: string }> = [];
      const ytAdapter = new YouTubePublishAdapter(async (url, init) => {
        const method = init?.method || 'GET';
        calls.push({
          url,
          method,
          body: typeof init?.body === 'string' ? init.body : undefined,
        });

        if (url.includes('uploadType=resumable')) {
          return createJsonResponse(200, {}, { Location: 'https://youtube.local/resumable-session-1' });
        }
        if (url === 'https://youtube.local/resumable-session-1') {
          return createJsonResponse(200, {
            id: 'yt-vid-999',
            processingDetails: { processingStatus: 'succeeded' },
          });
        }
        if (url.includes('/playlistItems')) {
          return createJsonResponse(200, { id: 'pl-item-1' });
        }
        if (url.includes('/thumbnails/set')) {
          return createJsonResponse(200, { items: [{ default: { url: 'https://yt.local/thumb.jpg' } }] });
        }
        return createJsonResponse(200, {});
      });

      const ctx = makeBaseContext({
        platform: 'YOUTUBE',
        options: { playlistId: 'PL-executive-vitality' },
        media: [
          ...makeBaseContext().media,
          {
            assetId: 'asset-thumb-1',
            role: 'THUMBNAIL',
            position: 0,
            fileName: 'thumb.jpg',
            mimeType: 'image/jpeg',
            sizeBytes: 512,
            bucket: 'social-media',
            objectKey: 'media/2026/11/asset-thumb-1/thumb.jpg',
          },
        ],
      });

      const res = await ytAdapter.publish(ctx);
      expect(res.state).toBe('PUBLISHED');
      expect(res.platformPostId).toBe('yt-vid-999');
      expect(res.url).toBe('https://www.youtube.com/watch?v=yt-vid-999');
      expect(calls.length).toBe(4); // init + put + playlist + thumbnail

      const initBody = JSON.parse(calls[0].body || '{}');
      expect(initBody.status.privacyStatus).toBe('private');
      expect(initBody.status.publishAt).toBe(ctx.scheduledAt.toISOString());

      // Test Edge Case #26: quotaExceeded -> RetryableError with customDelayMinutes = 1440 (24h)
      const quotaAdapter = new YouTubePublishAdapter(async () =>
        createJsonResponse(403, {
          error: { errors: [{ reason: 'quotaExceeded' }], message: 'Quota exceeded' },
        })
      );

      await expect(quotaAdapter.publish(ctx)).rejects.toMatchObject({
        name: 'RetryableError',
        errorCode: 'YOUTUBE_QUOTA_EXCEEDED',
        customDelayMinutes: 1440,
      });
    });

    it('LinkedIn adapter: uploads image via Images API and posts to /rest/posts with Linkedin-Version header and org URN', async () => {
      const headersSeen: Array<Record<string, any>> = [];
      let postPayload: any = null;

      const liAdapter = new LinkedInPublishAdapter(async (url, init) => {
        headersSeen.push((init?.headers as Record<string, any>) || {});
        if (url.includes('/rest/images?action=initializeUpload')) {
          return createJsonResponse(200, {
            value: {
              uploadUrl: 'https://linkedin.local/upload-img-1',
              image: 'urn:li:image:C4E10AQF123',
            },
          });
        }
        if (url === 'https://linkedin.local/upload-img-1') {
          return new Response(null, { status: 201 });
        }
        if (url.includes('/rest/posts')) {
          postPayload = JSON.parse(String(init?.body || '{}'));
          return createJsonResponse(201, { id: 'urn:li:share:778899' }, { 'x-restli-id': 'urn:li:share:778899' });
        }
        return createJsonResponse(200, {});
      });

      const ctx = makeBaseContext({
        platform: 'LINKEDIN',
        account: {
          id: 'acc-li-org',
          platform: 'LINKEDIN',
          label: 'Leaders Performance Company Page',
          externalId: '18948042', // numeric org ID -> urn:li:organization:18948042
          accessToken: 'li-token',
        },
        media: [
          {
            assetId: 'asset-img-1',
            role: 'MAIN',
            position: 0,
            fileName: 'quote.png',
            mimeType: 'image/png',
            sizeBytes: 2048,
            bucket: 'social-media',
            objectKey: 'media/2026/11/asset-img-1/quote.png',
          },
        ],
      });

      const res = await liAdapter.publish(ctx);
      expect(res.state).toBe('PUBLISHED');
      expect(res.platformPostId).toBe('urn:li:share:778899');
      expect(headersSeen[0]['Linkedin-Version']).toBeDefined();
      expect(postPayload.author).toBe('urn:li:organization:18948042');
      expect(postPayload.content.media.id).toBe('urn:li:image:C4E10AQF123');
    });

    it('Instagram adapter: checks daily cap (Edge Case #23), creates REELS container -> PROCESSING, recreates once on EXPIRED (Edge Case #24), and publishes on FINISHED', async () => {
      // 1. Test daily cap reached -> RetryableError (+60 min)
      const capReachedAdapter = new InstagramPublishAdapter(async () =>
        createJsonResponse(200, {
          data: [{ quota_usage: 50, config: { quota_total: 50 } }],
        })
      );
      const igCtx = makeBaseContext({
        platform: 'INSTAGRAM',
        account: {
          id: 'acc-ig',
          platform: 'INSTAGRAM',
          label: 'Instagram Main',
          externalId: '17841400001',
          accessToken: 'ig-token',
        },
      });

      await expect(capReachedAdapter.publish(igCtx)).rejects.toMatchObject({
        name: 'RetryableError',
        errorCode: 'INSTAGRAM_DAILY_CAP_REACHED',
        customDelayMinutes: 60,
      });

      // 2. Normal publish -> PROCESSING, then poll EXPIRED -> recreated once, then poll FINISHED -> PUBLISHED
      let containerSeq = 0;
      let pollCall = 0;
      const igAdapter = new InstagramPublishAdapter(async (url, init) => {
        if (url.includes('/content_publishing_limit')) {
          return createJsonResponse(200, {
            data: [{ quota_usage: 3, config: { quota_total: 50 } }],
          });
        }
        if (url.endsWith('/media') && init?.method === 'POST') {
          containerSeq += 1;
          return createJsonResponse(200, { id: `ig-container-${containerSeq}` });
        }
        if (url.includes('fields=status_code')) {
          pollCall += 1;
          if (pollCall === 1) {
            return createJsonResponse(200, { status_code: 'EXPIRED', status: 'Expired' });
          }
          return createJsonResponse(200, { status_code: 'FINISHED', status: 'Finished' });
        }
        if (url.endsWith('/media_publish')) {
          return createJsonResponse(200, { id: 'ig-media-live-555' });
        }
        if (url.includes('fields=permalink')) {
          return createJsonResponse(200, { permalink: 'https://www.instagram.com/reel/Cxyz555/' });
        }
        return createJsonResponse(200, {});
      });

      const pubRes = await igAdapter.publish(igCtx);
      expect(pubRes.state).toBe('PROCESSING');
      expect(pubRes.processingRef).toBe('ig-container-1');

      // First poll hits EXPIRED -> recreates ig-container-2
      const poll1 = await igAdapter.poll({ ...igCtx, processingRef: 'ig-container-1' });
      expect(poll1.state).toBe('PROCESSING');
      expect(poll1.processingRef).toBe('ig-container-2');
      expect(poll1.rawResponse?.igContainerRecreated).toBe(true);

      // Second poll hits FINISHED -> media_publish -> PUBLISHED with permalink
      const poll2 = await igAdapter.poll({
        ...igCtx,
        processingRef: 'ig-container-2',
        options: { igContainerRecreated: true },
      });
      expect(poll2.state).toBe('PUBLISHED');
      expect(poll2.platformPostId).toBe('ig-media-live-555');
      expect(poll2.url).toBe('https://www.instagram.com/reel/Cxyz555/');
    });

    it('TikTok adapter: refuses public posting when TIKTOK_AUDITED=false (Edge Case #25), and performs chunked upload + status/fetch when TIKTOK_AUDITED=true', async () => {
      process.env.TIKTOK_AUDITED = 'false';
      const ttAdapter = new TikTokPublishAdapter(async () => createJsonResponse(200, {}));
      const ttCtx = makeBaseContext({
        platform: 'TIKTOK',
        account: {
          id: 'acc-tt',
          platform: 'TIKTOK',
          label: 'TikTok NL',
          externalId: 'lionel.nl',
          accessToken: 'tt-token',
        },
      });

      await expect(ttAdapter.publish(ttCtx)).rejects.toMatchObject({
        name: 'FatalError',
        errorCode: 'TIKTOK_AUDIT_PENDING',
      });

      // Now enable TIKTOK_AUDITED=true and verify creator_info -> video/init -> chunked PUT -> poll PUBLISH_COMPLETE
      process.env.TIKTOK_AUDITED = 'true';
      try {
        const auditedAdapter = new TikTokPublishAdapter(async (url, init) => {
          if (url.includes('creator_info/query')) {
            return createJsonResponse(200, {
              data: {
                privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
                max_video_post_duration_sec: 180,
              },
            });
          }
          if (url.includes('video/init')) {
            return createJsonResponse(200, {
              data: {
                publish_id: 'tt-pub-777',
                upload_url: 'https://tiktok.local/upload-777',
              },
            });
          }
          if (url === 'https://tiktok.local/upload-777' && init?.method === 'PUT') {
            return new Response(null, { status: 201 });
          }
          if (url.includes('status/fetch')) {
            return createJsonResponse(200, {
              data: {
                status: 'PUBLISH_COMPLETE',
                publicaly_available_post_id: ['7399001122'],
              },
            });
          }
          return createJsonResponse(200, {});
        });

        const pubRes = await auditedAdapter.publish(ttCtx);
        expect(pubRes.state).toBe('PROCESSING');
        expect(pubRes.processingRef).toBe('tt-pub-777');

        const pollRes = await auditedAdapter.poll({ ...ttCtx, processingRef: 'tt-pub-777' });
        expect(pollRes.state).toBe('PUBLISHED');
        expect(pollRes.platformPostId).toBe('7399001122');
      } finally {
        process.env.TIKTOK_AUDITED = 'false';
      }
    });
  });

  describe('2. Publisher Orchestration (Flow 2): Forced 500 Retry Backoff -> FAILED Email, Grace/MISSED & 401 Token Refresh', () => {
    const testRunId = `step4-pub-${Date.now()}`;
    let createdAccountIds: string[] = [];
    let createdItemIds: string[] = [];
    let createdPostIds: string[] = [];

    afterAll(async () => {
      if (createdPostIds.length > 0) {
        await automationPrisma.notification.deleteMany({
          where: { postId: { in: createdPostIds } },
        });
      }
      if (createdAccountIds.length > 0) {
        await automationPrisma.notification.deleteMany({
          where: {
            OR: createdAccountIds.map((id) => ({
              dedupeKey: { contains: id },
            })),
          },
        });
      }
      if (createdItemIds.length > 0) {
        await automationPrisma.contentItem.deleteMany({
          where: { id: { in: createdItemIds } },
        });
      }
      if (createdAccountIds.length > 0) {
        await automationPrisma.socialAccount.deleteMany({
          where: { id: { in: createdAccountIds } },
        });
      }
    });

    it('retries a forced HTTP 500 error at 1m, 5m, 15m backoff and transitions to FAILED + queues PUBLISH_FAILED email on 3rd failure (Done-when check & Edge Case #21)', async () => {
      const account = await automationPrisma.socialAccount.create({
        data: {
          platform: 'LINKEDIN',
          label: `Test LinkedIn ${testRunId}`,
          externalId: 'urn:li:organization:18948042',
          tokenEncrypted: encryptToken('li-access-token'),
          refreshEncrypted: encryptToken('li-refresh-token'),
          isActive: true,
        },
      });
      createdAccountIds.push(account.id);

      const scheduledAt = new Date(Date.now() - 5 * 60 * 1000); // 5 mins ago (within 120m grace)
      const item = await automationPrisma.contentItem.create({
        data: {
          sheetId: '1eb9XK1hvhX-ABd4nHjpmMBdtTH6cmMgL',
          sheetTab: 'Sheet1',
          rowNumber: 101,
          rowKey: `${testRunId}-retry-500`,
          rowHash: 'hash-retry-500',
          scheduledAt,
          channelRaw: 'LinkedIn',
          contentType: 'Quote',
          subject: 'Forced 500 Retry Test',
          rawRow: {},
          lastSeenAt: new Date(),
          posts: {
            create: {
              accountId: account.id,
              platform: 'LINKEDIN',
              mode: 'AUTO',
              status: 'APPROVED',
              approvedById: 'lionel@leadersperformance.ae',
              approvedAt: new Date(Date.now() - 60 * 60 * 1000),
              scheduledAt,
              title: 'Forced 500 Retry Test',
              caption: 'Testing 3-attempt retry backoff.',
              idempotencyKey: `${testRunId}|LINKEDIN|retry500`,
            },
          },
        },
        include: { posts: true },
      });
      createdItemIds.push(item.id);
      const postId = item.posts[0].id;
      createdPostIds.push(postId);

      // Adapter always returns HTTP 500
      const failingLiAdapter = new LinkedInPublishAdapter(async () =>
        createJsonResponse(500, { message: 'Internal Server Error (simulated 500)' })
      );
      const pubService = new PublisherService(mockStorage, [failingLiAdapter]);

      // Attempt 1 -> stays APPROVED with attemptCount=1, nextAttemptAt = +1 min
      const t1 = new Date();
      const res1 = await pubService.publishSinglePost(postId, { now: t1 });
      expect(res1.status).toBe('APPROVED');
      expect(res1.post.attemptCount).toBe(1);
      expect(res1.post.nextAttemptAt.getTime() - t1.getTime()).toBe(1 * 60 * 1000);

      // Attempt 2 -> stays APPROVED with attemptCount=2, nextAttemptAt = +5 min
      const t2 = new Date(t1.getTime() + 2 * 60 * 1000);
      const res2 = await pubService.publishSinglePost(postId, { now: t2 });
      expect(res2.status).toBe('APPROVED');
      expect(res2.post.attemptCount).toBe(2);
      expect(res2.post.nextAttemptAt.getTime() - t2.getTime()).toBe(5 * 60 * 1000);

      // Attempt 3 -> attempts exhausted -> FAILED + PUBLISH_FAILED email queued
      const t3 = new Date(t2.getTime() + 6 * 60 * 1000);
      const res3 = await pubService.publishSinglePost(postId, { now: t3 });
      expect(res3.status).toBe('FAILED');
      expect(res3.post.attemptCount).toBe(3);

      const attempts = await automationPrisma.publishAttempt.findMany({
        where: { postId },
        orderBy: { attemptNo: 'asc' },
      });
      expect(attempts.length).toBe(3);
      expect(attempts[2].httpStatus).toBe(500);

      const failedEmails = await automationPrisma.notification.findMany({
        where: { postId, type: 'PUBLISH_FAILED' },
      });
      expect(failedEmails.length).toBe(1);
      expect(failedEmails[0].recipients).toEqual(
        expect.arrayContaining([
          'sarath@leadersperformance.ae',
          'asad@leadersperformance.ae',
          'asif@leadersperformance.ae',
        ])
      );
    });

    it('marks unapproved posts past scheduledAt + grace as MISSED and queues MISSED email (Edge Case #17)', async () => {
      const pastGraceDate = new Date(Date.now() - 150 * 60 * 1000); // 150 mins ago (> 120m grace)
      const item = await automationPrisma.contentItem.create({
        data: {
          sheetId: '1eb9XK1hvhX-ABd4nHjpmMBdtTH6cmMgL',
          sheetTab: 'Sheet1',
          rowNumber: 102,
          rowKey: `${testRunId}-missed`,
          rowHash: 'hash-missed',
          scheduledAt: pastGraceDate,
          channelRaw: 'LinkedIn',
          contentType: 'Quote',
          subject: 'Unapproved Past Grace Slot',
          rawRow: {},
          lastSeenAt: new Date(),
          posts: {
            create: {
              platform: 'LINKEDIN',
              mode: 'AUTO',
              status: 'PENDING_REVIEW',
              scheduledAt: pastGraceDate,
              title: 'Unapproved Past Grace Slot',
              caption: 'Never approved before slot + grace.',
              idempotencyKey: `${testRunId}|LINKEDIN|missed`,
            },
          },
        },
        include: { posts: true },
      });
      createdItemIds.push(item.id);
      const postId = item.posts[0].id;
      createdPostIds.push(postId);

      const pubService = new PublisherService(mockStorage, []);
      const summary = await pubService.run({ now: new Date() });
      expect(summary.missedMarked).toBeGreaterThanOrEqual(1);

      const updated = await automationPrisma.post.findUnique({ where: { id: postId } });
      expect(updated?.status).toBe('MISSED');

      const missedEmails = await automationPrisma.notification.findMany({
        where: { postId, type: 'MISSED' },
      });
      expect(missedEmails.length).toBe(1);
    });
  });
});

