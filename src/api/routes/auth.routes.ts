import { Router, Request, Response } from 'express';
import { getSupabaseClient } from '../../services/supabaseStorageService';
import { requireApiKey } from '../../middleware/apiKeyAuth';

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

    // 1. Try Supabase Auth signInWithPassword
    try {
      const supabase = await getSupabaseClient();
      const { data, error } = await supabase.auth.signInWithPassword({
        email: cleanEmail,
        password: cleanPassword,
      });

      if (!error && data?.session && data.user) {
        const role = (data.user.app_metadata?.role || data.user.user_metadata?.role || '').toLowerCase();
        const isStaff =
          ['admin', 'staff', 'crm', 'editor'].includes(role) ||
          cleanEmail.endsWith('@leadersperformance.ae') ||
          (process.env.CRM_ADMIN_EMAIL && cleanEmail === process.env.CRM_ADMIN_EMAIL.toLowerCase());

        if (isStaff) {
          res.status(200).json({
            success: true,
            user: {
              id: data.user.id,
              email: data.user.email,
              name: data.user.user_metadata?.name || data.user.email?.split('@')[0],
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
    } catch (supabaseErr: any) {
      console.warn('[AuthRouter] Supabase signInWithPassword bypassed/failed:', supabaseErr?.message);
    }

    // 2. Fallback: Authenticate against CRM Admin / System Credentials
    const configuredAdminEmail = (process.env.CRM_ADMIN_EMAIL || process.env.SWAGGER_USER || 'admin@leadersperformance.ae').toLowerCase();
    const configuredAdminPass = process.env.CRM_ADMIN_PASSWORD || process.env.SWAGGER_PASSWORD;
    const fallbackApiKey = process.env.CRM_API_KEY || process.env.ADMIN_API_KEY || process.env.ARTICLES_API_KEY;

    const isDirectMatch =
      configuredAdminPass &&
      cleanEmail === configuredAdminEmail &&
      cleanPassword === configuredAdminPass;

    // Also support passing valid CRM_API_KEY / ADMIN_API_KEY directly as password
    const isApiKeyMatch =
      fallbackApiKey &&
      (cleanPassword === fallbackApiKey || cleanPassword === process.env.ADMIN_API_KEY || cleanPassword === process.env.CRM_API_KEY) &&
      (cleanEmail.endsWith('@leadersperformance.ae') || cleanEmail.startsWith('admin'));

    if (isDirectMatch || isApiKeyMatch) {
      const issuedToken = fallbackApiKey || 'lp_crm_sess_' + Buffer.from(cleanEmail).toString('hex');
      res.status(200).json({
        success: true,
        user: {
          id: 'crm-admin',
          email: cleanEmail,
          name: cleanEmail.startsWith('admin') ? 'CRM Administrator' : 'Lionel Eersteling',
          role: 'admin',
        },
        token: issuedToken,
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

