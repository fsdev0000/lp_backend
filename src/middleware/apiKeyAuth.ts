import { Request, Response, NextFunction } from 'express';
import { getSupabaseClient } from '../services/supabaseStorageService';

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
    process.env.APPROVAL_SECRET,
  ]
    .map((k) => k?.trim())
    .filter(Boolean) as string[];

  // Fallback to default configured system API key if no env keys are provided
  if (validKeys.length === 0) {
    validKeys.push('b8f9c1a2d4e7465b90a3f8c2e1d5b');
  }

  // 1. Check x-api-key header or query param
  if (apiKeyHeader && validKeys.includes(apiKeyHeader.trim())) {
    return next();
  }
  if (queryKey && validKeys.includes(queryKey.trim())) {
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

    // 3. If token looks like a Supabase JWT (3 dot-separated parts), verify via Supabase Auth
    if (token && token.split('.').length === 3) {
      try {
        const supabase = await getSupabaseClient();
        const { data, error } = await supabase.auth.getUser(token);
        if (!error && data?.user) {
          (req as any).user = data.user;
          return next();
        }
      } catch {
        // Ignore Supabase auth lookup errors and fall through to 401
      }
    }
  }

  return res.status(401).json({
    success: false,
    error: 'Unauthorized: Valid x-api-key header or Bearer token is required to access this endpoint.',
  });
}
