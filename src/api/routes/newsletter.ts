import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { upsertContact, sendEmail } from '../../services/ghl';
import { renderTemplate } from '../../services/email';
import { getSecret } from '../../services/secrets';
import {
  processNewsletterCampaignSend,
  getEligibleSubscribersForSend,
  maskEmail,
} from '../../services/newsletterSender';
import { getNewsletterPdfAttachmentUrl } from '../../services/newsletterStorage';

const prisma = new PrismaClient();
const db = prisma as any;

export const newsletterRouter = Router();

// Public Rate Limiter: Max 10 newsletter subscriptions per IP per hour
const newsletterRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  statusCode: 429,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many subscription attempts from this IP address. Please try again later.',
  },
  skip: (req) => {
    if (process.env.NODE_ENV === 'test' && !req.headers['x-forwarded-for'] && !req.headers['x-test-rate-limit']) {
      return true;
    }
    return false;
  },
  handler: (_req, res, _next, options) => {
    res.status(options.statusCode).json(options.message);
  },
});

/**
 * Authentication middleware for internal / n8n campaign endpoints
 */
export async function authenticateInternalApiKey(req: Request, res: Response, next: NextFunction) {
  const apiKey = (req.headers['x-api-key'] || req.headers['authorization']) as string | undefined;
  const cleanKey = apiKey?.replace(/^Bearer\s+/i, '').trim();

  if (!cleanKey) {
    return res.status(401).json({ error: 'Unauthorized: Missing API key' });
  }

  const expectedKey =
    process.env.NEWSLETTER_SEND_API_KEY ||
    process.env.ARTICLES_API_KEY ||
    process.env.ADMIN_API_KEY ||
    (await getSecret('ARTICLES_API_KEY').catch(() => null));

  if (!expectedKey || cleanKey !== expectedKey.trim()) {
    return res.status(401).json({ error: 'Unauthorized: Invalid API key' });
  }

  next();
}

export function validateNewsletterEmail(emailStr: string | undefined | null): { valid: boolean; error?: string; email?: string } {
  if (!emailStr || typeof emailStr !== 'string') {
    return { valid: false, error: 'Please enter your email address.' };
  }

  const trimmed = emailStr.trim().toLowerCase();
  if (!trimmed) {
    return { valid: false, error: 'Please enter your email address.' };
  }

  if (trimmed.length > 254) {
    return { valid: false, error: 'Email address cannot exceed 254 characters.' };
  }

  // RFC5322 compliant email regex check
  const emailRegex = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
  if (!emailRegex.test(trimmed)) {
    return { valid: false, error: 'Please enter a valid email address (e.g. founder@company.com).' };
  }

  return { valid: true, email: trimmed };
}

export function getEmailUnsubscribeUrl(tokenOrEmail: string): string {
  const base = (process.env.FRONTEND_URL || process.env.API_URL || '').replace(/\/$/, '');
  return `${base}/unsubscribe?token=${encodeURIComponent(tokenOrEmail)}`;
}

export function getDirectApiUnsubscribeUrl(tokenOrEmail: string): string {
  const apiBase = (process.env.API_URL || process.env.FRONTEND_URL || '').replace(/\/$/, '');
  return `${apiBase}/api/v1/newsletter/unsubscribe?token=${encodeURIComponent(tokenOrEmail)}`;
}

