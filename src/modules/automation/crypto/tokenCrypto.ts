import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function deriveKey(rawSecret?: string): Buffer {
  const secret = (rawSecret ?? process.env.TOKEN_ENCRYPTION_KEY ?? '').trim();
  if (!secret) {
    throw new Error('TOKEN_ENCRYPTION_KEY environment variable is required to encrypt or decrypt OAuth tokens');
  }
  if (/^[0-9a-fA-F]{64}$/.test(secret)) {
    return Buffer.from(secret, 'hex');
  }
  return createHash('sha256').update(secret, 'utf8').digest();
}

/**
 * Encrypts a plaintext OAuth token at rest using AES-256-GCM.
 * Format: v1:<iv_b64url>:<tag_b64url>:<ciphertext_b64url>
 */
export function encryptToken(plaintext: string, rawKey?: string): string {
  if (!plaintext) {
    throw new Error('Cannot encrypt an empty token');
  }
  const key = deriveKey(rawKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`;
}

/**
 * Decrypts an AES-256-GCM encrypted token stored in SocialAccount.
 */
export function decryptToken(encryptedPayload: string, rawKey?: string): string {
  if (!encryptedPayload) {
    throw new Error('Cannot decrypt an empty token payload');
  }
  const parts = encryptedPayload.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Invalid encrypted token format');
  }

  const [, ivB64, tagB64, dataB64] = parts;
  const key = deriveKey(rawKey);
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  const ciphertext = Buffer.from(dataB64, 'base64url');

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

