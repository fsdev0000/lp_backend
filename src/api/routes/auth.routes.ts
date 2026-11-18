import { Router, Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';
import { getSupabaseUrl, getSupabaseServiceKey } from '../../services/supabaseStorageService';
import { requireApiKey } from '../../middleware/apiKeyAuth';
import {
  ALL_WORKSPACES,
  getLiveUserOverride,
  isSupabaseUserDeactivated,
  requireCrmAuth,
  VerifiedSupabaseUser,
} from '../../middleware/crmRoleAuth';
import { generateCrmSessionToken, isUserSessionRevoked } from '../../utils/sessionToken';
import { crmUsersService, resolveCrmOrigin } from '../../modules/users/services/crmUsers.service';

export const authRouter = Router();

interface RateBucket {
  count: number;
  resetAt: number;
}

const ipRateBuckets = new Map<string, RateBucket>();
const emailRateBuckets = new Map<string, RateBucket>();

function checkRateLimit(
  store: Map<string, RateBucket>,
  key: string,
  maxRequests: number,
  windowMs: number
): boolean {
  const now = Date.now();
  const bucket = store.get(key);
  if (!bucket || now >= bucket.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= maxRequests) {
    return false;
  }
  bucket.count += 1;
  return true;
}

export function resetAuthRateLimitsForTests(): void {
  ipRateBuckets.clear();
  emailRateBuckets.clear();
}

/**
 * POST /api/v1/auth/login
 * Body: { email, password }
 * Returns: { success: true, user: { id, email, name, role, workspaces, roleVersion: 2 }, token }
 */
authRouter.post('/login', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
      res.status(400).json({ success: false, error: 'Email and password are required.' });
      return;
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanPassword = password.trim();

    const liveOverride = getLiveUserOverride(undefined, cleanEmail);
    if (liveOverride?.status === 'deactivated' || isUserSessionRevoked(undefined, cleanEmail)) {
      res.status(403).json({
        success: false,
        error: 'This account is deactivated. Ask an admin to reactivate it.',
      });
      return;
    }

    // 1. Try Supabase Auth signInWithPassword using an ISOLATED, non-cached client
    try {
      const supabaseUrl = getSupabaseUrl();
      const serviceKey = await getSupabaseServiceKey();
      if (supabaseUrl && serviceKey) {
        const isolatedAuthClient = createClient(supabaseUrl, serviceKey, {
          auth: {
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false,
          },
        });

        const { data, error } = await isolatedAuthClient.auth.signInWithPassword({
          email: cleanEmail,
          password: cleanPassword,
        });

        if (error) {
          const errMsg = (error.message || '').toLowerCase();
          if (errMsg.includes('banned') || errMsg.includes('deactivated')) {
            res.status(403).json({
              success: false,
              error: 'This account is deactivated. Ask an admin to reactivate it.',
            });
            return;
          }
        }

        if (!error && data?.session && data.user) {
          const rawUser = data.user as unknown as VerifiedSupabaseUser;
          if (isSupabaseUserDeactivated(rawUser)) {
            res.status(403).json({
              success: false,
              error: 'This account is deactivated. Ask an admin to reactivate it.',
            });
            return;
          }

          const managed = crmUsersService.toManagedUser(rawUser);
          if (managed.status === 'deactivated') {
            res.status(403).json({
              success: false,
              error: 'This account is deactivated. Ask an admin to reactivate it.',
            });
            return;
          }

          const rawRole = (rawUser.app_metadata?.role || '').toLowerCase();
          const isEmailConfirmed = Boolean(
            rawUser.email_confirmed_at || (rawUser as any).confirmed_at
          );
          const isAuthorizedCrmUser =
            ['super_admin', 'admin', 'manager', 'user', 'approver', 'founder', 'editor', 'staff', 'crm'].includes(
              rawRole
            ) ||
            (isEmailConfirmed && cleanEmail.endsWith('@leadersperformance.ae')) ||
            (process.env.CRM_ADMIN_EMAIL &&
              cleanEmail === process.env.CRM_ADMIN_EMAIL.toLowerCase());

          if (!isAuthorizedCrmUser) {
            res.status(403).json({
              success: false,
              error: 'Forbidden: User is not authorized to access Social CRM resources.',
            });
            return;
          }

          res.status(200).json({
            success: true,
            user: {
              id: managed.id,
              email: managed.email,
              name: managed.name,
              role: managed.role,
              workspaces: managed.workspaces,
              roleVersion: 2,
            },
            token: data.session.access_token,
          });
          return;
        }
      }
    } catch (supabaseErr: any) {
      console.warn('[AuthRouter] Supabase isolated signInWithPassword bypassed/failed:', supabaseErr?.message);
    }

    // 2. Fallback: Authenticate against configured CRM Admin credentials (owner / super_admin)
    const configuredAdminEmail = (
      process.env.CRM_ADMIN_EMAIL ||
      process.env.SWAGGER_USER ||
      'admin@leadersperformance.ae'
    ).toLowerCase();
    const configuredAdminPass = process.env.CRM_ADMIN_PASSWORD || process.env.SWAGGER_PASSWORD;

    const isDirectMatch =
      Boolean(configuredAdminPass) &&
      cleanEmail === configuredAdminEmail &&
      cleanPassword === configuredAdminPass;

    if (isDirectMatch) {
      const displayName = cleanEmail.startsWith('admin') ? 'CRM Administrator' : 'Lionel Eersteling';
      const sessionToken = generateCrmSessionToken({
        id: 'crm-admin',
        email: cleanEmail,
        name: displayName,
        role: 'super_admin',
        workspaces: [...ALL_WORKSPACES],
        roleVersion: 2,
      });

      res.status(200).json({
        success: true,
        user: {
          id: 'crm-admin',
          email: cleanEmail,
          name: displayName,
          role: 'super_admin',
          workspaces: [...ALL_WORKSPACES],
          roleVersion: 2,
        },
        token: sessionToken,
      });
      return;
    }

    res.status(401).json({
      success: false,
      error: 'Invalid email or password.',
    });
  } catch (error: any) {
    console.error('[AuthRouter] Login error:', error);
    res.status(500).json({ success: false, error: error?.message || 'Authentication failed' });
  }
});

