import { createHmac, timingSafeEqual } from 'crypto';

export interface CrmSessionPayload {
  id: string;
  email: string;
  name?: string;
  role: string;
  iat: number;
  exp: number;
}

function getSessionSecret(): string {
  return (
    process.env.CRM_SESSION_SECRET ||
    process.env.ADMIN_API_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    'lp-crm-session-secret-key-fallback'
  );
}

/**
 * Creates a signed, expiring session token for CRM staff (default 24h TTL)
 */
export function generateCrmSessionToken(
  user: { id: string; email: string; name?: string; role: string },
  expiresInSeconds = 24 * 60 * 60
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: CrmSessionPayload = {
    id: user.id,
    email: user.email.toLowerCase(),
    name: user.name || user.email.split('@')[0],
    role: user.role.toLowerCase(),
    iat: now,
    exp: now + expiresInSeconds,
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', getSessionSecret())
    .update(payloadB64)
    .digest('base64url');

  return `lp_sess.${payloadB64}.${signature}`;
}

/**
 * Verifies a CRM session token, checking signature and expiration
 */
export function verifyCrmSessionToken(token: string): CrmSessionPayload | null {
  if (!token || !token.startsWith('lp_sess.')) {
    return null;
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }

  const [, payloadB64, signature] = parts;
  const expectedSig = createHmac('sha256', getSessionSecret())
    .update(payloadB64)
    .digest('base64url');

  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSig);

  if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const payload: CrmSessionPayload = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8')
    );
    const now = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp < now) {
      return null; // Expired
    }
    return payload;
  } catch {
    return null;
  }
}

