import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';

const prisma = new PrismaClient();
export const consentRoutes = Router();

// Rate limit: 10 requests per minute per IP
const consentLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 10,
  message: { error: 'Too many consent updates, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const consentSchema = z.object({
  consentId: z.string().uuid(),
  anonymousId: z.string().uuid().optional(),
  eventType: z.enum(['INITIAL_CHOICE', 'ACCEPT_ALL', 'REJECT_ALL', 'PREFERENCE_UPDATE', 'WITHDRAW']),
  strictlyNecessary: z.boolean().default(true),
  functional: z.boolean(),
  analytics: z.boolean(),
  marketing: z.boolean(),
  personalization: z.boolean(),
  policyVersion: z.string().min(1),
  bannerVersion: z.string().min(1),
  jurisdiction: z.string().optional(),
  idempotencyKey: z.string().min(1),
});

function hashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  // Use SHA-256 and truncate to 16 chars for anonymization while retaining enough entropy for abuse tracking
  return crypto.createHash('sha256').update(ip).digest('hex').substring(0, 16);
}

function minimizeUserAgent(ua: string | undefined): string | null {
  if (!ua) return null;
  return ua.substring(0, 255); // Truncate long User-Agent strings
}

/**
 * @openapi
 * /consent/log:
 *   post:
 *     summary: Log a consent state transition
 *     tags: [Consent]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             # Add specific schema properties here...
 *     responses:
 *       201:
 *         description: Consent logged successfully
 *       200:
 *         description: Consent already logged (idempotent)
 */
consentRoutes.post('/log', consentLimiter, async (req, res) => {
  try {
    const parsed = consentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid consent payload', details: parsed.error.issues });
    }

    const data = parsed.data;

    // Idempotency check
    const existing = await prisma.consentAuditLog.findUnique({
      where: { idempotencyKey: data.idempotencyKey },
    });

    if (existing) {
      // Return 200 OK without creating a duplicate record
      return res.status(200).json({ message: 'Consent transition already logged.', id: existing.id });
    }

    // Prepare anonymized fields
    const ipStr = req.ip || (req.headers['x-forwarded-for'] as string);
    const ipAddress = hashIp(ipStr ? ipStr.split(',')[0].trim() : undefined);
    const userAgent = minimizeUserAgent(req.headers['user-agent']);

    // Append-only insert
    const auditLog = await prisma.consentAuditLog.create({
      data: {
        consentId: data.consentId,
        anonymousId: data.anonymousId,
        eventType: data.eventType,
        strictlyNecessary: data.strictlyNecessary,
        functional: data.functional,
        analytics: data.analytics,
        marketing: data.marketing,
        personalization: data.personalization,
        policyVersion: data.policyVersion,
        bannerVersion: data.bannerVersion,
        jurisdiction: data.jurisdiction,
        ipAddress,
        userAgent,
        idempotencyKey: data.idempotencyKey,
      },
    });

    return res.status(201).json({ message: 'Consent transition logged.', id: auditLog.id });
  } catch (error) {
    console.error('Consent Log Error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});
