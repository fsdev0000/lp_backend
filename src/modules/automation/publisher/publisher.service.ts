import {
  automationPrisma,
  transition,
} from '../state/transition';
import {
  IStorageService,
  storageService as defaultStorageService,
} from '../storage/storage.service';
import { notificationService } from '../notifications/notification.service';
import { decryptToken, encryptToken } from '../crypto/tokenCrypto';
import {
  IPublishAdapter,
  PublishablePostContext,
  RetryableError,
  FatalError,
  TokenExpiredError,
} from './adapters/base.adapter';
import { YouTubePublishAdapter } from './adapters/youtube.adapter';
import { LinkedInPublishAdapter } from './adapters/linkedin.adapter';
import { InstagramPublishAdapter } from './adapters/instagram.adapter';
import { TikTokPublishAdapter } from './adapters/tiktok.adapter';
import { crmHealthService, PublishingFlags } from '../monitoring/crmHealth.service';

export interface PublisherRunSummary {
  staleLocksReleased: number;
  missedMarked: number;
  published: string[];
  processing: string[];
  retried: string[];
  failed: string[];
  polledPublished: string[];
  polledStillProcessing: string[];
  polledFailed: string[];
  manualRemindersQueued: number;
  slaRemindersQueued: number;
}

export class PublisherService {
  private readonly adapters: Map<string, IPublishAdapter> = new Map();

  constructor(
    private readonly storage: IStorageService = defaultStorageService,
    customAdapters?: IPublishAdapter[]
  ) {
    const list = customAdapters || [
      new YouTubePublishAdapter(),
      new LinkedInPublishAdapter(),
      new InstagramPublishAdapter(),
      new TikTokPublishAdapter(),
    ];
    for (const adapter of list) {
      this.adapters.set(adapter.platform.toUpperCase(), adapter);
    }
  }

  public registerAdapter(adapter: IPublishAdapter): void {
    this.adapters.set(adapter.platform.toUpperCase(), adapter);
  }

  public getAdapter(platform: string): IPublishAdapter | undefined {
    return this.adapters.get(platform.toUpperCase());
  }

  private resolveAccessToken(encrypted?: string | null): string {
    if (!encrypted) return '';
    if (encrypted.startsWith('v1:')) {
      return decryptToken(encrypted);
    }
    return encrypted;
  }

  private async buildPostContext(post: any): Promise<PublishablePostContext> {
    if (!post.account) {
      throw new FatalError(`Post has no linked SocialAccount for platform ${post.platform}`, {
        httpStatus: 400,
        errorCode: 'MISSING_SOCIAL_ACCOUNT',
      });
    }

    if (!post.account.isActive) {
      throw new FatalError(
        `SocialAccount "${post.account.label}" is inactive; please reconnect account`,
        {
          httpStatus: 401,
          errorCode: 'ACCOUNT_INACTIVE',
        }
      );
    }

    const accessToken = this.resolveAccessToken(post.account.tokenEncrypted);
    const refreshToken = post.account.refreshEncrypted
      ? this.resolveAccessToken(post.account.refreshEncrypted)
      : null;

    if (!accessToken) {
      throw new FatalError(
        `SocialAccount "${post.account.label}" has no access token; please reconnect account`,
        {
          httpStatus: 401,
          errorCode: 'MISSING_ACCESS_TOKEN',
        }
      );
    }

    const currentMedia = (post.media || [])
      .filter((m: any) => m.revision === post.revision)
      .sort((a: any, b: any) => a.position - b.position)
      .map((m: any) => ({
        assetId: m.assetId,
        role: m.role,
        position: m.position,
        fileName: m.asset.fileName,
        mimeType: m.asset.mimeType,
        sizeBytes: Number(m.asset.sizeBytes || 0),
        bucket: m.asset.bucket,
        objectKey: m.asset.objectKey || '',
        durationSec: m.asset.durationSec,
        width: m.asset.width,
        height: m.asset.height,
      }));

    return {
      id: post.id,
      platform: post.platform,
      scheduledAt: post.scheduledAt,
      title: post.title,
      caption: post.caption,
      hashtags: post.hashtags || [],
      options:
        typeof post.options === 'object' && post.options !== null
          ? (post.options as Record<string, any>)
          : {},
      processingRef: post.processingRef,
      platformPostId: post.platformPostId,
      account: {
        id: post.account.id,
        platform: post.account.platform,
        label: post.account.label,
        externalId: post.account.externalId,
        accessToken,
        refreshToken,
      },
      media: currentMedia,
      storage: this.storage,
    };
  }

