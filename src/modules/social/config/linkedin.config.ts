/**
 * Centralized LinkedIn safety, API version, OAuth scopes, and redirect configuration.
 */

export const LINKEDIN_MEMBER_PLATFORM = 'LINKEDIN';
export const LINKEDIN_PAGE_PLATFORM = 'LINKEDIN_PAGE';

/**
 * Returns LinkedIn Member scopes configured in environment, or safe defaults.
 * If App 2 (Community Management API) is used as LINKEDIN_CLIENT_ID, it requests
 * r_member_profileAnalytics and w_member_social to fetch live member follower analytics.
 */
export function getLinkedInMemberScopes(): string[] {
  if (process.env.LINKEDIN_MEMBER_SCOPES) {
    const parsed = process.env.LINKEDIN_MEMBER_SCOPES
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parsed.length > 0) return parsed;
  }
  const clientId = process.env.LINKEDIN_CLIENT_ID?.trim();
  const pageClientId = process.env.LINKEDIN_PAGE_CLIENT_ID?.trim();
  if (clientId && pageClientId && clientId === pageClientId) {
    return ['r_member_profileAnalytics', 'w_member_social', 'r_basicprofile'];
  }
  return ['openid', 'profile', 'email', 'w_member_social'];
}

export const LINKEDIN_MEMBER_SCOPES = getLinkedInMemberScopes();

/**
 * Returns LinkedIn Company Page scopes configured in environment, or safe defaults.
 * Notice: 'rw_organization_admin' is intentionally omitted by default because standard
 * Community Management API apps reject it with 'invalid_scope_error'.
 */
export function getLinkedInPageScopes(): string[] {
  if (process.env.LINKEDIN_PAGE_SCOPES) {
    const parsed = process.env.LINKEDIN_PAGE_SCOPES
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parsed.length > 0) return parsed;
  }
  return ['r_organization_social', 'rw_organization_admin'];
}

export const LINKEDIN_PAGE_SCOPES = getLinkedInPageScopes();

/**
 * Kill switch: nothing may be posted to LinkedIn unless LINKEDIN_PUBLISHING_ENABLED === 'true'.
 * Defaults to false.
 */
export function isLinkedInPublishingEnabled(): boolean {
  return process.env.LINKEDIN_PUBLISHING_ENABLED === 'true';
}

/**
 * Single environment variable for LinkedIn REST API version header ('LinkedIn-Version').
 * Currently active version: 202611.
 */
export function getLinkedInApiVersion(): string {
  const envVer = process.env.LINKEDIN_API_VERSION?.trim();
  return envVer && envVer.length >= 6 ? envVer : '202611';
}

/**
 * Returns the canonical LinkedIn Company Page vanity name (linkedin.com/company/lioneleersteling).
 */
export function getLinkedInVanityName(): string {
  return process.env.LINKEDIN_ORGANIZATION_VANITY_NAME?.trim() || 'lioneleersteling';
}

/**
 * Returns the default LinkedIn Organization ID (18948042 for Leaders Performance / lioneleersteling).
 */
export const DEFAULT_LINKEDIN_ORGANIZATION_ID = '18948042';
export const DEFAULT_LINKEDIN_ORGANIZATION_URN = 'urn:li:organization:18948042';

/**
 * Validates OAuth callback return_to URLs to prevent open redirects.
 * Only allows configured Leaders Performance / CRM origins (and localhost in non-production).
 */
export function isAllowedReturnToUrl(returnTo?: string): boolean {
  if (!returnTo || typeof returnTo !== 'string') {
    return false;
  }

  try {
    const parsed = new URL(returnTo);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }

    const allowedOrigins = new Set<string>([
      'https://leadersperformance.ae',
      'https://www.leadersperformance.ae',
      'https://staging.leadersperformance.ae',
      'https://crm.leadersperformance.ae',
      'https://social.leadersperformance.ae',
      'https://lioneleersteling.com',
      'https://www.lioneleersteling.com',
    ]);

    const envUrls = [
      process.env.FRONTEND_URL,
      process.env.CRM_URL,
      process.env.SOCIAL_CRM_URL,
      process.env.CORS_ORIGIN,
    ];

    for (const raw of envUrls) {
      if (!raw) continue;
      for (const part of raw.split(',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        try {
          allowedOrigins.add(new URL(trimmed).origin);
        } catch {
          // ignore malformed env URL
        }
      }
    }

    if (process.env.NODE_ENV !== 'production') {
      allowedOrigins.add('http://localhost:4000');
      allowedOrigins.add('http://localhost:5173');
      allowedOrigins.add('http://localhost:5174');
      allowedOrigins.add('http://localhost:5175');
      allowedOrigins.add('http://localhost:3000');
      allowedOrigins.add('http://127.0.0.1:4000');
      allowedOrigins.add('http://127.0.0.1:5173');
      allowedOrigins.add('http://127.0.0.1:5174');
      allowedOrigins.add('http://127.0.0.1:5175');
      allowedOrigins.add('http://127.0.0.1:3000');
    }

    return allowedOrigins.has(parsed.origin);
  } catch {
    return false;
  }
}

