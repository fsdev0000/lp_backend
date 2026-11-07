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
  const secret = process.env.CRM_SESSION_SECRET?.trim();
  if (!secret) {
    throw new Error('CRM_SESSION_SECRET environment variable is required for CRM session signing');
  }
  return secret;
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
  let expectedSig: string;
  try {
    expectedSig = createHmac('sha256', getSessionSecret())
      .update(payloadB64)
      .digest('base64url');
  } catch {
    return null;
  }

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