  /**
   * Edge Case #22: On 401 TokenExpiredError, refresh once and retry.
   * If refresh fails: mark account `isActive=false`, fail all its due APPROVED posts with "reconnect account", and email Asif.
   */
  private async handle401AndRefreshOnce(
    post: any,
    adapter: IPublishAdapter,
    operation: (ctx: PublishablePostContext) => Promise<any>,
    now: Date
  ): Promise<any> {
    const account = post.account;
    const refreshTokenPlain = account?.refreshEncrypted
      ? this.resolveAccessToken(account.refreshEncrypted)
      : '';

    if (!account || !refreshTokenPlain) {
      await this.deactivateAccountAndFailDuePosts(
        account,
        'Access token expired (401) and no refresh token is available — reconnect account',
        now
      );
      throw new FatalError('Access token expired and no refresh token is available — reconnect account', {
        httpStatus: 401,
        errorCode: 'TOKEN_REFRESH_UNAVAILABLE',
      });
    }

    try {
      const refreshed = await adapter.refreshToken({
        id: account.id,
        platform: account.platform,
        externalId: account.externalId,
        refreshToken: refreshTokenPlain,
      });

      const encryptedAccess = encryptToken(refreshed.accessToken);
      const encryptedRefresh = refreshed.refreshToken
        ? encryptToken(refreshed.refreshToken)
        : account.refreshEncrypted;

      await automationPrisma.socialAccount.update({
        where: { id: account.id },
        data: {
          tokenEncrypted: encryptedAccess,
          refreshEncrypted: encryptedRefresh,
          tokenExpiresAt: refreshed.expiresAt ?? account.tokenExpiresAt,
          isActive: true,
        },
      });

      const updatedPost = await automationPrisma.post.findUnique({
        where: { id: post.id },
        include: {
          account: true,
          media: { include: { asset: true } },
        },
      });

      const freshCtx = await this.buildPostContext(updatedPost);
      return await operation(freshCtx);
    } catch (refreshErr: any) {
      await this.deactivateAccountAndFailDuePosts(
        account,
        `Token refresh failed (${refreshErr?.message || '401'}) — reconnect account`,
        now
      );
      throw new FatalError(
        `Token refresh failed (${refreshErr?.message || '401'}) — reconnect account`,
        {
          httpStatus: 401,
          errorCode: 'ACCOUNT_RECONNECT_REQUIRED',
        }
      );
    }
  }

  private async deactivateAccountAndFailDuePosts(
    account: any,
    reason: string,
    now: Date
  ): Promise<void> {
    if (!account?.id) return;

    await automationPrisma.socialAccount.update({
      where: { id: account.id },
      data: { isActive: false },
    });

    await notificationService.queueAccountAlert({
      type: 'ACCOUNT_DISCONNECTED',
      account: {
        id: account.id,
        platform: account.platform,
        label: account.label,
      },
      reason,
      dedupeSuffix: now.toISOString().slice(0, 10),
    });

    // Fail any other due APPROVED posts on this account with "reconnect account"
    const otherDuePosts = await automationPrisma.post.findMany({
      where: {
        accountId: account.id,
        status: 'APPROVED',
        mode: 'AUTO',
        scheduledAt: { lte: now },
      },
    });

    for (const duePost of otherDuePosts) {
      try {
        await transition(duePost.id, 'LOCK_FOR_PUBLISH', {
          actorId: 'publisher-401-cascade',
          now,
        });
        const failed = await transition(duePost.id, 'FATAL_ERROR', {
          actorId: 'publisher-401-cascade',
          now,
          httpStatus: 401,
          errorCode: 'ACCOUNT_RECONNECT_REQUIRED',
          errorMessage: `Account "${account.label}" disconnected: reconnect account`,
        });
        await notificationService.queuePublishFailedOrMissed({
          type: 'PUBLISH_FAILED',
          post: failed,
          reason: `Account "${account.label}" disconnected: reconnect account`,
        });
      } catch (err: any) {
        console.warn(`[Publisher] postId=${duePost.id} 401 cascade fail warning: ${err?.message}`);
      }
    }
  }

