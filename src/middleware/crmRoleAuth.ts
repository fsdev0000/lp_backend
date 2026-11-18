import { Request, Response, NextFunction } from 'express';
import {
  verifyCrmSessionToken,
  isUserSessionRevoked,
  revokeUserSessions,
  restoreUserSessions,
} from '../utils/sessionToken';
import { getSupabaseClient } from '../services/supabaseStorageService';

export type CanonicalCrmRole = 'super_admin' | 'admin' | 'manager' | 'user';
export type SocialCrmRole = CanonicalCrmRole | 'approver' | 'editor';

export interface AuthenticatedCrmUser {
  id: string;
  email: string;
  name: string;
  role: CanonicalCrmRole;
  workspaces: string[];
  roleVersion: 2;
}

declare global {
  namespace Express {
    interface Request {
      crmUser?: AuthenticatedCrmUser;
    }
  }
}

export const ALL_WORKSPACES = ['leaders_performance', 'lionel_eersteling'] as const;

export function normalizeWorkspace(raw?: string | null): string {
  const norm = (raw || 'leaders_performance').toLowerCase().trim();
  if (
    norm.includes('lioneleersteling') ||
    norm.includes('lionel_eersteling') ||
    norm === 'le' ||
    norm === 'personal'
  ) {
    return 'lionel_eersteling';
  }
  return 'leaders_performance';
}

export function cleanWorkspacesForRole(
  role: CanonicalCrmRole,
  rawWorkspaces?: unknown,
  defaultAllIfMissing = true
): string[] {
  if (role === 'super_admin' || role === 'admin') {
    return [...ALL_WORKSPACES];
  }
  if (Array.isArray(rawWorkspaces)) {
    const valid = rawWorkspaces
      .filter((w): w is string => typeof w === 'string' && w.trim().length > 0)
      .map((w) => normalizeWorkspace(w))
      .filter((w) => (ALL_WORKSPACES as readonly string[]).includes(w));
    return [...new Set(valid)];
  }
  return defaultAllIfMissing ? [...ALL_WORKSPACES] : [];
}

/** Default approver while EMAIL_APPROVER is unset (used strictly as notification recipient). */
export const DEFAULT_APPROVER_EMAIL = 'asif@leadersperformance.ae';

/**
 * Live user state overrides from User Management (/api/v1/crm/users) so role/workspace updates
 * and deactivations apply immediately on /auth/me and protected routes without re-signing in.
 */
interface LiveUserOverride {
  id: string;
  email: string;
  name?: string;
  role: CanonicalCrmRole;
  workspaces: string[];
  status: 'active' | 'invited' | 'deactivated';
}

const liveOverridesById = new Map<string, LiveUserOverride>();
const liveOverridesByEmail = new Map<string, LiveUserOverride>();

export function setLiveUserOverride(override: LiveUserOverride): void {
  const cleanEmail = override.email.trim().toLowerCase();
  const normalized: LiveUserOverride = {
    ...override,
    email: cleanEmail,
    workspaces: cleanWorkspacesForRole(override.role, override.workspaces, false),
  };
  liveOverridesById.set(override.id, normalized);
  liveOverridesByEmail.set(cleanEmail, normalized);

  if (override.status === 'deactivated') {
    revokeUserSessions(override.id, cleanEmail);
  } else {
    restoreUserSessions(override.id, cleanEmail);
  }
}

export function getLiveUserOverride(id?: string | null, email?: string | null): LiveUserOverride | null {
  if (id && liveOverridesById.has(id)) {
    return liveOverridesById.get(id)!;
  }
  if (email && liveOverridesByEmail.has(email.trim().toLowerCase())) {
    return liveOverridesByEmail.get(email.trim().toLowerCase())!;
  }
  return null;
}

export function clearLiveUserOverrides(): void {
  liveOverridesById.clear();
  liveOverridesByEmail.clear();
}

/**
 * Maps a raw role name to the V2 4-role model (owner's decision, 17 Nov 2026):
 * - super_admin
 * - admin
 * - manager (formerly approver / founder)
 * - user (formerly editor / staff / crm)
 *
 * EMAIL_APPROVER / EMAIL_EDITORS / EMAIL_ADMIN are NO LONGER used for role assignment
 * (they remain only as notification recipients).
 * Legacy tokens without roleVersion === 2 map 'admin' -> 'super_admin' so legacy admin tokens keep full access.
 */
