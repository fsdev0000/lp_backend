import { Router, Request, Response, NextFunction } from 'express';
import { LionelWebsiteController } from './controllers/lionelWebsite.controller';
import { requireCrmAuth } from '../../middleware/crmRoleAuth';
import { contactRateLimiter } from '../../middleware/rateLimiter';

export const lionelWebsiteRoutes = Router();
const controller = new LionelWebsiteController();

const LE_ALLOWED_ORIGINS = [
  'https://lioneleersteling.com',
  'https://www.lioneleersteling.com',
  'https://social.leadersperformance.ae',
  'https://leadersperformance.ae',
  'https://www.leadersperformance.ae',
  'https://staging.leadersperformance.ae',
];

if (process.env.NODE_ENV !== 'production') {
  LE_ALLOWED_ORIGINS.push(
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
    'http://localhost:4000',
    'http://localhost:8080'
  );
}

/**
 * CORS handler restricted to lioneleersteling.com, CRM, and verified origins.
 */
function allowLionelWebsiteCors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (!origin || LE_ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Api-Key, X-Client-Info, Apikey, X-LE-Sync-Secret, X-Internal-Key'
  );
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

/**
 * Guard for public contact form submissions:
 * Enforces rate limiting unless authenticated via shared secret header from Supabase Edge Functions.
 */
function protectPublicContactSubmission(req: Request, res: Response, next: NextFunction): void {
  const sharedSecret =
    process.env.LE_SYNC_SECRET?.trim() ||
    process.env.ADMIN_API_KEY?.trim() ||
    process.env.CRM_API_KEY?.trim();

  const providedSecret =
    req.headers['x-le-sync-secret'] ||
    req.headers['x-internal-key'] ||
    req.headers['x-api-key'];

  if (sharedSecret && providedSecret && String(providedSecret).trim() === sharedSecret) {
    next();
    return;
  }

  contactRateLimiter(req, res, next);
}

lionelWebsiteRoutes.use(allowLionelWebsiteCors);

/**
 * @route POST /api/v1/le/contact
 * @route POST /api/v1/le/inquiries
 * @desc Store contact-form submission from lioneleersteling.com (separate module from leadersperformance.ae)
 * @access Public (Protected with CORS, Rate Limiter & Edge Function Shared Secret)
 */
lionelWebsiteRoutes.post('/contact', protectPublicContactSubmission, controller.submitContact);
lionelWebsiteRoutes.post('/contact-us', protectPublicContactSubmission, controller.submitContact);
lionelWebsiteRoutes.post('/inquiries', protectPublicContactSubmission, controller.submitContact);

/**
 * @route GET /api/v1/le/inquiries
 * @desc List stored lioneleersteling.com contact form inquiries for Social CRM (strictly read-only)
 * @access Protected CRM
 */
lionelWebsiteRoutes.get('/inquiries', requireCrmAuth, controller.listInquiries);

/**
 * @route POST /api/v1/le/sync
 * @desc Sync contact inquiries from lioneleersteling.com Supabase DB & GHL location (write operation)
 * @access Protected CRM
 */
lionelWebsiteRoutes.post('/sync', requireCrmAuth, controller.syncInquiries);
