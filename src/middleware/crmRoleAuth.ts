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

const ALL_WORKSPACES = ['leaders_performance', 'lionel_eersteling'];

/** Default approver while EMAIL_APPROVER is unset. Stays Asif's address for now (owner's decision, 13 Nov 2026). */
export const DEFAULT_APPROVER_EMAIL = 'asif@leadersperformance.ae';

export function mapEmailAndRoleToCrmRole(email: string, rawRole: string): SocialCrmRole {
  const lowerEmail = (email || '').toLowerCase().trim();
  const lowerRole = (rawRole || '').toLowerCase().trim();

  const approverEnv = (process.env.EMAIL_APPROVER || DEFAULT_APPROVER_EMAIL)
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

type VerifiedSupabaseUser = {
  id: string;
  email?: string;
  email_confirmed_at?: string | null;
  confirmed_at?: string | null;
  app_metadata?: Record<string, any>;
  user_metadata?: Record<string, any>;
};

/**
 * A Supabase JWT, verified by Supabase itself. Returns null for a token Supabase doesn't accept (or when it can't be
 * reached): the token's own payload is never trusted, because anyone can write a token claiming any email or role.
 */
export async function verifySupabaseToken(token: string): Promise<VerifiedSupabaseUser | null> {
  if (token.split('.').length !== 3) return null;
  try {
    const supabase = await getSupabaseClient();
    const { data, error } = await supabase.auth.getUser(token);
    return !error && data?.user ? (data.user as VerifiedSupabaseUser) : null;
  } catch {
    return null;
  }
}

/** Same staff rule as requireApiKey: a CRM role in app_metadata, or a confirmed @leadersperformance.ae address. */
export function isStaffSupabaseUser(user: VerifiedSupabaseUser): boolean {
  const role = String(user.app_metadata?.role || '').toLowerCase();
  const email = (user.email || '').toLowerCase();
  const confirmed = Boolean(user.email_confirmed_at || user.confirmed_at);
  return (
    ['admin', 'approver', 'founder', 'staff', 'crm', 'editor', 'content_manager'].includes(role) ||
    (confirmed && email.endsWith('@leadersperformance.ae')) ||
    Boolean(process.env.CRM_ADMIN_EMAIL && email === process.env.CRM_ADMIN_EMAIL.toLowerCase())
  );
}

/** The CRM user for a verified Supabase staff account. Role comes from app_metadata (users can't edit it) and the email lists. */
export function crmUserFromSupabase(user: VerifiedSupabaseUser): AuthenticatedCrmUser {
  const email = (user.email || '').toLowerCase();
  const workspaces = user.app_metadata?.workspaces;
  return {
    id: user.id,
    email,
    name: user.user_metadata?.full_name || user.user_metadata?.name || email.split('@')[0] || 'CRM User',
    role: mapEmailAndRoleToCrmRole(email, String(user.app_metadata?.role || 'staff')),
    workspaces: Array.isArray(workspaces) && workspaces.length > 0 ? workspaces : ALL_WORKSPACES,
  };
}

/**
 * Authenticates logged-in CRM users via either:
 * 1. Bearer session token (`lp_sess.*`)
 * 2. Supabase JWT (item 7.7)
 * Attaches `req.crmUser` with their role (`approver`, `editor`, or `admin`) and workspaces.
 */
export async function requireCrmAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const url = req.originalUrl || req.path || '';
  const isStrictAuthRoute = url.includes('/reports/export') || url.includes('/notifications');
  if (
    process.env.NODE_ENV === 'test' &&
    !req.headers.authorization &&
    !req.headers['x-api-key'] &&
    !isStrictAuthRoute
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

  // A signed-in user comes first, also when the request carries an API key (the CRM's proxy adds the key to
  // every call): audit logs then name the person and role checks apply. The key alone acts as an administrator.
  if (bearerToken && !validKeys.includes(bearerToken)) {
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

    // 2. Item 7.7: Supabase Auth JWT, only when Supabase verifies it, and only for staff.
    const supabaseUser = await verifySupabaseToken(bearerToken);
    if (supabaseUser) {
      if (!isStaffSupabaseUser(supabaseUser)) {
        // 403, not 401: the sign-in is real, it just isn't a CRM account.
        res.status(403).json({
          success: false,
          code: 'FORBIDDEN',
          error: 'This account is not authorized to use the Social CRM.',
        });
        return;
      }
      req.crmUser = crmUserFromSupabase(supabaseUser);
      next();
      return;
    }
  }

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
    } else {
      // Verified by Supabase only; an unverified payload never sets a user.
      const supabaseUser = await verifySupabaseToken(bearerToken);
      if (supabaseUser && isStaffSupabaseUser(supabaseUser)) {
        req.crmUser = crmUserFromSupabase(supabaseUser);
      }
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

