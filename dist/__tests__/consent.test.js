"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const globals_1 = require("@jest/globals");
const supertest_1 = __importDefault(require("supertest"));
const express_1 = __importDefault(require("express"));
const consent_1 = require("../api/routes/consent");
const client_1 = require("@prisma/client");
const app = (0, express_1.default)();
app.use(express_1.default.json());
// Trust proxy is usually required for rate limiting to work with req.ip in tests if we mock IPs
app.set('trust proxy', 1);
app.use('/api/v1/consent', consent_1.consentRoutes);
const prisma = new client_1.PrismaClient();
(0, globals_1.describe)('Consent Audit Service', () => {
    globals_1.jest.setTimeout(30000);
    const validPayload = {
        consentId: '123e4567-e89b-12d3-a456-426614174000',
        anonymousId: '987e6543-e21b-12d3-a456-426614174111',
        eventType: 'ACCEPT_ALL',
        strictlyNecessary: true,
        functional: true,
        analytics: true,
        marketing: true,
        personalization: true,
        policyVersion: '1.0.0',
        bannerVersion: 'v2',
        jurisdiction: 'EU',
        idempotencyKey: 'test-key-' + Date.now(),
    };
    (0, globals_1.afterAll)(async () => {
        // Clean up
        await prisma.consentAuditLog.deleteMany({
            where: {
                consentId: '123e4567-e89b-12d3-a456-426614174000'
            }
        });
        await prisma.consentAuditLog.deleteMany({
            where: {
                consentId: '123e4567-e89b-12d3-a456-426614174001'
            }
        });
        await prisma.$disconnect();
    });
    (0, globals_1.it)('should securely accept valid consent events and create audit record', async () => {
        const res = await (0, supertest_1.default)(app)
            .post('/api/v1/consent/log')
            .set('x-forwarded-for', '192.168.1.1')
            .set('user-agent', 'Jest Test Agent')
            .send(validPayload);
        (0, globals_1.expect)(res.status).toBe(201);
        (0, globals_1.expect)(res.body).toHaveProperty('id');
        (0, globals_1.expect)(res.body.message).toBe('Consent transition logged.');
        const record = await prisma.consentAuditLog.findUnique({
            where: { id: res.body.id }
        });
        (0, globals_1.expect)(record).not.toBeNull();
        (0, globals_1.expect)(record?.consentId).toBe(validPayload.consentId);
        (0, globals_1.expect)(record?.idempotencyKey).toBe(validPayload.idempotencyKey);
        // Ensure IP is hashed and not plaintext '192.168.1.1'
        (0, globals_1.expect)(record?.ipAddress).not.toBe('192.168.1.1');
        (0, globals_1.expect)(record?.ipAddress?.length).toBe(16);
    });
    (0, globals_1.it)('should prevent duplicate network requests (Idempotency)', async () => {
        const res = await (0, supertest_1.default)(app)
            .post('/api/v1/consent/log')
            .send(validPayload);
        (0, globals_1.expect)(res.status).toBe(200); // Idempotent response
        (0, globals_1.expect)(res.body.message).toBe('Consent transition already logged.');
    });
    (0, globals_1.it)('should validate incoming payload and reject invalid data', async () => {
        const invalidPayload = {
            consentId: 'not-a-uuid',
            eventType: 'INVALID_TYPE',
            policyVersion: '', // too short
        };
        const res = await (0, supertest_1.default)(app)
            .post('/api/v1/consent/log')
            .send(invalidPayload);
        (0, globals_1.expect)(res.status).toBe(400);
        (0, globals_1.expect)(res.body.error).toBe('Invalid consent payload');
    });
    (0, globals_1.it)('should enforce rate limiting', async () => {
        const limitPayload = { ...validPayload, consentId: '123e4567-e89b-12d3-a456-426614174001' };
        // Send 10 valid requests
        for (let i = 0; i < 10; i++) {
            limitPayload.idempotencyKey = 'limit-key-' + i;
            await (0, supertest_1.default)(app)
                .post('/api/v1/consent/log')
                .set('x-forwarded-for', '10.0.0.1')
                .send(limitPayload);
        }
        // The 11th request should be rate limited
        limitPayload.idempotencyKey = 'limit-key-11';
        const res = await (0, supertest_1.default)(app)
            .post('/api/v1/consent/log')
            .set('x-forwarded-for', '10.0.0.1')
            .send(limitPayload);
        (0, globals_1.expect)(res.status).toBe(429); // Too Many Requests
    });
});
