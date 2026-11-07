import { randomUUID, createHash } from 'crypto';
import { Platform, PostStatus } from '@prisma/client';
import {
  automationPrisma,
  transition,
  InvalidTransitionError,
} from '../state/transition';
import {
  IStorageService,
  storageService as defaultStorageService,
  buildStorageObjectKey,
  normalizeFileNameNfc,
} from '../storage/storage.service';
import {
  notificationService,
  formatDualTimezone,
} from '../notifications/notification.service';
import {
  probeMediaBuffer,
  validateMediaForPlatform,
} from '../ingest/fileParsers';
import { PLATFORM_LIMITS } from './geminiDraft.service';
import { AuthenticatedCrmUser } from '../../../middleware/crmRoleAuth';

export interface ListPostsQuery {
  status?: string;
  platform?: string;
  from?: string;
  to?: string;
  search?: string;
  page?: number;
  limit?: number;
}

/**
 * Computes a concise human-readable diff between two revisions for the Post detail screen and REVISION_READY email.
 */
export function computeRevisionDiffSummary(
  prev: { title?: string | null; caption?: string | null; mediaSnapshot?: any } | null,
  curr: { title?: string | null; caption?: string | null; mediaSnapshot?: any }
): string {
  if (!prev) return 'Initial draft staged';
  const changes: string[] = [];

  if ((prev.title || '') !== (curr.title || '')) {
    changes.push(`Title changed ("${prev.title || 'none'}" -> "${curr.title || 'none'}")`);
  }

  if ((prev.caption || '') !== (curr.caption || '')) {
    const prevLen = (prev.caption || '').length;
    const currLen = (curr.caption || '').length;
    changes.push(`Caption updated (${prevLen} -> ${currLen} chars)`);
  }

  const prevMediaSig = JSON.stringify(prev.mediaSnapshot || []);
  const currMediaSig = JSON.stringify(curr.mediaSnapshot || []);
  if (prevMediaSig !== currMediaSig) {
    changes.push('Media assets updated');
  }

  return changes.length > 0 ? changes.join('; ') : 'Resubmitted without text changes';
}

export class CrmPostsService {
  constructor(private readonly storage: IStorageService = defaultStorageService) {}

  private async enrichMediaWithSignedUrls(
    mediaRows: Array<{
      postId: string;
      assetId: string;
      position: number;
      role: string;
      revision: number;
      asset: any;
    }>
  ) {
    const out = [];
    for (const m of mediaRows) {
      let signedUrl: string | null = null;
      if (m.asset.objectKey && process.env.NODE_ENV !== 'test') {
        try {
          signedUrl = await this.storage.signedUrl(
            m.asset.objectKey,
            3600,
            m.asset.bucket
          );
        } catch {
          signedUrl = null;
        }
      }
      out.push({
        postId: m.postId,
        assetId: m.assetId,
        position: m.position,
        role: m.role,
        revision: m.revision,
        asset: {
          ...m.asset,
          sizeBytes: Number(m.asset.sizeBytes || 0),
          signedUrl,
        },
      });
    }
    return out;
  }

  /**
   * GET /posts — Paginated list with filters (status, platform, date range, search).
   */
  public async listPosts(query: ListPostsQuery) {
    const page = Math.max(Number(query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(query.limit) || 25, 1), 100);
    const skip = (page - 1) * limit;

    const where: Record<string, any> = {};

    if (query.status) {
      const statuses = query.status
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean) as PostStatus[];
      if (statuses.length === 1) {
        where.status = statuses[0];
      } else if (statuses.length > 1) {
        where.status = { in: statuses };
      }
    }

    if (query.platform) {
      const platforms = query.platform
        .split(',')
        .map((p) => p.trim().toUpperCase())
        .filter(Boolean) as Platform[];
      if (platforms.length === 1) {
        where.platform = platforms[0];
      } else if (platforms.length > 1) {
        where.platform = { in: platforms };
      }
    }

    if (query.from || query.to) {
      where.scheduledAt = {};
      if (query.from) where.scheduledAt.gte = new Date(query.from);
      if (query.to) where.scheduledAt.lte = new Date(query.to);
    }

    if (query.search && query.search.trim()) {
      const q = query.search.trim();
      where.OR = [
        { title: { contains: q, mode: 'insensitive' } },
        { caption: { contains: q, mode: 'insensitive' } },
        { blockedReason: { contains: q, mode: 'insensitive' } },
      ];
    }

