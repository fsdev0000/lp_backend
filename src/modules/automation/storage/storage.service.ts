import { getSupabaseClient } from '../../../services/supabaseStorageService';

export const DEFAULT_SOCIAL_MEDIA_BUCKET = 'social-media';

export interface StoragePutParams {
  bucket?: string;
  objectKey: string;
  data: Buffer;
  contentType: string;
}

export interface StorageLocation {
  storageProvider: string;
  bucket: string;
  objectKey: string;
}

export interface IStorageService {
  readonly provider: string;
  readonly defaultBucket: string;
  put(params: StoragePutParams): Promise<StorageLocation>;
  get(objectKey: string, bucket?: string): Promise<Buffer>;
  signedUrl(objectKey: string, expiresInSeconds?: number, bucket?: string): Promise<string>;
  signedUploadUrl(objectKey: string, bucket?: string): Promise<{ signedUrl: string; token?: string; path: string }>;
  delete(objectKey: string, bucket?: string): Promise<void>;
}

/**
 * Normalises a file name to Unicode NFC (Plan Section 4 Rule 7).
 */
export function normalizeFileNameNfc(fileName: string): string {
  return (fileName || '').normalize('NFC').trim();
}

/**
 * Sanitises a file name for safe S3/Supabase object keys while preserving extension.
 */
export function sanitizeFileNameForObjectKey(fileName: string): string {
  const normalized = normalizeFileNameNfc(fileName);
  const cleaned = normalized
    .replace(/[\u2013\u2014]/g, '-') // en-dash / em-dash -> hyphen
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || 'asset';
}

/**
 * Builds the mandatory object key format (Plan Section 3 Rule 3):
 * media/{yyyy}/{mm}/{asset_uuid}/{sanitised_original_name}
 * Uses UTC year/month from the provided creation timestamp.
 */
export function buildStorageObjectKey(
  assetUuid: string,
  originalFileName: string,
  referenceDate: Date = new Date()
): string {
  if (!assetUuid || !assetUuid.trim()) {
    throw new Error('assetUuid is required to build a storage object key');
  }
  const yyyy = String(referenceDate.getUTCFullYear());
  const mm = String(referenceDate.getUTCMonth() + 1).padStart(2, '0');
  const sanitized = sanitizeFileNameForObjectKey(originalFileName);
  return `media/${yyyy}/${mm}/${assetUuid.trim()}/${sanitized}`;
}

/**
 * Validates that a value stored in the database is an object key and NOT a full URL
 * (Plan Section 3 Mandatory Rule 1).
 */
export function assertNotFullUrl(objectKey: string): void {
  if (/^https?:\/\//i.test(objectKey.trim())) {
    throw new Error('Storage rule violation: store bucket + object_key only, never a full URL');
  }
}

export class SupabaseStorageService implements IStorageService {
  public readonly provider: string;
  public readonly defaultBucket: string;

  constructor(
    bucket: string = process.env.STORAGE_BUCKET || DEFAULT_SOCIAL_MEDIA_BUCKET,
    provider: string = process.env.STORAGE_PROVIDER || 'supabase'
  ) {
    this.defaultBucket = bucket;
    this.provider = provider;
  }

  public async put(params: StoragePutParams): Promise<StorageLocation> {
    const bucket = params.bucket || this.defaultBucket;
    assertNotFullUrl(params.objectKey);

    const supabase = await getSupabaseClient();
    const { error } = await supabase.storage.from(bucket).upload(params.objectKey, params.data, {
      contentType: params.contentType,
      upsert: true,
    });

    if (error) {
      throw new Error(`[StorageService.put] Failed to upload ${params.objectKey} to ${bucket}: ${error.message}`);
    }

    return {
      storageProvider: this.provider,
      bucket,
      objectKey: params.objectKey,
    };
  }

  public async get(objectKey: string, bucket: string = this.defaultBucket): Promise<Buffer> {
    assertNotFullUrl(objectKey);
    const supabase = await getSupabaseClient();
    const { data, error } = await supabase.storage.from(bucket).download(objectKey);

    if (error || !data) {
      throw new Error(
        `[StorageService.get] Failed to download ${objectKey} from ${bucket}: ${error?.message || 'Empty response'}`
      );
    }

    const arrayBuffer = await data.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  public async signedUrl(
    objectKey: string,
    expiresInSeconds: number = 24 * 60 * 60, // 24h default (e.g. for Instagram containers)
    bucket: string = this.defaultBucket
  ): Promise<string> {
    assertNotFullUrl(objectKey);
    const supabase = await getSupabaseClient();
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(objectKey, expiresInSeconds);

    if (error || !data?.signedUrl) {
      throw new Error(
        `[StorageService.signedUrl] Failed to generate signed URL for ${objectKey}: ${error?.message || 'Empty URL'}`
      );
    }

    return data.signedUrl;
  }

  public async signedUploadUrl(
    objectKey: string,
    bucket: string = this.defaultBucket
  ): Promise<{ signedUrl: string; token?: string; path: string }> {
    assertNotFullUrl(objectKey);
    const supabase = await getSupabaseClient();
    const { data, error } = await supabase.storage.from(bucket).createSignedUploadUrl(objectKey);

    if (error || !data?.signedUrl) {
      throw new Error(
        `[StorageService.signedUploadUrl] Failed to generate signed upload URL for ${objectKey}: ${
          error?.message || 'Empty URL'
        }`
      );
    }

    return {
      signedUrl: data.signedUrl,
      token: (data as any).token,
      path: data.path || objectKey,
    };
  }

  public async delete(objectKey: string, bucket: string = this.defaultBucket): Promise<void> {
    assertNotFullUrl(objectKey);
    const supabase = await getSupabaseClient();
    const { error } = await supabase.storage.from(bucket).remove([objectKey]);

    if (error) {
      throw new Error(`[StorageService.delete] Failed to delete ${objectKey} from ${bucket}: ${error.message}`);
    }
  }
}

export const storageService: IStorageService = new SupabaseStorageService();