  /**
   * Executes a single post publish (used both by Flow 2 `run()` and CRM `POST /posts/:id/publish-now`).
   */
  public async publishSinglePost(
    postId: string,
    options: { now?: Date; forceImmediate?: boolean; actorId?: string; dryRun?: boolean } = {}
  ): Promise<{ status: string; post: any }> {
    const now = options.now || new Date();
    const actorId = options.actorId || 'flow2-publisher';
    const post = await automationPrisma.post.findUnique({
      where: { id: postId },
      include: {
        account: true,
        media: { include: { asset: true } },
      },
    });

    if (!post) {
      throw new Error(`Post ${postId} not found`);
    }

    // Check per-platform feature flags and global dry-run toggle (Task 14)
    const flags = await crmHealthService.getPublishingFlags();
    const platKey = (post.platform?.toLowerCase() || '') as keyof PublishingFlags;
    const isPlatformFlagEnabled = typeof flags[platKey] === 'boolean' ? flags[platKey] : true;
    // A caller can ask for a dry run, never skip one: while the global switch, this platform's flag or the env says
    // dry-run, nothing is posted, whatever `options.dryRun` says (no live posts for now, 13 Nov 2026).
    const isDryRun =
      options.dryRun === true ||
      flags.dryRunGlobal ||
      !isPlatformFlagEnabled ||
      process.env.PUBLISHER_DRY_RUN === 'true' ||
      process.env.PUBLISHER_DRY_RUN === '1' ||
      process.env.ENABLE_LIVE_PUBLISHING === 'false';

    // Hard rule: Never publish a post that is not APPROVED
    if (post.status !== 'APPROVED') {
      throw new FatalError(
        `[postId=${post.id}] Cannot publish post in status "${post.status}"; only APPROVED posts may be published`,
        {
          httpStatus: 400,
          errorCode: 'NOT_APPROVED',
        }
      );
    }

    // Idempotency guard (Plan Section 7): if platformPostId is already set, do not re-post
    if (post.platformPostId) {
      console.log(`[Publisher] postId=${post.id} already has platformPostId=${post.platformPostId}; skipping duplicate publish`);
      return { status: post.status, post };
    }

    // Lock post: APPROVED -> PUBLISHING
    const allowEarly =
      Boolean(options.forceImmediate) || post.platform === 'YOUTUBE';
    await transition(post.id, 'LOCK_FOR_PUBLISH', {
      actorId,
      lockedBy: actorId,
      now,
      allowEarlyScheduledUpload: allowEarly,
    });

    // If dryRun is active, dump state to database without calling external social APIs
    if (isDryRun) {
      console.log(
        `[Publisher] DRY RUN: Post ${post.id} (${post.platform}) approved — dumped to DB without external publish.`
      );
      const pubPost = await transition(post.id, 'PUBLISH_SUCCESS', {
        actorId,
        now,
        platformPostId: `staged_db_${post.id.slice(0, 8)}`,
        platformUrl: `https://social.leadersperformance.ae/approvals?post=${post.id}`,
        httpStatus: 200,
        rawResponse: {
          dryRun: true,
          dumpedToDbAt: now.toISOString(),
          note: 'Live publishing disabled: dumped to PostgreSQL DB',
        },
      });

      await notificationService.queuePublished({
        id: pubPost.id,
        platform: pubPost.platform,
        scheduledAt: pubPost.scheduledAt,
        title: pubPost.title,
        caption: pubPost.caption,
        revision: pubPost.revision,
        platformUrl: pubPost.platformUrl,
      });

      return { status: 'PUBLISHED', post: pubPost };
    }

    const adapter = this.getAdapter(post.platform);
    if (!adapter) {
      const failed = await transition(post.id, 'FATAL_ERROR', {
        actorId,
        now,
        httpStatus: 400,
        errorCode: 'NO_ADAPTER_FOR_PLATFORM',
        errorMessage: `No publish adapter registered for platform ${post.platform}`,
      });
      await notificationService.queuePublishFailedOrMissed({
        type: 'PUBLISH_FAILED',
        post: failed,
        reason: failed.lastError || 'No publish adapter registered',
      });
      return { status: 'FAILED', post: failed };
    }

    try {
      const ctx = await this.buildPostContext(post);
      let result;
      try {
        result = await adapter.publish(ctx);
      } catch (err: any) {
        if (err instanceof TokenExpiredError) {
          result = await this.handle401AndRefreshOnce(
            post,
            adapter,
            (freshCtx) => adapter.publish(freshCtx),
            now
          );
        } else {
          throw err;
        }
      }

      if (result.state === 'PROCESSING') {
        const currentOpts =
          typeof post.options === 'object' && post.options !== null
            ? (post.options as Record<string, any>)
            : {};
        if (post.platform === 'INSTAGRAM' && !currentOpts.igContainerCreatedAt) {
          await automationPrisma.post.update({
            where: { id: post.id },
            data: {
              options: {
                ...currentOpts,
                igContainerCreatedAt: now.toISOString(),
              },
            },
          });
        }

        const procPost = await transition(post.id, 'ASYNC_ACCEPTED', {
          actorId,
          now,
          processingRef: result.processingRef,
          httpStatus: result.httpStatus ?? 202,
          rawResponse: result.rawResponse,
        });
        return { status: 'PROCESSING', post: procPost };
      }

      const pubPost = await transition(post.id, 'PUBLISH_SUCCESS', {
        actorId,
        now,
        platformPostId: result.platformPostId,
        platformUrl: result.url,
        httpStatus: result.httpStatus ?? 200,
        rawResponse: result.rawResponse,
      });

      await notificationService.queuePublished({
        id: pubPost.id,
        platform: pubPost.platform,
        scheduledAt: pubPost.scheduledAt,
        title: pubPost.title,
        caption: pubPost.caption,
        revision: pubPost.revision,
        platformUrl: pubPost.platformUrl,
      });

      return { status: 'PUBLISHED', post: pubPost };
    } catch (err: any) {
      return await this.handlePublishOrPollFailure(post, err, actorId, now);
    }
  }

