import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';

/**
 * Authenticates n8n internal requests via X-Internal-Key header and optional IP allowlist.
 * Plan Section 6: "Every decision and every status change happens in lp_backend through the /internal/* endpoints (auth: X-Internal-Key header, IP-restricted)."
 */
export function requireInternalKey(req: Request, res: Response, next: NextFunction): void {
  const configuredKey = (process.env.INTERNAL_API_KEY || '').trim();
  if (!configuredKey) {
    res.status(503).json({
      success: false,
      code: 'INTERNAL_AUTH_NOT_CONFIGURED',
      error: 'INTERNAL_API_KEY is not configured on the server.',
    });
    return;
  }

  const providedKey = String(req.headers['x-internal-key'] || '').trim();
  if (!providedKey) {
    res.status(401).json({
      success: false,
      code: 'UNAUTHORIZED',
      error: 'Missing X-Internal-Key header.',
    });
    return;
  }

  const providedBuf = Buffer.from(providedKey, 'utf8');
  const expectedBuf = Buffer.from(configuredKey, 'utf8');
  if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
    res.status(401).json({
      success: false,
      code: 'UNAUTHORIZED',
      error: 'Invalid X-Internal-Key header.',
    });
    return;
  }

  // Optional IP restriction via INTERNAL_ALLOWED_IPS (comma-separated)
  const rawAllowedIps = (process.env.INTERNAL_ALLOWED_IPS || '').trim();
  if (rawAllowedIps) {
    const allowedIps = rawAllowedIps
      .split(',')
      .map((ip) => ip.trim())
      .filter(Boolean);
    const clientIp = (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
    if (allowedIps.length > 0 && !allowedIps.includes(clientIp)) {
      res.status(403).json({
        success: false,
        code: 'FORBIDDEN_IP',
        error: `IP ${clientIp} is not authorized to call /internal/* endpoints.`,
      });
      return;
    }
  }

  next();
}

