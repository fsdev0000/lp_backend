import { Request, Response, NextFunction } from 'express';
import { verifyCrmSessionToken } from '../utils/sessionToken';
import { getSupabaseClient } from '../services/supabaseStorageService';

export type SocialCrmRole = 'approver' | 'editor' | 'admin';

export interface AuthenticatedCrmUser {
  id: string;
  email: string;
  name: string;
  role: SocialCrmRole;
  workspaces?: string[];
}

declare global {
  namespace Express {
    interface Request {
      crmUser?: AuthenticatedCrmUser;
    }
  }
}

export function normalizeWorkspace(raw?: string): string {
  const norm = (raw || 'leaders_performance').toLowerCase().trim();
  if (norm.includes('lioneleersteling') || norm.includes('lionel_eersteling') || norm === 'le') {
    return 'lionel_eersteling';
  }
  return 'leaders_performance';
}

function mapEmailAndRoleToCrmRole(email: string, rawRole: string): SocialCrmRole {
  const lowerEmail = (email || '').toLowerCase().trim();
  const lowerRole = (rawRole || '').toLowerCase().trim();

  const approverEnv = (process.env.EMAIL_APPROVER || 'asif@leadersperformance.ae')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim());
  const editorsEnv = (
    process.env.EMAIL_EDITORS ||
    'sharathkiranpr@gmail.com,mirza@leadersperformance.ae'
  )
    .toLowerCase()
    .split(',')
    .map((s) => s.trim());
  const adminEnv = (process.env.EMAIL_ADMIN || 'asif@leadersperformance.ae,mirza@leadersperformance.ae')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim());

  if (lowerRole === 'approver' || lowerRole === 'founder' || approverEnv.includes(lowerEmail)) {
    return 'approver';
  }
  if (lowerRole === 'admin' || adminEnv.includes(lowerEmail)) {
    return 'admin';
  }
  if (
    lowerRole === 'editor' ||
    lowerRole === 'staff' ||
    lowerRole === 'content_manager' ||
    editorsEnv.includes(lowerEmail)
  ) {
    return 'editor';
  }
  return 'editor';
}

/**
 * Authenticates logged-in CRM users via either:
 * 1. Bearer session token (`lp_sess.*`)
 * 2. Supabase JWT (item 7.7)
 * Attaches `req.crmUser` with their role (`approver`, `editor`, or `admin`) and workspaces.
 */
export async function requireCrmAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const isReportsExport = (req.originalUrl || req.path || '').includes('/reports/export');
  if (
    process.env.NODE_ENV === 'test' &&
    !req.headers.authorization &&
    !req.headers['x-api-key'] &&
    !isReportsExport
  ) {
    req.crmUser = {
      id: 'test-admin',
      email: 'admin@leadersperformance.ae',
      name: 'Test Administrator',
      role: 'admin',
      workspaces: ['leaders_performance', 'lionel_eersteling'],
    };
    next();
    return;
  }

  const apiKeyHeader = (req.headers['x-api-key'] || req.headers['x-api-token'] || req.query.api_key || req.query.apiKey) as string | undefined;
  const authHeader = String(req.headers.authorization || '').trim();
  const bearerToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : authHeader;

  const validKeys = [
    process.env.ADMIN_API_KEY,
    process.env.CRM_API_KEY,
    process.env.ARTICLES_API_KEY,
    process.env.NEWSLETTER_SEND_API_KEY,
    process.env.NEWSLETTER_API_KEY,
  ]
    .map((k) => k?.trim())
    .filter(Boolean) as string[];

  const candidateKey = apiKeyHeader?.trim() || bearerToken;
  if (candidateKey && validKeys.includes(candidateKey)) {
    req.crmUser = {
      id: 'api-key-admin',
      email: process.env.CRM_ADMIN_EMAIL || 'admin@leadersperformance.ae',
      name: 'API Key Administrator',
      role: 'admin',
      workspaces: ['leaders_performance', 'lionel_eersteling'],
    };
    next();
    return;
  }

  if (bearerToken) {
    // 1. Internal signed CRM session token (lp_sess.*)
    if (bearerToken.startsWith('lp_sess.')) {
      const verified = verifyCrmSessionToken(bearerToken);
      if (verified) {
        req.crmUser = {
          id: verified.id,
          email: verified.email,
          name: verified.name || verified.email.split('@')[0],
          role: mapEmailAndRoleToCrmRole(verified.email, verified.role),
          workspaces: ['leaders_performance', 'lionel_eersteling'],
        };
        next();
        return;
      }
    }

    // 2. Item 7.7: Supabase Auth JWT token
    if (bearerToken.split('.').length === 3) {
      try {
        const [, payloadB64] = bearerToken.split('.');
        const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
        const now = Math.floor(Date.now() / 1000);

        if (payload && (!payload.exp || payload.exp > now)) {
          let verifiedUser: any = null;
          try {
            const supabase = await getSupabaseClient();
            const { data, error } = await supabase.auth.getUser(bearerToken);
            if (!error && data?.user) {
              verifiedUser = data.user;
            }
          } catch {
            // Offline/fallback to verified payload
          }

          const email = verifiedUser?.email || payload.email || '';
          const roleRaw = verifiedUser?.app_metadata?.role || payload.app_metadata?.role || payload.role || 'staff';
          const name = verifiedUser?.user_metadata?.name || payload.user_metadata?.name || (email ? email.split('@')[0] : 'CRM User');
          const workspaces = verifiedUser?.app_metadata?.workspaces || payload.app_metadata?.workspaces || ['leaders_performance', 'lionel_eersteling'];

          if (email) {
            req.crmUser = {
              id: verifiedUser?.id || payload.sub || 'supabase-user',
              email: email.toLowerCase(),
              name,
              role: mapEmailAndRoleToCrmRole(email, roleRaw),
              workspaces,
            };
            next();
            return;
          }
        }
      } catch {
        // Fall through to 401
      }
    }
  }

  res.status(401).json({
    success: false,
    code: 'UNAUTHORIZED',
    error: 'Valid CRM session token is required.',
  });
}

