import { Router, Request, Response, NextFunction } from 'express';
import { LionelWebsiteController } from './controllers/lionelWebsite.controller';
import { requireCrmAuth } from '../../middleware/crmRoleAuth';

export const lionelWebsiteRoutes = Router();
const controller = new LionelWebsiteController();

/**
 * Dedicated CORS handler for lioneleersteling.com (deployed on Vercel) & Supabase Edge Function forwards.
 */
function allowLionelWebsiteCors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Api-Key, X-Client-Info, Apikey'
  );
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

lionelWebsiteRoutes.use(allowLionelWebsiteCors);

/**
 * @route POST /api/v1/le/contact
 * @route POST /api/v1/le/inquiries
 * @desc Store contact-form submission from lioneleersteling.com (separate module from leadersperformance.ae)
 * @access Public (Website Form & Edge Function Webhook)
 */
lionelWebsiteRoutes.post('/contact', controller.submitContact);
lionelWebsiteRoutes.post('/contact-us', controller.submitContact);
lionelWebsiteRoutes.post('/inquiries', controller.submitContact);

/**
 * @route GET /api/v1/le/inquiries
 * @desc List stored lioneleersteling.com contact form inquiries for Social CRM
 * @access Protected CRM
 */
lionelWebsiteRoutes.get('/inquiries', requireCrmAuth, controller.listInquiries);

/**
 * @route POST /api/v1/le/sync
 * @desc Sync contact inquiries from lioneleersteling.com Supabase DB & GHL location
 * @access Protected CRM
 */
lionelWebsiteRoutes.post('/sync', requireCrmAuth, controller.syncInquiries);
