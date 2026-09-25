import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { contactRouter } from '../api/routes/contact';
import { assessmentRateLimiter, contactRateLimiter, createRateLimiter } from '../middleware/rateLimiter';

// Create test app with trust proxy enabled matching production server.ts setup
const app = express();
app.set('trust proxy', 1);
app.use(express.json());

// Mock handler to track if execution reaches form processing
const mockAssessmentHandler = jest.fn((req: express.Request, res: express.Response) => {
  res.status(201).json({ success: true, message: 'Assessment processed' });
});

// Mount test endpoints
app.post('/api/v1/assessments/submit', assessmentRateLimiter, mockAssessmentHandler);
app.use('/api', contactRouter);
app.use('/api/v1', contactRouter);

describe('Public Form Submission Rate Limiter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GHL_BASE = 'https://services.leadconnectorhq.com';
    process.env.GHL_API_KEY = 'pit-mock-test-key';
    process.env.GHL_LOCATION_ID = 'mock-location-id';
  });

  describe('1. POST /assessments/submit Rate Limiting', () => {
    const testIpA = '198.51.100.10';
    const testIpB = '198.51.100.20';

    it('allows requests 1-5 from the same IP, returns 429 on request 6, and does not reach processing logic', async () => {
      // Requests 1 to 5: must succeed and reach the handler
      for (let i = 1; i <= 5; i++) {
        const res = await request(app)
          .post('/api/v1/assessments/submit')
          .set('x-forwarded-for', testIpA)
          .send({ founder: { name: 'Test' }, answers: [1, 2, 3] });

        expect(res.status).toBe(201);
        expect(res.body).toEqual({ success: true, message: 'Assessment processed' });
      }

      expect(mockAssessmentHandler).toHaveBeenCalledTimes(5);

      // Request 6: must return 429 Too Many Requests
      const res6 = await request(app)
        .post('/api/v1/assessments/submit')
        .set('x-forwarded-for', testIpA)
        .send({ founder: { name: 'Test' }, answers: [1, 2, 3] });

      expect(res6.status).toBe(429);
      expect(res6.body).toEqual({
        error: 'Too many requests. Please try again later.',
      });

      // Verification: blocked request did NOT reach form-processing logic
      expect(mockAssessmentHandler).toHaveBeenCalledTimes(5);
    });

    it('isolates rate limits so a different IP address has its own independent limit', async () => {
      // testIpB should be allowed despite testIpA being rate limited
      const res = await request(app)
        .post('/api/v1/assessments/submit')
        .set('x-forwarded-for', testIpB)
        .send({ founder: { name: 'Founder B' }, answers: [4, 5, 6] });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ success: true, message: 'Assessment processed' });
    });

    it('allows IP to submit again after the rate limit window is reset/expired', async () => {
      // Reset the in-memory window for testIpA
      assessmentRateLimiter.resetKey(testIpA);

      const res = await request(app)
        .post('/api/v1/assessments/submit')
        .set('x-forwarded-for', testIpA)
        .send({ founder: { name: 'Reset Test' }, answers: [1, 2, 3] });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ success: true, message: 'Assessment processed' });
    });
  });

  describe('2. POST /contact Rate Limiting', () => {
    const contactIpA = '203.0.113.50';
    const contactIpB = '203.0.113.60';

    const validContactPayload = {
      first_name: 'Jane',
      last_name: 'Smith',
      company: 'Acme Corp',
      role: 'CTO',
      email: 'jane@example.com',
      message: 'Testing contact rate limiter protection.',
    };

    it('allows requests 1-5 from the same IP on POST /contact and blocks request 6 with 429', async () => {
      // Requests 1 to 5: allowed through (returns 400 validation or 200, but NOT 429)
      for (let i = 1; i <= 5; i++) {
        const res = await request(app)
          .post('/api/contact')
          .set('x-forwarded-for', contactIpA)
          .send({
            ...validContactPayload,
            // Invalid email triggers validation error inside the handler, proving request reached handler
            email: 'invalid-email',
          });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('valid email address');
      }

      // Request 6: blocked at middleware level with HTTP 429
      const res6 = await request(app)
        .post('/api/contact')
        .set('x-forwarded-for', contactIpA)
        .send(validContactPayload);

      expect(res6.status).toBe(429);
      expect(res6.body).toEqual({
        error: 'Too many requests. Please try again later.',
      });
    });

    it('isolates rate limits so a second IP address can submit to /contact', async () => {
      const res = await request(app)
        .post('/api/contact')
        .set('x-forwarded-for', contactIpB)
        .send({
          ...validContactPayload,
          email: 'invalid-email',
        });

      // Should reach handler validation rather than 429
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('valid email address');
    });

    it('also protects POST /contact-us alias endpoint', async () => {
      // contactIpA is already at 5 requests, so /contact-us must also return 429
      const res = await request(app)
        .post('/api/contact-us')
        .set('x-forwarded-for', contactIpA)
        .send(validContactPayload);

      expect(res.status).toBe(429);
      expect(res.body).toEqual({
        error: 'Too many requests. Please try again later.',
      });
    });

    it('allows IP to submit again after the rate limit window expires/resets', async () => {
      contactRateLimiter.resetKey(contactIpA);

      const res = await request(app)
        .post('/api/contact')
        .set('x-forwarded-for', contactIpA)
        .send({
          ...validContactPayload,
          email: 'invalid-email',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('valid email address');
    });
  });

  describe('3. Window Expiration Simulation', () => {
    it('automatically allows submissions after windowMs expires', async () => {
      // Test short window (50ms) to verify native timer expiration
      const shortLimiter = createRateLimiter({ windowMs: 50, limit: 1 });
      const expApp = express();
      expApp.set('trust proxy', 1);
      expApp.post('/test-expiry', shortLimiter, (_req, res) => res.json({ ok: true }));

      const testIp = '198.51.100.99';

      // 1st request succeeds
      const r1 = await request(expApp).post('/test-expiry').set('x-forwarded-for', testIp);
      expect(r1.status).toBe(200);

      // 2nd request immediately fails with 429
      const r2 = await request(expApp).post('/test-expiry').set('x-forwarded-for', testIp);
      expect(r2.status).toBe(429);
      expect(r2.body).toEqual({ error: 'Too many requests. Please try again later.' });

      // Wait for window to expire (>50ms)
      await new Promise((resolve) => setTimeout(resolve, 60));

      // 3rd request succeeds again
      const r3 = await request(expApp).post('/test-expiry').set('x-forwarded-for', testIp);
      expect(r3.status).toBe(200);
    });
  });
});