/**
 * GET /api/v1/auth/me
 * Returns current user with V2 role & workspaces ({ id, email, name, role, workspaces, roleVersion: 2 }).
 * Returns 401 immediately for a deactivated user or revoked session.
 */
authRouter.get(
  '/me',
  (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      requireCrmAuth(req, res, next);
      return;
    }
    requireApiKey(req, res, next);
  },
  async (req: Request, res: Response): Promise<void> => {
    try {
      const crmUser = req.crmUser || (req as any).user;
      if (!crmUser) {
        res.status(401).json({ success: false, error: 'Unauthorized: Missing or invalid session.' });
        return;
      }

      if (isUserSessionRevoked(crmUser.id, crmUser.email)) {
        res.status(401).json({
          success: false,
          error: 'This account has been deactivated.',
        });
        return;
      }

      const live = getLiveUserOverride(crmUser.id, crmUser.email);
      if (live?.status === 'deactivated') {
        res.status(401).json({
          success: false,
          error: 'This account has been deactivated.',
        });
        return;
      }

      // If this is a real Supabase user UUID, refresh from Supabase when available so role/workspace updates apply immediately
      if (
        crmUser.id &&
        crmUser.id !== 'crm-admin' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(crmUser.id)
      ) {
        try {
          const { managed } = await crmUsersService.getUserById(crmUser.id);
          if (managed.status === 'deactivated') {
            res.status(401).json({
              success: false,
              error: 'This account has been deactivated.',
            });
            return;
          }
          res.status(200).json({
            success: true,
            user: {
              id: managed.id,
              email: managed.email,
              name: managed.name,
              role: managed.role,
              workspaces: managed.workspaces,
              roleVersion: 2,
            },
          });
          return;
        } catch {
          // Fall back to verified token/live override state if Supabase lookup is unavailable in unit tests
        }
      }

      const effectiveRole = live?.role || crmUser.role || 'super_admin';
      const effectiveWorkspaces =
        live?.workspaces ||
        (Array.isArray(crmUser.workspaces) && crmUser.workspaces.length > 0
          ? crmUser.workspaces
          : [...ALL_WORKSPACES]);

      res.status(200).json({
        success: true,
        user: {
          id: crmUser.id || 'crm-admin',
          email: crmUser.email || process.env.CRM_ADMIN_EMAIL || 'admin@leadersperformance.ae',
          name: live?.name || crmUser.name || 'CRM Administrator',
          role: effectiveRole,
          workspaces: effectiveWorkspaces,
          roleVersion: 2,
        },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'Failed to resolve current user' });
    }
  }
);

/**
 * POST /api/v1/auth/forgot-password
 * Body: { email }
 * Always responds 200 (never reveals whether the email has an account).
 */
authRouter.post('/forgot-password', async (req: Request, res: Response): Promise<void> => {
  const ip = req.ip || 'unknown-ip';
  const rawEmail = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';

  if (!checkRateLimit(ipRateBuckets, `forgot-ip:${ip}`, 15, 15 * 60 * 1000)) {
    res.status(429).json({
      success: false,
      error: 'Too many password reset requests. Please wait a few minutes and try again.',
    });
    return;
  }

  if (rawEmail && !checkRateLimit(emailRateBuckets, `forgot-email:${rawEmail}`, 5, 15 * 60 * 1000)) {
    // Still return 200 to prevent account enumeration while silently dropping excessive per-email requests
    res.status(200).json({ success: true, data: {} });
    return;
  }

  const origin = resolveCrmOrigin(req.get('origin') || req.get('referer'));
  await crmUsersService.sendForgotPasswordEmail(rawEmail, origin);

  res.status(200).json({
    success: true,
    data: {},
  });
});

/**
 * POST /api/v1/auth/set-password
 * Body: { accessToken, password }
 * Verifies the single-use invitation or recovery token, validates password strength,
 * sets the password, marks an invited user active, and returns { success: true, user, token }.
 */
authRouter.post('/set-password', async (req: Request, res: Response): Promise<void> => {
  const ip = req.ip || 'unknown-ip';
  if (!checkRateLimit(ipRateBuckets, `setpw-ip:${ip}`, 15, 15 * 60 * 1000)) {
    res.status(429).json({
      success: false,
      error: 'Too many attempts. Please wait a few minutes and try again.',
    });
    return;
  }

  try {
    const result = await crmUsersService.setPasswordWithToken(
      {
        accessToken: req.body?.accessToken,
        password: req.body?.password,
      },
      req.ip
    );

    res.status(200).json({
      success: true,
      user: result.user,
      token: result.token,
    });
  } catch (err: any) {
    const statusCode = Number(err?.statusCode) || 500;
    res.status(statusCode).json({
      success: false,
      code: err?.code || 'SET_PASSWORD_ERROR',
      error: err?.message || 'Failed to set password.',
    });
  }
});