function getEmailUnsubscribeHeaders(tokenOrEmail: string): Record<string, string> {
  const oneClickUrl = getDirectApiUnsubscribeUrl(tokenOrEmail);
  const mailtoDomain = process.env.MAIL_DOMAIN || 'leadersperformance.ae';
  const mailtoUrl = `mailto:unsubscribe@${mailtoDomain}?subject=unsubscribe`;

  return {
    'List-Unsubscribe': `<${oneClickUrl}>, <${mailtoUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

/**
 * Send welcome email to subscriber via GoHighLevel
 */
export async function sendNewsletterWelcomeEmail(email: string, contactId?: string, unsubscribeToken?: string): Promise<void> {
  // STRICT SUPPRESSION CHECK:
  // If subscriber is unsubscribed, abort immediately
  const sub = await db.newsletterSubscriber.findUnique({ where: { email } });
  if (sub && (!sub.subscribed || sub.status === 'unsubscribed' || sub.unsubscribedAt !== null)) {
    console.log(`[Newsletter] Suppression active for ${maskEmail(email)}. Aborting welcome email.`);
    return;
  }

  const templatePath = path.join(__dirname, '../../../templates/welcome-newsletter.html');

  if (!fs.existsSync(templatePath)) {
    console.warn(`[Newsletter] Welcome email template not found at ${templatePath}`);
    return;
  }

  const rawTemplate = fs.readFileSync(templatePath, 'utf8');
  const token = unsubscribeToken || sub?.unsubscribeToken || email;
  const unsubscribeUrl = getEmailUnsubscribeUrl(token);

  const html = renderTemplate(rawTemplate, {
    unsubscribe_url: unsubscribeUrl,
    email: email,
  });

  const subject = 'Welcome to The Founder Performance Newsletter';
  const emailHeaders = getEmailUnsubscribeHeaders(token);

  let targetContactId = contactId || sub?.ghlContactId;

  if (!targetContactId) {
    targetContactId = await upsertContact({
      email,
      source: 'Leaders Performance Website Footer',
      tags: ['The Founder Performance Newsletter', 'Newsletter Subscriber'],
    });
  }

  if (targetContactId) {
    await sendEmail(targetContactId, subject, html, emailHeaders);
    console.log(`[Newsletter] Welcome email dispatched to ${maskEmail(email)}`);
  }
}

/**
 * Send Issue #1 (Edition 01 - PDF) to subscriber via GoHighLevel
 */
export async function sendFirstNewsletterIssue(email: string, contactId?: string, unsubscribeToken?: string): Promise<void> {
  try {
    // STRICT SUPPRESSION CHECK:
    // If user unsubscribed at any time, NEVER send any email
    const sub = await db.newsletterSubscriber.findUnique({ where: { email } });
    if (!sub || !sub.subscribed || sub.status === 'unsubscribed' || sub.unsubscribedAt !== null) {
      console.log(`[Newsletter] Suppression active for ${maskEmail(email)}. Aborting Issue #1 dispatch.`);
      return;
    }

    if (sub.firstIssueSent) {
      return;
    }

    const templatePath = path.join(__dirname, '../../../templates/first-newsletter-issue.html');
    if (!fs.existsSync(templatePath)) {
      console.warn(`[Newsletter] Issue #1 template not found at ${templatePath}`);
      return;
    }

    const rawTemplate = fs.readFileSync(templatePath, 'utf8');
    const token = unsubscribeToken || sub.unsubscribeToken || email;
    const unsubscribeUrl = getEmailUnsubscribeUrl(token);

    // Resolve PDF dynamically from private Supabase Storage bucket news-letter
    const pdfAttachmentUrl = await getNewsletterPdfAttachmentUrl('2026/10/NEWSLETTER_DESKTOP_FINAL_REVISED.pdf');

    const html = renderTemplate(rawTemplate, {
      unsubscribe_url: unsubscribeUrl,
      pdf_url: pdfAttachmentUrl || '#',
      email: email,
    });

    const subject = 'The Founder Performance Newsletter — Issue #1: Performance Under Pressure';
    const emailHeaders = getEmailUnsubscribeHeaders(token);
    const attachments = pdfAttachmentUrl ? [pdfAttachmentUrl] : undefined;

    let targetContactId = contactId || sub.ghlContactId;

    if (!targetContactId) {
      targetContactId = await upsertContact({
        email,
        source: 'Leaders Performance Website Footer',
        tags: ['The Founder Performance Newsletter', 'Newsletter Subscriber', 'Issue #1 Sent'],
      });
    }

    if (targetContactId) {
      await sendEmail(targetContactId, subject, html, emailHeaders, attachments);
      await db.newsletterSubscriber.update({
        where: { email },
        data: {
          firstIssueSent: true,
          firstIssueSentAt: new Date(),
        },
      }).catch(() => null);
    }
  } catch (err) {
    console.error(`[Newsletter] Error sending Issue #1 to ${maskEmail(email)}:`, err);
  }
}

/**
 * Async background handler to sync subscriber to GHL and send welcome email
 */
async function processBackgroundSubscription(email: string, firstName?: string | null, token?: string): Promise<void> {
  try {
    // Suppression check
    const current = await db.newsletterSubscriber.findUnique({ where: { email } });
    if (!current || !current.subscribed || current.status === 'unsubscribed') {
      return;
    }

    const ghlContactId = await upsertContact({
      email,
      firstName: firstName || undefined,
      source: 'Leaders Performance Website Footer',
      tags: ['The Founder Performance Newsletter', 'Newsletter Subscriber'],
    });

    if (ghlContactId) {
      await db.newsletterSubscriber.update({
        where: { email },
        data: { ghlContactId },
      }).catch(() => null);

      // Send Welcome Email immediately
      await sendNewsletterWelcomeEmail(email, ghlContactId, token);
    }
  } catch (err) {
    console.error('[Newsletter] Background processing error:', err);
  }
}