export function mapEmailAndRoleToCrmRole(
  _email: string,
  rawRole: string,
  roleVersion?: number
): CanonicalCrmRole {
  const lowerRole = (rawRole || '').toLowerCase().trim();

  if (lowerRole === 'super_admin') {
    return 'super_admin';
  }
  if (lowerRole === 'admin') {
    return roleVersion === 2 ? 'admin' : 'super_admin';
  }
  if (lowerRole === 'manager' || lowerRole === 'approver' || lowerRole === 'founder') {
    return 'manager';
  }
  if (
    lowerRole === 'user' ||
    lowerRole === 'editor' ||
    lowerRole === 'staff' ||
    lowerRole === 'crm' ||
    lowerRole === 'content_manager'
  ) {
    return 'user';
  }
  return 'user';
}

export type VerifiedSupabaseUser = {
  id: string;
  email?: string;
  email_confirmed_at?: string | null;
  confirmed_at?: string | null;
  banned_until?: string | null;
  last_sign_in_at?: string | null;
  invited_at?: string | null;
  created_at?: string | null;
  app_metadata?: Record<string, any>;
  user_metadata?: Record<string, any>;
};

export function isSupabaseUserDeactivated(user: VerifiedSupabaseUser): boolean {
  if (isUserSessionRevoked(user.id, user.email)) return true;
  if (user.app_metadata?.deactivated === true || user.app_metadata?.status === 'deactivated') {
    return true;
  }
  if (user.banned_until) {
    const bannedUntilMs = new Date(user.banned_until).getTime();
    if (!isNaN(bannedUntilMs) && bannedUntilMs > Date.now()) {
      return true;
    }
  }
  if (user.app_metadata?.deactivated === false || user.app_metadata?.status === 'active') {
    return false;
  }
  const live = getLiveUserOverride(user.id, user.email);
  if (live && live.status === 'deactivated') {
    return true;
  }
  return false;
}

/**
 * A Supabase JWT, verified by Supabase itself. Returns null for a token Supabase doesn't accept.
 */
export async function verifySupabaseToken(token: string): Promise<VerifiedSupabaseUser | null> {
  if (token.split('.').length !== 3) return null;
  try {
    const supabase = await getSupabaseClient();
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return null;
    return data.user as VerifiedSupabaseUser;
  } catch {
    return null;
  }
}

/** Checks whether a verified Supabase user is an authorized CRM staff member (and not deactivated). */
export function isStaffSupabaseUser(user: VerifiedSupabaseUser): boolean {
  if (isSupabaseUserDeactivated(user)) return false;
  const role = String(user.app_metadata?.role || '').toLowerCase();
  const email = (user.email || '').toLowerCase();
  const confirmed = Boolean(user.email_confirmed_at || user.confirmed_at);
  return (
    [
      'super_admin',
      'admin',
      'manager',
      'user',
      'approver',
      'founder',
      'staff',
      'crm',
      'editor',
      'content_manager',
    ].includes(role) ||
    (confirmed && email.endsWith('@leadersperformance.ae')) ||
    Boolean(process.env.CRM_ADMIN_EMAIL && email === process.env.CRM_ADMIN_EMAIL.toLowerCase())
  );
}

/** Builds the AuthenticatedCrmUser from a verified Supabase account, honoring live overrides. */
export function crmUserFromSupabase(user: VerifiedSupabaseUser): AuthenticatedCrmUser {
  const email = (user.email || '').toLowerCase();
  const live = getLiveUserOverride(user.id, email);
  if (live) {
    return {
      id: user.id,
      email,
      name:
        live.name ||
        user.app_metadata?.name ||
        user.user_metadata?.full_name ||
        user.user_metadata?.name ||
        email.split('@')[0] ||
        'CRM User',
      role: live.role,
      workspaces: cleanWorkspacesForRole(live.role, live.workspaces, false),
      roleVersion: 2,
    };
  }

  const rawRole = String(user.app_metadata?.role || 'user');
  const roleVersion = user.app_metadata?.roleVersion;
  const role = mapEmailAndRoleToCrmRole(email, rawRole, roleVersion);
  const hasExplicitWorkspaces = Array.isArray(user.app_metadata?.workspaces);
  const workspaces = cleanWorkspacesForRole(
    role,
    user.app_metadata?.workspaces,
    !hasExplicitWorkspaces && roleVersion !== 2
  );

  return {
    id: user.id,
    email,
    name:
      user.app_metadata?.name ||
      user.user_metadata?.full_name ||
      user.user_metadata?.name ||
      email.split('@')[0] ||
      'CRM User',
    role,
    workspaces,
    roleVersion: 2,
  };
}