    const items = await automationPrisma.post.findMany({
      where,
      orderBy: { scheduledAt: 'asc' },
      take: limit,
      skip,
      include: {
        contentItem: true,
        account: {
          select: {
            id: true,
            platform: true,
            label: true,
            externalId: true,
            isActive: true,
          },
        },
        media: {
          include: { asset: true },
          orderBy: { position: 'asc' },
        },
      },
    });

    const total = await automationPrisma.post.count({ where });
    const nowMs = Date.now();

    const enriched = [];
    for (const p of items) {
      const tz = formatDualTimezone(p.scheduledAt);
      const currentMedia = p.media.filter((m) => m.revision === p.revision);
      const mediaWithUrls = await this.enrichMediaWithSignedUrls(currentMedia);
      const timeLeftMinutes = Math.round((p.scheduledAt.getTime() - nowMs) / 60000);

      enriched.push({
        ...p,
        scheduledAtAmsterdam: tz.amsterdam,
        scheduledAtDubai: tz.dubai,
        timeLeftMinutes,
        isUrgent: timeLeftMinutes > 0 && timeLeftMinutes <= 7 * 24 * 60,
        media: mediaWithUrls,
      });
    }

    return {
      items: enriched,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  /**
   * GET /posts/:id — Full post detail with revision history + diff, comment thread, dual timezones, and signed media URLs.
   */
  public async getPostDetail(postId: string) {
    const post = await automationPrisma.post.findUnique({
      where: { id: postId },
      include: {
        contentItem: true,
        account: {
          select: {
            id: true,
            platform: true,
            label: true,
            externalId: true,
            isActive: true,
          },
        },
        media: {
          include: { asset: true },
          orderBy: [{ revision: 'desc' }, { position: 'asc' }],
        },
        revisions: {
          orderBy: { revision: 'asc' },
        },
        reviewEvents: {
          orderBy: { createdAt: 'asc' },
        },
        attempts: {
          orderBy: { attemptNo: 'asc' },
        },
      },
    });

    if (!post) {
      throw new Error(`Post ${postId} not found`);
    }

    const tz = formatDualTimezone(post.scheduledAt);
    const mediaWithUrls = await this.enrichMediaWithSignedUrls(post.media);
    const limits = PLATFORM_LIMITS[post.platform] || PLATFORM_LIMITS.DEFAULT;

    const revisionsWithDiff = post.revisions.map((rev, idx) => {
      const prev = idx > 0 ? post.revisions[idx - 1] : null;
      return {
        ...rev,
        diffSummary: computeRevisionDiffSummary(prev, rev),
      };
    });

    return {
      ...post,
      scheduledAtAmsterdam: tz.amsterdam,
      scheduledAtDubai: tz.dubai,
      characterCount: (post.caption || '').length,
      maxCaptionLength: limits.maxCaptionLength,
      maxTitleLength: limits.maxTitleLength,
      maxHashtags: limits.maxHashtags,
      media: mediaWithUrls,
      revisions: revisionsWithDiff,
    };
  }

  /**
   * PATCH /posts/:id — Editor/Admin updates caption, title, hashtags, options, or scheduledAt.
   * Enforces:
   * - Editing an APPROVED post sends it back to PENDING_REVIEW (revision + 1, approval cleared)
   * - Setting a new scheduledAt on a MISSED post transitions via RESCHEDULE
   */
  public async updatePost(
    postId: string,
    updates: {
      title?: string | null;
      caption?: string | null;
      hashtags?: string[];
      options?: Record<string, any>;
      scheduledAt?: string | Date;
    },
    actor: AuthenticatedCrmUser
  ) {
    const existing = await automationPrisma.post.findUnique({
      where: { id: postId },
      include: {
        media: { include: { asset: true } },
      },
    });

    if (!existing) {
      throw new Error(`Post ${postId} not found`);
    }

    const nextTitle = updates.title !== undefined ? updates.title : existing.title;
    const nextCaption = updates.caption !== undefined ? updates.caption : existing.caption;
    const nextHashtags = updates.hashtags !== undefined ? updates.hashtags : existing.hashtags;
    const currentOpts =
      typeof existing.options === 'object' && existing.options !== null
        ? (existing.options as Record<string, any>)
        : {};
    const nextOptions =
      updates.options !== undefined ? { ...currentOpts, ...updates.options } : currentOpts;
    const nextScheduledAt = updates.scheduledAt
      ? new Date(updates.scheduledAt)
      : existing.scheduledAt;

    const contentChanged =
      (nextTitle || '') !== (existing.title || '') ||
      (nextCaption || '') !== (existing.caption || '') ||
      JSON.stringify(nextHashtags) !== JSON.stringify(existing.hashtags);

    const scheduleChanged = nextScheduledAt.getTime() !== existing.scheduledAt.getTime();

    await automationPrisma.post.update({
      where: { id: postId },
      data: {
        title: nextTitle,
        caption: nextCaption,
        hashtags: nextHashtags,
        options: nextOptions,
        scheduledAt: nextScheduledAt,
      },
    });

    let updatedPost = await automationPrisma.post.findUnique({ where: { id: postId } });

    // Edge Case #17: Rescheduling a MISSED post
    if (existing.status === 'MISSED' && scheduleChanged) {
      updatedPost = await transition(postId, 'RESCHEDULE', {
        actorId: actor.email,
        newScheduledAt: nextScheduledAt,
        contentChanged,
        comment: `Rescheduled by ${actor.email}`,
      });
    } else if (existing.status === 'APPROVED' && contentChanged) {
      // Plan Section 8 Rule 6 & Edge Case #18: Any edit to an APPROVED post sends it back to PENDING_REVIEW
      updatedPost = await transition(postId, 'EDIT_CONTENT', {
        actorId: actor.email,
        comment: `Edited after approval by ${actor.email}; re-approval required`,
      });

      // Carry PostMedia links forward to the new revision
      const prevRevMedia = existing.media.filter((m) => m.revision === existing.revision);
      for (const pm of prevRevMedia) {
        await automationPrisma.postMedia.upsert({
          where: {
            postId_assetId_role_revision: {
              postId,
              assetId: pm.assetId,
              role: pm.role,
              revision: updatedPost.revision,
            },
          },
          update: { position: pm.position },
          create: {
            postId,
            assetId: pm.assetId,
            role: pm.role,
            position: pm.position,
            revision: updatedPost.revision,
          },
        });
      }

      // Create PostRevision snapshot & queue REVISION_READY notification
      await automationPrisma.postRevision.create({
        data: {
          postId,
          revision: updatedPost.revision,
          title: nextTitle,
          caption: nextCaption,
          mediaSnapshot: prevRevMedia.map((m) => ({
            assetId: m.assetId,
            role: m.role,
            position: m.position,
            fileName: m.asset.fileName,
            objectKey: m.asset.objectKey,
          })),
          createdById: actor.email,
        },
      });

      const changeSummary = computeRevisionDiffSummary(
        { title: existing.title, caption: existing.caption },
        { title: nextTitle, caption: nextCaption }
      );

      await notificationService.queueRevisionReady({
        post: {
          id: updatedPost.id,
          platform: updatedPost.platform,
          scheduledAt: updatedPost.scheduledAt,
          title: updatedPost.title,
          caption: updatedPost.caption,
          revision: updatedPost.revision,
        },
        editorActor: actor.email,
        changeSummary,
      });
    }

    return this.getPostDetail(postId);
  }

  /**
   * POST /posts/:id/media — Editor uploads a replacement media file straight to StorageService.
   */
  public async replacePostMedia(
    postId: string,
    input: {
      fileName: string;
      mimeType: string;
      base64Data: string;
      role?: 'MAIN' | 'THUMBNAIL' | 'COVER';
      position?: number;
      skipStoragePut?: boolean;
    },
    actor: AuthenticatedCrmUser
  ) {
    const post = await automationPrisma.post.findUnique({
      where: { id: postId },
    });
    if (!post) {
      throw new Error(`Post ${postId} not found`);
    }

    const buffer = Buffer.from(input.base64Data || '', 'base64');
    const normalizedName = normalizeFileNameNfc(input.fileName || 'upload.bin');
    const role = input.role || 'MAIN';
    const position = input.position ?? 0;

    const probed = probeMediaBuffer(buffer, input.mimeType, normalizedName);
    if (role === 'MAIN') {
      const check = validateMediaForPlatform({
        platform: post.platform,
        mimeType: input.mimeType,
        fileName: normalizedName,
        sizeBytes: buffer.length,
        width: probed.width,
        height: probed.height,
        durationSec: probed.durationSec,
      });
      if (!check.valid) {
        throw new InvalidTransitionError(
          check.invalidReason || 'Uploaded file failed platform validation'
        );
      }
    }

    const assetUuid = randomUUID();
    const objectKey = buildStorageObjectKey(assetUuid, normalizedName);
    const checksumMd5 = createHash('md5').update(buffer).digest('hex');

    if (!input.skipStoragePut && process.env.NODE_ENV !== 'test') {
      await this.storage.put({
        bucket: this.storage.defaultBucket,
        objectKey,
        data: buffer,
        contentType: input.mimeType,
      });
    }

    const asset = await automationPrisma.mediaAsset.create({
      data: {
        id: assetUuid,
        driveFileId: `crm-upload-${assetUuid}`,
        checksumMd5,
        fileName: normalizedName,
        mimeType: input.mimeType,
        sizeBytes: BigInt(buffer.length),
        width: probed.width ?? null,
        height: probed.height ?? null,
        durationSec: probed.durationSec ?? null,
        storageProvider: this.storage.provider,
        bucket: this.storage.defaultBucket,
        objectKey,
        status: 'READY',
      },
    });

    let targetRevision = post.revision;

    // If post was APPROVED, replacing media sends it back to PENDING_REVIEW (revision + 1)
    if (post.status === 'APPROVED') {
      const transitioned = await transition(postId, 'EDIT_CONTENT', {
        actorId: actor.email,
        comment: `Replaced ${role} media (${normalizedName}) after approval`,
      });
      targetRevision = transitioned.revision;
    }

    // Remove previous asset in the same role & position for targetRevision, then attach the new asset
    await automationPrisma.postMedia.deleteMany({
      where: {
        postId,
        role,
        position,
        revision: targetRevision,
      },
    });

    await automationPrisma.postMedia.create({
      data: {
        postId,
        assetId: asset.id,
        role,
        position,
        revision: targetRevision,
      },
    });

    return this.getPostDetail(postId);
  }

  /**
   * POST /posts/:id/submit — Editor clicks Resubmit (or submits a resolved BLOCKED post).
   * Increments revision on CHANGES_REQUESTED -> PENDING_REVIEW, writes PostRevision, and queues REVISION_READY email.
   */
  public async submitForReview(
    postId: string,
    actor: AuthenticatedCrmUser,
    comment?: string
  ) {
    const post = await automationPrisma.post.findUnique({
      where: { id: postId },
      include: {
        media: { include: { asset: true } },
        revisions: { orderBy: { revision: 'desc' }, take: 1 },
      },
    });

    if (!post) {
      throw new Error(`Post ${postId} not found`);
    }

    const prevRevisionRow = post.revisions[0] || null;
    const prevRevisionNumber = post.revision;

    let updatedPost;
    if (post.status === 'CHANGES_REQUESTED') {
      updatedPost = await transition(postId, 'RESUBMIT', {
        actorId: actor.email,
        comment: comment || `Resubmitted by ${actor.email}`,
      });
    } else if (post.status === 'BLOCKED') {
      updatedPost = await transition(postId, 'FILE_RESOLVED', {
        actorId: actor.email,
        comment: comment || `Blocked issue fixed and submitted by ${actor.email}`,
      });
    } else {
      throw new InvalidTransitionError(
        `Cannot submit post in status "${post.status}". Only CHANGES_REQUESTED or BLOCKED posts can be submitted.`
      );
    }

    // Carry PostMedia links forward to the new revision if revision incremented
    const currentMedia = post.media.filter((m) => m.revision === prevRevisionNumber);
    if (updatedPost.revision !== prevRevisionNumber) {
      for (const pm of currentMedia) {
        await automationPrisma.postMedia.upsert({
          where: {
            postId_assetId_role_revision: {
              postId,
              assetId: pm.assetId,
              role: pm.role,
              revision: updatedPost.revision,
            },
          },
          update: { position: pm.position },
          create: {
            postId,
            assetId: pm.assetId,
            role: pm.role,
            position: pm.position,
            revision: updatedPost.revision,
          },
        });
      }
    }

    const mediaSnapshot = currentMedia.map((m) => ({
      assetId: m.assetId,
      role: m.role,
      position: m.position,
      fileName: m.asset.fileName,
      objectKey: m.asset.objectKey,
    }));

    await automationPrisma.postRevision.create({
      data: {
        postId,
        revision: updatedPost.revision,
        title: updatedPost.title,
        caption: updatedPost.caption,
        mediaSnapshot,
        createdById: actor.email,
      },
    });

    const changeSummary = computeRevisionDiffSummary(prevRevisionRow, {
      title: updatedPost.title,
      caption: updatedPost.caption,
      mediaSnapshot,
    });

    await notificationService.queueRevisionReady({
      post: {
        id: updatedPost.id,
        platform: updatedPost.platform,
        scheduledAt: updatedPost.scheduledAt,
        title: updatedPost.title,
        caption: updatedPost.caption,
        revision: updatedPost.revision,
      },
      editorActor: actor.email,
      changeSummary: comment ? `${changeSummary} (Note: ${comment})` : changeSummary,
    });

    return this.getPostDetail(postId);
  }

  /**
   * POST /posts/:id/approve — Lionel (Approver) or Admin approves a PENDING_REVIEW post.
   */
  public async approvePost(
    postId: string,
    actor: AuthenticatedCrmUser,
    comment?: string
  ) {
    const updatedPost = await transition(postId, 'APPROVE', {
      actorId: actor.email,
      comment,
    });

    await notificationService.queueApproved({
      id: updatedPost.id,
      platform: updatedPost.platform,
      scheduledAt: updatedPost.scheduledAt,
      title: updatedPost.title,
      caption: updatedPost.caption,
      revision: updatedPost.revision,
    });

    return this.getPostDetail(postId);
  }

  /**
   * POST /posts/:id/request-changes — Lionel (Approver) or Admin requests changes (comment required).
   */
  public async requestChanges(
    postId: string,
    actor: AuthenticatedCrmUser,
    comment: string
  ) {
    const updatedPost = await transition(postId, 'REQUEST_CHANGES', {
      actorId: actor.email,
      comment,
    });

    await notificationService.queueChangesRequestedOrRejected({
      type: 'CHANGES_REQUESTED',
      post: {
        id: updatedPost.id,
        platform: updatedPost.platform,
        scheduledAt: updatedPost.scheduledAt,
        title: updatedPost.title,
        caption: updatedPost.caption,
        revision: updatedPost.revision,
      },
      comment: comment.trim(),
    });

    return this.getPostDetail(postId);
  }

  /**
   * POST /posts/:id/reject — Lionel (Approver) or Admin rejects a post (comment required).
   */
  public async rejectPost(
    postId: string,
    actor: AuthenticatedCrmUser,
    comment: string
  ) {
    const updatedPost = await transition(postId, 'REJECT', {
      actorId: actor.email,
      comment,
    });

    await notificationService.queueChangesRequestedOrRejected({
      type: 'REJECTED',
      post: {
        id: updatedPost.id,
        platform: updatedPost.platform,
        scheduledAt: updatedPost.scheduledAt,
        title: updatedPost.title,
        caption: updatedPost.caption,
        revision: updatedPost.revision,
      },
      comment: comment.trim(),
    });

    return this.getPostDetail(postId);
  }

  /**
   * POST /posts/:id/comments — Adds a comment to the post's ReviewEvent thread.
   */
  public async addComment(
    postId: string,
    actor: AuthenticatedCrmUser,
    comment: string
  ) {
    const clean = (comment || '').trim();
    if (!clean) {
      throw new InvalidTransitionError('Comment text cannot be empty');
    }

    const post = await automationPrisma.post.findUnique({ where: { id: postId } });
    if (!post) {
      throw new Error(`Post ${postId} not found`);
    }

    const event = await automationPrisma.reviewEvent.create({
      data: {
        postId,
        revision: post.revision,
        action: 'COMMENT',
        comment: clean,
        actorId: actor.email,
      },
    });

    console.log(`[CrmPosts] postId=${postId} action=COMMENT actor=${actor.email}`);
    return event;
  }

  /**
   * POST /posts/:id/retry — Admin retries a FAILED post (FAILED -> APPROVED, attemptCount = 0).
   */
  public async adminRetryPost(
    postId: string,
    actor: AuthenticatedCrmUser,
    comment?: string
  ) {
    await transition(postId, 'ADMIN_RETRY', {
      actorId: actor.email,
      comment,
    });

    return this.getPostDetail(postId);
  }

  /**
   * POST /posts/:id/manual-done — Editor/Admin marks an APPROVED MANUAL post as MANUAL_DONE with live URL.
   */
  public async markManualDone(
    postId: string,
    actor: AuthenticatedCrmUser,
    url: string,
    comment?: string
  ) {
    await transition(postId, 'MARK_MANUAL_DONE', {
      actorId: actor.email,
      platformUrl: url,
      comment,
    });

    return this.getPostDetail(postId);
  }
}

export const crmPostsService = new CrmPostsService();

