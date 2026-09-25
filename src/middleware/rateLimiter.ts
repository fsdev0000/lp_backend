import rateLimit, { Options } from 'express-rate-limit';

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

export const createRateLimiter = (customOptions?: Partial<Options>) => {
  return rateLimit({
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

// Rate limiter dedicated to POST /assessments/submit
export const assessmentRateLimiter = createRateLimiter();

// Rate limiter dedicated to POST /contact (and /contact-us)
export const contactRateLimiter = createRateLimiter();
