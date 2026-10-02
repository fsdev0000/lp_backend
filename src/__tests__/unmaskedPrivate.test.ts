import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { unmaskedPrivateRouter } from '../api/routes/unmaskedPrivate';
import {
  clearRecentSubmissions,
  clearQuestionnaireCache,
  buildUnmaskedBriefingEmail,
} from '../services/unmaskedPrivateService';

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use('/api/unmasked-private', unmaskedPrivateRouter);
app.use('/api/v1/unmasked-private', unmaskedPrivateRouter);

describe('UNMASKED PRIVATE API & Dynamic Questionnaire (/api/unmasked-private)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    clearRecentSubmissions();
    clearQuestionnaireCache();
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
      companyWebsite: 'https://vanceholding.com',
      role: 'Managing Director',
      cityAndCountry: 'Dubai, United Arab Emirates',
    },
    step2: {
      businessResult: 'Decoupling founder dependency and establishing operational governance.',
      attentionNow: 'Expanding to secondary markets requires autonomous operational cadence.',
      outcome90Days: 'Executive team takes 100% ownership of operating margins and hiring.',
      attemptedAlready: 'Appointed general manager but decision bottlenecks persisted.',
    },
    step3: {
      decisionInfluence: 'Tendency to micromanage tactical deliveries during high-pressure cycles.',
      challengeView: 'CTO proposed architectural shift which I initially resisted then endorsed.',
      authorityToAct: 'Yes',
      investmentReadiness: 'FROM_15K_TO_20K',
      availableForCall: 'Yes',
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

  describe('1. Dynamic Questionnaire Endpoint (GET & PUT /questions)', () => {
    it('should return 200 OK and concise Step 2 and Step 3 questionnaire definition from DB', async () => {
      const res = await request(app).get('/api/unmasked-private/questions');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.questionnaire).toBeDefined();

      // Verify Step 1 is NOT in the database questionnaire (it is rendered statically on frontend)
      expect(res.body.questionnaire.step1).toBeUndefined();

      // Verify Step 2 (Your Result)
      const step2 = res.body.questionnaire.step2;
      expect(step2).toBeDefined();
      expect(step2.title).toBe('Your Result');
      const step2QuestionIds = step2.questions.map((q: any) => q.id);
      expect(step2QuestionIds).toEqual([
        'businessResult',
        'attentionNow',
        'outcome90Days',
        'attemptedAlready',
      ]);

      // Verify Step 3 (Your Readiness)
      const step3 = res.body.questionnaire.step3;
      expect(step3).toBeDefined();
      expect(step3.title).toBe('Your Readiness');
      const step3QuestionIds = step3.questions.map((q: any) => q.id);
      expect(step3QuestionIds).toEqual([
        'decisionInfluence',
        'challengeView',
        'authorityToAct',
        'investmentReadiness',
        'availableForCall',
      ]);

      // Verify investment readiness options in Step 3
      const invQuestion = step3.questions.find((q: any) => q.id === 'investmentReadiness');
      expect(invQuestion.options).toHaveLength(6);
      expect(invQuestion.options[0].value).toBe('UP_TO_5K');
      expect(invQuestion.options[5].value).toBe('VALUE_DEPENDENT');
    });

    it('should also be accessible via /api/v1/unmasked-private/questions', async () => {
      const res = await request(app).get('/api/v1/unmasked-private/questions');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.questionnaire.step2).toBeDefined();
      expect(res.body.questionnaire.step3).toBeDefined();
    });
  });

  describe('2. Success Responses & Routing Logic (/apply)', () => {
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
          ...validQualifiedPayload.step3,
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

    it('should accept human-readable string for investment option and route properly', async () => {
      const payload = {
        ...validQualifiedPayload,
        step1: {
          ...validQualifiedPayload.step1,
          email: 'human.readable@example.com',
        },
        step3: {
          ...validQualifiedPayload.step3,
          investmentReadiness: 'AED 20,000 or more',
        },
      };

      const res = await request(app)
        .post('/api/unmasked-private/apply')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe('PENDING_PERSONAL_REVIEW');
    });

    it('should return 200 OK and BELOW_INVESTMENT_THRESHOLD for UP_TO_5K', async () => {
      const payload = {
        ...validQualifiedPayload,
        step1: {
          ...validQualifiedPayload.step1,
          email: 'budget@example.com',
        },
        step3: {
          ...validQualifiedPayload.step3,
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
          ...validQualifiedPayload.step3,
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

  describe('3. Exact Validation Error Messages (400 Bad Request)', () => {
    it('should reject when fullName is missing or too short', async () => {
      const payload = {
        ...validQualifiedPayload,
        step1: { ...validQualifiedPayload.step1, fullName: 'A' },
      };

      const res = await request(app).post('/api/unmasked-private/apply').send(payload);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
      expect(res.body.fields['step1.fullName']).toBe('Please enter your full name.');
    });

    it('should reject when email is invalid', async () => {
      const payload = {
        ...validQualifiedPayload,
        step1: { ...validQualifiedPayload.step1, email: 'not-an-email' },
      };

      const res = await request(app).post('/api/unmasked-private/apply').send(payload);

      expect(res.status).toBe(400);
      expect(res.body.fields['step1.email']).toBe('Please enter your work email.');
    });

    it('should reject when phone is missing or too short', async () => {
      const payload = {
        ...validQualifiedPayload,
        step1: { ...validQualifiedPayload.step1, phone: '' },
      };

      const res = await request(app).post('/api/unmasked-private/apply').send(payload);

      expect(res.status).toBe(400);
      expect(res.body.fields['step1.phone']).toBe('Please enter your mobile or WhatsApp number.');
    });

    it('should reject when companyName is missing', async () => {
      const payload = {
        ...validQualifiedPayload,
        step1: { ...validQualifiedPayload.step1, companyName: '' },
      };

      const res = await request(app).post('/api/unmasked-private/apply').send(payload);

      expect(res.status).toBe(400);
      expect(res.body.fields['step1.companyName']).toBe('Please enter your company name.');
    });

    it('should reject when role is missing', async () => {
      const payload = {
        ...validQualifiedPayload,
        step1: { ...validQualifiedPayload.step1, role: '', roleTitle: '' },
      };

      const res = await request(app).post('/api/unmasked-private/apply').send(payload);

      expect(res.status).toBe(400);
      expect(res.body.fields['step1.role']).toBe('Please enter your role.');
    });

    it('should reject when cityAndCountry is missing', async () => {
      const payload = {
        ...validQualifiedPayload,
        step1: { ...validQualifiedPayload.step1, cityAndCountry: '', location: '' },
      };

      const res = await request(app).post('/api/unmasked-private/apply').send(payload);

      expect(res.status).toBe(400);
      expect(res.body.fields['step1.cityAndCountry']).toBe('Please enter your city and country.');
    });

    it('should reject when Step 2 businessResult is missing', async () => {
      const payload = {
        ...validQualifiedPayload,
        step2: { ...validQualifiedPayload.step2, businessResult: '' },
      };

      const res = await request(app).post('/api/unmasked-private/apply').send(payload);

      expect(res.status).toBe(400);
      expect(res.body.fields['step2.businessResult']).toBe('This field is required.');
    });

    it('should reject when Step 2 attentionNow is missing', async () => {
      const payload = {
        ...validQualifiedPayload,
        step2: { ...validQualifiedPayload.step2, attentionNow: '' },
      };

      const res = await request(app).post('/api/unmasked-private/apply').send(payload);

      expect(res.status).toBe(400);
      expect(res.body.fields['step2.attentionNow']).toBe('This field is required.');
    });

    it('should reject when Step 2 outcome90Days is missing', async () => {
      const payload = {
        ...validQualifiedPayload,
        step2: { ...validQualifiedPayload.step2, outcome90Days: '' },
      };

      const res = await request(app).post('/api/unmasked-private/apply').send(payload);

      expect(res.status).toBe(400);
      expect(res.body.fields['step2.outcome90Days']).toBe('This field is required.');
    });

    it('should reject when Step 3 decisionInfluence is missing', async () => {
      const payload = {
        ...validQualifiedPayload,
        step3: { ...validQualifiedPayload.step3, decisionInfluence: '' },
      };

      const res = await request(app).post('/api/unmasked-private/apply').send(payload);

      expect(res.status).toBe(400);
      expect(res.body.fields['step3.decisionInfluence']).toBe('This field is required.');
    });

    it('should reject when Step 3 challengeView is missing', async () => {
      const payload = {
        ...validQualifiedPayload,
        step3: { ...validQualifiedPayload.step3, challengeView: '' },
      };

      const res = await request(app).post('/api/unmasked-private/apply').send(payload);

      expect(res.status).toBe(400);
      expect(res.body.fields['step3.challengeView']).toBe('This field is required.');
    });

    it('should reject when Step 3 authorityToAct is missing', async () => {
      const payload = {
        ...validQualifiedPayload,
        step3: { ...validQualifiedPayload.step3, authorityToAct: '' },
      };

      const res = await request(app).post('/api/unmasked-private/apply').send(payload);

      expect(res.status).toBe(400);
      expect(res.body.fields['step3.authorityToAct']).toBe('Please select an option.');
    });

    it('should reject when Step 3 investmentReadiness is invalid', async () => {
      const payload = {
        ...validQualifiedPayload,
        step3: { ...validQualifiedPayload.step3, investmentReadiness: 'INVALID_INVESTMENT' },
      };

      const res = await request(app).post('/api/unmasked-private/apply').send(payload);

      expect(res.status).toBe(400);
      expect(res.body.fields['step3.investmentReadiness']).toBe('Please select an option.');
    });

    it('should reject when Step 3 availableForCall is missing', async () => {
      const payload = {
        ...validQualifiedPayload,
        step3: { ...validQualifiedPayload.step3, availableForCall: '' },
      };

      const res = await request(app).post('/api/unmasked-private/apply').send(payload);

      expect(res.status).toBe(400);
      expect(res.body.fields['step3.availableForCall']).toBe('Please select an option.');
    });

    it('should reject when privacyConsent is false', async () => {
      const payload = {
        ...validQualifiedPayload,
        consent: { privacyConsent: false },
      };

      const res = await request(app).post('/api/unmasked-private/apply').send(payload);

      expect(res.status).toBe(400);
      expect(res.body.fields['consent.privacyConsent']).toBe('Please confirm your consent to continue.');
    });
  });

  describe('4. Duplicate Submission Detection (409 Conflict)', () => {
    it('should reject duplicate submission within the 24-hour window', async () => {
      const email = 'duplicate.check@example.com';
      const payload = {
        ...validQualifiedPayload,
        step1: { ...validQualifiedPayload.step1, email },
      };

      // First submission: Success
      const res1 = await request(app).post('/api/unmasked-private/apply').send(payload);
      expect(res1.status).toBe(200);

      // Second submission with same email: 409 Conflict
      const res2 = await request(app).post('/api/unmasked-private/apply').send(payload);
      expect(res2.status).toBe(409);
      expect(res2.body.success).toBe(false);
      expect(res2.body.error).toBe('DUPLICATE_SUBMISSION');
      expect(res2.body.message).toBe(
        'An application with this email has already been received and is currently under review.'
      );
    });
  });

  describe('5. Rate Limiting Protection (429 Too Many Requests)', () => {
    it('should allow up to 5 requests per IP and block the 6th with 429', async () => {
      const testIp = '198.51.100.77';

      // Send 5 valid requests with distinct emails from same IP
      for (let i = 1; i <= 5; i++) {
        const payload = {
          ...validQualifiedPayload,
          step1: {
            ...validQualifiedPayload.step1,
            email: `executive_${i}@enterprise.ae`,
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
          email: 'executive_6@enterprise.ae',
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

  describe('6. Email Template Generator (buildUnmaskedBriefingEmail)', () => {
    it('should correctly format and populate all questionnaire fields in executive HTML briefing email', () => {
      const { subject, html } = buildUnmaskedBriefingEmail({
        participantName: 'Alexander Vance',
        email: 'a.vance@example.com',
        phone: '+971 50 123 4567',
        companyName: 'Vance Holding Ltd',
        companyWebsite: 'https://vanceholding.com',
        roleTitle: 'Managing Director',
        cityAndCountry: 'Dubai, UAE',
        investmentReadiness: 'FROM_15K_TO_20K',
        referenceNumber: 'UNM-2026-9999',
        submittedAt: '02 Oct 2026 14:00 GST',
        reviewUrl: 'https://app.gohighlevel.com/contact/123',
        businessResult: 'Decoupling founder dependency and operational scale',
        attentionNow: 'Expanding to regional markets',
        outcome90Days: 'Autonomous management team ownership',
        attemptedAlready: 'Previous management hire was insufficient',
        decisionInfluence: 'Tendency to hold all strategic approvals',
        challengeView: 'CTO altered core product roadmap after debate',
        authorityToAct: 'Yes',
        availableForCall: 'Yes',
      });

      expect(subject).toContain('Alexander Vance');
      expect(subject).toContain('Vance Holding Ltd');
      expect(subject).toContain('UNM-2026-9999');

      // Verify HTML content
      expect(html).toContain('Alexander Vance');
      expect(html).toContain('a.vance@example.com');
      expect(html).toContain('+971 50 123 4567');
      expect(html).toContain('Vance Holding Ltd');
      expect(html).toContain('https://vanceholding.com');
      expect(html).toContain('Managing Director');
      expect(html).toContain('Dubai, UAE');
      expect(html).toContain('Decoupling founder dependency and operational scale');
      expect(html).toContain('Expanding to regional markets');
      expect(html).toContain('Autonomous management team ownership');
      expect(html).toContain('Tendency to hold all strategic approvals');
      expect(html).toContain('CTO altered core product roadmap after debate');
      expect(html).toContain('AED 15,000');
    });
  });
});
