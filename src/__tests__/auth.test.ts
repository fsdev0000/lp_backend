import { describe, it, expect, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { authRouter } from '../api/routes/auth.routes';

const app = express();
app.use(express.json());
app.use('/api/v1/auth', authRouter);

describe('Authentication & CRM Staff Access Suite', () => {
  const TEST_ADMIN_KEY = 'test-crm-admin-key-2026';
  const CRM_ADMIN_EMAIL = 'admin@leadersperformance.ae';
  const CRM_ADMIN_PASS = 'TestAdminPass123!';

  beforeAll(() => {
    process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
    process.env.CRM_API_KEY = TEST_ADMIN_KEY;
    process.env.CRM_ADMIN_EMAIL = CRM_ADMIN_EMAIL;
    process.env.CRM_ADMIN_PASSWORD = CRM_ADMIN_PASS;
  });

  it('rejects POST /api/v1/auth/login when email or password is missing', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@leadersperformance.ae' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('Email and password are required');
  });

  it('rejects POST /api/v1/auth/login with invalid credentials', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@leadersperformance.ae', password: 'WrongPassword' });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('authenticates POST /api/v1/auth/login successfully and returns user profile and token', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: CRM_ADMIN_EMAIL, password: CRM_ADMIN_PASS });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.email).toBe(CRM_ADMIN_EMAIL);
    expect(res.body.user.role).toBe('admin');
    expect(res.body.token).toBeDefined();
  });

  it('GET /api/v1/auth/me rejects unauthenticated request with 401', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });

  it('GET /api/v1/auth/me succeeds with valid Bearer token', async () => {
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${TEST_ADMIN_KEY}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

