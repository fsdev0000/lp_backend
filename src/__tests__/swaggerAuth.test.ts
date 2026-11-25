import { describe, it, expect } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { swaggerBasicAuth } from '../middleware/swaggerAuth';

const app = express();
app.use('/test-protected', swaggerBasicAuth, (req, res) => {
  res.status(200).json({ access: 'granted' });
});

describe('Swagger HTTP Basic Auth Middleware', () => {
  const originalUser = process.env.SWAGGER_USER;
  const originalPassword = process.env.SWAGGER_PASSWORD;

  beforeEach(() => {
    process.env.SWAGGER_USER = 'admin';
    process.env.SWAGGER_PASSWORD = 'Leaders2026!';
  });

  afterAll(() => {
    process.env.SWAGGER_USER = originalUser;
    process.env.SWAGGER_PASSWORD = originalPassword;
  });

  it('should return 401 Unauthorized with WWW-Authenticate header when credentials are provided but invalid', async () => {
    const wrongAuth = 'Basic ' + Buffer.from('admin:wrongpassword').toString('base64');
    const res = await request(app)
      .get('/test-protected')
      .set('Authorization', wrongAuth);

    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('Basic realm="Leaders Performance API Documentation"');
    expect(res.text).toBe('Invalid credentials.');
  });

  it('should return 200 OK when valid Basic Auth credentials are supplied', async () => {
    const validAuth = 'Basic ' + Buffer.from('admin:Leaders2026!').toString('base64');
    const res = await request(app)
      .get('/test-protected')
      .set('Authorization', validAuth);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ access: 'granted' });
  });

  it('should reject malformed base64 headers gracefully', async () => {
    const res = await request(app)
      .get('/test-protected')
      .set('Authorization', 'Basic malformed-without-colon');

    expect(res.status).toBe(401);
    expect(res.text).toBe('Invalid credentials format.');
  });
});
