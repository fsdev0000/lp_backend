"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.contactRateLimiter = exports.assessmentRateLimiter = exports.createRateLimiter = void 0;
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
/**
 * Public Form Submission Rate Limiter
 *
 * Enforces a strict limit of 5 requests per IP address per 1 hour.
 * The 6th request from the same IP within the 1-hour window returns HTTP 429 Too Many Requests.
 *
 * Applied strictly to:
 * - POST /assessments/submit
 * - POST /contact
 */
const ONE_HOUR_MS = 60 * 60 * 1000; // 1 hour in milliseconds
const MAX_REQUESTS = 5;
const createRateLimiter = (customOptions) => {
    return (0, express_rate_limit_1.default)({
        windowMs: ONE_HOUR_MS,
        limit: MAX_REQUESTS,
        statusCode: 429,
        standardHeaders: true, // draft-7 RateLimit headers
        legacyHeaders: false, // Disable X-RateLimit-* headers
        message: {
            error: 'Too many requests. Please try again later.',
        },
        validate: {
            trustProxy: false, // Trust proxy validation is managed at Express app level (app.set('trust proxy', 1))
        },
        // In test environment, skip only if neither x-forwarded-for nor x-test-rate-limit is provided,
        // allowing unit tests for other features to run without unintended 429 errors.
        skip: (req) => {
            if (process.env.NODE_ENV === 'test' && !req.headers['x-forwarded-for'] && !req.headers['x-test-rate-limit']) {
                return true;
            }
            return false;
        },
        handler: (_req, res, _next, options) => {
            res.status(options.statusCode).json(options.message);
        },
        ...customOptions,
    });
};
exports.createRateLimiter = createRateLimiter;
// Rate limiter dedicated to POST /assessments/submit
exports.assessmentRateLimiter = (0, exports.createRateLimiter)();
// Rate limiter dedicated to POST /contact (and /contact-us)
exports.contactRateLimiter = (0, exports.createRateLimiter)();
