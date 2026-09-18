import request from 'supertest';
import express from 'express';
import { contactRouter } from '../api/routes/contact';

const app = express();
app.use(express.json());
app.use('/api', contactRouter);
app.use('/api/v1', contactRouter);

describe('Contact Us API', () => {
  beforeEach(() => {
    process.env.GHL_BASE = 'https://services.leadconnectorhq.com';
    process.env.GHL_API_KEY = 'pit-mock-test-key';
    process.env.GHL_LOCATION_ID = 'mock-location-id';
  });

  describe('Validation', () => {
    it('should reject requests with missing first name', async () => {
      const res = await request(app)
        .post('/api/contact')
        .send({
          last_name: 'Doe',
          company: 'Acme Corp',
          role: 'CEO',
          email: 'john@example.com',
          message: 'This is a valid enquiry message for testing.',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Please provide your first name.');
    });

    it('should reject requests with invalid email', async () => {
      const res = await request(app)
        .post('/api/v1/contact')
        .send({
          first_name: 'John',
          last_name: 'Doe',
          company: 'Acme Corp',
          role: 'CEO',
          email: 'invalid-email',
          message: 'This is a valid enquiry message for testing.',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Please provide a valid email address');
    });

    it('should reject message that is too short', async () => {
      const res = await request(app)
        .post('/api/contact-us')
        .send({
          first_name: 'John',
          last_name: 'Doe',
          company: 'Acme Corp',
          role: 'CEO',
          email: 'john@example.com',
          message: 'Short',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Description must be at least 10 characters.');
    });

    it('should reject invalid phone characters', async () => {
      const res = await request(app)
        .post('/api/contact')
        .send({
          first_name: 'John',
          last_name: 'Doe',
          company: 'Acme Corp',
          role: 'CEO',
          email: 'john@example.com',
          phone: 'abc-not-phone',
          message: 'This is a valid enquiry message for testing.',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Please provide a valid phone number');
    });
  });

  describe('Successful submission with GHL mocked', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('should accept snake_case payload and process successfully', async () => {
      const mockFetch = jest.fn().mockImplementation((url: string) => {
        if (url.includes('/contacts/upsert')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ contact: { id: 'mock-contact-123' } }),
          });
        }
        if (url.includes('/conversations/messages')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ messageId: 'mock-msg-123' }),
          });
        }
        return Promise.reject(new Error('Unknown URL: ' + url));
      });

      global.fetch = mockFetch as any;

      const res = await request(app)
        .post('/api/v1/contact')
        .send({
          first_name: 'John',
          last_name: 'Doe',
          company: 'Acme Corp',
          role: 'CEO',
          email: 'john.doe@example.com',
          phone: '+971 50 123 4567',
          preferred_contact_method: 'Email',
          message: 'Preparing for global business expansion and leadership realignment.',
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, contactId: 'mock-contact-123' });
      expect(mockFetch).toHaveBeenCalled();
    });

    it('should accept camelCase payload (from React frontend form) and process successfully', async () => {
      const mockFetch = jest.fn().mockImplementation((url: string) => {
        if (url.includes('/contacts/upsert')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ contact: { id: 'mock-contact-456' } }),
          });
        }
        if (url.includes('/conversations/messages')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ messageId: 'mock-msg-456' }),
          });
        }
        return Promise.reject(new Error('Unknown URL: ' + url));
      });

      global.fetch = mockFetch as any;

      const res = await request(app)
        .post('/api/contact-us')
        .send({
          firstName: 'Lionel',
          lastName: 'Smith',
          company: 'Enterprise Partners',
          role: 'Managing Director',
          email: 'lionel.smith@example.com',
          phone: '+971 50 987 6543',
          preferredContact: 'phone',
          preparingFor: 'Preparing for board-level strategic restructuring.',
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, contactId: 'mock-contact-456' });
    });
  });
});
