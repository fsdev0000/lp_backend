import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import contentRoutes from '../modules/content/content.routes';
import { LinkedInAdapter } from '../modules/social/adapters/linkedin.adapter';
import { contentPrisma } from '../modules/content/services/content.service';

jest.setTimeout(30000);

const app = express();
app.use(express.json());
app.use('/api/v1/content', contentRoutes);

const TEST_API_KEY = process.env.ARTICLES_API_KEY || 'b8f9c1a2d4e7465b90a3f8c2e1d5b';

describe('Content Studio Media Upload & LinkedIn Publishing Matrix', () => {
  const linkedinAdapter = new LinkedInAdapter();
  const mockPostsStore = new Map<string, any>();

  beforeEach(() => {
    mockPostsStore.clear();

    jest.spyOn(contentPrisma.socialPost, 'deleteMany').mockResolvedValue({ count: 0 } as any);
    jest.spyOn(contentPrisma.socialAuditLog, 'deleteMany').mockResolvedValue({ count: 0 } as any);
    jest.spyOn(contentPrisma.socialAuditLog, 'create').mockResolvedValue({ id: 'audit-1' } as any);

    jest.spyOn(contentPrisma.socialPost, 'create').mockImplementation((async ({ data }: any) => {
      const created = {
        id: data.id || `post-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockPostsStore.set(created.id, created);
      return created;
    }) as any);
  });

  describe('1. Upload Endpoint: POST /api/v1/content/media', () => {
    it('requires authentication and returns 401 when no token is provided', async () => {
      const dummyPng = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
      const res = await request(app)
        .post('/api/v1/content/media')
        .attach('file', dummyPng, { filename: 'founder_cover.png', contentType: 'image/png' });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('accepts PNG image and returns mediaUrl, mediaType="image", fileName, and size', async () => {
      const dummyPng = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');

      const res = await request(app)
        .post('/api/v1/content/media')
        .set('x-api-key', TEST_API_KEY)
        .attach('file', dummyPng, { filename: 'founder_cover.png', contentType: 'image/png' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.mediaType).toBe('image');
      expect(res.body.mediaUrl).toBeDefined();
      expect(typeof res.body.mediaUrl).toBe('string');
      expect(res.body.fileName).toBe('founder_cover.png');
      expect(res.body.size).toBe(dummyPng.length);
    });

    it('accepts JPG image and returns mediaUrl, mediaType="image", fileName, and size', async () => {
      const dummyJpg = Buffer.from('ffd8ffe000104a46494600010101006000600000ffd9', 'hex');

      const res = await request(app)
        .post('/api/v1/content/media')
        .set('x-api-key', TEST_API_KEY)
        .attach('file', dummyJpg, { filename: 'lionel_briefing.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.mediaType).toBe('image');
      expect(res.body.fileName).toBe('lionel_briefing.jpg');
      expect(res.body.size).toBe(dummyJpg.length);
    });

    it('accepts MP4 video and returns mediaUrl, mediaType="video", fileName, and size', async () => {
      const dummyMp4 = Buffer.from('000000206674797069736f6d0000020069736f6d69736f3261766331', 'hex');

      const res = await request(app)
        .post('/api/v1/content/media')
        .set('x-api-key', TEST_API_KEY)
        .attach('file', dummyMp4, { filename: 'masterclass_teaser.mp4', contentType: 'video/mp4' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.mediaType).toBe('video');
      expect(res.body.fileName).toBe('masterclass_teaser.mp4');
      expect(res.body.size).toBe(dummyMp4.length);
    });

    it('rejects unsupported file types (e.g. PDF/TXT) with HTTP 400', async () => {
      const dummyPdf = Buffer.from('%PDF-1.4 sample content');

      const res = await request(app)
        .post('/api/v1/content/media')
        .set('x-api-key', TEST_API_KEY)
        .attach('file', dummyPdf, { filename: 'document.pdf', contentType: 'application/pdf' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Unsupported file type');
    });

    it('rejects requests with no file attached with HTTP 400', async () => {
      const res = await request(app)
        .post('/api/v1/content/media')
        .set('x-api-key', TEST_API_KEY)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('No file uploaded');
    });
  });

  describe('2. Posts mediaType Inference: POST / PUT /content/posts', () => {
    it('defaults to "article" when only a website link is provided', async () => {
      const res = await request(app)
        .post('/api/v1/content/posts')
        .set('x-api-key', TEST_API_KEY)
        .send({
          title: 'Article Post Without Explicit mediaType',
          mediaUrl: 'https://leadersperformance.ae/articles/founder-cognitive-load',
          requireApproval: false,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.mediaType).toBe('article');
    });

    it('infers "image" when an image file URL is provided', async () => {
      const res = await request(app)
        .post('/api/v1/content/posts')
        .set('x-api-key', TEST_API_KEY)
        .send({
          title: 'Image Post Inferred From Extension',
          mediaUrl: 'https://staging.leadersperformance.ae/uploads/content/images/header.jpg',
          requireApproval: false,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.mediaType).toBe('image');
    });

    it('infers "video" when a video file URL is provided', async () => {
      const res = await request(app)
        .post('/api/v1/content/posts')
        .set('x-api-key', TEST_API_KEY)
        .send({
          title: 'Video Post Inferred From Extension',
          mediaUrl: 'https://staging.leadersperformance.ae/uploads/content/videos/clip.mp4',
          requireApproval: false,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.mediaType).toBe('video');
    });

    it('respects explicitly provided mediaType ("article", "image", "video")', async () => {
      const res = await request(app)
        .post('/api/v1/content/posts')
        .set('x-api-key', TEST_API_KEY)
        .send({
          title: 'Explicit Article Post',
          mediaUrl: 'https://leadersperformance.ae/thought-leadership',
          mediaType: 'article',
          requireApproval: false,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.mediaType).toBe('article');
    });

    it('rejects invalid mediaType values with HTTP 400', async () => {
      const res = await request(app)
        .post('/api/v1/content/posts')
        .set('x-api-key', TEST_API_KEY)
        .send({
          title: 'Invalid Media Type Post',
          mediaType: 'podcast_audio',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Invalid mediaType');
    });
  });

  describe('3. Publishing & Kill Switch Enforcement', () => {
    it('blocks publishPost with 403 while LINKEDIN_PUBLISHING_ENABLED is "false"', async () => {
      const previous = process.env.LINKEDIN_PUBLISHING_ENABLED;
      process.env.LINKEDIN_PUBLISHING_ENABLED = 'false';

      try {
        await expect(
          linkedinAdapter.publishPost('test_token_123', 'urn:li:person:12345', {
            title: 'Safety Test Post',
            text: 'This should be blocked while publishing is off.',
            mediaUrl: 'https://leadersperformance.ae/article',
            mediaType: 'article',
          })
        ).rejects.toThrow('LINKEDIN_PUBLISHING_ENABLED=false');
      } finally {
        process.env.LINKEDIN_PUBLISHING_ENABLED = previous;
      }
    });

    it('blocks image and video uploads with 403 when publishing switch is off', async () => {
      const previous = process.env.LINKEDIN_PUBLISHING_ENABLED;
      process.env.LINKEDIN_PUBLISHING_ENABLED = 'false';

      try {
        await expect(
          linkedinAdapter.uploadImageToLinkedIn('test_token_123', 'urn:li:person:12345', 'https://example.com/test.jpg')
        ).rejects.toThrow('LINKEDIN_PUBLISHING_ENABLED=false');

        await expect(
          linkedinAdapter.uploadVideoToLinkedIn('test_token_123', 'urn:li:person:12345', 'https://example.com/test.mp4')
        ).rejects.toThrow('LINKEDIN_PUBLISHING_ENABLED=false');
      } finally {
        process.env.LINKEDIN_PUBLISHING_ENABLED = previous;
      }
    });
  });
});
