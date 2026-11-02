import { describe, it, expect, jest, beforeAll } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import contentRoutes from '../modules/content/content.routes';
import { LinkedInAdapter } from '../modules/social/adapters/linkedin.adapter';
import { ContentService } from '../modules/content/services/content.service';
import fs from 'fs';
import path from 'path';

jest.setTimeout(30000);

const app = express();
app.use(express.json());
app.use('/api/v1/content', contentRoutes);

describe('Content Studio Media Upload & LinkedIn Publishing Matrix', () => {
  const linkedinAdapter = new LinkedInAdapter();
  const contentService = new ContentService();

  describe('1. Upload Endpoint: POST /api/v1/content/media', () => {
    it('accepts PNG image and returns mediaUrl, mediaType="image", fileName, and size', async () => {
      const dummyPng = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');

      const res = await request(app)
        .post('/api/v1/content/media')
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
        .attach('file', dummyPdf, { filename: 'document.pdf', contentType: 'application/pdf' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Unsupported file type');
    });

    it('rejects requests with no file attached with HTTP 400', async () => {
      const res = await request(app).post('/api/v1/content/media').send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('No file uploaded');
    });
  });

  describe('2. Posts mediaType Inference: POST / PUT /content/posts', () => {
    it('defaults to "article" when only a website link is provided', async () => {
      const res = await request(app)
        .post('/api/v1/content/posts')
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
        .send({
          title: 'Invalid Media Type Post',
          mediaType: 'podcast_audio',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Invalid mediaType');
    });
  });

  describe('3. Publishing & Safety Switch', () => {
    it('does not send live HTTP requests to LinkedIn while LINKEDIN_PUBLISHING_ENABLED is off ("false")', async () => {
      const previous = process.env.LINKEDIN_PUBLISHING_ENABLED;
      process.env.LINKEDIN_PUBLISHING_ENABLED = 'false';

      try {
        const result = await linkedinAdapter.publishPost(
          'test_token_123',
          'urn:li:person:12345',
          {
            title: 'Safety Test Post',
            text: 'This should never hit LinkedIn servers while publishing is off.',
            mediaUrl: 'https://leadersperformance.ae/article',
            mediaType: 'article',
          }
        );

        expect(result.postUrn).toContain('urn:li:share:safety-dry-run-');
        expect(result.postUrl).toContain('https://www.linkedin.com/feed/update/');
      } finally {
        process.env.LINKEDIN_PUBLISHING_ENABLED = previous;
      }
    });

    it('simulates image upload safely when publishing switch is off', async () => {
      const previous = process.env.LINKEDIN_PUBLISHING_ENABLED;
      process.env.LINKEDIN_PUBLISHING_ENABLED = 'false';

      try {
        const urn = await linkedinAdapter.uploadImageToLinkedIn(
          'test_token_123',
          'urn:li:person:12345',
          'https://example.com/test.jpg'
        );

        expect(urn).toContain('urn:li:image:safety-dry-run-');
      } finally {
        process.env.LINKEDIN_PUBLISHING_ENABLED = previous;
      }
    });

    it('simulates video upload safely when publishing switch is off', async () => {
      const previous = process.env.LINKEDIN_PUBLISHING_ENABLED;
      process.env.LINKEDIN_PUBLISHING_ENABLED = 'false';

      try {
        const urn = await linkedinAdapter.uploadVideoToLinkedIn(
          'test_token_123',
          'urn:li:person:12345',
          'https://example.com/test.mp4'
        );

        expect(urn).toContain('urn:li:video:safety-dry-run-');
      } finally {
        process.env.LINKEDIN_PUBLISHING_ENABLED = previous;
      }
    });
  });
});
