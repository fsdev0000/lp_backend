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

function getCleanPath(req: Request): string {
  const raw = req.baseUrl ? `${req.baseUrl}${req.path}` : (req.path || req.originalUrl || '');
  return raw.split('?')[0].trim();
}

function isArticlesRoute(path: string): boolean {
  return /^\/(?:api\/)?(?:v1\/)?articles(?:\/|$)/i.test(path);
}

function isNewsletterRoute(path: string): boolean {
  return /^\/(?:api\/)?(?:v1\/)?newsletter(?:\/|$)/i.test(path);
}

/**
 * Validates x-api-key, Authorization: Bearer <key|jwt>, or Basic Auth
 * for protected CRM, content, and social endpoints.
 *
 * Scoping rules:
 * - ADMIN_API_KEY and CRM_API_KEY: CRM Super Admin access across all endpoints.
 * - ARTICLES_API_KEY: Scoped exclusively to articles routes (403 on Social CRM / Content).
 * - NEWSLETTER_API_KEY & NEWSLETTER_SEND_API_KEY: Scoped exclusively to newsletter routes (403 on Social CRM / Content).
 */
export async function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const apiKeyHeader = (req.headers['x-api-key'] || req.headers['x-api-token']) as string | undefined;
  const authHeader = req.headers.authorization as string | undefined;

  const crmAdminKeys = [
    process.env.ADMIN_API_KEY,
    process.env.CRM_API_KEY,
  ]
    .map((k) => k?.trim())
    .filter(Boolean) as string[];

  const articlesKeys = [process.env.ARTICLES_API_KEY]
    .map((k) => k?.trim())
    .filter(Boolean) as string[];

  const newsletterKeys = [
    process.env.NEWSLETTER_SEND_API_KEY,
    process.env.NEWSLETTER_API_KEY,
  ]
    .map((k) => k?.trim())
    .filter(Boolean) as string[];

  const serviceKeys = [...articlesKeys, ...newsletterKeys];
  const allValidKeys = [...crmAdminKeys, ...serviceKeys];

  const cleanPath = getCleanPath(req);

  // Extract raw candidate key from x-api-key, Bearer, or Basic
  let candidateKey: string | undefined;
  if (apiKeyHeader) {
    candidateKey = apiKeyHeader.trim();
  } else if (authHeader) {
    if (authHeader.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(authHeader.slice(6).trim(), 'base64').toString('utf8');
        const [user, pass] = decoded.split(':');
        const expectedUser = process.env.SWAGGER_USER || 'admin';
        const expectedPass = process.env.SWAGGER_PASSWORD;
        if (expectedPass && user === expectedUser && pass === expectedPass) {
          req.crmUser = {
            id: 'api-key-admin',
            email: 'admin@leadersperformance.ae',
            name: 'API Key Admin',
            role: 'super_admin',
            workspaces: ['leaders_performance', 'lionel_eersteling'],
            roleVersion: 2,
          };
          return next();
        }
        candidateKey = pass?.trim();
      } catch {
        // Ignore malformed basic auth
      }
    } else {
      const token = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : authHeader.trim();
      candidateKey = token;
    }
  }

  // 1. Check if candidateKey matches a master CRM Admin key (ADMIN_API_KEY, CRM_API_KEY)
  if (candidateKey && crmAdminKeys.includes(candidateKey)) {
    // If request also carries a signed-in staff token (CRM proxy attaches key to every call), attach that user
    const bearerToken = bearerOf(authHeader);
    if (bearerToken && !crmAdminKeys.includes(bearerToken)) {
      await attachSignedInUser(req, bearerToken, allValidKeys);
    }
    if (!req.crmUser) {
      req.crmUser = {
        id: 'api-key-admin',
        email: process.env.CRM_ADMIN_EMAIL || 'admin@leadersperformance.ae',
        name: 'API Key Admin',
        role: 'super_admin',
        workspaces: ['leaders_performance', 'lionel_eersteling'],
        roleVersion: 2,
      };
    }
    return next();
  }

  // 2. Check if candidateKey matches a Service Key (ARTICLES_API_KEY, NEWSLETTER_SEND_API_KEY, NEWSLETTER_API_KEY)
  if (candidateKey && serviceKeys.includes(candidateKey)) {
    const isArticlesKey = articlesKeys.includes(candidateKey);
    const isNewsletterKey = newsletterKeys.includes(candidateKey);

    // ARTICLES_API_KEY only works on articles routes
    if (isArticlesKey && isArticlesRoute(cleanPath)) {
      return next();
    }

    // NEWSLETTER keys only work on newsletter routes
    if (isNewsletterKey && isNewsletterRoute(cleanPath)) {
      return next();
    }

    // Service keys get 403 Forbidden on LinkedIn, Instagram, TikTok, /content, and any other CRM route
    return res.status(403).json({
      success: false,
      error: 'Forbidden: Service API key is not authorized for Social CRM or content management routes.',
    });
  }

  // 3. Check signed expiring CRM session token (lp_sess.*)
  if (candidateKey && candidateKey.startsWith('lp_sess.')) {
    const sessionUser = verifyCrmSessionToken(candidateKey);
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

  // 4. Check Supabase JWT
  if (candidateKey) {
    const user = await verifySupabaseToken(candidateKey);
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

  return res.status(401).json({
    success: false,
    error: 'Unauthorized: Valid x-api-key header or Bearer token is required to access this endpoint.',
  });
}
