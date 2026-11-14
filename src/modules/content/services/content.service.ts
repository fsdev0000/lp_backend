import { PrismaClient, SocialPost } from '@prisma/client';
import { LinkedInAdapter } from '../../social/adapters/linkedin.adapter';
import { InstagramPublishingService } from './instagramPublishing.service';
import { generateAuthoritativeSignature } from '../../../utils/approvalSignature';
import { isLinkedInPublishingEnabled } from '../../social/config/linkedin.config';
import { inboxService } from '../../automation/notifications/inbox.service';

export const contentPrisma = new PrismaClient();

export interface CreatePostDto {
  workspace?: string;
  title: string;
  hook?: string;
  body?: string;
  platform?: string;
  scheduledFor?: string;
  mediaUrl?: string;
  mediaType?: string;
  tags?: string[];
  author?: string;
  requireApproval?: boolean;
}

export interface PostFilterDto {
  workspace?: string;
  platform?: string;
  status?: string;
  search?: string;
  page?: number;
  limit?: number;
}

const LEGACY_SEED_POST_IDS = ['post-101', 'post-102', 'post-103', 'post-104', 'post-105'];
const LEGACY_SEED_AUDIT_IDS = ['audit-901', 'audit-902'];

function createHttpError(message: string, statusCode: number): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

export class ContentService {
  private linkedin = new LinkedInAdapter();
  private instagramPublishing = new InstagramPublishingService();
  private static legacyPurged = false;

  constructor() {
    this.purgeLegacySeedData().catch(() => {
      // Ignore if DB is offline during boot
    });
  }

  /**
   * One-time removal of any previously seeded fake posts (post-101..105) and audit logs (audit-901..902)
   * so fake published metrics (post-101) or past-dated scheduled posts (post-103) never remain in the DB.
   */
  public async purgeLegacySeedData(): Promise<void> {
    if (ContentService.legacyPurged) return;
    ContentService.legacyPurged = true;
    try {
      await contentPrisma.socialPost.deleteMany({
        where: { id: { in: LEGACY_SEED_POST_IDS } },
      });
      await contentPrisma.socialAuditLog.deleteMany({
        where: { id: { in: LEGACY_SEED_AUDIT_IDS } },
      });

      // Item 4f / Item 6: Migrate legacy posts saved before 0d3d43e (created before Nov 4, 2026) that defaulted to mediaType="image"
      const legacyPosts = await contentPrisma.socialPost.findMany({
        where: {
          mediaType: 'image',
          mediaUrl: { not: null },
          createdAt: { lt: new Date('2026-11-04T00:00:00.000Z') },
        },
      });

      for (const p of legacyPosts) {
        if (p.mediaUrl) {
          const cleanUrl = p.mediaUrl.trim().toLowerCase().split('?')[0];
          const isDirectMedia = /\.(jpg|jpeg|png|gif|webp|svg|mp4|mov|webm)$/i.test(cleanUrl);
          if (!isDirectMedia && (p.mediaUrl.startsWith('http://') || p.mediaUrl.startsWith('https://'))) {
            await contentPrisma.socialPost.update({
              where: { id: p.id },
              data: { mediaType: 'article' },
            });
          }
        }
      }
    } catch {
      // Ignore if DB is unreachable
    }
  }

