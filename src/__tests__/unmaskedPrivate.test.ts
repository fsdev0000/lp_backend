import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { unmaskedPrivateRouter } from '../api/routes/unmaskedPrivate';
import { clearRecentSubmissions } from '../services/unmaskedPrivateService';
import * as ghlService from '../services/ghl';

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use('/api/unmasked-private', unmaskedPrivateRouter);
app.use('/api/v1/unmasked-private', unmaskedPrivateRouter);

describe('UNMASKED PRIVATE API (/api/unmasked-private/apply)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    clearRecentSubmissions();
    jest.clearAllMocks();

    process.env.GHL_BASE = 'https://services.leadconnectorhq.com';
    process.env.GHL_API_KEY = 'pit-mock-test-key';
    process.env.GHL_LOCATION_ID = 'mock-location-id';

    const mockFetch = jest.fn<any>().mockImplementation((url: any) => {
      const urlStr = String(url);
      if (urlStr.includes('/contacts/upsert')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ contact: { id: 'mock-contact-123' } }),
        });
      }
      if (urlStr.includes('/conversations/messages')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ messageId: 'mock-msg-123' }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      });
    });

    global.fetch = mockFetch as any;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const validQualifiedPayload = {
    step1: {
      fullName: 'Alexander Vance',
      email: 'a.vance@example.com',
      phone: '+971 50 123 4567',
      companyName: 'Vance Holding Ltd',
      roleTitle: 'Managing Director',
    },
    step2: {
      contextAnswers: {
        currentChallenge: 'Scaling executive leadership team',
        teamSize: '50-100',
      },
    },
    step3: {
      investmentReadiness: 'FROM_15K_TO_20K',
    },
    consent: {
      privacyConsent: true,
      privacyPolicyVersion: '2026.1',
    },
    tracking: {
      utm_source: 'linkedin',
      utm_medium: 'ad',
      utm_campaign: 'q1_private',
    },
  };

  describe('1. Success Responses & Routing Logic', () => {
    it('should return 200 OK and PENDING_PERSONAL_REVIEW for qualified investment (AED 15k - 20k)', async () => {
      const res = await request(app)
        .post('/api/unmasked-private/apply')
        .send(validQualifiedPayload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.outcome).toBe('PENDING_PERSONAL_REVIEW');
      expect(res.body.redirectUrl).toBe('/unmasked-private/thank-you');
      expect(res.body.referenceNumber).toMatch(/^UNM-\d{4}-\d{4}$/);
      expect(res.body.applicationId).toMatch(/^unm_app_/);
    });

    it('should return 200 OK and PENDING_PERSONAL_REVIEW for VALUE_DEPENDENT answer', async () => {
      const payload = {
        ...validQualifiedPayload,
        step1: {
          ...validQualifiedPayload.step1,
          email: 'value.dependent@example.com',
        },
        step3: {
          investmentReadiness: 'VALUE_DEPENDENT',
        },
      };

      const res = await request(app)
        .post('/api/v1/unmasked-private/apply')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.outcome).toBe('PENDING_PERSONAL_REVIEW');
      expect(res.body.redirectUrl).toBe('/unmasked-private/thank-you');
    });

    it('should return 200 OK and BELOW_INVESTMENT_THRESHOLD for UP_TO_5K', async () => {
      const payload = {
        ...validQualifiedPayload,
        step1: {
          ...validQualifiedPayload.step1,
          email: 'budget@example.com',
        },
        step3: {
          investmentReadiness: 'UP_TO_5K',
        },
      };

      const res = await request(app)
        .post('/api/unmasked-private/apply')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.outcome).toBe('BELOW_INVESTMENT_THRESHOLD');
      expect(res.body.redirectUrl).toBe('/unmasked-private/not-ready-yet');
      expect(res.body.referenceNumber).toMatch(/^UNM-\d{4}-\d{4}$/);
    });

    it('should return 200 OK and BELOW_INVESTMENT_THRESHOLD for FROM_5K_TO_10K', async () => {
      const payload = {
        ...validQualifiedPayload,
        step1: {
          ...validQualifiedPayload.step1,
          email: 'under10k@example.com',
        },
        step3: {
          investmentReadiness: 'FROM_5K_TO_10K',
        },
      };

      const res = await request(app)
        .post('/api/unmasked-private/apply')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.outcome).toBe('BELOW_INVESTMENT_THRESHOLD');
      expect(res.body.redirectUrl).toBe('/unmasked-private/not-ready-yet');
    });
  });

  describe('2. Validation & Error Handling (400 Bad Request)', () => {
    it('should reject request when email is invalid', async () => {
      const payload = {
        ...validQualifiedPayload,
        step1: {
          ...validQualifiedPayload.step1,
          email: 'not-an-email',
        },
      };

      const res = await request(app)
        .post('/api/unmasked-private/apply')
        .send(payload);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('VALIDATION_ERROR');
      expect(res.body.message).toBe('Please correct the highlighted fields.');
      expect(res.body.fields['step1.email']).toBe('A valid corporate email address is required.');
    });

    it('should reject request when fullName is too short', async () => {
      const payload = {
        ...validQualifiedPayload,
        step1: {
          ...validQualifiedPayload.step1,
          fullName: 'A',
        },
      };

      const res = await request(app)
        .post('/api/unmasked-private/apply')
        .send(payload);

      expect(res.status).toBe(400);
      expect(res.body.fields['step1.fullName']).toBe('Full name must be at least 2 characters.');
    });

    it('should reject request when privacyConsent is not granted', async () => {
      const payload = {
        ...validQualifiedPayload,
        consent: {
          privacyConsent: false,
        },
      };

      const res = await request(app)
        .post('/api/unmasked-private/apply')
        .send(payload);

      expect(res.status).toBe(400);
      expect(res.body.fields['consent.privacyConsent']).toBe('Privacy consent must be explicitly granted.');
    });

    it('should reject request when investmentReadiness is invalid option', async () => {
      const payload = {
        ...validQualifiedPayload,
        step3: {
          investmentReadiness: 'INVALID_OPTION',
        },
      };

      const res = await request(app)
        .post('/api/unmasked-private/apply')
        .send(payload);

      expect(res.status).toBe(400);
      expect(res.body.fields['step3.investmentReadiness']).toBe('Please select an investment readiness option.');
    });
  });

  describe('3. Duplicate Submission Detection (409 Conflict)', () => {
    it('should reject duplicate submission within the 24-hour window', async () => {
      const email = 'duplicate.check@example.com';
      const payload = {
        ...validQualifiedPayload,
        step1: {
          ...validQualifiedPayload.step1,
          email,
        },
      };

      // First submission: Success
      const res1 = await request(app)
        .post('/api/unmasked-private/apply')
        .send(payload);
      expect(res1.status).toBe(200);

      // Second submission with same email: 409 Conflict
      const res2 = await request(app)
        .post('/api/unmasked-private/apply')
        .send(payload);

      expect(res2.status).toBe(409);
      expect(res2.body.success).toBe(false);
      expect(res2.body.error).toBe('DUPLICATE_SUBMISSION');
      expect(res2.body.message).toBe(
        'An application with this email has already been received and is currently under review.'
      );
    });
  });

  describe('4. Rate Limiting Protection (429 Too Many Requests)', () => {
    it('should allow up to 5 requests per IP and block the 6th with 429', async () => {
      const testIp = '198.51.100.55';

      // Send 5 valid requests with distinct emails from same IP
      for (let i = 1; i <= 5; i++) {
        const payload = {
          ...validQualifiedPayload,
          step1: {
            ...validQualifiedPayload.step1,
            email: `founder_${i}@enterprise.ae`,
          },
        };

        const res = await request(app)
          .post('/api/unmasked-private/apply')
          .set('x-forwarded-for', testIp)
          .send(payload);

        expect(res.status).toBe(200);
      }

      // 6th request from same IP within the hour: 429 Too Many Requests
      const payload6 = {
        ...validQualifiedPayload,
        step1: {
          ...validQualifiedPayload.step1,
          email: 'founder_6@enterprise.ae',
        },
      };

      const res6 = await request(app)
        .post('/api/unmasked-private/apply')
        .set('x-forwarded-for', testIp)
        .send(payload6);

      expect(res6.status).toBe(429);
      expect(res6.body.error).toBe('TOO_MANY_REQUESTS');
    });
  });

  describe('5. Resilience & Retry Logic (withRetry)', () => {
    it('should retry transient failures and succeed when an operation eventually resolves', async () => {
      const { withRetry } = await import('../services/unmaskedPrivateService');

      let attempts = 0;
      const operation = jest.fn(async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error(`Transient network glitch on attempt ${attempts}`);
        }
        return 'success_payload';
      });

      const result = await withRetry(operation, {
        retries: 3,
        delayMs: 10,
        backoffFactor: 1.5,
        context: 'Test Operation',
      });

      expect(result).toBe('success_payload');
      expect(attempts).toBe(3);
    });

    it('should throw error after exhausting all retries', async () => {
      const { withRetry } = await import('../services/unmaskedPrivateService');

      const operation = jest.fn(async () => {
        throw new Error('Persistent failure');
      });

      await expect(
        withRetry(operation, {
          retries: 3,
          delayMs: 10,
          context: 'Failing Operation',
        })
      ).rejects.toThrow('Persistent failure');
    });
  });
});
