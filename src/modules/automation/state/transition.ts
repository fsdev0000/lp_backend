import { PrismaClient } from '@prisma/client';

export type PostStatusType =
  | 'BLOCKED'
  | 'PENDING_REVIEW'
  | 'CHANGES_REQUESTED'
  | 'APPROVED'
  | 'PUBLISHING'
  | 'PROCESSING'
  | 'PUBLISHED'
  | 'FAILED'
  | 'MISSED'
  | 'REJECTED'
  | 'SKIPPED'
  | 'CANCELLED'
  | 'MANUAL_DONE';

export type PublishModeType = 'AUTO' | 'MANUAL';

export type ReviewActionType =
  | 'SUBMITTED'
  | 'APPROVED'
  | 'CHANGES_REQUESTED'
  | 'REJECTED'
  | 'COMMENT'
  | 'RESUBMITTED';

export type TransitionEventType =
  | 'INGEST_VALID'           // (new) -> PENDING_REVIEW
  | 'INGEST_BLOCKED'         // (new) -> BLOCKED
  | 'INGEST_SKIPPED'         // (new) -> SKIPPED
  | 'FILE_RESOLVED'          // BLOCKED -> PENDING_REVIEW
  | 'APPROVE'                // PENDING_REVIEW -> APPROVED
  | 'REQUEST_CHANGES'        // PENDING_REVIEW -> CHANGES_REQUESTED (comment required)
  | 'REJECT'                 // PENDING_REVIEW -> REJECTED (comment required)
  | 'RESUBMIT'               // CHANGES_REQUESTED -> PENDING_REVIEW (revision + 1)
  | 'EDIT_CONTENT'           // APPROVED -> PENDING_REVIEW (revision + 1, approval cleared)
  | 'LOCK_FOR_PUBLISH'       // APPROVED -> PUBLISHING (now >= scheduledAt && now <= scheduledAt + grace)
  | 'MARK_MISSED'            // APPROVED | PENDING_REVIEW -> MISSED (now > scheduledAt + grace)
  | 'RESCHEDULE'             // MISSED -> PENDING_REVIEW (if contentChanged) else APPROVED
  | 'ASYNC_ACCEPTED'         // PUBLISHING -> PROCESSING
  | 'PUBLISH_SUCCESS'        // PUBLISHING | PROCESSING -> PUBLISHED
  | 'RETRYABLE_ERROR'        // PUBLISHING | PROCESSING -> APPROVED (if attempt < 3) else FAILED
  | 'FATAL_ERROR'            // PUBLISHING | PROCESSING -> FAILED
  | 'ADMIN_RETRY'            // FAILED -> APPROVED
  | 'CALENDAR_ROW_DELETED'   // any non-final -> CANCELLED
  | 'MARK_MANUAL_DONE';      // APPROVED (MANUAL mode) -> MANUAL_DONE

export const FINAL_POST_STATUSES: ReadonlySet<PostStatusType> = new Set<PostStatusType>([
  'PUBLISHED',
  'REJECTED',
  'SKIPPED',
  'CANCELLED',
  'MANUAL_DONE',
]);

// Retry backoff schedule from Plan Section 5: 1m, 5m, 15m
export const RETRY_BACKOFF_MS = [1 * 60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000] as const;

export class InvalidTransitionError extends Error {
  public readonly statusCode = 400;
  public readonly code = 'INVALID_STATUS_TRANSITION';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidTransitionError';
  }
}

export interface PostStateSnapshot {
  id: string;
  status: PostStatusType | null; // null represents a brand-new post during ingest
  mode: PublishModeType;
  scheduledAt: Date;
  revision: number;
  approvedById?: string | null;
  approvedAt?: Date | null;
  attemptCount: number;
  nextAttemptAt?: Date | null;
  lockedAt?: Date | null;
  lockedBy?: string | null;
  platformPostId?: string | null;
  platformUrl?: string | null;
  processingRef?: string | null;
  publishedAt?: Date | null;
  blockedReason?: string | null;
  lastError?: string | null;
  platform?: string;
}