  /**
   * Lists posts matching multi-platform filtering criteria directly from the database (no seed or memory fallback).
   */
  public async listPosts(filter: PostFilterDto) {
    await this.purgeLegacySeedData();

    const where: any = {};
    if (filter.workspace) {
      where.workspace = filter.workspace;
    }
    if (filter.platform && filter.platform !== 'ALL') {
      where.platform = filter.platform.toUpperCase();
    }
    if (filter.status && filter.status !== 'ALL') {
      where.status = filter.status.toUpperCase();
    }
    if (filter.search && filter.search.trim()) {
      const q = filter.search.trim();
      where.OR = [
        { title: { contains: q, mode: 'insensitive' } },
        { hook: { contains: q, mode: 'insensitive' } },
        { body: { contains: q, mode: 'insensitive' } },
      ];
    }

    const page = Math.max(1, filter.page || 1);
    const limit = Math.min(100, Math.max(1, filter.limit || 50));
    const skip = (page - 1) * limit;

    const [total, posts] = await Promise.all([
      contentPrisma.socialPost.count({ where }),
      contentPrisma.socialPost.findMany({
        where,
        orderBy: [{ scheduledFor: 'desc' }, { createdAt: 'desc' }],
        skip,
        take: limit,
      }),
    ]);

    return {
      posts,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Retrieves single post details from the database.
   */
  public async getPostById(id: string): Promise<SocialPost> {
    const post = await contentPrisma.socialPost.findUnique({ where: { id } });
    if (!post) {
      throw createHttpError(`Social post not found with ID: ${id}`, 404);
    }
    return post;
  }

  /**
   * Resolves and validates mediaType according to CRM requirements:
   * Accepts "image" | "video" | "article".
   * Defaults to "article" when only a link is given or when omitted.
   */
  public resolveMediaType(mediaType?: string, mediaUrl?: string): 'image' | 'video' | 'article' {
    if (mediaType && mediaType.trim()) {
      const normalized = mediaType.toLowerCase().trim();
      if (['image', 'video', 'article'].includes(normalized)) {
        return normalized as 'image' | 'video' | 'article';
      }
      throw createHttpError(
        `Invalid mediaType: "${mediaType}". Allowed values are "image", "video", or "article".`,
        400
      );
    }

    if (!mediaUrl || !mediaUrl.trim()) {
      return 'article';
    }

    const clean = mediaUrl.trim().toLowerCase().split('?')[0];
    if (clean.endsWith('.mp4')) {
      return 'video';
    }
    if (clean.endsWith('.jpg') || clean.endsWith('.jpeg') || clean.endsWith('.png') || clean.endsWith('.gif')) {
      return 'image';
    }

    // Default to "article" when only a link is given
    return 'article';
  }

  /**
   * Creates a new post in DRAFT or PENDING_REVIEW
   */
  public async createPost(dto: CreatePostDto, ipAddress?: string, actor?: string): Promise<SocialPost> {
    const status = dto.requireApproval ? 'PENDING_REVIEW' : 'DRAFT';
    const scheduledFor = dto.scheduledFor ? new Date(dto.scheduledFor) : null;
    const resolvedMediaType = this.resolveMediaType(dto.mediaType, dto.mediaUrl);

    const post = await contentPrisma.socialPost.create({
      data: {
        workspace: dto.workspace || 'leaders_performance',
        title: dto.title,
        hook: dto.hook || null,
        body: dto.body || null,
        platform: (dto.platform || 'LINKEDIN').toUpperCase(),
        status,
        author: dto.author || actor || 'Unknown author',
        scheduledFor,
        mediaUrl: dto.mediaUrl || null,
        mediaType: resolvedMediaType,
        tags: dto.tags || [],
      },
    });

    await this.logAudit({
      actor: actor || dto.author || 'Unknown user',
      action: dto.requireApproval ? 'PENDING_REVIEW_REQUESTED' : 'DRAFT_CREATED',
      entity: `ContentPost #${post.id}`,
      details: `Created ${post.platform} post "${post.title}" with status ${status}.`,
      ipAddress,
    });

    return post;
  }

  /**
   * Updates an existing post.
   * Workflow rule (6c): Editing an APPROVED or SCHEDULED post (or any post with an approvalSignature)
   * clears its approval signature and sends it back to PENDING_REVIEW.
   * Published posts cannot be edited.
   */
  public async updatePost(
    id: string,
    updates: Partial<CreatePostDto>,
    ipAddress?: string,
    actor?: string
  ): Promise<SocialPost> {
    const existing = await this.getPostById(id);

    if (existing.status === 'PUBLISHED') {
      throw createHttpError('Cannot edit a post that has already been published.', 400);
    }

    let resolvedMediaType: string | undefined = undefined;
    if (updates.mediaType !== undefined) {
      resolvedMediaType = this.resolveMediaType(updates.mediaType, updates.mediaUrl ?? existing.mediaUrl ?? undefined);
    } else if (updates.mediaUrl !== undefined) {
      resolvedMediaType = this.resolveMediaType(undefined, updates.mediaUrl);
    }

    const wasApprovedOrScheduled =
      existing.status === 'SCHEDULED' ||
      existing.status === 'APPROVED' ||
      Boolean(existing.approvalSignature);

    const post = await contentPrisma.socialPost.update({
      where: { id },
      data: {
        ...(updates.title !== undefined ? { title: updates.title } : {}),
        ...(updates.hook !== undefined ? { hook: updates.hook } : {}),
        ...(updates.body !== undefined ? { body: updates.body } : {}),
        ...(updates.platform !== undefined ? { platform: updates.platform.toUpperCase() } : {}),
        ...(updates.scheduledFor !== undefined
          ? { scheduledFor: updates.scheduledFor ? new Date(updates.scheduledFor) : null }
          : {}),
        ...(updates.mediaUrl !== undefined ? { mediaUrl: updates.mediaUrl } : {}),
        ...(resolvedMediaType !== undefined ? { mediaType: resolvedMediaType } : {}),
        ...(updates.tags !== undefined ? { tags: updates.tags } : {}),
        ...(wasApprovedOrScheduled
          ? {
            status: 'PENDING_REVIEW',
            approvalSignature: null,
            approvedBy: null,
            approvedAt: null,
          }
          : {}),
      },
    });

    await this.logAudit({
      actor: actor || 'Unknown user',
      action: wasApprovedOrScheduled ? 'POST_UPDATED_SENT_TO_REVIEW' : 'POST_UPDATED',
      entity: `ContentPost #${post.id}`,
      details: wasApprovedOrScheduled
        ? `Updated approved/scheduled post "${post.title}". Approval cleared and status reset to PENDING_REVIEW.`
        : `Updated fields on post "${post.title}".`,
      ipAddress,
    });

    return post;
  }

  /**
   * Deletes a post from CRM
   */
  public async deletePost(id: string, ipAddress?: string, actor?: string): Promise<{ success: boolean }> {
    const post = await this.getPostById(id);
    await contentPrisma.socialPost.delete({ where: { id } });

    await this.logAudit({
      actor: actor || 'Unknown user',
      action: 'POST_DELETED',
      entity: `ContentPost #${id}`,
      details: `Deleted post "${post.title}".`,
      ipAddress,
    });

    return { success: true };
  }

  /**
   * Requests executive approval, moving post to PENDING_REVIEW
   */
  public async requestApproval(id: string, ipAddress?: string, actor?: string): Promise<SocialPost> {
    const post = await this.getPostById(id);

    if (post.status === 'PUBLISHED') {
      throw createHttpError('Post is already published.', 400);
    }

    const updated = await contentPrisma.socialPost.update({
      where: { id },
      data: {
        status: 'PENDING_REVIEW',
        rejectionReason: null,
        rejectedAt: null,
      },
    });

    await this.logAudit({
      actor: actor || post.author || 'Unknown user',
      action: 'DRAFT_SUBMITTED_FOR_REVIEW',
      entity: `ContentPost #${post.id}`,
      details: `Submitted post "${post.title}" for Mr. Lionel's executive sign-off.`,
      ipAddress,
    });

    // CRM in-app notification feed
    inboxService.notify({
      category: 'APPROVAL',
      type: 'REVIEW_REQUEST',
      title: 'Post Waiting for Review',
      message: `${post.platform} · "${post.title}" submitted for review by ${post.author || 'Editor'}`,
      link: '/approvals',
      workspace: (post as any).workspace || 'leaders_performance',
      entityId: post.id,
      dedupeKey: `REVIEW_REQUEST:${post.id}:${Date.now()}`,
      roles: ['Approver'],
    }).catch((err) => console.warn('[ContentService] Inbox notify warning:', err?.message));

    return updated;
  }

  /**
   * Mr. Lionel Executive Approval Gate
   * Workflow rules:
   * - Must be in PENDING_REVIEW status (Item 6a).
   * - While LINKEDIN_PUBLISHING_ENABLED is false, approve NEVER publishes to LinkedIn (Item 1);
   *   it only marks the post SCHEDULED and tags metadata.approvedWhilePublishingDisabled = true (Item 4).
   */
  public async approvePost(
    id: string,
    approvalData: { signature?: string; approvedBy?: string },
    ipAddress?: string,
    actorName?: string
  ): Promise<SocialPost> {
    const post = await this.getPostById(id);

    if (post.status !== 'PENDING_REVIEW') {
      throw createHttpError(
        `Cannot approve post in "${post.status}" status. Only posts in "PENDING_REVIEW" status can be approved.`,
        400
      );
    }

    // Item 4e: Authoritative digital signature is always generated on the server; client-supplied signatures are ignored
    const signature = generateAuthoritativeSignature({
      id: post.id,
      title: post.title,
      hook: post.hook,
      body: post.body,
      platform: post.platform,
      mediaUrl: post.mediaUrl,
    });
    const approvedBy = approvalData.approvedBy || 'Approver';
    const approvedAt = new Date();
    const publishingEnabled = isLinkedInPublishingEnabled();

    const isImmediate = !post.scheduledFor || new Date(post.scheduledFor).getTime() <= Date.now();
    let newStatus = 'SCHEDULED';
    let publishedAt: Date | undefined = undefined;
    let platformPostId: string | null | undefined = undefined;
    let platformPostUrl: string | null | undefined = undefined;
    let rejectionReason: string | null = null;
    let scheduledFor = post.scheduledFor;

    const existingMetadata =
      post.metadata && typeof post.metadata === 'object' && !Array.isArray(post.metadata)
        ? (post.metadata as Record<string, any>)
        : {};

    const updatedMetadata: Record<string, any> = {
      ...existingMetadata,
      approvedWhilePublishingDisabled: !publishingEnabled,
      approvedAtIso: approvedAt.toISOString(),
    };

    // Only attempt immediate live dispatch when LINKEDIN_PUBLISHING_ENABLED is explicitly true
    if (publishingEnabled && post.platform === 'LINKEDIN' && isImmediate) {
      try {
        const dispatchRes = await this.dispatchToLinkedIn(post);
        newStatus = 'PUBLISHED';
        publishedAt = new Date();
        platformPostId = dispatchRes.postUrn;
        platformPostUrl = dispatchRes.postUrl;
      } catch (err: any) {
        console.warn(`[ContentService] Immediate LinkedIn dispatch failed: ${err?.message}`);
        // Item 4h: If immediate publish fails, mark as FAILED so it doesn't get stuck in SCHEDULED with scheduledFor null
        newStatus = 'FAILED';
        rejectionReason = `Immediate LinkedIn dispatch failed: ${err?.message || 'Platform error'}`;
      }
    } else if (!scheduledFor) {
      // Ensure scheduledFor is populated if post was approved without a specific time, allowing scheduler pickup
      scheduledFor = approvedAt;
    }

    const updated = await contentPrisma.socialPost.update({
      where: { id },
      data: {
        status: newStatus,
        approvalSignature: signature,
        approvedBy,
        approvedAt,
        scheduledFor,
        rejectionReason,
        rejectedAt: null,
        metadata: updatedMetadata,
        ...(publishedAt ? { publishedAt } : {}),
        ...(platformPostId !== undefined ? { platformPostId } : {}),
        ...(platformPostUrl !== undefined ? { platformPostUrl } : {}),
      },
    });

    await this.logAudit({
      actor: actorName || approvedBy,
      action: 'CRYPTOGRAPHIC_APPROVAL_GRANTED',
      entity: `ContentPost #${post.id}`,
      details: `Generated digital token ${signature}. Status transitioned to ${newStatus} (publishingEnabled=${publishingEnabled}).`,
      ipAddress,
    });

    // CRM in-app notification feed
    inboxService.notify({
      category: 'APPROVAL',
      type: 'POST_APPROVED',
      title: 'Post Approved',
      message: `${post.platform} · "${post.title}" was approved by ${actorName || approvedBy}`,
      link: '/content',
      workspace: (post as any).workspace || 'leaders_performance',
      entityId: post.id,
      dedupeKey: `POST_APPROVED:${post.id}:${Date.now()}`,
      roles: ['Marketing'],
      recipients: post.author ? [post.author] : undefined,
    }).catch((err) => console.warn('[ContentService] Inbox notify warning:', err?.message));

    return updated;
  }

  /**
   * Rejects a post draft with feedback reason
   */
  public async rejectPost(id: string, reason: string, ipAddress?: string, actor?: string): Promise<SocialPost> {
    const post = await this.getPostById(id);

    const updated = await contentPrisma.socialPost.update({
      where: { id },
      data: {
        status: 'REJECTED',
        rejectionReason: reason,
        rejectedAt: new Date(),
        approvalSignature: null,
        approvedBy: null,
        approvedAt: null,
      },
    });

    await this.logAudit({
      actor: actor || 'Approver',
      action: 'POST_REJECTED',
      entity: `ContentPost #${post.id}`,
      details: `Revisions requested: "${reason}".`,
      ipAddress,
    });

    // CRM in-app notification feed
    inboxService.notify({
      category: 'APPROVAL',
      type: 'CHANGES_REQUESTED',
      title: 'Changes Requested on Post',
      message: `${post.platform} · "${post.title}": ${reason}`,
      link: '/content',
      workspace: (post as any).workspace || 'leaders_performance',
      entityId: post.id,
      dedupeKey: `CHANGES_REQUESTED:${post.id}:${Date.now()}`,
      roles: ['Marketing'],
      recipients: post.author ? [post.author] : undefined,
    }).catch((err) => console.warn('[ContentService] Inbox notify warning:', err?.message));

    return updated;
  }

  /**
   * Forces immediate live broadcast to LinkedIn
   * Workflow rules:
   * - Returns 403 while LINKEDIN_PUBLISHING_ENABLED is false (Item 1).
   * - Never signs off by itself when a post has no approval (Item 6b).
   * - Never marks YouTube/TikTok/unimplemented platforms as PUBLISHED without posting them (Item 6d).
   */
  public async publishPostNow(id: string, ipAddress?: string, actor?: string): Promise<SocialPost> {
    if (!isLinkedInPublishingEnabled()) {
      throw createHttpError(
        'LinkedIn publishing is currently disabled (LINKEDIN_PUBLISHING_ENABLED=false). No posts may be sent until the owner enables publishing.',
        403
      );
    }

    const post = await this.getPostById(id);

    if (post.status === 'PUBLISHED') {
      throw createHttpError('Post has already been published.', 400);
    }

    // Item 6b: Never self-sign when a post has no approval
    if (
      !post.approvalSignature ||
      !post.approvedBy ||
      (post.status !== 'SCHEDULED' && post.status !== 'APPROVED')
    ) {
      throw createHttpError(
        'Post cannot be published without executive approval. Please submit for review and approve first.',
        400
      );
    }

    // Item 6d: Only publish supported live channels; never mark YouTube/TikTok/etc. PUBLISHED without posting
    if (post.platform !== 'LINKEDIN') {
      throw createHttpError(
        `Live publishing is not supported for platform "${post.platform}". Only approved LINKEDIN posts can be published via this endpoint.`,
        400
      );
    }

    // LinkedIn Live Broadcast
    const dispatch = await this.dispatchToLinkedIn(post);

    const updated = await contentPrisma.socialPost.update({
      where: { id },
      data: {
        status: 'PUBLISHED',
        publishedAt: new Date(),
        platformPostId: dispatch.postUrn,
        platformPostUrl: dispatch.postUrl,
      },
    });

    await this.logAudit({
      actor: actor || post.approvedBy || 'System Publisher',
      action: 'LINKEDIN_BROADCAST_DISPATCHED',
      entity: `ContentPost #${post.id}`,
      details: `Live post broadcast to LinkedIn feed. URN: ${dispatch.postUrn || 'none'}`,
      ipAddress,
      metadata: { postUrl: dispatch.postUrl },
    });

    return updated;
  }

  /**
   * Internal helper to dispatch content to LinkedIn API using the personal profile connection ('LINKEDIN').
   */
  private async dispatchToLinkedIn(post: SocialPost) {
    const conn =
      (await this.linkedin.ensureValidConnection('member').catch(() => null)) ||
      (await this.linkedin.getActiveConnection());
    if (!conn || !conn.accessToken || !conn.accountUrn) {
      throw createHttpError(
        'LinkedIn personal publishing account is not connected. Please connect LinkedIn first.',
        400
      );
    }

    return this.linkedin.publishPost(conn.accessToken, conn.accountUrn, {
      title: post.title,
      text: post.hook ? `${post.hook}\n\n${post.body || ''}` : post.body || post.title,
      mediaUrl: post.mediaUrl || undefined,
      mediaType: (post.mediaType || 'article').toLowerCase(),
    });
  }

  /**
   * Retrieves pending posts for the Approval Desk
   */
  public async getApprovalDeskPosts(workspace?: string) {
    await this.purgeLegacySeedData();
    const where: any = { status: 'PENDING_REVIEW' };
    if (workspace) {
      where.workspace = workspace;
    }
    return contentPrisma.socialPost.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Returns approval queue analytics
   */
  public async getApprovalStats(workspace?: string) {
    await this.purgeLegacySeedData();
    const baseWhere: any = workspace ? { workspace } : {};
    const [pending, scheduled, published, rejected, total] = await Promise.all([
      contentPrisma.socialPost.count({ where: { ...baseWhere, status: 'PENDING_REVIEW' } }),
      contentPrisma.socialPost.count({ where: { ...baseWhere, status: 'SCHEDULED' } }),
      contentPrisma.socialPost.count({ where: { ...baseWhere, status: 'PUBLISHED' } }),
      contentPrisma.socialPost.count({ where: { ...baseWhere, status: 'REJECTED' } }),
      contentPrisma.socialPost.count({ where: baseWhere }),
    ]);

    return {
      pendingReview: pending,
      scheduled,
      published,
      rejected,
      total,
    };
  }

  /**
   * Retrieves governance audit logs with pagination support
   */
  public async getAuditLogs(limit = 50, page = 1, cursor?: string) {
    await this.purgeLegacySeedData();
    const take = Math.min(100, Math.max(1, limit));
    const skip = cursor ? 1 : Math.max(0, (page - 1) * take);
    const query: any = {
      orderBy: { timestamp: 'desc' },
      take,
    };
    if (cursor) {
      query.cursor = { id: cursor };
      query.skip = 1;
    } else if (page > 1) {
      query.skip = (page - 1) * take;
    }
    const items = await contentPrisma.socialAuditLog.findMany(query);
    let total = items.length;
    try {
      total = await contentPrisma.socialAuditLog.count();
    } catch {}
    return {
      items,
      total,
      page,
      limit: take,
      hasMore: (query.skip || 0) + items.length < total,
    };
  }

  /**
   * Records a cryptographic or operational event in the audit trail
   */
  public async logAudit(params: {
    actor: string;
    action: string;
    entity: string;
    details: string;
    ipAddress?: string;
    metadata?: any;
  }) {
    try {
      await contentPrisma.socialAuditLog.create({
        data: {
          actor: params.actor,
          action: params.action,
          entity: params.entity,
          details: params.details,
          ipAddress: params.ipAddress || null,
          metadata: params.metadata || null,
        },
      });
    } catch (e: any) {
      console.warn('[ContentService] Audit log write notice:', e?.message);
    }
  }
}