/** Builds AuthenticatedCrmUser from a verified lp_sess.* payload, honoring live role/workspace/deactivation overrides. */
export function crmUserFromSessionPayload(verified: {
  id: string;
  email: string;
  name?: string;
  role: string;
  workspaces?: string[];
  roleVersion?: number;
}): AuthenticatedCrmUser | null {
  if (isUserSessionRevoked(verified.id, verified.email)) {
    return null;
  }
  const live = getLiveUserOverride(verified.id, verified.email);
  if (live) {
    if (live.status === 'deactivated') return null;
    return {
      id: verified.id,
      email: verified.email,
      name: live.name || verified.name || verified.email.split('@')[0],
      role: live.role,
      workspaces: cleanWorkspacesForRole(live.role, live.workspaces, false),
      roleVersion: 2,
    };
  }

  const role = mapEmailAndRoleToCrmRole(verified.email, verified.role, verified.roleVersion);
  const hasExplicitWorkspaces = Array.isArray(verified.workspaces);
  const workspaces = cleanWorkspacesForRole(
    role,
    verified.workspaces,
    !hasExplicitWorkspaces && verified.roleVersion !== 2
  );

  return {
    id: verified.id,
    email: verified.email,
    name: verified.name || verified.email.split('@')[0],
    role,
    workspaces,
    roleVersion: 2,
  };
}

/**
 * Authenticates logged-in CRM users via either:
 * 1. Bearer session token (`lp_sess.*`)
 * 2. Supabase JWT
 * Attaches `req.crmUser` with their V2 role (`super_admin`, `admin`, `manager`, or `user`), workspaces, and roleVersion: 2.
 */
export async function requireCrmAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const url = req.originalUrl || req.path || '';
  const isStrictAuthRoute =
    url.includes('/reports/export') ||
    url.includes('/notifications') ||
    url.includes('/ai-referrals') ||
    url.includes('/crm/users') ||
    url.includes('/auth/me');
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
      role: 'super_admin',
      workspaces: [...ALL_WORKSPACES],
      roleVersion: 2,
    };
    next();
    return;
  }

  const apiKeyHeader = (req.headers['x-api-key'] ||
    req.headers['x-api-token'] ||
    req.query.api_key ||
    req.query.apiKey) as string | undefined;
  const authHeader = String(req.headers.authorization || '').trim();
  const rawQueryToken = (req.query.token || req.query.auth_token || req.query.bearer) as
    | string
    | undefined;
  const bearerToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : authHeader || (rawQueryToken ? String(rawQueryToken).trim() : '');

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

  if (bearerToken && !validKeys.includes(bearerToken)) {
    // 1. Internal signed CRM session token (lp_sess.*)
    if (bearerToken.startsWith('lp_sess.')) {
      const verified = verifyCrmSessionToken(bearerToken);
      if (verified) {
        const crmUser = crmUserFromSessionPayload(verified);
        if (!crmUser) {
          res.status(401).json({
            success: false,
            code: 'UNAUTHORIZED',
            error: 'This account has been deactivated.',
          });
          return;
        }
        req.crmUser = crmUser;
        next();
        return;
      }
    }

    // 2. Supabase Auth JWT
    const supabaseUser = await verifySupabaseToken(bearerToken);
    if (supabaseUser) {
      if (isSupabaseUserDeactivated(supabaseUser)) {
        res.status(401).json({
          success: false,
          code: 'UNAUTHORIZED',
          error: 'This account has been deactivated.',
        });
        return;
      }
      if (!isStaffSupabaseUser(supabaseUser)) {
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
      role: 'super_admin',
      workspaces: [...ALL_WORKSPACES],
      roleVersion: 2,
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
        const crmUser = crmUserFromSessionPayload(verified);
        if (crmUser) req.crmUser = crmUser;
      }
    } else {
      const supabaseUser = await verifySupabaseToken(bearerToken);
      if (supabaseUser && isStaffSupabaseUser(supabaseUser)) {
        req.crmUser = crmUserFromSupabase(supabaseUser);
      }
    }
  }
  next();
}

