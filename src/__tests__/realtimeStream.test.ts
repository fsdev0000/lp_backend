import { describe, it, expect } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import http from 'http';
import { analyticsRoutes } from '../modules/analytics/analytics.routes';

const app = express();
app.use(express.json());
app.use('/api/v1/analytics', analyticsRoutes);

describe('Realtime SSE Stream & Analytics Route Security', () => {
  it('GET /api/v1/analytics/realtime/stream is accessible via browser EventSource without 401', (done) => {
    const server = app.listen(0, () => {
      const port = (server.address() as any).port;

      const req = http.get(
        `http://localhost:${port}/api/v1/analytics/realtime/stream?domain=leadersperformance.ae`,
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

  it('GET /api/v1/analytics/overview remains strictly protected against unauthorized access', async () => {
    // In production mode (non-test), verify 401 is enforced
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
