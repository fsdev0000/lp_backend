import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { newsletterRouter, validateNewsletterEmail } from '../api/routes/newsletter';

const app = express();
app.use(express.json());
app.use('/api/newsletter', newsletterRouter);

describe('Newsletter Subscription API', () => {
  jest.setTimeout(15000);

  describe('Email Validator Helper', () => {
    it('should reject null or undefined email', () => {
      expect(validateNewsletterEmail(undefined).valid).toBe(false);
      expect(validateNewsletterEmail(null).valid).toBe(false);
    });

    it('should reject empty or whitespace-only email', () => {
      expect(validateNewsletterEmail('').valid).toBe(false);
      expect(validateNewsletterEmail('   ').valid).toBe(false);
    });

    it('should reject invalid email formats', () => {
      expect(validateNewsletterEmail('not-an-email').valid).toBe(false);
      expect(validateNewsletterEmail('john@').valid).toBe(false);
      expect(validateNewsletterEmail('@domain.com').valid).toBe(false);
      expect(validateNewsletterEmail('john@domain').valid).toBe(false);
    });

    it('should accept valid email formats and sanitize input', () => {
      const res = validateNewsletterEmail('  FOUNDER@Company.Com  ');
      expect(res.valid).toBe(true);
      expect(res.email).toBe('founder@company.com');
    });
  });

  describe('POST /api/newsletter/subscribe', () => {
    it('should return 400 for empty request payload', async () => {
      const res = await request(app)
        .post('/api/newsletter/subscribe')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Please enter your email address.');
    });

    it('should return 400 for invalid email format', async () => {
      const res = await request(app)
        .post('/api/newsletter/subscribe')
        .send({ email: 'invalid-email-address' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Please enter a valid email address');
    });

    it('should process a valid email subscription successfully', async () => {
      const testEmail = `test.founder.${Date.now()}@example.com`;
      const res = await request(app)
        .post('/api/newsletter/subscribe')
        .set('x-test-rate-limit', 'bypass')
        .send({ email: testEmail });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.alreadySubscribed).toBe(false);
      expect(res.body.message).toContain('Thank you for subscribing');
    });

    it('should handle duplicate subscription gracefully without erroring out', async () => {
      const duplicateEmail = `duplicate.${Date.now()}@example.com`;

      // Initial subscription
      const res1 = await request(app)
        .post('/api/newsletter/subscribe')
        .set('x-test-rate-limit', 'bypass')
        .send({ email: duplicateEmail });
      expect(res1.status).toBe(200);
      expect(res1.body.alreadySubscribed).toBe(false);

      // Duplicate subscription
      const res2 = await request(app)
        .post('/api/newsletter/subscribe')
        .set('x-test-rate-limit', 'bypass')
        .send({ email: duplicateEmail });
      expect(res2.status).toBe(200);
      expect(res2.body.success).toBe(true);
      expect(res2.body.alreadySubscribed).toBe(true);
      expect(res2.body.message).toContain('already subscribed');
    });
  });

  describe('Unsubscribe API', () => {
    it('should process unsubscribe request successfully', async () => {
      const unsubEmail = `unsub.${Date.now()}@example.com`;

      // First subscribe
      await request(app)
        .post('/api/newsletter/subscribe')
        .set('x-test-rate-limit', 'bypass')
        .send({ email: unsubEmail });

      // Then unsubscribe
      const res = await request(app)
        .post('/api/newsletter/unsubscribe')
        .send({ email: unsubEmail });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('unsubscribed');
    });
  });

  describe('Welcome Email Template', () => {
    it('should verify welcome newsletter HTML template exists and contains required tags', () => {
      const templatePath = path.join(__dirname, '../../templates/welcome-newsletter.html');
      expect(fs.existsSync(templatePath)).toBe(true);

      const content = fs.readFileSync(templatePath, 'utf8');
      expect(content).toContain('The Founder Performance Newsletter');
      expect(content).toContain('{{unsubscribe_url}}');
      expect(content).toContain('Leaders Performance Management Consultancies');
    });
  });
});