  private async handlePublishOrPollFailure(
    post: any,
    err: any,
    actorId: string,
    now: Date
  ): Promise<{ status: string; post: any }> {
    const graceMinutes = Number(process.env.PUBLISH_GRACE_MINUTES) || 120;
    const graceMs = graceMinutes * 60 * 1000;

    if (err instanceof RetryableError) {
      // Edge Case #26: YouTube quota exceeded -> alert Asif
      if (err.errorCode === 'YOUTUBE_QUOTA_EXCEEDED' && post.account) {
        await notificationService.queueAccountAlert({
          type: 'TOKEN_EXPIRING',
          account: {
            id: post.account.id,
            platform: post.account.platform,
            label: post.account.label,
          },
          reason: `YouTube daily quota exceeded while publishing post ${post.id}. Retrying in next day window.`,
          dedupeSuffix: `quota-${now.toISOString().slice(0, 10)}`,
        });
      }

      const updated = await transition(post.id, 'RETRYABLE_ERROR', {
        actorId,
        now,
        httpStatus: err.httpStatus,
        errorCode: err.errorCode,
        errorMessage: err.message,
        rawResponse: err.rawResponse,
      });

      // Custom delay override (e.g. +60m for Instagram daily cap, Edge Case #23, or +24h for YouTube quota, Edge Case #26)
      if (updated.status === 'APPROVED' && err.customDelayMinutes) {
        const customNextAttempt = new Date(
          now.getTime() + err.customDelayMinutes * 60 * 1000
        );
        await automationPrisma.post.update({
          where: { id: post.id },
          data: { nextAttemptAt: customNextAttempt },
        });
        updated.nextAttemptAt = customNextAttempt;

        // Edge Case #23: If +60m pushes past scheduledAt + grace, email warning
        if (
          err.errorCode === 'INSTAGRAM_DAILY_CAP_REACHED' &&
          customNextAttempt.getTime() > post.scheduledAt.getTime() + graceMs
        ) {
          await notificationService.queuePublishFailedOrMissed({
            type: 'MISSED',
            post: updated,
            reason: `Instagram daily cap reached; next attempt (${customNextAttempt.toISOString()}) exceeds publish grace window`,
          });
        }
      }

      if (updated.status === 'FAILED') {
        await notificationService.queuePublishFailedOrMissed({
          type: 'PUBLISH_FAILED',
          post: updated,
          reason: err.message,
        });
      }

      return { status: updated.status, post: updated };
    }

    // FatalError or unexpected error -> FAILED immediately
    const httpStatus = err instanceof FatalError ? err.httpStatus : 500;
    const errorCode = err instanceof FatalError ? err.errorCode : 'UNEXPECTED_PUBLISH_ERROR';
    const errorMessage = err?.message || 'Unexpected publish error';

    const failed = await transition(post.id, 'FATAL_ERROR', {
      actorId,
      now,
      httpStatus,
      errorCode,
      errorMessage,
      rawResponse: err instanceof FatalError ? err.rawResponse : undefined,
    });

    await notificationService.queuePublishFailedOrMissed({
      type: 'PUBLISH_FAILED',
      post: failed,
      reason: errorMessage,
    });

    return { status: 'FAILED', post: failed };
  }