/**
 * @openapi
 * /newsletter/subscribe:
 *   post:
 *     summary: Subscribe to The Founder Performance Newsletter
 *     description: Validates email, requires explicit consent, records subscription in Supabase PostgreSQL (source of truth), syncs CRM contact, and sends welcome email.
 *     tags:
 *       - Newsletter
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - consent
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: founder@company.com
 *               firstName:
 *                 type: string
 *                 example: Alexander
 *               consent:
 *                 type: boolean
 *                 example: true
 *     responses:
 *       200:
 *         description: Successfully subscribed, resubscribed, or already subscribed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 subscribed:
 *                   type: boolean
 *                   example: true
 *                 alreadySubscribed:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: Thank you for subscribing to The Founder Performance Newsletter.
 *       400:
 *         description: Invalid email format or missing explicit consent
 *       429:
 *         description: Rate limit exceeded (Max 10 per hour per IP)
 *       500:
 *         description: Internal server error
 */
newsletterRouter.post('/subscribe', newsletterRateLimiter, async (req: Request, res: Response) => {
  try {
    const emailInput = req.body?.email;
    const firstNameInput = typeof req.body?.firstName === 'string' ? req.body.firstName.trim() : null;
    const consentInput = req.body?.consent;

    // 1. Server-side validation
    const validation = validateNewsletterEmail(emailInput);
    if (!validation.valid || !validation.email) {
      return res.status(400).json({ error: validation.error });
    }

    // Explicit consent requirement
    if (consentInput !== true && consentInput !== 'true') {
      return res.status(400).json({
        error: 'Explicit consent is required to subscribe to The Founder Performance Newsletter.',
      });
    }

    const email = validation.email;

    // 2. Query existing record
    const existing = await db.newsletterSubscriber.findUnique({
      where: { email },
    });

    if (existing) {
      // Check if already actively subscribed
      if (existing.subscribed && existing.status === 'subscribed') {
        console.log(`[Newsletter] newsletter.subscribe duplicate attempt for ${maskEmail(email)}`);
        return res.status(200).json({
          success: true,
          subscribed: true,
          alreadySubscribed: true,
          message: 'This email address is already subscribed to The Founder Performance Newsletter.',
        });
      }

      // Resubscribe if previously unsubscribed
      const token = existing.unsubscribeToken || crypto.randomBytes(32).toString('hex');
      const updated = await db.newsletterSubscriber.update({
        where: { email },
        data: {
          subscribed: true,
          status: 'subscribed',
          consentGiven: true,
          consentDate: new Date(),
          consentSource: 'website',
          privacyPolicyVersion: 'v2026.3',
          unsubscribedAt: null,
          firstName: firstNameInput || existing.firstName,
          unsubscribeToken: token,
          subscribedAt: new Date(),
        },
      });

      console.log(`[Newsletter] newsletter.resubscribe recorded for ${maskEmail(email)}`);
      processBackgroundSubscription(email, firstNameInput || existing.firstName, token);

      return res.status(200).json({
        success: true,
        subscribed: true,
        alreadySubscribed: false,
        resubscribed: true,
        message: 'Welcome back! Your subscription to The Founder Performance Newsletter has been reactivated.',
      });
    }

    // 3. Create new subscriber
    const unsubscribeToken = crypto.randomBytes(32).toString('hex');
    await db.newsletterSubscriber.create({
      data: {
        email,
        firstName: firstNameInput || null,
        consentGiven: true,
        consentDate: new Date(),
        consentSource: 'website',
        privacyPolicyVersion: 'v2026.3',
        subscribed: true,
        status: 'subscribed',
        unsubscribeToken,
        source: 'Website Footer',
        subscribedAt: new Date(),
      },
    });

    console.log(`[Newsletter] newsletter.subscribe recorded for ${maskEmail(email)}`);
    processBackgroundSubscription(email, firstNameInput, unsubscribeToken);

    return res.status(200).json({
      success: true,
      subscribed: true,
      alreadySubscribed: false,
      message: 'Thank you for subscribing to The Founder Performance Newsletter. A welcome email has been sent to your inbox.',
    });
  } catch (error) {
    console.error('[Newsletter] Subscription error:', error);
    return res.status(500).json({
      error: 'An unexpected error occurred while processing your subscription. Please try again.',
    });
  }
});

