import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { getSupabaseUrl, getSupabaseServiceKey } from '../../services/supabaseStorageService';
import { requireApiKey } from '../../middleware/apiKeyAuth';
import { generateCrmSessionToken } from '../../utils/sessionToken';

export const authRouter = Router();

/**
 * POST /api/v1/auth/login
 * Body: { email, password }
 * Returns: { success: true, user: { id, email, name, role }, token }
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

    // 1. Try Supabase Auth signInWithPassword using an ISOLATED, non-cached client (Item 2)
    // Prevents polluting cachedClient service-role state with user auth tokens
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

        if (!error && data?.session && data.user) {
          // Security (Item 3): Rely strictly on app_metadata.role (user_metadata is client-editable)
          const role = (data.user.app_metadata?.role || '').toLowerCase();
          const isEmailConfirmed = Boolean(data.user.email_confirmed_at || (data.user as any).confirmed_at);
          const isStaff =
            ['admin', 'staff', 'crm', 'editor'].includes(role) ||
            (isEmailConfirmed && cleanEmail.endsWith('@leadersperformance.ae')) ||
            (process.env.CRM_ADMIN_EMAIL && cleanEmail === process.env.CRM_ADMIN_EMAIL.toLowerCase());

          if (isStaff) {
            res.status(200).json({
              success: true,
              user: {
                id: data.user.id,
                email: data.user.email,
                name: (data.user.app_metadata?.name as string) || data.user.email?.split('@')[0],
                role: role || 'staff',
              },
              token: data.session.access_token,
            });
            return;
          } else {
            res.status(403).json({
              success: false,
              error: 'Forbidden: User is not authorized to access Social CRM resources.',
            });
            return;
          }
        }
      }
    } catch (supabaseErr: any) {
      console.warn('[AuthRouter] Supabase isolated signInWithPassword bypassed/failed:', supabaseErr?.message);
    }

    // 2. Fallback: Authenticate against configured CRM Admin credentials (Item 1)
    // Drops "API key as password" and issues an expiring signed CRM session token (not the master API key)
    const configuredAdminEmail = (process.env.CRM_ADMIN_EMAIL || process.env.SWAGGER_USER || 'admin@leadersperformance.ae').toLowerCase();
    const configuredAdminPass = process.env.CRM_ADMIN_PASSWORD || process.env.SWAGGER_PASSWORD;

    const isDirectMatch =
      Boolean(configuredAdminPass) &&
      cleanEmail === configuredAdminEmail &&
      cleanPassword === configuredAdminPass;

    if (isDirectMatch) {
      const sessionToken = generateCrmSessionToken({
        id: 'crm-admin',
        email: cleanEmail,
        name: cleanEmail.startsWith('admin') ? 'CRM Administrator' : 'Lionel Eersteling',
        role: 'admin',
      });

      res.status(200).json({
        success: true,
        user: {
          id: 'crm-admin',
          email: cleanEmail,
          name: cleanEmail.startsWith('admin') ? 'CRM Administrator' : 'Lionel Eersteling',
          role: 'admin',
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
 * Protected by requireApiKey / Bearer token
 */
authRouter.get('/me', requireApiKey, (req: Request, res: Response): void => {
  const user = (req as any).user;
  res.status(200).json({
    success: true,
    user: user || {
      id: 'crm-admin',
      email: process.env.CRM_ADMIN_EMAIL || 'admin@leadersperformance.ae',
      role: 'admin',
      authenticatedVia: 'api_key',
    },
  });
});

