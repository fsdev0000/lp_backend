import { Request, Response, NextFunction } from 'express';
import { getSupabaseClient } from '../services/supabaseStorageService';
import { verifyCrmSessionToken } from '../utils/sessionToken';
import {
  crmUserFromSessionPayload,
  crmUserFromSupabase,
  isSupabaseUserDeactivated,
  normalizeWorkspace,
} from './crmRoleAuth';

export interface CmsAuthResult {
  success: boolean;
  user?: {
    id?: string;
    email?: string;
    name?: string;
    role: string;
    workspaces?: string[];
  };
  status?: number;
  error?: string;
}

/**
 * Authenticates whether a request carries a valid Super Admin or Manager identity for Website CMS.
 * - super_admin: allowed
 * - manager: allowed if assigned to 'leaders_performance' (or target workspace)
 * - admin (V2) & user: NOT allowed to publish website texts (403)
 * - Strictly rejects raw environment API keys.
 */
export async function authenticateCmsAdmin(req: Request): Promise<CmsAuthResult> {
  const authHeader = req.headers.authorization as string | undefined;
  const apiKeyHeader = req.headers['x-api-key'] as string | undefined;

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
      error:
        'Forbidden: Environment API keys cannot manage CMS content. Please log in with an administrator account.',
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

  if (envKeys.includes(token)) {
    return {
      success: false,
      status: 403,
      error:
        'Forbidden: Environment API keys cannot manage CMS content. Please log in with an administrator account.',
    };
  }

  const targetWorkspace = normalizeWorkspace(
    (req.query?.workspace as string) ||
    (req.body?.workspace as string) ||
    (req.headers['x-workspace-id'] as string) ||
    'leaders_performance'
  );

  // 2. Check signed expiring CRM session token (lp_sess.*)
  if (token.startsWith('lp_sess.')) {
    const sessionUser = verifyCrmSessionToken(token);
    if (sessionUser) {
      const crmUser = crmUserFromSessionPayload(sessionUser);
      if (!crmUser) {
        return {
          success: false,
          status: 401,
          error: 'Unauthorized: Account has been deactivated.',
        };
      }
      if (crmUser.role === 'super_admin') {
        return { success: true, user: crmUser };
      }
      if (crmUser.role === 'manager') {
        const allowed = Array.isArray(crmUser.workspaces)
          ? crmUser.workspaces.map((w: string) => normalizeWorkspace(w))
          : [];
        if (!allowed.includes('leaders_performance')) {
          return {
            success: false,
            status: 403,
            error: 'Forbidden: CMS texts belong to leadersperformance.ae. Manager does not have access to workspace "leaders_performance".',
          };
        }
        return { success: true, user: crmUser };
      }
      return {
        success: false,
        status: 403,
        error: 'Forbidden: Only Super Admins and assigned Managers can publish website texts.',
      };
    }
  }

  // 3. Check Supabase JWT
  if (token.split('.').length === 3) {
    try {
      const supabase = await getSupabaseClient();
      const { data, error } = await supabase.auth.getUser(token);
      if (!error && data?.user) {
        const user = data.user as any;
        if (isSupabaseUserDeactivated(user)) {
          return {
            success: false,
            status: 401,
            error: 'Unauthorized: Account has been deactivated.',
          };
        }
        const crmUser = crmUserFromSupabase(user);
        if (crmUser.role === 'super_admin') {
          return { success: true, user: crmUser };
        }
        if (crmUser.role === 'manager') {
          const allowed = Array.isArray(crmUser.workspaces)
            ? crmUser.workspaces.map((w: string) => normalizeWorkspace(w))
            : [];
          if (!allowed.includes('leaders_performance')) {
            return {
              success: false,
              status: 403,
              error: 'Forbidden: CMS texts belong to leadersperformance.ae. Manager does not have access to workspace "leaders_performance".',
            };
          }
          return { success: true, user: crmUser };
        }
        return {
          success: false,
          status: 403,
          error: 'Forbidden: Only Super Admins and assigned Managers can publish website texts.',
        };
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
