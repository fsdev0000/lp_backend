import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const CONFIG_KEY = 'crm_revoked_users';
let hasLoadedFromDb = false;

export interface CrmSessionPayload {
  id: string;
  email: string;
  name?: string;
  role: string;
  workspaces?: string[];
  roleVersion?: number;
  iat: number;
  exp: number;
}

/**
 * Registry of deactivated user IDs and emails, persisted in SystemConfig and cached in-memory,
 * so existing lp_sess.* tokens are rejected immediately upon deactivation across restarts and instances.
 */
const revokedUserIds = new Set<string>();
const revokedUserEmails = new Set<string>();

async function syncRevocationsFromDb(): Promise<void> {
  if (process.env.NODE_ENV === 'test') return;
  try {
    const row = await prisma.systemConfig.findUnique({ where: { key: CONFIG_KEY } });
    if (row?.value) {
      const data = JSON.parse(row.value) as { userIds?: string[]; emails?: string[] };
      if (Array.isArray(data.userIds)) {
        for (const id of data.userIds) revokedUserIds.add(id);
      }
      if (Array.isArray(data.emails)) {
        for (const e of data.emails) revokedUserEmails.add(e.toLowerCase());
      }
    }
    hasLoadedFromDb = true;
  } catch {}
}

async function persistRevocationsToDb(): Promise<void> {
  if (process.env.NODE_ENV === 'test') return;
  try {
    const data = {
      userIds: Array.from(revokedUserIds),
      emails: Array.from(revokedUserEmails),
    };
    await prisma.systemConfig.upsert({
      where: { key: CONFIG_KEY },
      update: { value: JSON.stringify(data), updatedAt: new Date() },
      create: { key: CONFIG_KEY, value: JSON.stringify(data), updatedAt: new Date() },
    });
  } catch (err: any) {
    console.warn('[SessionToken] Failed to persist revoked users to DB:', err?.message);
  }
}

// Initial hydration from DB on load
syncRevocationsFromDb().catch(() => {});

export function revokeUserSessions(userId?: string | null, email?: string | null): void {
  if (userId) revokedUserIds.add(userId.trim());
  if (email) revokedUserEmails.add(email.trim().toLowerCase());
  persistRevocationsToDb().catch(() => {});
}

export function restoreUserSessions(userId?: string | null, email?: string | null): void {
  if (userId) revokedUserIds.delete(userId.trim());
  if (email) revokedUserEmails.delete(email.trim().toLowerCase());
  persistRevocationsToDb().catch(() => {});
}

export function isUserSessionRevoked(userId?: string | null, email?: string | null): boolean {
  if (!hasLoadedFromDb && process.env.NODE_ENV !== 'test') {
    syncRevocationsFromDb().catch(() => {});
  }
  if (userId && revokedUserIds.has(userId.trim())) return true;
  if (email && revokedUserEmails.has(email.trim().toLowerCase())) return true;
  return false;
}

export function clearRevokedUserSessions(): void {
  revokedUserIds.clear();
  revokedUserEmails.clear();
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
  user: {
    id: string;
    email: string;
    name?: string;
    role: string;
    workspaces?: string[];
    roleVersion?: number;
  },
  expiresInSeconds = 24 * 60 * 60
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: CrmSessionPayload = {
    id: user.id,
    email: user.email.toLowerCase(),
    name: user.name || user.email.split('@')[0],
    role: user.role.toLowerCase(),
    ...(Array.isArray(user.workspaces) ? { workspaces: user.workspaces } : {}),
    ...(typeof user.roleVersion === 'number' ? { roleVersion: user.roleVersion } : {}),
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
 * Verifies a CRM session token, checking signature, expiration, and immediate deactivation revocation.
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
    if (isUserSessionRevoked(payload.id, payload.email)) {
      return null; // Deactivated
    }
    return payload;
  } catch {
    return null;
  }
}
