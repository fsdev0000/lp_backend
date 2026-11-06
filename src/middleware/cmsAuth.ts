import { Request, Response, NextFunction } from 'express';
import { getSupabaseClient } from '../services/supabaseStorageService';
import { verifyCrmSessionToken } from '../utils/sessionToken';

export interface CmsAuthResult {
  success: boolean;
  user?: {
    id?: string;
    email?: string;
    name?: string;
    role: string;
  };
  status?: number;
  error?: string;
}

/**
 * Authenticates whether a request carries a valid administrator identity.
 * Strictly rejects environment API keys.
 */
export async function authenticateCmsAdmin(req: Request): Promise<CmsAuthResult> {
  const authHeader = req.headers.authorization as string | undefined;
  const apiKeyHeader = req.headers['x-api-key'] as string | undefined;

  // 1. Strictly reject raw env API keys (Item 2d / 4)
  const envKeys = [
    process.env.ADMIN_API_KEY,
    process.env.CRM_API_KEY,
    process.env.ARTICLES_API_KEY,
    process.env.NEWSLETTER_SEND_API_KEY,
    process.env.NEWSLETTER_API_KEY,
  ]
    .map((k) => k?.trim())
    .filter(Boolean) as string[];

  if (apiKeyHeader && envKeys.includes(apiKeyHeader.trim())) {
    return {
      success: false,
      status: 403,
      error: 'Forbidden: Environment API keys cannot manage CMS content. Please log in with an administrator account.',
    };
  }

  if (!authHeader) {
    return {
      success: false,
      status: 401,
      error: 'Unauthorized: Administrator session token required (Bearer <token>).',
    };
  }

  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();

  // If token is an env key passed as Bearer, reject it
  if (envKeys.includes(token)) {
    return {
      success: false,
      status: 403,
      error: 'Forbidden: Environment API keys cannot manage CMS content. Please log in with an administrator account.',
    };
  }

  // 2. Check signed expiring CRM session token (lp_sess.*)
  if (token.startsWith('lp_sess.')) {
    const sessionUser = verifyCrmSessionToken(token);
    if (sessionUser) {
      if (sessionUser.role !== 'admin') {
        return {
          success: false,
          status: 403,
          error: 'Forbidden: Only administrators (role: admin) can manage CMS content.',
        };
      }
      return {
        success: true,
        user: {
          id: sessionUser.id,
          email: sessionUser.email,
          name: sessionUser.name,
          role: 'admin',
        },
      };
    }
  }

  // 3. Check Supabase JWT
  if (token.split('.').length === 3) {
    try {
      const supabase = await getSupabaseClient();
      const { data, error } = await supabase.auth.getUser(token);
      if (!error && data?.user) {
        const user = data.user;
        const role = (user.app_metadata?.role || '').toLowerCase();
        if (role === 'admin') {
          return {
            success: true,
            user: {
              id: user.id,
              email: user.email,
              name: user.user_metadata?.name || user.email?.split('@')[0],
              role: 'admin',
            },
          };
        } else {
          return {
            success: false,
            status: 403,
            error: 'Forbidden: Only administrators with app_metadata.role = "admin" can manage CMS content.',
          };
        }
      }
    } catch (err: any) {
      console.warn('[CmsAuth] Supabase token verification failed:', err.message);
    }
  }

  return {
    success: false,
    status: 401,
    error: 'Unauthorized: Invalid or expired administrator session token.',
  };
}

/**
 * Strict administrator authentication middleware for CMS endpoints.
 * Only users with app_metadata.role = "admin" or valid admin session tokens are allowed.
 * All raw environment API keys (ARTICLES_API_KEY, CRM_API_KEY, etc.) are strictly rejected.
 */
export async function requireCmsAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const result = await authenticateCmsAdmin(req);
  if (!result.success) {
    res.status(result.status || 401).json({
      success: false,
      error: result.error,
    });
    return;
  }

  (req as any).user = result.user;
  next();
}
