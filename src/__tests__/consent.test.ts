import request from 'supertest';
import express from 'express';
import { consentRoutes } from '../api/routes/consent';
import { PrismaClient } from '@prisma/client';

const app = express();
app.use(express.json());
// Trust proxy is usually required for rate limiting to work with req.ip in tests if we mock IPs
app.set('trust proxy', 1);
app.use('/api/v1/consent', consentRoutes);

const prisma = new PrismaClient();

describe('Consent Audit Service', () => {
  jest.setTimeout(30000);

  const validPayload = {
    consentId: '123e4567-e89b-12d3-a456-426614174000',
    anonymousId: '987e6543-e21b-12d3-a456-426614174111',
    eventType: 'ACCEPT_ALL',
    strictlyNecessary: true,
    functional: true,
    analytics: true,
    marketing: true,
    personalization: true,
    policyVersion: '1.0.0',
    bannerVersion: 'v2',
    jurisdiction: 'EU',
    idempotencyKey: 'test-key-' + Date.now(),
  };

  afterAll(async () => {
    // Clean up
    await prisma.consentAuditLog.deleteMany({
      where: {
        consentId: '123e4567-e89b-12d3-a456-426614174000'
      }
    });
    
    await prisma.consentAuditLog.deleteMany({
      where: {
        consentId: '123e4567-e89b-12d3-a456-426614174001'
      }
    });
    await prisma.$disconnect();
  });

  it('should securely accept valid consent events and create audit record', async () => {
    const res = await request(app)
      .post('/api/v1/consent/log')
      .set('x-forwarded-for', '192.168.1.1')
      .set('user-agent', 'Jest Test Agent')
      .send(validPayload);
      
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.message).toBe('Consent transition logged.');

    const record = await prisma.consentAuditLog.findUnique({
      where: { id: res.body.id }
    });
    expect(record).not.toBeNull();
    expect(record?.consentId).toBe(validPayload.consentId);
    expect(record?.idempotencyKey).toBe(validPayload.idempotencyKey);
    // Ensure IP is hashed and not plaintext '192.168.1.1'
    expect(record?.ipAddress).not.toBe('192.168.1.1');
    expect(record?.ipAddress?.length).toBe(16);
  });

  it('should prevent duplicate network requests (Idempotency)', async () => {
    const res = await request(app)
      .post('/api/v1/consent/log')
      .send(validPayload);
      
    expect(res.status).toBe(200); // Idempotent response
    expect(res.body.message).toBe('Consent transition already logged.');
  });

  it('should validate incoming payload and reject invalid data', async () => {
    const invalidPayload = {
      consentId: 'not-a-uuid',
      eventType: 'INVALID_TYPE',
      policyVersion: '', // too short
    };
    
    const res = await request(app)
      .post('/api/v1/consent/log')
      .send(invalidPayload);
      
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid consent payload');
  });

  it('should enforce rate limiting', async () => {
    const limitPayload = { ...validPayload, consentId: '123e4567-e89b-12d3-a456-426614174001' };
    
    // Send 10 valid requests
    for (let i = 0; i < 10; i++) {
      limitPayload.idempotencyKey = 'limit-key-' + i;
      await request(app)
        .post('/api/v1/consent/log')
        .set('x-forwarded-for', '10.0.0.1')
        .send(limitPayload);
    }
    
    // The 11th request should be rate limited
    limitPayload.idempotencyKey = 'limit-key-11';
    const res = await request(app)
      .post('/api/v1/consent/log')
      .set('x-forwarded-for', '10.0.0.1')
      .send(limitPayload);
      
    expect(res.status).toBe(429); // Too Many Requests
  });
});
