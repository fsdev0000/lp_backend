import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getSecret } from './secrets';
import dotenv from 'dotenv';

export const UNMASKED_BUCKET = 'unmasked-private';
export const UNMASKED_VIDEO_OBJECT = 'unmasked-private.mp4';
// Effectively permanent / long-lived (10 years)
export const DEFAULT_EXPIRES_IN_SECONDS = 315360000;

let cachedClient: SupabaseClient | null = null;
let mockClient: any = null;

export function setMockSupabaseStorageClient(mock: any) {
  mockClient = mock;
}

export function resetSupabaseStorageClient() {
  mockClient = null;
  cachedClient = null;
}

export function getSupabaseUrl(): string {
  return (
    process.env.SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    'https://tpyudbsbzrhhngulxyxp.supabase.co'
  );
}

export async function getSupabaseServiceKey(): Promise<string | undefined> {
  // Re-read .env to capture runtime updates without process restarts
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      dotenv.config({ override: true });
    } catch {
      // Ignore in non-file environments
    }
  }

  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return process.env.SUPABASE_SERVICE_ROLE_KEY;
  }
  if (process.env.SUPABASE_KEY) {
    return process.env.SUPABASE_KEY;
  }
  if (process.env.SUPABASE_SECRET_KEY) {
    return process.env.SUPABASE_SECRET_KEY;
  }
  if (process.env.SUPABASE_API_KEY) {
    return process.env.SUPABASE_API_KEY;
  }
  if (process.env.SUPABASE_ANON_KEY) {
    return process.env.SUPABASE_ANON_KEY;
  }

  const fromVault =
    (await getSecret('SUPABASE_SERVICE_ROLE_KEY')) ||
    (await getSecret('SUPABASE_KEY')) ||
    (await getSecret('SUPABASE_ANON_KEY')) ||
    (await getSecret('email_queue_service_role_key'));

  return fromVault;
}

export async function getSupabaseClient(): Promise<SupabaseClient> {
  if (mockClient) {
    return mockClient as SupabaseClient;
  }

  if (cachedClient) {
    return cachedClient;
  }

  const supabaseUrl = getSupabaseUrl();
  const serviceKey = await getSupabaseServiceKey();

  if (!serviceKey) {
    if (process.env.NODE_ENV === 'test') {
      return createClient(supabaseUrl, 'mock-service-key-for-test-env', {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    }
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is missing in lp_backend/.env. Please add SUPABASE_SERVICE_ROLE_KEY="eyJ..." from your Supabase Dashboard (Settings > API > service_role).');
  }

  cachedClient = createClient(supabaseUrl, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return cachedClient;
}

/**
 * Generates a secure signed URL for the private unmasked-private.mp4 video file.
 * Returns a long-lived signed URL so frontend can simply call the API and play the video.
 */
export async function generateUnmaskedVideoSignedUrl(
  expiresInSeconds: number = DEFAULT_EXPIRES_IN_SECONDS
): Promise<{ videoUrl: string }> {
  const supabase = await getSupabaseClient();

  const { data, error } = await supabase.storage
    .from(UNMASKED_BUCKET)
    .createSignedUrl(UNMASKED_VIDEO_OBJECT, expiresInSeconds);

  if (error) {
    const errorMsg = error.message || String(error);
    console.error('[SupabaseStorage] Signed URL generation error:', errorMsg);

    if (
      errorMsg.toLowerCase().includes('not found') ||
      (error as any).statusCode === '404' ||
      (error as any).status === 404
    ) {
      const notFoundErr: any = new Error('The requested video file does not exist in storage.');
      notFoundErr.code = 'VIDEO_NOT_FOUND';
      notFoundErr.status = 404;
      throw notFoundErr;
    }

    const storageErr: any = new Error('Failed to generate signed video URL.');
    storageErr.code = 'STORAGE_ERROR';
    storageErr.status = 502;
    throw storageErr;
  }

  if (!data?.signedUrl) {
    const emptyErr: any = new Error('Storage service returned an empty URL response.');
    emptyErr.code = 'STORAGE_EMPTY_URL';
    emptyErr.status = 502;
    throw emptyErr;
  }

  return {
    videoUrl: data.signedUrl,
  };
}
