import { describe, it, expect, jest, beforeEach, afterAll } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { authRouter, resetAuthRateLimitsForTests } from '../api/routes/auth.routes';
import { clearRevokedTokens, clearRevokedUserSessions } from '../utils/sessionToken';
import {
  setMockSupabaseStorageClient,
  resetSupabaseStorageClient,
} from '../services/supabaseStorageService';

const mockSignInWithPassword = jest.fn();
const mockGetUser = jest.fn();
const mockUpdateUserById = jest.fn();

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use('/api/v1/auth', authRouter);

describe('Authentication & CRM Staff Access Suite', () => {
  const TEST_ADMIN_KEY = 'test-crm-admin-key-2026';
  const CRM_ADMIN_EMAIL = 'admin@leadersperformance.ae';
  const CRM_ADMIN_PASS = 'TestAdminPass123!';

  beforeEach(() => {
    resetAuthRateLimitsForTests();
    clearRevokedTokens();
    clearRevokedUserSessions();
    process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
    process.env.CRM_API_KEY = TEST_ADMIN_KEY;
    process.env.CRM_ADMIN_EMAIL = CRM_ADMIN_EMAIL;
    process.env.CRM_ADMIN_PASSWORD = CRM_ADMIN_PASS;
    process.env.CRM_SESSION_SECRET = 'test-crm-session-secret-xyz12345';
    process.env.SUPABASE_URL = 'https://mock.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-service-role-key';

    mockSignInWithPassword.mockReset();
    mockGetUser.mockReset();
    mockUpdateUserById.mockReset();

    setMockSupabaseStorageClient({
      auth: {
        signInWithPassword: (...args: any[]) => mockSignInWithPassword(...args),
        getUser: (...args: any[]) => mockGetUser(...args),
        admin: {
          updateUserById: (...args: any[]) => mockUpdateUserById(...args),
        },
      },
    });

    // Default mock implementation: check admin credentials against CRM_ADMIN_EMAIL & CRM_ADMIN_PASS
    mockSignInWithPassword.mockImplementation(async ({ email, password }: any) => {
      if (
        email?.trim().toLowerCase() === CRM_ADMIN_EMAIL.toLowerCase() &&
        password === CRM_ADMIN_PASS
      ) {
        return {
          data: {
            session: { access_token: 'mock-sb-token' },
            user: {
              id: 'test-admin-id',
              email: CRM_ADMIN_EMAIL,
              email_confirmed_at: new Date().toISOString(),
              app_metadata: {
                role: 'admin',
                name: 'Test Administrator',
                workspaces: ['leaders_performance', 'lionel_eersteling'],
                roleVersion: 2,
                status: 'active',
              },
            },
          },
          error: null,
        };
      }
      return {
        data: { session: null, user: null },
        error: { message: 'Invalid login credentials' },
      };
    });
  });

  afterAll(() => {
    resetSupabaseStorageClient();
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

  it('authenticates POST /api/v1/auth/login successfully and returns user profile and expiring session token', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: CRM_ADMIN_EMAIL, password: CRM_ADMIN_PASS });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.email).toBe(CRM_ADMIN_EMAIL);
    expect(res.body.user.role).toBe('admin');
    expect(res.body.token).toBeDefined();
    // Must be a signed expiring session token (lp_sess.*), NEVER the master API key
    expect(res.body.token.startsWith('lp_sess.')).toBe(true);
    expect(res.body.token).not.toBe(TEST_ADMIN_KEY);

    // Verify session token works on protected endpoints
    const meRes = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${res.body.token}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.success).toBe(true);
    expect(meRes.body.user.email).toBe(CRM_ADMIN_EMAIL);
  });

  it('rejects "API key as password" on POST /api/v1/auth/login', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: CRM_ADMIN_EMAIL, password: TEST_ADMIN_KEY });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
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

  /* ------------------------------------------------------------------------
   * Issue 1: Logout revoking only that session
   * ------------------------------------------------------------------------ */
  describe('Issue 1: Logout session invalidation without user deactivation', () => {
    it('after logging out, the same user can sign in again, and the old token gets 401', async () => {
      // 1. Initial sign-in
      const loginRes1 = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: CRM_ADMIN_EMAIL, password: CRM_ADMIN_PASS });

      expect(loginRes1.status).toBe(200);
      const token1 = loginRes1.body.token;

      // 2. Token1 works on /me
      const meRes1 = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${token1}`);
      expect(meRes1.status).toBe(200);

      // 3. User logs out using token1
      const logoutRes = await request(app)
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${token1}`);
      expect(logoutRes.status).toBe(200);
      expect(logoutRes.body.success).toBe(true);

      // 4. Old token gets 401 on /me
      const meAfterLogout = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${token1}`);
      expect(meAfterLogout.status).toBe(401);

      // 5. The same user can sign in again without being told "This account is deactivated"
      const loginRes2 = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: CRM_ADMIN_EMAIL, password: CRM_ADMIN_PASS });

      expect(loginRes2.status).toBe(200);
      expect(loginRes2.body.success).toBe(true);
      const token2 = loginRes2.body.token;
      expect(token2).toBeDefined();

      // 6. Token2 works on /me
      const meRes2 = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${token2}`);
      expect(meRes2.status).toBe(200);

      // 7. Token1 is still 401
      const meOldToken = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${token1}`);
      expect(meOldToken.status).toBe(401);
    });
  });

  /* ------------------------------------------------------------------------
   * Issue 2: IP rate limiting immune to faked X-Forwarded-For
   * ------------------------------------------------------------------------ */
  describe('Issue 2: Faked X-Forwarded-For does not reset the IP limit', () => {
    it('enforces IP rate limit using req.ip and ignores spoofed X-Forwarded-For prefixes', async () => {
      // With app.set('trust proxy', 1), Express uses the rightmost trusted hop.
      // Prepending faked IPs in X-Forwarded-For does not change req.ip.
      for (let i = 1; i <= 10; i++) {
        const res = await request(app)
          .post('/api/v1/auth/login')
          .set('X-Forwarded-For', `fake-spoofed-ip-${i}, 198.51.100.22`)
          .send({ email: `user-${i}@example.com`, password: 'WrongPassword' });

        expect(res.status).toBe(401); // Failed login attempt recorded against 198.51.100.22
      }

      // 11th request with yet another faked X-Forwarded-For still hits 429
      const rateLimitedRes = await request(app)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', `completely-new-fake-ip, 198.51.100.22`)
        .send({ email: 'user-11@example.com', password: 'WrongPassword' });

      expect(rateLimitedRes.status).toBe(429);
      expect(rateLimitedRes.body.error).toContain('Too many login attempts');
    });
  });

  /* ------------------------------------------------------------------------
   * Issue 3: Set-password disallowed for normal login sessions
   * ------------------------------------------------------------------------ */
  describe('Issue 3: Normal login sessions cannot set password', () => {
    it('rejects a normal login session token even if password_set is not set on the user', async () => {
      // Normal login token with amr: ['password']
      const normalLoginToken = [
        Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url'),
        Buffer.from(JSON.stringify({ amr: [{ method: 'password' }] })).toString('base64url'),
        'sig',
      ].join('.');

      mockGetUser.mockResolvedValueOnce({
        data: {
          user: {
            id: 'usr-older-1',
            email: 'older@leadersperformance.ae',
            email_confirmed_at: new Date().toISOString(),
            app_metadata: {
              role: 'user',
              workspaces: ['leaders_performance'],
              // password_set is NOT true (older user)
            },
          },
        },
        error: null,
      });

      const res = await request(app)
        .post('/api/v1/auth/set-password')
        .send({ accessToken: normalLoginToken, password: 'NewSecurePassword2026!' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_TOKEN_TYPE');
      expect(res.body.error).toContain('Standard login sessions cannot be used to set or reset passwords');
    });

    it('allows set-password when using a recovery or invite session token', async () => {
      const recoveryToken = [
        Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url'),
        Buffer.from(JSON.stringify({ amr: [{ method: 'recovery' }] })).toString('base64url'),
        'sig',
      ].join('.');

      const mockUser = {
        id: 'usr-recovery-1',
        email: 'recovery@leadersperformance.ae',
        email_confirmed_at: new Date().toISOString(),
        app_metadata: {
          role: 'user',
          workspaces: ['leaders_performance'],
          status: 'active',
        },
      };

      mockGetUser.mockResolvedValueOnce({
        data: { user: mockUser },
        error: null,
      });

      mockUpdateUserById.mockResolvedValueOnce({
        data: {
          user: {
            ...mockUser,
            app_metadata: { ...mockUser.app_metadata, password_set: true },
          },
        },
        error: null,
      });

      const res = await request(app)
        .post('/api/v1/auth/set-password')
        .send({ accessToken: recoveryToken, password: 'NewSecurePassword2026!' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.token).toMatch(/^lp_sess\./);
    });
  });
});


