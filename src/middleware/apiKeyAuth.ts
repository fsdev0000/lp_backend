import { Request, Response, NextFunction } from 'express';
import { verifyCrmSessionToken } from '../utils/sessionToken';
import {
  ALL_WORKSPACES,
  crmUserFromSessionPayload,
  crmUserFromSupabase,
  isStaffSupabaseUser,
  isSupabaseUserDeactivated,
  verifySupabaseToken,
} from './crmRoleAuth';

function bearerOf(authHeader?: string): string | undefined {
  if (!authHeader || authHeader.startsWith('Basic ')) return undefined;
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
  return token || undefined;
}

/**
 * The request passed on its API key; if it also carries a signed-in user's token (the CRM's proxy adds the key to
 * every call), note who that is, so audit logs name them and role checks apply.
 */
async function attachSignedInUser(req: Request, token: string | undefined, validKeys: string[]) {
  if (!token || validKeys.includes(token)) return;
  if (token.startsWith('lp_sess.')) {
    const sessionUser = verifyCrmSessionToken(token);
    if (sessionUser) {
      const crmUser = crmUserFromSessionPayload(sessionUser);
      if (crmUser) {
        (req as any).user = crmUser;
        (req as any).crmUser = crmUser;
      }
    }
    return;
  }
  const user = await verifySupabaseToken(token);
  if (user && isStaffSupabaseUser(user)) {
    const crmUser = crmUserFromSupabase(user);
    (req as any).user = crmUser;
    (req as any).crmUser = crmUser;
  }
}

/**
 * Validates x-api-key, Authorization: Bearer <key|jwt>, or Basic Auth
 * for protected CRM, content, and social endpoints.
 */
export async function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const apiKeyHeader = req.headers['x-api-key'] as string | undefined;
  const authHeader = req.headers.authorization as string | undefined;
  const queryKey = (req.query.api_key || req.query.apiKey || req.query.token) as string | undefined;

  const validKeys = [
    process.env.ADMIN_API_KEY,
    process.env.CRM_API_KEY,
    process.env.ARTICLES_API_KEY,
    process.env.NEWSLETTER_SEND_API_KEY,
    process.env.NEWSLETTER_API_KEY,
  ]
    .map((k) => k?.trim())
    .filter(Boolean) as string[];

  // 1. Check x-api-key header or query param
  if (
    (apiKeyHeader && validKeys.includes(apiKeyHeader.trim())) ||
    (queryKey && validKeys.includes(queryKey.trim()))
  ) {
    await attachSignedInUser(req, bearerOf(authHeader), validKeys);
    return next();
  }

  // 2. Check Authorization header (Bearer or Basic)
  if (authHeader) {
    if (authHeader.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(authHeader.slice(6).trim(), 'base64').toString('utf8');
        const [user, pass] = decoded.split(':');
        const expectedUser = process.env.SWAGGER_USER || 'admin';
        const expectedPass = process.env.SWAGGER_PASSWORD;
        if (
          (expectedPass && user === expectedUser && pass === expectedPass) ||
          (pass && validKeys.includes(pass))
        ) {
          return next();
        }
      } catch {
        // Ignore malformed basic auth
      }
    }

    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : authHeader.trim();

    if (token && validKeys.includes(token)) {
      return next();
    }

    // 2. Check signed expiring CRM session token
    if (token && token.startsWith('lp_sess.')) {
      const sessionUser = verifyCrmSessionToken(token);
      if (sessionUser) {
        const crmUser = crmUserFromSessionPayload(sessionUser);
        if (!crmUser) {
          return res.status(401).json({
            success: false,
            error: 'Unauthorized: Account has been deactivated.',
          });
        }
        (req as any).user = crmUser;
        (req as any).crmUser = crmUser;
        return next();
      }
    }

    // 3. If token looks like a Supabase JWT, verify via Supabase Auth
    if (token) {
      const user = await verifySupabaseToken(token);
      if (user) {
        if (isSupabaseUserDeactivated(user)) {
          return res.status(401).json({
            success: false,
            error: 'Unauthorized: Account has been deactivated.',
          });
        }
        if (!isStaffSupabaseUser(user)) {
          return res.status(403).json({
            success: false,
            error: 'Forbidden: User is not authorized to access Social CRM resources.',
          });
        }
        const crmUser = crmUserFromSupabase(user);
        (req as any).user = crmUser;
        (req as any).crmUser = crmUser;
        return next();
      }
    }
  }

  return res.status(401).json({
    success: false,
    error: 'Unauthorized: Valid x-api-key header or Bearer token is required to access this endpoint.',
  });
}
