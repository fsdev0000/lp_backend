import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { unmaskedPrivateRouter } from '../api/routes/unmaskedPrivate';
import {
  setMockSupabaseStorageClient,
  resetSupabaseStorageClient,
  UNMASKED_BUCKET,
  UNMASKED_VIDEO_OBJECT,
} from '../services/supabaseStorageService';

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use('/api/unmasked-private', unmaskedPrivateRouter);
app.use('/api/v1/unmasked-private', unmaskedPrivateRouter);

describe('UNMASKED PRIVATE Video Signed URL API (/api/v1/unmasked-private/video-url)', () => {
  const MOCK_SIGNED_URL =
    'https://tpyudbsbzrhhngulxyxp.supabase.co/storage/v1/object/sign/unmasked-private/unmasked-private.mp4?token=mock_signed_token_12345';

  let mockCreateSignedUrl: any;

  beforeEach(() => {
    jest.clearAllMocks();
    resetSupabaseStorageClient();

    process.env.SUPABASE_URL = 'https://tpyudbsbzrhhngulxyxp.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-service-role-key-test-env';

    mockCreateSignedUrl = jest.fn<any>().mockImplementation((path: any, expiresIn: any) => {
      if (path === UNMASKED_VIDEO_OBJECT) {
        return Promise.resolve({
          data: { signedUrl: MOCK_SIGNED_URL },
          error: null,
        });
      }
      return Promise.resolve({
        data: null,
        error: { message: 'The resource was not found', status: 404 },
      });
    });

    const mockStorage = {
      from: jest.fn<any>().mockImplementation((bucket: any) => {
        if (bucket === UNMASKED_BUCKET) {
          return { createSignedUrl: mockCreateSignedUrl };
        }
        return {
          createSignedUrl: jest.fn<any>().mockResolvedValue({
            data: null,
            error: { message: 'Bucket not found', status: 404 },
          }),
        };
      }),
    };

    setMockSupabaseStorageClient({ storage: mockStorage });
  });

  afterEach(() => {
    resetSupabaseStorageClient();
  });

  it('1. Generates secure signed video URL with simple GET request (zero parameters required)', async () => {
    const res = await request(app).get('/api/v1/unmasked-private/video-url');

    expect(res.status).toBe(200);
    expect(res.body.videoUrl).toBe(MOCK_SIGNED_URL);
    expect(mockCreateSignedUrl).toHaveBeenCalledWith(UNMASKED_VIDEO_OBJECT, expect.any(Number));
  });

  it('2. Returns secure signed video URL on /unmasked-private/video-url alias', async () => {
    const res = await request(app).get('/api/unmasked-private/video-url');

    expect(res.status).toBe(200);
    expect(res.body.videoUrl).toBe(MOCK_SIGNED_URL);
  });

  it('3. Handles missing video file in storage bucket safely with 404', async () => {
    mockCreateSignedUrl.mockResolvedValueOnce({
      data: null,
      error: { message: 'The resource was not found', status: 404 },
    });

    const res = await request(app).get('/api/v1/unmasked-private/video-url');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    expect(res.body.message).toMatch(/not exist/i);
  });

  it('4. Handles generic Supabase storage failure safely with 502 Bad Gateway', async () => {
    mockCreateSignedUrl.mockResolvedValueOnce({
      data: null,
      error: { message: 'Supabase Storage internal server connection failure', status: 500 },
    });

    const res = await request(app).get('/api/v1/unmasked-private/video-url');

    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('STORAGE_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('mock-service-role-key');
  });

  it('5. Never exposes service-role keys or internal credentials in API responses', async () => {
    const res = await request(app).get('/api/v1/unmasked-private/video-url');

    const bodyString = JSON.stringify(res.body);
    expect(bodyString).not.toContain('mock-service-role-key');
    expect(bodyString).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(bodyString).not.toContain('SUPABASE_KEY');
    expect(bodyString).not.toContain('service_role');
  });
});
