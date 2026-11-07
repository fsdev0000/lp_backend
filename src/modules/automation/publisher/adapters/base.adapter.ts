import { IStorageService } from '../../storage/storage.service';

export interface PublishAdapterResult {
  state: 'PUBLISHED' | 'PROCESSING';
  platformPostId?: string;
  url?: string;
  processingRef?: string;
  httpStatus?: number;
  rawResponse?: Record<string, any>;
}

export interface PollAdapterResult {
  state: 'PUBLISHED' | 'PROCESSING';
  platformPostId?: string;
  url?: string;
  processingRef?: string;
  httpStatus?: number;
  rawResponse?: Record<string, any>;
}

export interface RefreshTokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
}

export interface PublishMediaItem {
  assetId: string;
  role: string;
  position: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  bucket: string;
  objectKey: string;
  durationSec?: number | null;
  width?: number | null;
  height?: number | null;
}

export interface PublishablePostContext {
  id: string;
  platform: string;
  scheduledAt: Date;
  title?: string | null;
  caption?: string | null;
  hashtags: string[];
  options: Record<string, any>;
  processingRef?: string | null;
  platformPostId?: string | null;
  account: {
    id: string;
    platform: string;
    label: string;
    externalId: string;
    accessToken: string;
    refreshToken?: string | null;
  };
  media: PublishMediaItem[];
  storage: IStorageService;
}

export interface IPublishAdapter {
  readonly platform: string;
  publish(post: PublishablePostContext): Promise<PublishAdapterResult>;
  poll(post: PublishablePostContext): Promise<PollAdapterResult>;
  refreshToken(account: {
    id: string;
    platform: string;
    externalId: string;
    refreshToken: string;
  }): Promise<RefreshTokenResult>;
}

/**
 * Thrown on 429 rate limits, 5xx platform errors, network timeouts, or transient container delays (Edge Case #21).
 * Triggers `RETRYABLE_ERROR` transition with 1m / 5m / 15m backoff up to MAX_PUBLISH_ATTEMPTS (3).
 */
export class RetryableError extends Error {
  public readonly httpStatus: number;
  public readonly errorCode: string;
  public readonly rawResponse?: Record<string, any>;
  public readonly customDelayMinutes?: number;

  constructor(
    message: string,
    opts: {
      httpStatus?: number;
      errorCode?: string;
      rawResponse?: Record<string, any>;
      customDelayMinutes?: number;
    } = {}
  ) {
    super(message);
    this.name = 'RetryableError';
    this.httpStatus = opts.httpStatus ?? 503;
    this.errorCode = opts.errorCode || 'RETRYABLE_ERROR';
    this.rawResponse = opts.rawResponse;
    this.customDelayMinutes = opts.customDelayMinutes;
  }
}

/**
 * Thrown on non-retryable 400 validation errors, 403 permission errors, rejected media specs,
 * or `TIKTOK_AUDITED=false` (Edge Case #25).
 * Immediately transitions the post to `FAILED` and queues `PUBLISH_FAILED` email.
 */
export class FatalError extends Error {
  public readonly httpStatus: number;
  public readonly errorCode: string;
  public readonly rawResponse?: Record<string, any>;

  constructor(
    message: string,
    opts: {
      httpStatus?: number;
      errorCode?: string;
      rawResponse?: Record<string, any>;
    } = {}
  ) {
    super(message);
    this.name = 'FatalError';
    this.httpStatus = opts.httpStatus ?? 400;
    this.errorCode = opts.errorCode || 'FATAL_ERROR';
    this.rawResponse = opts.rawResponse;
  }
}

/**
 * Thrown when a platform returns HTTP 401 Unauthorized so the publisher can refresh the token once
 * and retry, or deactivate the account and fail its due posts if refresh fails (Edge Case #22).
 */
export class TokenExpiredError extends Error {
  public readonly httpStatus = 401;
  public readonly errorCode = 'TOKEN_EXPIRED';

  constructor(message = 'Platform access token expired (HTTP 401)') {
    super(message);
    this.name = 'TokenExpiredError';
  }
}

export type HttpFetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Builds the full caption text combining caption + hashtags when hashtags are not already embedded.
 */
export function buildFullPostCaption(caption?: string | null, hashtags: string[] = []): string {
  const base = (caption || '').trim();
  const missingTags = (hashtags || [])
    .map((t) => t.trim())
    .filter((t) => t && !base.toLowerCase().includes(t.toLowerCase()));
  if (missingTags.length === 0) return base;
  return `${base}\n\n${missingTags.join(' ')}`.trim();
}

