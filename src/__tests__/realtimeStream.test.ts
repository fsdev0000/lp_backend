import { describe, it, expect, beforeEach } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import http from 'http';
import { analyticsRoutes } from '../modules/analytics/analytics.routes';
import { generateCrmSessionToken } from '../utils/sessionToken';
import { SseStreamManager } from '../modules/analytics/realtime/sseStreamManager';

process.env.CRM_SESSION_SECRET = 'test-crm-session-secret-for-realtime-tests-1234567890';

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use('/api/v1/analytics', analyticsRoutes);

const validAdminToken = generateCrmSessionToken({
  id: 'admin-user-1',
  email: 'admin@leadersperformance.ae',
  role: 'super_admin',
  workspaces: ['leaders_performance', 'lionel_eersteling'],
});

const lionelOnlyToken = generateCrmSessionToken({
  id: 'lionel-manager-1',
  email: 'lionel.manager@example.com',
  role: 'manager',
  workspaces: ['lionel_eersteling'],
});

describe('Realtime SSE Stream & Analytics Route Security', () => {
  beforeEach(() => {
    SseStreamManager.getInstance().resetLimitsForTests();
  });

  it('refuses stream requests without a valid CRM session (401)', async () => {
    const res = await request(app).get('/api/v1/analytics/realtime/stream');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('refuses stream requests with an invalid CRM session token (401)', async () => {
    const res = await request(app)
      .get('/api/v1/analytics/realtime/stream')
      .set('Authorization', 'Bearer invalid-session-token');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('refuses stream requests with an invalid query token (401)', async () => {
    const res = await request(app).get('/api/v1/analytics/realtime/stream?token=invalid-query-token');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('forbids stream request when user lacks access to the requested workspace/domain (403)', async () => {
    const res = await request(app)
      .get('/api/v1/analytics/realtime/stream?domain=leadersperformance.ae')
      .set('Authorization', `Bearer ${lionelOnlyToken}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_WORKSPACE');
  });

  it('connects to stream via Authorization Bearer header (CRM frontend mode)', (done) => {
    const server = app.listen(0, () => {
      const port = (server.address() as any).port;

      const req = http.get(
        `http://localhost:${port}/api/v1/analytics/realtime/stream?domain=leadersperformance.ae`,
        {
          headers: {
            Authorization: `Bearer ${validAdminToken}`,
          },
        },
        (res: any) => {
          expect(res.statusCode).toBe(200);
          expect(res.headers['content-type']).toBe('text/event-stream');
          expect(res.headers['cache-control']).toBe('no-cache, no-transform');
          expect(res.headers['connection']).toBe('keep-alive');

          let buffer = '';
          res.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            if (buffer.includes('initial_state')) {
              expect(buffer).toContain(':connected');
              expect(buffer).toContain('initial_state');
              expect(buffer).toContain('leadersperformance.ae');
              res.destroy();
              server.close(done);
            }
          });
        }
      );

      req.on('error', (err: any) => {
        server.close(() => done(err));
      });
    });
  });

  it('connects to stream via ?token= query parameter (EventSource mode)', (done) => {
    const server = app.listen(0, () => {
      const port = (server.address() as any).port;

      const req = http.get(
        `http://localhost:${port}/api/v1/analytics/realtime/stream?domain=leadersperformance.ae&token=${encodeURIComponent(
          validAdminToken
        )}`,
        (res: any) => {
          expect(res.statusCode).toBe(200);
          expect(res.headers['content-type']).toBe('text/event-stream');

          let buffer = '';
          res.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            if (buffer.includes('initial_state')) {
              expect(buffer).toContain(':connected');
              expect(buffer).toContain('initial_state');
              res.destroy();
              server.close(done);
            }
          });
        }
      );

      req.on('error', (err: any) => {
        server.close(() => done(err));
      });
    });
  });

  it('enforces per-IP connection limit using req.ip and prevents bypass via spoofed X-Forwarded-For', async () => {
    // Under trust proxy: 1, Express treats socket address (127.0.0.1) as 1 trusted hop.
    // In X-Forwarded-For: "spoofed-client-prefix, 203.0.113.195",
    // the address 1 hop back from socket is 203.0.113.195, so req.ip is 203.0.113.195.
    // Even if an attacker changes the prefix ("attacker-1", "attacker-2"), req.ip remains 203.0.113.195.
    const realClientHop = '203.0.113.195';
    const openResponses: any[] = [];
    const server = app.listen(0);
    const port = (server.address() as any).port;

    try {
      // Open 5 connections (the maximum allowed per IP) with varying spoofed prefixes
      for (let i = 0; i < 5; i++) {
        await new Promise<void>((resolve, reject) => {
          const req = http.get(
            `http://localhost:${port}/api/v1/analytics/realtime/stream?domain=leadersperformance.ae`,
            {
              headers: {
                Authorization: `Bearer ${validAdminToken}`,
                'X-Forwarded-For': `fake-attacker-prefix-${i}, ${realClientHop}`,
              },
            },
            (res) => {
              expect(res.statusCode).toBe(200);
              openResponses.push(res);
              resolve();
            }
          );
          req.on('error', reject);
        });
      }

      // The 6th connection from the same IP (despite another spoofed prefix) must be rejected with 429
      const sixthRes = await request(app)
        .get('/api/v1/analytics/realtime/stream?domain=leadersperformance.ae')
        .set('Authorization', `Bearer ${validAdminToken}`)
        .set('X-Forwarded-For', `fake-attacker-prefix-999, ${realClientHop}`);

      expect(sixthRes.status).toBe(429);
      expect(sixthRes.body.error).toContain('Too many SSE connections from this IP');
    } finally {
      // Clean up open connections
      for (const res of openResponses) {
        res.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('GET /api/v1/analytics/overview remains strictly protected against unauthorized access', async () => {
    const oldNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      const res = await request(app).get('/api/v1/analytics/overview');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    } finally {
      process.env.NODE_ENV = oldNodeEnv;
    }
  });
});
