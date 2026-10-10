import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { PrismaClient } from '@prisma/client';
import { masterclassRouter } from '../api/routes/masterclass';

const prisma = new PrismaClient();

const app = express();
app.use(express.json());
app.use('/masterclass', masterclassRouter);
app.use('/api/v1/masterclass', masterclassRouter);

describe('Masterclass API & Recognition Endpoints', () => {
  beforeAll(async () => {
    await prisma.masterclassBooking.deleteMany({
      where: {
        OR: [
          { email: { in: ['founder_alpha@enterprise.com', 'founder_beta@enterprise.com'] } },
          { slotTime: { contains: '2026-11-10' } },
          { slotTime: { contains: '2026-11-11' } },
          { slotTime: { contains: '2026-11-12' } },
        ],
      },
    });
  });

  afterAll(async () => {
    await prisma.masterclassBooking.deleteMany({
      where: {
        OR: [
          { email: { in: ['founder_alpha@enterprise.com', 'founder_beta@enterprise.com'] } },
          { slotTime: { contains: '2026-11-10' } },
          { slotTime: { contains: '2026-11-11' } },
          { slotTime: { contains: '2026-11-12' } },
        ],
      },
    });
    await prisma.$disconnect();
  });

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

    it('should reject draft save when an answer exceeds 1,000 characters', async () => {
      const res = await request(app)
        .post('/api/v1/masterclass/save-draft')
        .send({
          email: 'alexander@example.com',
          currentStage: 1,
          formData: {
            stage1_nextStage: 'A'.repeat(1001),
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('VALIDATION_ERROR');
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

    it('should reject workbook submission when an answer exceeds 1,000 characters', async () => {
      const res = await request(app)
        .post('/api/v1/masterclass/submit-workbook')
        .send({
          participantDetails: {
            fullName: 'Alexander Wright',
            email: 'alexander@example.com',
            company: 'Apex Dynamics',
          },
          formData: {
            stage1_nextStage: 'A'.repeat(1005),
            stage1_possibility: 'Valid unlock',
            stage1_strength: 'Valid strength',
            stage2_changes: 'Valid changes',
            stage2_demand1: 'Valid demand',
            stage2_investment: 'Valid investment',
            stage3_founderStrength: 'Valid standard',
            stage3_teamStrength: 'Valid team standard',
            stage3_orgStrength: 'Valid org standard',
            stage4_priority90Days: 'Valid priority',
            stage4_action7Days: 'Valid action',
            stage4_evidence: 'Valid evidence',
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
    }, 10000);

    it('should return exact 3 canonical slots (1:30 PM, 2:30 PM, 3:30 PM) for a specific date', async () => {
      const res = await request(app)
        .get('/api/v1/masterclass/available-slots')
        .query({ date: '2026-11-09', timezone: 'GST (UTC+4)' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.slots).toHaveLength(3);
      expect(res.body.slots[0].dubaiLabel).toBe('1:30 PM – 2:15 PM GST');
      expect(res.body.slots[1].dubaiLabel).toBe('2:30 PM – 3:15 PM GST');
      expect(res.body.slots[2].dubaiLabel).toBe('3:30 PM – 4:15 PM GST');
    });

    it('should correctly format slots in participant local timezone (e.g. EST)', async () => {
      const res = await request(app)
        .get('/api/v1/masterclass/available-slots')
        .query({ date: '2026-11-09', timezone: 'EST (UTC-5)' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.slots).toHaveLength(3);
      expect(res.body.slots[0].localRange).toContain('4:30 AM');
      expect(res.body.slots[1].localRange).toContain('5:30 AM');
      expect(res.body.slots[2].localRange).toContain('6:30 AM');
    });

    it('should return month availability mapping for DaisyBookingScreen calendar widget', async () => {
      const res = await request(app)
        .get('/api/v1/masterclass/availability/month')
        .query({ year: 2026, month: 11 });

      expect(res.status).toBe(200);
      expect(typeof res.body).toBe('object');
      expect(res.body).toHaveProperty('2026-11-09');
      expect(Array.isArray(res.body['2026-11-09'])).toBe(true);
      expect(res.body['2026-11-09']).toEqual(expect.arrayContaining(['13:30', '14:30', '15:30']));
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

    it('should prevent overlapping or duplicate bookings with 409 Conflict', async () => {
      // First booking
      const res1 = await request(app)
        .post('/api/v1/masterclass/book-slot')
        .send({
          email: 'founder_alpha@enterprise.com',
          fullName: 'Founder Alpha',
          company: 'Alpha Corp',
          selectedSlot: '2026-11-10 at 1:30 PM – 2:15 PM',
          timezone: 'GST (UTC+4)',
          submissionRef: 'FNM-2026-ALPHA',
        });

      expect(res1.status).toBe(200);
      expect(res1.body.success).toBe(true);
      expect(res1.body.bookingRef).toMatch(/^MBK-2026-\d{4}$/);

      // Attempt conflicting booking for same date and slot
      const res2 = await request(app)
        .post('/api/v1/masterclass/book-slot')
        .send({
          email: 'founder_beta@enterprise.com',
          fullName: 'Founder Beta',
          company: 'Beta Corp',
          selectedSlot: '2026-11-10 at 1:30 PM – 2:15 PM',
          timezone: 'GST (UTC+4)',
          submissionRef: 'FNM-2026-BETA',
        });

      expect(res2.status).toBe(409);
      expect(res2.body.success).toBe(false);
      expect(res2.body.message).toContain('no longer available');

      // Reschedule first booking to a different time
      const resResched = await request(app)
        .post('/api/v1/masterclass/reschedule')
        .send({
          bookingRef: res1.body.bookingRef,
          newDate: '2026-11-11',
          newSlotTime: '2:30 PM – 3:15 PM',
          timezone: 'GST (UTC+4)',
          reason: 'Founder board meeting rescheduled',
        });

      expect(resResched.status).toBe(200);
      expect(resResched.body.success).toBe(true);
      expect(resResched.body.slotTime).toContain('2026-11-11');
    }, 30000);
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
      expect(res.body).toHaveProperty('thumbnails');
      expect(res.body.thumbnails).toHaveProperty('welcome');
      expect(res.body.thumbnails).toHaveProperty('stage1');
      expect(res.body.thumbnails).toHaveProperty('stage2');
      expect(res.body.thumbnails).toHaveProperty('stage3');
      expect(res.body.thumbnails).toHaveProperty('stage4');
      expect(res.body.thumbnails).toHaveProperty('closing');
      expect(res.body.thumbnails.welcome).toContain('supabase.co');
    }, 15000);

    it('should allow POST /config with email', async () => {
      const res = await request(app)
        .post('/api/v1/masterclass/config')
        .send({ email: 'newfounder@company.com' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.userExists).toBe(false);
      expect(Array.isArray(res.body.videos)).toBe(true);
      expect(Array.isArray(res.body.stages)).toBe(true);
      expect(res.body.stages[0]).toHaveProperty('thumbnailUrl');
    }, 15000);

    it('should return 6 video objects with private signed URLs and thumbnails from GET /videos', async () => {
      const res = await request(app).get('/api/v1/masterclass/videos');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.totalVideos).toBe(6);
      expect(res.body.videos).toHaveLength(6);
      expect(res.body.videos[1].fileName).toBe('STAGE-01.mp4');
      expect(res.body.videos[1].signedUrl).toContain('supabase.co');
      expect(res.body.videos[1].thumbnailFileName).toBe('STAGE-01.jpg');
      expect(res.body.videos[1].thumbnailUrl).toContain('supabase.co');
    }, 15000);

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