  /**
   * Polls a single PROCESSING post (`poll(post)`).
   */
  public async pollProcessingPost(
    postId: string,
    now: Date = new Date()
  ): Promise<{ status: string; post: any }> {
    const post = await automationPrisma.post.findUnique({
      where: { id: postId },
      include: {
        account: true,
        media: { include: { asset: true } },
      },
    });

    if (!post || post.status !== 'PROCESSING') {
      return { status: post?.status || 'UNKNOWN', post };
    }

    const adapter = this.getAdapter(post.platform);
    if (!adapter) {
      return { status: post.status, post };
    }

    try {
      const ctx = await this.buildPostContext(post);
      let pollRes;
      try {
        pollRes = await adapter.poll(ctx);
      } catch (err: any) {
        if (err instanceof TokenExpiredError) {
          pollRes = await this.handle401AndRefreshOnce(
            post,
            adapter,
            (freshCtx) => adapter.poll(freshCtx),
            now
          );
        } else {
          throw err;
        }
      }

      if (pollRes.state === 'PROCESSING') {
        // If IG container was recreated on EXPIRED (Edge Case #24), persist new processingRef and igContainerRecreated flag
        if (
          pollRes.processingRef &&
          (pollRes.processingRef !== post.processingRef ||
            pollRes.rawResponse?.igContainerRecreated)
        ) {
          const currentOpts =
            typeof post.options === 'object' && post.options !== null
              ? (post.options as Record<string, any>)
              : {};
          const updated = await automationPrisma.post.update({
            where: { id: post.id },
            data: {
              processingRef: pollRes.processingRef,
              options: {
                ...currentOpts,
                ...(pollRes.rawResponse?.igContainerRecreated
                  ? { igContainerRecreated: true, igContainerCreatedAt: now.toISOString() }
                  : {}),
              },
            },
          });
          return { status: 'PROCESSING', post: updated };
        }
        return { status: 'PROCESSING', post };
      }

      const pubPost = await transition(post.id, 'PUBLISH_SUCCESS', {
        actorId: 'flow2-poller',
        now,
        platformPostId: pollRes.platformPostId,
        platformUrl: pollRes.url,
        httpStatus: pollRes.httpStatus ?? 200,
        rawResponse: pollRes.rawResponse,
      });

      await notificationService.queuePublished({
        id: pubPost.id,
        platform: pubPost.platform,
        scheduledAt: pubPost.scheduledAt,
        title: pubPost.title,
        caption: pubPost.caption,
        revision: pubPost.revision,
        platformUrl: pubPost.platformUrl,
      });

      return { status: 'PUBLISHED', post: pubPost };
    } catch (err: any) {
      return await this.handlePublishOrPollFailure(post, err, 'flow2-poller', now);
    }
  }

