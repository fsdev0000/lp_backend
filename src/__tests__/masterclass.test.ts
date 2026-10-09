import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { masterclassRouter } from '../api/routes/masterclass';

const app = express();
app.use(express.json());
app.use('/masterclass', masterclassRouter);
app.use('/api/v1/masterclass', masterclassRouter);

describe('Masterclass API & Recognition Endpoints', () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_mock_stripe_key';
    process.env.FRONTEND_URL = 'https://leadersperformance.ae';
  });

  describe('Stage 1: Identification, Validation & Registration', () => {
    it('should reject identify request when email is missing or invalid', async () => {
      const res = await request(app)
        .post('/api/v1/masterclass/auth/identify')
        .send({ email: 'not-an-email' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('should reject session creation with missing required fields', async () => {
      const res = await request(app)
        .post('/api/v1/masterclass/create-session')
        .send({
          email: 'alexander@example.com',
          // missing fullName & company
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('VALIDATION_ERROR');
      expect(res.body.details).toHaveProperty('fullName');
      expect(res.body.details).toHaveProperty('company');
    });

    it('should require session_id in verify-payment endpoint', async () => {
      const res = await request(app).get('/api/v1/masterclass/verify-payment');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('MISSING_SESSION_ID');
    });

    it('should require session_id in payment-status endpoint', async () => {
      const res = await request(app).get('/api/v1/masterclass/payment-status');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('MISSING_SESSION_ID');
    });
  });

  describe('Stage 2: Curriculum & Draft Auto-Saving', () => {
    it('should return masterclass modules curriculum and structure', async () => {
      const res = await request(app).get('/api/v1/masterclass/modules');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.totalModules).toBe(4);
      expect(res.body.modules).toHaveLength(4);
      expect(res.body.modules[0].stageNumber).toBe(1);
      expect(res.body.modules[0].title).toBe('Define the Next Stage');
      expect(res.body.modules[3].stageNumber).toBe(4);
      expect(res.body.modules[3].title).toBe('Your Next Move');
    });

    it('should reject saving draft with missing email or invalid stage', async () => {
      const res = await request(app)
        .post('/api/v1/masterclass/save-draft')
        .send({
          email: 'not-valid',
          currentStage: 99, // exceeds 4
          formData: {},
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('should reject draft fetch when email parameter is missing', async () => {
      const res = await request(app).get('/api/v1/masterclass/draft');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('MISSING_EMAIL');
    });
  });

  describe('Stage 3: Workbook Submission & Storage Validation', () => {
    it('should reject workbook submission when required fields are missing', async () => {
      const res = await request(app)
        .post('/api/v1/masterclass/submit-workbook')
        .send({
          participantDetails: {
            fullName: 'Alexander Wright',
            email: 'alexander@example.com',
            company: 'Apex Dynamics',
          },
          formData: {
            // Missing all stage 1-4 fields
            stage1_nextStage: '',
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });
  });

  describe('Stage 4: 1-on-1 Strategic Review Available Slots & Booking', () => {
    it('should return available strategic review slots and timezones', async () => {
      const res = await request(app)
        .get('/api/v1/masterclass/available-slots')
        .query({ timezone: 'GST (UTC+4)' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.timezone).toBe('GST (UTC+4)');
      expect(Array.isArray(res.body.availableSlots)).toBe(true);
      expect(res.body.availableSlots.length).toBeGreaterThan(0);
      expect(Array.isArray(res.body.timezones)).toBe(true);
    });

    it('should reject booking slot when participant info is missing', async () => {
      const res = await request(app)
        .post('/api/v1/masterclass/book-slot')
        .send({
          email: 'alexander@example.com',
          // missing fullName, company, selectedSlot
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('VALIDATION_ERROR');
      expect(res.body.details).toHaveProperty('fullName');
      expect(res.body.details).toHaveProperty('company');
      expect(res.body.details).toHaveProperty('selectedSlot');
    });
  });

  describe('Stage 2: Dynamic Config, 4-Stage Questions & 6 Private Videos', () => {
    it('should return masterclass dynamic config with 4 stages and 6 videos', async () => {
      const res = await request(app).get('/api/v1/masterclass/config');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.stages)).toBe(true);
      expect(res.body.stages.length).toBe(4);
      expect(Array.isArray(res.body.videos)).toBe(true);
      expect(res.body.videos.length).toBe(6);
      expect(res.body.stages[0]).toHaveProperty('questions');
    });

    it('should allow POST /config with email', async () => {
      const res = await request(app)
        .post('/api/v1/masterclass/config')
        .send({ email: 'newfounder@company.com' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.userExists).toBe(false);
      expect(Array.isArray(res.body.videos)).toBe(true);
      expect(Array.isArray(res.body.stages)).toBe(true);
    });

    it('should return 6 video objects with private signed URLs from GET /videos', async () => {
      const res = await request(app).get('/api/v1/masterclass/videos');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.totalVideos).toBe(6);
      expect(res.body.videos).toHaveLength(6);
      expect(res.body.videos[1].fileName).toBe('STAGE -01.mp4');
      expect(res.body.videos[1].signedUrl).toContain('supabase.co');
    });

    it('should allow updating masterclass questions via PUT /config/questions', async () => {
      const res = await request(app)
        .put('/api/v1/masterclass/config/questions')
        .send({ reflectionPauseDurationSeconds: 45 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.config.reflectionPauseDurationSeconds).toBe(45);
    });
  });
});

