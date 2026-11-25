import { describe, it, expect } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { crmAutomationRouter } from '../modules/automation/crm.routes';

describe('CRM Route Guard Scoping & Public API Route Passthrough', () => {
  const app = express();
  app.use(express.json());

  // Mount crmAutomationRouter at bare prefixes exactly as server.ts does
  app.use('/api/v1', crmAutomationRouter);
  app.use('/api', crmAutomationRouter);

  // Mount mock public routes downstream, exactly as server.ts does
  const publicRouter = express.Router();
  publicRouter.get('/scan/config', (_req, res) => {
    res.status(200).json({ success: true, scanConfig: { ready: true } });
  });
  publicRouter.post('/assessments/submit', (req, res) => {
    if (!req.body || Object.keys(req.body).length === 0) {
      res.status(400).json({ success: false, error: 'Empty payload' });
      return;
    }
    res.status(200).json({ success: true, saved: true });
  });
  publicRouter.get('/bookings/calendar-info', (_req, res) => {
    res.status(200).json({ success: true, calendarId: 'cal-123' });
  });
  publicRouter.get('/terms', (_req, res) => {
    res.status(200).json({ success: true, terms: 'v1.0' });
  });

  app.use('/api/v1', publicRouter);

  // 1. Public route scan/config must pass through with 200, NOT 401
  it('allows public GET /api/v1/scan/config without CRM auth (returns 200, not 401)', async () => {
    const res = await request(app).get('/api/v1/scan/config');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.scanConfig.ready).toBe(true);
  });

  // 2. Public route assessments/submit must pass through with 400 on empty payload, NOT 401
  it('allows public POST /api/v1/assessments/submit without CRM auth (returns 400 for empty body, not 401)', async () => {
    const res = await request(app)
      .post('/api/v1/assessments/submit')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Empty payload');
  });

  // 3. Public route bookings/calendar-info must return 200
  it('allows public GET /api/v1/bookings/calendar-info without CRM auth', async () => {
    const res = await request(app).get('/api/v1/bookings/calendar-info');
    expect(res.status).toBe(200);
    expect(res.body.calendarId).toBe('cal-123');
  });

  // 4. Public route terms must return 200
  it('allows public GET /api/v1/terms without CRM auth', async () => {
    const res = await request(app).get('/api/v1/terms');
    expect(res.status).toBe(200);
  });

  // 5. CRM protected route /posts must STILL be protected (401 with invalid token)
  it('blocks unauthenticated GET /api/v1/posts with 401 Valid CRM session token is required', async () => {
    const res = await request(app)
      .get('/api/v1/posts')
      .set('Authorization', 'Bearer invalid_token');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Valid CRM session token is required.');
  });

  // 6. CRM protected route /inventory must STILL be protected (401 with invalid token)
  it('blocks unauthenticated GET /api/v1/inventory with 401 Valid CRM session token is required', async () => {
    const res = await request(app)
      .get('/api/v1/inventory')
      .set('Authorization', 'Bearer invalid_token');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Valid CRM session token is required.');
  });

  // 7. CRM protected route /accounts must STILL be protected (401 with invalid token)
  it('blocks unauthenticated GET /api/v1/accounts with 401 Valid CRM session token is required', async () => {
    const res = await request(app)
      .get('/api/v1/accounts')
      .set('Authorization', 'Bearer invalid_token');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Valid CRM session token is required.');
  });

  // 8. CRM protected route /settings/notifications must STILL be protected (401 without token)
  it('blocks unauthenticated GET /api/v1/settings/notifications with 401 Valid CRM session token is required', async () => {
    const res = await request(app).get('/api/v1/settings/notifications');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Valid CRM session token is required.');
  });
});