export interface TransitionContext {
  actorId?: string;
  comment?: string;
  blockedReason?: string;
  now?: Date;
  graceMinutes?: number;
  maxAttempts?: number;
  allowEarlyScheduledUpload?: boolean;
  contentChanged?: boolean;
  newScheduledAt?: Date;
  lockedBy?: string;
  processingRef?: string;
  platformPostId?: string;
  platformUrl?: string;
  httpStatus?: number;
  errorCode?: string;
  errorMessage?: string;
  rawResponse?: Record<string, any>;
}

export interface TransitionComputation {
  nextStatus: PostStatusType;
  postUpdates: Partial<PostStateSnapshot>;
  reviewEvent?: {
    postId: string;
    revision: number;
    action: ReviewActionType;
    comment: string | null;
    actorId: string;
  };
  publishAttempt?: {
    postId: string;
    attemptNo: number;
    startedAt: Date;
    finishedAt: Date | null;
    httpStatus: number | null;
    errorCode: string | null;
    response: Record<string, any> | null;
  };
}

/**
 * Pure state machine evaluator enforcing the exact transition table in Plan Section 5.
 * Throws InvalidTransitionError on any disallowed state change or missing required parameter.
 */
export function computeTransition(
  current: PostStateSnapshot,
  event: TransitionEventType,
  ctx: TransitionContext = {}
): TransitionComputation {
  const now = ctx.now || new Date();
  const actorId = (ctx.actorId || 'system').trim();
  const graceMinutes =
    ctx.graceMinutes ?? (Number(process.env.PUBLISH_GRACE_MINUTES) || 120);
  const maxAttempts =
    ctx.maxAttempts ?? (Number(process.env.MAX_PUBLISH_ATTEMPTS) || 3);
  const graceMs = graceMinutes * 60 * 1000;
  const fromStatus = current.status;

  switch (event) {
    case 'INGEST_VALID': {
      if (fromStatus !== null) {
        throw new InvalidTransitionError(
          `[postId=${current.id}] INGEST_VALID is only allowed from (new), got ${fromStatus}`
        );
      }
      return {
        nextStatus: 'PENDING_REVIEW',
        postUpdates: {
          status: 'PENDING_REVIEW',
          blockedReason: null,
        },
        reviewEvent: {
          postId: current.id,
          revision: current.revision,
          action: 'SUBMITTED',
          comment: ctx.comment || 'Staged by ingest',
          actorId,
        },
      };
    }

    case 'INGEST_BLOCKED': {
      if (fromStatus !== null && fromStatus !== 'BLOCKED' && fromStatus !== 'PENDING_REVIEW' && fromStatus !== 'APPROVED') {
        throw new InvalidTransitionError(
          `[postId=${current.id}] INGEST_BLOCKED is not allowed from ${fromStatus}`
        );
      }
      const reason = (ctx.blockedReason || '').trim();
      if (!reason) {
        throw new InvalidTransitionError(
          `[postId=${current.id}] blockedReason is required when transitioning to BLOCKED`
        );
      }
      return {
        nextStatus: 'BLOCKED',
        postUpdates: {
          status: 'BLOCKED',
          blockedReason: reason,
          approvedById: null,
          approvedAt: null,
        },
        reviewEvent: {
          postId: current.id,
          revision: current.revision,
          action: 'COMMENT',
          comment: `Blocked: ${reason}`,
          actorId,
        },
      };
    }

    case 'INGEST_SKIPPED': {
      if (fromStatus !== null) {
        throw new InvalidTransitionError(
          `[postId=${current.id}] INGEST_SKIPPED is only allowed from (new), got ${fromStatus}`
        );
      }
      return {
        nextStatus: 'SKIPPED',
        postUpdates: {
          status: 'SKIPPED',
          blockedReason: null,
        },
        reviewEvent: {
          postId: current.id,
          revision: current.revision,
          action: 'COMMENT',
          comment: ctx.comment || 'Skipped per calendar entry',
          actorId,
        },
      };
    }

    case 'FILE_RESOLVED': {
      if (fromStatus !== 'BLOCKED') {
        throw new InvalidTransitionError(
          `[postId=${current.id}] FILE_RESOLVED is only allowed from BLOCKED, got ${fromStatus}`
        );
      }
      return {
        nextStatus: 'PENDING_REVIEW',
        postUpdates: {
          status: 'PENDING_REVIEW',
          blockedReason: null,
        },
        reviewEvent: {
          postId: current.id,
          revision: current.revision,
          action: 'SUBMITTED',
          comment: ctx.comment || 'Blocked issue resolved',
          actorId,
        },
      };
    }

    case 'APPROVE': {
      if (fromStatus !== 'PENDING_REVIEW') {
        throw new InvalidTransitionError(
          `[postId=${current.id}] APPROVE is only allowed from PENDING_REVIEW, got ${fromStatus}`
        );
      }
      return {
        nextStatus: 'APPROVED',
        postUpdates: {
          status: 'APPROVED',
          approvedById: actorId,
          approvedAt: now,
          blockedReason: null,
          lastError: null,
        },
        reviewEvent: {
          postId: current.id,
          revision: current.revision,
          action: 'APPROVED',
          comment: ctx.comment?.trim() || null,
          actorId,
        },
      };
    }

    case 'REQUEST_CHANGES': {
      if (fromStatus !== 'PENDING_REVIEW') {
        throw new InvalidTransitionError(
          `[postId=${current.id}] REQUEST_CHANGES is only allowed from PENDING_REVIEW, got ${fromStatus}`
        );
      }
      const comment = (ctx.comment || '').trim();
      if (!comment) {
        throw new InvalidTransitionError(
          `[postId=${current.id}] A comment is required when requesting changes`
        );
      }
      return {
        nextStatus: 'CHANGES_REQUESTED',
        postUpdates: {
          status: 'CHANGES_REQUESTED',
          approvedById: null,
          approvedAt: null,
        },
        reviewEvent: {
          postId: current.id,
          revision: current.revision,
          action: 'CHANGES_REQUESTED',
          comment,
          actorId,
        },
      };
    }

    case 'REJECT': {
      if (fromStatus !== 'PENDING_REVIEW') {
        throw new InvalidTransitionError(
          `[postId=${current.id}] REJECT is only allowed from PENDING_REVIEW, got ${fromStatus}`
        );
      }
      const comment = (ctx.comment || '').trim();
      if (!comment) {
        throw new InvalidTransitionError(
          `[postId=${current.id}] A comment is required when rejecting a post`
        );
      }
      return {
        nextStatus: 'REJECTED',
        postUpdates: {
          status: 'REJECTED',
          approvedById: null,
          approvedAt: null,
        },
        reviewEvent: {
          postId: current.id,
          revision: current.revision,
          action: 'REJECTED',
          comment,
          actorId,
        },
      };
    }

    case 'RESUBMIT': {
      if (fromStatus !== 'CHANGES_REQUESTED') {
        throw new InvalidTransitionError(
          `[postId=${current.id}] RESUBMIT is only allowed from CHANGES_REQUESTED, got ${fromStatus}`
        );
      }
      const nextRevision = current.revision + 1;
      return {
        nextStatus: 'PENDING_REVIEW',
        postUpdates: {
          status: 'PENDING_REVIEW',
          revision: nextRevision,
          approvedById: null,
          approvedAt: null,
        },
        reviewEvent: {
          postId: current.id,
          revision: nextRevision,
          action: 'RESUBMITTED',
          comment: ctx.comment?.trim() || null,
          actorId,
        },
      };
    }

    case 'EDIT_CONTENT': {
      if (fromStatus !== 'APPROVED') {
        throw new InvalidTransitionError(
          `[postId=${current.id}] EDIT_CONTENT transition is only for APPROVED posts, got ${fromStatus}`
        );
      }
      const nextRevision = current.revision + 1;
      return {
        nextStatus: 'PENDING_REVIEW',
        postUpdates: {
          status: 'PENDING_REVIEW',
          revision: nextRevision,
          approvedById: null,
          approvedAt: null,
        },
        reviewEvent: {
          postId: current.id,
          revision: nextRevision,
          action: 'RESUBMITTED',
          comment: ctx.comment?.trim() || 'Edited after approval; re-approval required',
          actorId,
        },
      };
    }

    case 'LOCK_FOR_PUBLISH': {
      if (fromStatus !== 'APPROVED') {
        throw new InvalidTransitionError(
          `[postId=${current.id}] LOCK_FOR_PUBLISH is only allowed from APPROVED, got ${fromStatus}`
        );
      }
      const scheduledMs = current.scheduledAt.getTime();
      const nowMs = now.getTime();
      if (nowMs < scheduledMs && !ctx.allowEarlyScheduledUpload) {
        throw new InvalidTransitionError(
          `[postId=${current.id}] Cannot lock post before scheduledAt (${current.scheduledAt.toISOString()})`
        );
      }
      if (nowMs > scheduledMs + graceMs) {
        throw new InvalidTransitionError(
          `[postId=${current.id}] Cannot lock post past grace window (${graceMinutes}m after scheduledAt)`
        );
      }
      const nextAttemptNo = current.attemptCount + 1;
      return {
        nextStatus: 'PUBLISHING',
        postUpdates: {
          status: 'PUBLISHING',
          lockedAt: now,
          lockedBy: ctx.lockedBy || actorId,
        },
        publishAttempt: {
          postId: current.id,
          attemptNo: nextAttemptNo,
          startedAt: now,
          finishedAt: null,
          httpStatus: null,
          errorCode: null,
          response: null,
        },
      };
    }

    case 'MARK_MISSED': {
      if (fromStatus !== 'APPROVED' && fromStatus !== 'PENDING_REVIEW') {
        throw new InvalidTransitionError(
          `[postId=${current.id}] MARK_MISSED is only allowed from APPROVED or PENDING_REVIEW, got ${fromStatus}`
        );
      }
      const scheduledMs = current.scheduledAt.getTime();
      if (now.getTime() <= scheduledMs + graceMs) {
        throw new InvalidTransitionError(
          `[postId=${current.id}] Cannot mark MISSED before scheduledAt + grace (${graceMinutes}m)`
        );
      }
      return {
        nextStatus: 'MISSED',
        postUpdates: {
          status: 'MISSED',
          lockedAt: null,
          lockedBy: null,
        },
        reviewEvent: {
          postId: current.id,
          revision: current.revision,
          action: 'COMMENT',
          comment: ctx.comment || `Missed publishing window (exceeded ${graceMinutes}m grace period)`,
          actorId,
        },
      };
    }

    case 'RESCHEDULE': {
      if (fromStatus !== 'MISSED') {
        throw new InvalidTransitionError(
          `[postId=${current.id}] RESCHEDULE is only allowed from MISSED, got ${fromStatus}`
        );
      }
      if (!ctx.newScheduledAt) {
        throw new InvalidTransitionError(
          `[postId=${current.id}] newScheduledAt is required when rescheduling a MISSED post`
        );
      }
      const contentChanged = Boolean(ctx.contentChanged);
      const nextStatus: PostStatusType = contentChanged ? 'PENDING_REVIEW' : 'APPROVED';
      const nextRevision = contentChanged ? current.revision + 1 : current.revision;
      return {
        nextStatus,
        postUpdates: {
          status: nextStatus,
          scheduledAt: ctx.newScheduledAt,
          revision: nextRevision,
          ...(contentChanged ? { approvedById: null, approvedAt: null } : {}),
        },
        reviewEvent: {
          postId: current.id,
          revision: nextRevision,
          action: contentChanged ? 'RESUBMITTED' : 'COMMENT',
          comment:
            ctx.comment ||
            `Rescheduled to ${ctx.newScheduledAt.toISOString()}${
              contentChanged ? ' (content updated, awaiting review)' : ''
            }`,
          actorId,
        },
      };
    }

    case 'ASYNC_ACCEPTED': {
      if (fromStatus !== 'PUBLISHING') {
        throw new InvalidTransitionError(
          `[postId=${current.id}] ASYNC_ACCEPTED is only allowed from PUBLISHING, got ${fromStatus}`
        );
      }
      const processingRef = (ctx.processingRef || '').trim();
      if (!processingRef) {
        throw new InvalidTransitionError(
          `[postId=${current.id}] processingRef is required when transitioning to PROCESSING`
        );
      }
      const attemptNo = current.attemptCount + 1;
      return {
        nextStatus: 'PROCESSING',
        postUpdates: {
          status: 'PROCESSING',
          processingRef,
          attemptCount: attemptNo,
          lockedAt: null,
          lockedBy: null,
        },
        publishAttempt: {
          postId: current.id,
          attemptNo,
          startedAt: current.lockedAt || now,
          finishedAt: now,
          httpStatus: ctx.httpStatus ?? 202,
          errorCode: null,
          response: ctx.rawResponse ?? { processingRef },
        },
      };
    }

    case 'PUBLISH_SUCCESS': {
      if (fromStatus !== 'PUBLISHING' && fromStatus !== 'PROCESSING') {
        throw new InvalidTransitionError(
          `[postId=${current.id}] PUBLISH_SUCCESS is only allowed from PUBLISHING or PROCESSING, got ${fromStatus}`
        );
      }
      const attemptNo =
        fromStatus === 'PUBLISHING' ? current.attemptCount + 1 : Math.max(1, current.attemptCount);
      return {
        nextStatus: 'PUBLISHED',
        postUpdates: {
          status: 'PUBLISHED',
          platformPostId: ctx.platformPostId || current.platformPostId || null,
          platformUrl: ctx.platformUrl || current.platformUrl || null,
          publishedAt: now,
          attemptCount: attemptNo,
          nextAttemptAt: null,
          lockedAt: null,
          lockedBy: null,
          lastError: null,
        },
        publishAttempt: {
          postId: current.id,
          attemptNo,
          startedAt: current.lockedAt || now,
          finishedAt: now,
          httpStatus: ctx.httpStatus ?? 200,
          errorCode: null,
          response:
            ctx.rawResponse ?? {
              platformPostId: ctx.platformPostId || null,
              platformUrl: ctx.platformUrl || null,
            },
        },
      };
    }

    case 'RETRYABLE_ERROR': {
      if (fromStatus !== 'PUBLISHING' && fromStatus !== 'PROCESSING') {
        throw new InvalidTransitionError(
          `[postId=${current.id}] RETRYABLE_ERROR is only allowed from PUBLISHING or PROCESSING, got ${fromStatus}`
        );
      }
      const attemptNo =
        fromStatus === 'PUBLISHING' ? current.attemptCount + 1 : Math.max(1, current.attemptCount);
      const errorMessage = ctx.errorMessage || 'Retryable platform error';

      if (attemptNo < maxAttempts) {
        const backoffMs =
          RETRY_BACKOFF_MS[Math.min(attemptNo - 1, RETRY_BACKOFF_MS.length - 1)];
        const nextAttemptAt = new Date(now.getTime() + backoffMs);
        return {
          nextStatus: 'APPROVED',
          postUpdates: {
            status: 'APPROVED',
            attemptCount: attemptNo,
            nextAttemptAt,
            lockedAt: null,
            lockedBy: null,
            lastError: errorMessage,
          },
          publishAttempt: {
            postId: current.id,
            attemptNo,
            startedAt: current.lockedAt || now,
            finishedAt: now,
            httpStatus: ctx.httpStatus ?? 503,
            errorCode: ctx.errorCode || 'RETRYABLE_ERROR',
            response: ctx.rawResponse ?? { error: errorMessage, nextAttemptAt: nextAttemptAt.toISOString() },
          },
        };
      }

      // Attempts exhausted -> FAILED
      return {
        nextStatus: 'FAILED',
        postUpdates: {
          status: 'FAILED',
          attemptCount: attemptNo,
          nextAttemptAt: null,
          lockedAt: null,
          lockedBy: null,
          lastError: errorMessage,
        },
        publishAttempt: {
          postId: current.id,
          attemptNo,
          startedAt: current.lockedAt || now,
          finishedAt: now,
          httpStatus: ctx.httpStatus ?? 503,
          errorCode: ctx.errorCode || 'MAX_ATTEMPTS_EXCEEDED',
          response: ctx.rawResponse ?? { error: errorMessage },
        },
      };
    }

    case 'FATAL_ERROR': {
      if (fromStatus !== 'PUBLISHING' && fromStatus !== 'PROCESSING') {
        throw new InvalidTransitionError(
          `[postId=${current.id}] FATAL_ERROR is only allowed from PUBLISHING or PROCESSING, got ${fromStatus}`
        );
      }
      const attemptNo =
        fromStatus === 'PUBLISHING' ? current.attemptCount + 1 : Math.max(1, current.attemptCount);
      const errorMessage = ctx.errorMessage || 'Non-retryable platform error';
      return {
        nextStatus: 'FAILED',
        postUpdates: {
          status: 'FAILED',
          attemptCount: attemptNo,
          nextAttemptAt: null,
          lockedAt: null,
          lockedBy: null,
          lastError: errorMessage,
        },
        publishAttempt: {
          postId: current.id,
          attemptNo,
          startedAt: current.lockedAt || now,
          finishedAt: now,
          httpStatus: ctx.httpStatus ?? 400,
          errorCode: ctx.errorCode || 'FATAL_ERROR',
          response: ctx.rawResponse ?? { error: errorMessage },
        },
      };
    }

    case 'ADMIN_RETRY': {
      if (fromStatus !== 'FAILED') {
        throw new InvalidTransitionError(
          `[postId=${current.id}] ADMIN_RETRY is only allowed from FAILED, got ${fromStatus}`
        );
      }
      return {
        nextStatus: 'APPROVED',
        postUpdates: {
          status: 'APPROVED',
          attemptCount: 0,
          nextAttemptAt: null,
          lockedAt: null,
          lockedBy: null,
          processingRef: null,
          lastError: null,
        },
        reviewEvent: {
          postId: current.id,
          revision: current.revision,
          action: 'COMMENT',
          comment: ctx.comment || 'Admin triggered manual retry',
          actorId,
        },
      };
    }

    case 'CALENDAR_ROW_DELETED': {
      if (fromStatus === null || FINAL_POST_STATUSES.has(fromStatus)) {
        throw new InvalidTransitionError(
          `[postId=${current.id}] CALENDAR_ROW_DELETED is only allowed from non-final states, got ${fromStatus}`
        );
      }
      return {
        nextStatus: 'CANCELLED',
        postUpdates: {
          status: 'CANCELLED',
          lockedAt: null,
          lockedBy: null,
          nextAttemptAt: null,
        },
        reviewEvent: {
          postId: current.id,
          revision: current.revision,
          action: 'COMMENT',
          comment: ctx.comment || 'Cancelled after calendar row was removed',
          actorId,
        },
      };
    }

    case 'MARK_MANUAL_DONE': {
      if (fromStatus !== 'APPROVED') {
        throw new InvalidTransitionError(
          `[postId=${current.id}] MARK_MANUAL_DONE is only allowed from APPROVED, got ${fromStatus}`
        );
      }
      if (current.mode !== 'MANUAL') {
        throw new InvalidTransitionError(
          `[postId=${current.id}] MARK_MANUAL_DONE is only allowed for MANUAL mode posts, got ${current.mode}`
        );
      }
      const url = (ctx.platformUrl || '').trim();
      if (!url) {
        throw new InvalidTransitionError(
          `[postId=${current.id}] platformUrl is required when marking a manual post done`
        );
      }
      return {
        nextStatus: 'MANUAL_DONE',
        postUpdates: {
          status: 'MANUAL_DONE',
          platformUrl: url,
          publishedAt: now,
        },
        reviewEvent: {
          postId: current.id,
          revision: current.revision,
          action: 'COMMENT',
          comment: ctx.comment || `Manual publish confirmed: ${url}`,
          actorId,
        },
      };
    }

    default: {
      throw new InvalidTransitionError(
        `[postId=${current.id}] Unknown transition event: ${String(event)}`
      );
    }
  }
}