/**
 * @openapi
 * /newsletter/unsubscribe:
 *   get:
 *     summary: Unsubscribe from newsletter via token
 *     description: Token-based suppression unsubscribe. Sets subscribed to false and populates unsubscribed_at in Supabase PostgreSQL without deleting the record.
 *     tags:
 *       - Newsletter
 *     parameters:
 *       - in: query
 *         name: token
 *         required: true
 *         schema:
 *           type: string
 *         description: Cryptographically secure non-guessable unsubscribe token
 *     responses:
 *       200:
 *         description: Successfully unsubscribed (renders HTML confirmation or returns JSON)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 subscribed:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: You have been successfully unsubscribed from The Founder Performance Newsletter.
 *       400:
 *         description: Invalid or missing unsubscribe token
 *   post:
 *     summary: Unsubscribe via POST body
 *     description: Accepts unsubscribe token or email to unsubscribe and suppress future newsletter sending.
 *     tags:
 *       - Newsletter
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               token:
 *                 type: string
 *               email:
 *                 type: string
 *     responses:
 *       200:
 *         description: Successfully unsubscribed
 *       400:
 *         description: Invalid parameters
 */
newsletterRouter.all(['/unsubscribe', '/newsletter/unsubscribe', '/api/newsletter/unsubscribe', '/api/v1/newsletter/unsubscribe'], async (req: Request, res: Response) => {
  try {
    const tokenParam = (req.query.token || req.body?.token) as string | undefined;
    const emailParam = (req.query.email || req.body?.email || req.body?.ListUnsubscribe || req.body?.['List-Unsubscribe']) as string | undefined;

    let subscriber = null;

    if (tokenParam && typeof tokenParam === 'string' && tokenParam.trim().length > 8) {
      subscriber = await db.newsletterSubscriber.findUnique({
        where: { unsubscribeToken: tokenParam.trim() },
      });
    } else if (emailParam) {
      const validation = validateNewsletterEmail(emailParam);
      if (validation.valid && validation.email) {
        subscriber = await db.newsletterSubscriber.findUnique({
          where: { email: validation.email },
        });
      }
    }

    if (!subscriber) {
      if (req.method === 'GET' && req.headers.accept?.includes('text/html')) {
        return res.status(400).send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Unsubscribe — Leaders Performance</title>
</head>
<body style="margin:0;padding:0;background:#051225;font-family:system-ui,-apple-system,sans-serif;color:#ffffff;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;box-sizing:border-box;">
  <div style="max-width:500px;width:100%;background:#081a35;border:1px solid rgba(215,185,120,0.3);border-radius:12px;padding:40px 32px;text-align:center;">
    <h1 style="color:#ffffff;font-size:22px;margin-bottom:12px;">Invalid Unsubscribe Request</h1>
    <p style="color:#CECFD2;font-size:14px;margin-bottom:24px;">The unsubscribe link is invalid or has expired.</p>
    <a href="https://leadersperformance.ae" style="display:inline-block;background:#D7B978;color:#051225;padding:12px 24px;text-decoration:none;font-weight:600;border-radius:6px;">Return to Website</a>
  </div>
</body>
</html>
        `);
      }
      return res.status(400).json({ error: 'Invalid or missing unsubscribe token.' });
    }

    // Mark as unsubscribed in Supabase PostgreSQL (suppression record preserved)
    await db.newsletterSubscriber.update({
      where: { id: subscriber.id },
      data: {
        subscribed: false,
        status: 'unsubscribed',
        unsubscribedAt: new Date(),
      },
    });

    console.log(`[Newsletter] newsletter.unsubscribe processed for ${maskEmail(subscriber.email)}`);

    // Sync unsubscribe tag to GHL in background
    upsertContact({
      email: subscriber.email,
      tags: ['Unsubscribed - Founder Performance Newsletter'],
    }).catch((e) => console.warn('[Newsletter] Failed to update GHL unsubscribe tags:', e));

    const returnUrl = (process.env.FRONTEND_URL || 'https://leadersperformance.ae').replace(/\/$/, '');
    if (req.method === 'GET' && req.headers.accept?.includes('text/html')) {
      return res.status(200).send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>You Have Been Unsubscribed — Leaders Performance</title>
</head>
<body style="margin:0;padding:0;background:#051225;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#ffffff;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;box-sizing:border-box;">
  <div style="max-width:540px;width:100%;background:#081a35;border:1px solid rgba(215,185,120,0.3);border-radius:12px;padding:44px 36px;text-align:center;box-shadow:0 20px 40px rgba(0,0,0,0.5);position:relative;">
    <div style="height:3px;width:100%;background:linear-gradient(90deg,transparent,#D7B978,transparent);position:absolute;top:0;left:0;border-radius:12px 12px 0 0;"></div>
    <div style="margin-bottom:24px;">
      <a href="${returnUrl}" target="_blank" style="display:inline-block;text-decoration:none;">
        <img src="${returnUrl}/assets/home/logo-gold.png" alt="Leaders Performance" width="150" style="display:block;margin:0 auto;width:150px;height:auto;border:0;" />
      </a>
    </div>
    <div style="display:inline-block;padding:4px 14px;background:rgba(215,185,120,0.12);border:1px solid rgba(215,185,120,0.3);border-radius:20px;font-size:11px;font-weight:600;letter-spacing:2px;color:#D7B978;text-transform:uppercase;margin-bottom:20px;">
      THE FOUNDER PERFORMANCE NEWSLETTER
    </div>
    <h1 style="font-family:Georgia,serif;font-size:26px;color:#ffffff;margin:0 0 14px 0;font-weight:600;">You Have Been Unsubscribed</h1>
    <p style="font-size:14px;line-height:1.6;color:#CECFD2;margin:0 0 28px 0;">
      Your email address has been successfully unsubscribed from The Founder Performance Newsletter mailing list. You will no longer receive marketing communications or future issues.
    </p>
    <div>
      <a href="${returnUrl}" style="display:inline-block;background:#D7B978;color:#051225;padding:14px 28px;text-decoration:none;font-size:14px;font-weight:600;border-radius:6px;">
        Return to Leaders Performance
      </a>
    </div>
  </div>
</body>
</html>
      `);
    }

    return res.status(200).json({
      success: true,
      subscribed: false,
      message: 'You have been successfully unsubscribed from The Founder Performance Newsletter.',
    });
  } catch (error) {
    console.error('[Newsletter] Unsubscribe error:', error);
    return res.status(500).json({ error: 'Failed to process unsubscribe request.' });
  }
});

