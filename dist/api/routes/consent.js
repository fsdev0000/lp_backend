"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.consentRoutes = void 0;
const express_1 = require("express");
const client_1 = require("@prisma/client");
const zod_1 = require("zod");
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const crypto_1 = __importDefault(require("crypto"));
const prisma = new client_1.PrismaClient();
exports.consentRoutes = (0, express_1.Router)();
// Rate limit: 10 requests per minute per IP
const consentLimiter = (0, express_rate_limit_1.default)({
    windowMs: 1 * 60 * 1000,
    max: 10,
    message: { error: 'Too many consent updates, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});
const consentSchema = zod_1.z.object({
    consentId: zod_1.z.string().uuid(),
    anonymousId: zod_1.z.string().uuid().optional(),
    eventType: zod_1.z.enum(['INITIAL_CHOICE', 'ACCEPT_ALL', 'REJECT_ALL', 'PREFERENCE_UPDATE', 'WITHDRAW']),
    strictlyNecessary: zod_1.z.boolean().default(true),
    functional: zod_1.z.boolean(),
    analytics: zod_1.z.boolean(),
    marketing: zod_1.z.boolean(),
    personalization: zod_1.z.boolean(),
    policyVersion: zod_1.z.string().min(1),
    bannerVersion: zod_1.z.string().min(1),
    jurisdiction: zod_1.z.string().optional(),
    idempotencyKey: zod_1.z.string().min(1),
});
function hashIp(ip) {
    if (!ip)
        return null;
    // Use SHA-256 and truncate to 16 chars for anonymization while retaining enough entropy for abuse tracking
    return crypto_1.default.createHash('sha256').update(ip).digest('hex').substring(0, 16);
}
function minimizeUserAgent(ua) {
    if (!ua)
        return null;
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
exports.consentRoutes.post('/log', consentLimiter, async (req, res) => {
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
        const ipStr = req.ip || req.headers['x-forwarded-for'];
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
    }
    catch (error) {
        console.error('Consent Log Error:', error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});