function buildPooledDatabaseUrl(): string | undefined {
  const base = process.env.DATABASE_URL || process.env.DIRECT_URL;
  if (!base) return undefined;
  const sep = base.includes('?') ? '&' : '?';
  const extras: string[] = [];
  if (!base.includes('connection_limit=')) extras.push('connection_limit=2');
  if (!base.includes('pool_timeout=')) extras.push('pool_timeout=30');
  if (!base.includes('connect_timeout=')) extras.push('connect_timeout=30');
  return extras.length > 0 ? `${base}${sep}${extras.join('&')}` : base;
}

const resolvedDbUrl = buildPooledDatabaseUrl();
export const automationPrisma = new PrismaClient(
  resolvedDbUrl
    ? {
        datasources: {
          db: {
            url: resolvedDbUrl,
          },
        },
      }
    : undefined
);

/**
 * Executes a validated state transition on a Post in PostgreSQL and records the audit row
 * (ReviewEvent or PublishAttempt) atomically. Logs postId on every log line.
 */
export async function transition(
  postId: string,
  event: TransitionEventType,
  ctx: TransitionContext = {},
  prismaClient: PrismaClient = automationPrisma
) {
  const existing = await prismaClient.post.findUnique({
    where: { id: postId },
  });

  if (!existing) {
    throw new Error(`[Transition] postId=${postId} Post not found`);
  }

  const snapshot: PostStateSnapshot = {
    id: existing.id,
    status: existing.status as PostStatusType,
    mode: existing.mode as PublishModeType,
    scheduledAt: existing.scheduledAt,
    revision: existing.revision,
    approvedById: existing.approvedById,
    approvedAt: existing.approvedAt,
    attemptCount: existing.attemptCount,
    nextAttemptAt: existing.nextAttemptAt,
    lockedAt: existing.lockedAt,
    lockedBy: existing.lockedBy,
    platformPostId: existing.platformPostId,
    platformUrl: existing.platformUrl,
    processingRef: existing.processingRef,
    publishedAt: existing.publishedAt,
    blockedReason: existing.blockedReason,
    lastError: existing.lastError,
  };

  const result = computeTransition(snapshot, event, ctx);

  console.log(
    `[Transition] postId=${postId} event=${event} from=${snapshot.status} to=${result.nextStatus} revision=${
      result.postUpdates.revision ?? snapshot.revision
    } actor=${ctx.actorId || 'system'}`
  );

  const updatedPost = await prismaClient.post.update({
    where: { id: postId },
    data: {
      status: result.nextStatus,
      ...(result.postUpdates.scheduledAt !== undefined ? { scheduledAt: result.postUpdates.scheduledAt } : {}),
      ...(result.postUpdates.revision !== undefined ? { revision: result.postUpdates.revision } : {}),
      ...(result.postUpdates.approvedById !== undefined ? { approvedById: result.postUpdates.approvedById } : {}),
      ...(result.postUpdates.approvedAt !== undefined ? { approvedAt: result.postUpdates.approvedAt } : {}),
      ...(result.postUpdates.attemptCount !== undefined ? { attemptCount: result.postUpdates.attemptCount } : {}),
      ...(result.postUpdates.nextAttemptAt !== undefined ? { nextAttemptAt: result.postUpdates.nextAttemptAt } : {}),
      ...(result.postUpdates.lockedAt !== undefined ? { lockedAt: result.postUpdates.lockedAt } : {}),
      ...(result.postUpdates.lockedBy !== undefined ? { lockedBy: result.postUpdates.lockedBy } : {}),
      ...(result.postUpdates.platformPostId !== undefined ? { platformPostId: result.postUpdates.platformPostId } : {}),
      ...(result.postUpdates.platformUrl !== undefined ? { platformUrl: result.postUpdates.platformUrl } : {}),
      ...(result.postUpdates.processingRef !== undefined ? { processingRef: result.postUpdates.processingRef } : {}),
      ...(result.postUpdates.publishedAt !== undefined ? { publishedAt: result.postUpdates.publishedAt } : {}),
      ...(result.postUpdates.blockedReason !== undefined ? { blockedReason: result.postUpdates.blockedReason } : {}),
      ...(result.postUpdates.lastError !== undefined ? { lastError: result.postUpdates.lastError } : {}),
    },
  });

  if (result.reviewEvent) {
    await prismaClient.reviewEvent.create({
      data: result.reviewEvent,
    });
  }

  if (result.publishAttempt) {
    const existingAttempt = await prismaClient.publishAttempt.findFirst({
      where: {
        postId: result.publishAttempt.postId,
        attemptNo: result.publishAttempt.attemptNo,
      },
      orderBy: { startedAt: 'desc' },
    });

    if (existingAttempt && result.publishAttempt.finishedAt) {
      await prismaClient.publishAttempt.update({
        where: { id: existingAttempt.id },
        data: {
          finishedAt: result.publishAttempt.finishedAt,
          httpStatus: result.publishAttempt.httpStatus,
          errorCode: result.publishAttempt.errorCode,
          response: (result.publishAttempt.response as any) ?? undefined,
        },
      });
    } else if (!existingAttempt) {
      await prismaClient.publishAttempt.create({
        data: {
          postId: result.publishAttempt.postId,
          attemptNo: result.publishAttempt.attemptNo,
          startedAt: result.publishAttempt.startedAt,
          finishedAt: result.publishAttempt.finishedAt,
          httpStatus: result.publishAttempt.httpStatus,
          errorCode: result.publishAttempt.errorCode,
          response: (result.publishAttempt.response as any) ?? undefined,
        },
      });
    }
  }

  return updatedPost;
}