/**
 * @openapi
 * /newsletter/send:
 *   post:
 *     summary: Dispatch approved monthly newsletter campaign
 *     description: Authenticated endpoint called by n8n. Verifies human approval, applies cutoff eligibility rule, snapshots recipients, attaches newsletter PDF from private Supabase Storage bucket, and dispatches emails with duplicate prevention.
 *     tags:
 *       - Newsletter
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: header
 *         name: x-api-key
 *         required: true
 *         schema:
 *           type: string
 *         description: Management API key
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               campaignId:
 *                 type: string
 *                 example: d8a719d2-7b19-48fe-89dc-6a1656c071d2
 *               campaignKey:
 *                 type: string
 *                 example: 2026-10
 *     responses:
 *       200:
 *         description: Monthly newsletter campaign processed successfully
 *       400:
 *         description: Campaign not found, not approved, or already sent
 *       401:
 *         description: Unauthorized
 */
newsletterRouter.post('/send', authenticateInternalApiKey, async (req: Request, res: Response) => {
  try {
    const { campaignId, campaignKey } = req.body || {};

    let targetCampaignId = campaignId;

    if (!targetCampaignId && campaignKey) {
      const camp = await db.newsletterCampaign.findUnique({
        where: { campaignKey },
      });
      if (camp) {
        targetCampaignId = camp.id;
      }
    }

    if (!targetCampaignId) {
      return res.status(400).json({ error: 'Missing campaignId or campaignKey' });
    }

    const result = await processNewsletterCampaignSend(targetCampaignId);
    return res.status(200).json({
      success: true,
      message: 'Monthly newsletter campaign processed successfully',
      data: result,
    });
  } catch (error: any) {
    console.error('[Newsletter] Campaign send execution error:', error?.message || error);
    return res.status(400).json({
      error: error?.message || 'Failed to execute campaign send',
    });
  }
});