  /**
   * Flow 2 (`POST /internal/publisher/run`):
   * 1. Release stale locks older than 15 minutes (Edge Case #19)
   * 2. Mark unapproved or overdue posts past `scheduledAt + PUBLISH_GRACE_MINUTES` as MISSED (Edge Case #17)
   * 3. Select due APPROVED AUTO posts (plus early-upload APPROVED YouTube posts) with `FOR UPDATE SKIP LOCKED LIMIT 10`
   * 4. Poll PROCESSING posts
   * 5. Queue MANUAL_TASK_DUE reminders (at scheduledAt and +24h reminder, Edge Case #30)
   * 6. Queue APPROVAL_SLA reminders (<24h and <6h before slot)
   */
  public async run(options: { now?: Date; dryRun?: boolean } = {}): Promise<PublisherRunSummary> {
    const now = options.now || new Date();
    const flags = await crmHealthService.getPublishingFlags();
    // `options.dryRun` (e.g. a request body on /internal/publisher/run) can only turn dry-run on, not off.
    const isDryRun =
      options.dryRun === true ||
      flags.dryRunGlobal ||
      process.env.PUBLISHER_DRY_RUN === 'true' ||
      process.env.PUBLISHER_DRY_RUN === '1' ||
      process.env.ENABLE_LIVE_PUBLISHING === 'false';
    const graceMinutes = Number(process.env.PUBLISH_GRACE_MINUTES) || 120;
    const graceCutoff = new Date(now.getTime() - graceMinutes * 60 * 1000);
    const staleLockCutoff = new Date(now.getTime() - 15 * 60 * 1000);

    const summary: PublisherRunSummary = {
      staleLocksReleased: 0,
      missedMarked: 0,
      published: [],
      processing: [],
      retried: [],
      failed: [],
      polledPublished: [],
      polledStillProcessing: [],
      polledFailed: [],
      manualRemindersQueued: 0,
      slaRemindersQueued: 0,
    };

    // Step 1: Release stale locks older than 15 minutes (Edge Case #19)
    const staleReleased = await automationPrisma.post.updateMany({
      where: {
        status: 'PUBLISHING',
        lockedAt: { lt: staleLockCutoff },
      },
      data: {
        status: 'APPROVED',
        lockedAt: null,
        lockedBy: null,
      },
    });
    summary.staleLocksReleased = staleReleased.count;

    // Step 2: Mark posts past scheduledAt + grace as MISSED (Edge Case #17)
    const overduePosts = await automationPrisma.post.findMany({
      where: {
        status: { in: ['PENDING_REVIEW', 'APPROVED'] },
        mode: 'AUTO',
        scheduledAt: { lt: graceCutoff },
        platformPostId: null,
      },
    });

    for (const overdue of overduePosts) {
      try {
        const missed = await transition(overdue.id, 'MARK_MISSED', {
          actorId: 'flow2-publisher',
          now,
          graceMinutes,
        });
        await notificationService.queuePublishFailedOrMissed({
          type: 'MISSED',
          post: missed,
          reason: `Not published within ${graceMinutes} minutes of scheduled slot (${overdue.scheduledAt.toISOString()})`,
        });
        summary.missedMarked += 1;
      } catch (err: any) {
        console.warn(`[Publisher] postId=${overdue.id} MARK_MISSED warning: ${err?.message}`);
      }
    }

    // Step 3: Select due APPROVED AUTO posts using FOR UPDATE SKIP LOCKED LIMIT 10 (Edge Case #19)
    // Includes YouTube posts as soon as they are APPROVED (Plan Section 6 Flow 2 Step 2 YouTube exception)
    const dueRows = await automationPrisma.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM crm_posts
      WHERE status = 'APPROVED'::"PostStatus"
        AND mode = 'AUTO'::"PublishMode"
        AND platform_post_id IS NULL
        AND (
          (scheduled_at <= ${now} AND scheduled_at >= ${graceCutoff})
          OR (platform = 'YOUTUBE'::"Platform" AND scheduled_at > ${now})
        )
        AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
      ORDER BY scheduled_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 10
    `;

    for (const row of dueRows) {
      const outcome = await this.publishSinglePost(row.id, { now, dryRun: isDryRun });
      if (outcome.status === 'PUBLISHED') summary.published.push(row.id);
      else if (outcome.status === 'PROCESSING') summary.processing.push(row.id);
      else if (outcome.status === 'APPROVED') summary.retried.push(row.id);
      else if (outcome.status === 'FAILED') summary.failed.push(row.id);
    }

    // Step 4: Poll PROCESSING posts
    const processingPosts = await automationPrisma.post.findMany({
      where: { status: 'PROCESSING' },
      orderBy: { updatedAt: 'asc' },
      take: 20,
    });

    for (const proc of processingPosts) {
      // Skip polling a post that was just moved to PROCESSING in this same cycle
      if (summary.processing.includes(proc.id)) continue;

      const pollOutcome = await this.pollProcessingPost(proc.id, now);
      if (pollOutcome.status === 'PUBLISHED') summary.polledPublished.push(proc.id);
      else if (pollOutcome.status === 'PROCESSING') summary.polledStillProcessing.push(proc.id);
      else if (pollOutcome.status === 'FAILED') summary.polledFailed.push(proc.id);
    }

    // Step 5: Manual channels (Medium, LinkedIn Newsletter, INSPO) reminders at scheduledAt and +24h (Edge Case #30)
    const dueManualPosts = await automationPrisma.post.findMany({
      where: {
        status: 'APPROVED',
        mode: 'MANUAL',
        scheduledAt: { lte: now },
      },
    });

    for (const mp of dueManualPosts) {
      const elapsedHours = (now.getTime() - mp.scheduledAt.getTime()) / (1000 * 60 * 60);
      const initialRes = await notificationService.queueManualTaskDue({
        post: mp,
        windowLabel: 'INITIAL',
      });
      if (initialRes.created) summary.manualRemindersQueued += 1;

      if (elapsedHours >= 24) {
        const rem24Res = await notificationService.queueManualTaskDue({
          post: mp,
          windowLabel: 'REMINDER_24H',
        });
        if (rem24Res.created) summary.manualRemindersQueued += 1;
      }
    }

    // Step 6: Approval SLA reminders (<24h and <6h before slot, max 2 per post)
    const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const pendingSoonPosts = await automationPrisma.post.findMany({
      where: {
        status: 'PENDING_REVIEW',
        scheduledAt: { gt: now, lte: in24h },
      },
    });

    for (const pp of pendingSoonPosts) {
      const hoursLeft = (pp.scheduledAt.getTime() - now.getTime()) / (1000 * 60 * 60);
      const windowLabel: '24H' | '6H' = hoursLeft <= 6 ? '6H' : '24H';
      const slaRes = await notificationService.queueApprovalSlaReminder({
        post: pp,
        windowLabel,
      });
      if (slaRes.created) summary.slaRemindersQueued += 1;
    }

    console.log(
      `[Publisher] postId=batch summary published=${summary.published.length} processing=${summary.processing.length} retried=${summary.retried.length} failed=${summary.failed.length} missed=${summary.missedMarked}`
    );

    return summary;
  }
}

export const publisherService = new PublisherService();