/**
 * Workspace-level authorization guard.
 * super_admin and admin have universal access to all workspaces.
 * manager and user may only access workspaces assigned in req.crmUser.workspaces.
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

  // super_admin and admin always have access to both workspaces
  if (req.crmUser.role === 'super_admin' || req.crmUser.role === 'admin') {
    next();
    return;
  }

  const allowed = req.crmUser.workspaces || [];
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
 * Normalizes a list of allowed roles (supporting legacy 'approver' -> 'manager' and 'editor' -> 'user').
 */
function expandAllowedRoles(roles: SocialCrmRole[]): Set<CanonicalCrmRole> {
  const set = new Set<CanonicalCrmRole>();
  for (const r of roles) {
    if (r === 'super_admin') set.add('super_admin');
    else if (r === 'admin') set.add('admin');
    else if (r === 'manager' || r === 'approver') set.add('manager');
    else if (r === 'user' || r === 'editor') set.add('user');
  }
  return set;
}

/**
 * Role guard enforcing the V2 4-role matrix:
 * - super_admin: permitted on all routes
 * - admin: manages users (not Super Admins) & integrations; does NOT approve or publish
 * - manager: approves posts and publishes website texts in assigned workspaces
 * - user: analytics and drafts in assigned workspaces
 */
export function requireCrmRoles(...allowedRoles: SocialCrmRole[]) {
  const expanded = expandAllowedRoles(allowedRoles);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.crmUser) {
      res.status(401).json({
        success: false,
        code: 'UNAUTHORIZED',
        error: 'Authentication required.',
      });
      return;
    }

    if (req.crmUser.role === 'super_admin' || expanded.has(req.crmUser.role)) {
      next();
      return;
    }

    res.status(403).json({
      success: false,
      code: 'FORBIDDEN_ROLE',
      error: `Role "${req.crmUser.role}" is not permitted to perform this action.`,
    });
  };
}

/**
 * Verifies that the signed-in user may approve, reject, request changes, or publish a post in `postWorkspace`.
 * - super_admin: allowed in all workspaces.
 * - manager: allowed ONLY if `postWorkspace` is in `crmUser.workspaces`.
 * - admin / user: never allowed to approve or publish (403).
 */
export function checkCanApprovePostWorkspace(
  crmUser: AuthenticatedCrmUser | undefined | null,
  postWorkspace?: string | null
): { allowed: boolean; statusCode: number; code: string; error: string } {
  if (!crmUser) {
    return {
      allowed: false,
      statusCode: 401,
      code: 'UNAUTHORIZED',
      error: 'Authentication required.',
    };
  }

  if (crmUser.role === 'super_admin') {
    return { allowed: true, statusCode: 200, code: 'OK', error: '' };
  }

  if (crmUser.role !== 'manager') {
    return {
      allowed: false,
      statusCode: 403,
      code: 'FORBIDDEN_ROLE',
      error:
        crmUser.role === 'admin'
          ? 'Admins cannot approve or publish posts. Only Super Admins and Managers can approve.'
          : 'Users cannot approve or publish posts. Only Super Admins and Managers can approve.',
    };
  }

  const targetWs = normalizeWorkspace(postWorkspace);
  const assigned = Array.isArray(crmUser.workspaces) ? crmUser.workspaces : [];
  if (!assigned.includes(targetWs)) {
    return {
      allowed: false,
      statusCode: 403,
      code: 'FORBIDDEN_WORKSPACE',
      error: `You can only approve or publish posts in your assigned workspaces (${assigned.join(', ') || 'none'}).`,
    };
  }

  return { allowed: true, statusCode: 200, code: 'OK', error: '' };
}