/**
 * @openapi
 * /newsletter/campaigns:
 *   post:
 *     summary: Create or update monthly newsletter campaign
 *     tags:
 *       - Newsletter
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: header
 *         name: x-api-key
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - campaignKey
 *               - campaignMonth
 *               - title
 *               - subject
 *             properties:
 *               campaignKey:
 *                 type: string
 *                 example: 2026-10
 *               campaignMonth:
 *                 type: string
 *                 example: 2026-10
 *               title:
 *                 type: string
 *                 example: Executive Focus Under Commercial Pressure
 *               subject:
 *                 type: string
 *                 example: The Founder Performance Newsletter — Issue #2
 *               pdfPath:
 *                 type: string
 *                 example: 2026/10/NEWSLETTER_DESKTOP_FINAL_REVISED.pdf
 *               scheduledAt:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       200:
 *         description: Campaign created or updated successfully
 *       400:
 *         description: Missing required fields
 *       401:
 *         description: Unauthorized
 */
newsletterRouter.post('/campaigns', authenticateInternalApiKey, async (req: Request, res: Response) => {
  try {
    const { campaignKey, campaignMonth, title, subject, pdfPath, scheduledAt } = req.body || {};

    if (!campaignKey || !campaignMonth || !title || !subject) {
      return res.status(400).json({
        error: 'Missing required fields: campaignKey, campaignMonth, title, subject',
      });
    }

    const campaign = await db.newsletterCampaign.upsert({
      where: { campaignKey },
      create: {
        campaignKey,
        campaignMonth,
        title,
        subject,
        pdfPath: pdfPath || null,
        scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
        status: 'draft',
        approvalStatus: 'pending',
      },
      update: {
        campaignMonth,
        title,
        subject,
        pdfPath: pdfPath || null,
        scheduledAt: scheduledAt ? new Date(scheduledAt) : undefined,
      },
    });

    return res.status(200).json({ success: true, campaign });
  } catch (error: any) {
    console.error('[Newsletter] Create campaign error:', error);
    return res.status(500).json({ error: error?.message || 'Failed to create/update campaign' });
  }
});

/**
 * @openapi
 * /newsletter/campaigns/{id}/approve:
 *   post:
 *     summary: Human approval gate for monthly campaign
 *     tags:
 *       - Newsletter
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: header
 *         name: x-api-key
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Campaign approved
 *       400:
 *         description: Failed to approve campaign
 *       401:
 *         description: Unauthorized
 */
newsletterRouter.post('/campaigns/:id/approve', authenticateInternalApiKey, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const campaign = await db.newsletterCampaign.update({
      where: { id },
      data: {
        approvalStatus: 'approved',
        approvedAt: new Date(),
      },
    });

    return res.status(200).json({
      success: true,
      message: `Campaign ${campaign.campaignKey} has been approved`,
      campaign,
    });
  } catch (error: any) {
    return res.status(400).json({ error: error?.message || 'Failed to approve campaign' });
  }
});

/**
 * @openapi
 * /newsletter/campaigns/{id}:
 *   get:
 *     summary: Get newsletter campaign details and delivery statistics
 *     tags:
 *       - Newsletter
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: header
 *         name: x-api-key
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Campaign details retrieved
 *       404:
 *         description: Campaign not found
 *       401:
 *         description: Unauthorized
 */
newsletterRouter.get('/campaigns/:id', authenticateInternalApiKey, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const campaign = await db.newsletterCampaign.findUnique({
      where: { id },
      include: {
        _count: {
          select: { recipients: true },
        },
      },
    });

    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    return res.status(200).json({ success: true, campaign });
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || 'Failed to fetch campaign' });
  }
});

/**
 * @openapi
 * /newsletter/eligible-subscribers:
 *   get:
 *     summary: Preview eligible subscriber count prior to send
 *     tags:
 *       - Newsletter
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: header
 *         name: x-api-key
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: cutoff
 *         schema:
 *           type: string
 *           format: date-time
 *     responses:
 *       200:
 *         description: Count and sample of eligible subscribers
 *       401:
 *         description: Unauthorized
 */
newsletterRouter.get('/eligible-subscribers', authenticateInternalApiKey, async (req: Request, res: Response) => {
  try {
    const cutoff = req.query.cutoff ? new Date(String(req.query.cutoff)) : new Date();
    const eligible = await getEligibleSubscribersForSend(cutoff);

    return res.status(200).json({
      success: true,
      cutoff: cutoff.toISOString(),
      count: eligible.length,
      sample: eligible.slice(0, 5).map((s: any) => ({
        id: s.id,
        email: maskEmail(s.email),
        subscribedAt: s.subscribedAt,
        consentGiven: s.consentGiven,
      })),
    });
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || 'Failed to query eligible subscribers' });
  }
});