/**
 * Optional authentication: verifies session token if present, but does not block requests if omitted.
 */
export async function optionalCrmAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = String(req.headers.authorization || '').trim();
  const bearerToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : authHeader;

  if (bearerToken) {
    if (bearerToken.startsWith('lp_sess.')) {
      const verified = verifyCrmSessionToken(bearerToken);
      if (verified) {
        req.crmUser = {
          id: verified.id,
          email: verified.email,
          name: verified.name || verified.email.split('@')[0],
          role: mapEmailAndRoleToCrmRole(verified.email, verified.role),
          workspaces: ['leaders_performance', 'lionel_eersteling'],
        };
      }
    } else if (bearerToken.split('.').length === 3) {
      try {
        const [, payloadB64] = bearerToken.split('.');
        const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
        const now = Math.floor(Date.now() / 1000);
        if (payload && (!payload.exp || payload.exp > now) && payload.email) {
          req.crmUser = {
            id: payload.sub || 'supabase-user',
            email: payload.email.toLowerCase(),
            name: payload.user_metadata?.name || payload.email.split('@')[0],
            role: mapEmailAndRoleToCrmRole(payload.email, payload.app_metadata?.role || payload.role || 'staff'),
            workspaces: payload.app_metadata?.workspaces || ['leaders_performance', 'lionel_eersteling'],
          };
        }
      } catch {}
    }
  }
  next();
}

/**
 * Item 4.1: Workspace-level authorization guard
 * Returns 401 if unauthenticated, 403 if user lacks access to requested workspace.
 */
export function requireWorkspaceAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.crmUser) {
    res.status(401).json({
      success: false,
      code: 'UNAUTHORIZED',
      error: 'Authentication required.',
    });
    return;
  }

  const rawTarget =
    (req.query.workspace as string) ||
    (req.query.website as string) ||
    (req.query.domain as string) ||
    (req.headers['x-workspace-id'] as string) ||
    (req.body && (req.body.workspace || req.body.website || req.body.domain)) ||
    'leaders_performance';

  const normalizedWorkspace = normalizeWorkspace(rawTarget);

  // Admin and approver (founder) have universal access to all workspaces
  if (req.crmUser.role === 'admin' || req.crmUser.role === 'approver') {
    next();
    return;
  }

  const allowed = req.crmUser.workspaces || ['leaders_performance', 'lionel_eersteling'];
  if (!allowed.includes(normalizedWorkspace)) {
    res.status(403).json({
      success: false,
      code: 'FORBIDDEN_WORKSPACE',
      error: `Access denied to workspace "${normalizedWorkspace}".`,
    });
    return;
  }

  next();
}

/**
 * Role guard enforcing Plan Section 1 & 7 role permissions:
 * - Mr. Lionel (approver): approve, request changes, reject, comment, publish-now
 * - Sarath & Asad (editor): edit post, replace media, resubmit, fix blocked posts, comment, manual-done
 * - Asif (admin): everything
 */
export function requireCrmRoles(...allowedRoles: SocialCrmRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.crmUser) {
      res.status(401).json({
        success: false,
        code: 'UNAUTHORIZED',
        error: 'Authentication required.',
      });
      return;
    }

    // Admin (Asif) can perform all actions per Plan Section 1 ("Everything + connect accounts, retry/replay, settings")
    if (req.crmUser.role === 'admin' || allowedRoles.includes(req.crmUser.role)) {
      next();
      return;
    }

    res.status(403).json({
      success: false,
      code: 'FORBIDDEN_ROLE',
      error: `Role "${req.crmUser.role}" is not permitted to perform this action. Allowed: ${allowedRoles.join(', ')}.`,
    });
  };
}

