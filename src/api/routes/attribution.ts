import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  HOW_DID_YOU_HEAR_OPTIONS,
  recordVisitorAttribution,
  VisitorAttributionPayload,
  extractClientIp,
  extractClientLocation,
} from '../../services/attributionService';

export const attributionRouter = Router();

const VisitSchema = z.object({
  anonymousId: z.string().trim().optional(),
  module: z.string().trim().optional(),
  landingPage: z.string().trim().min(1, 'landingPage is required'),
  referrer: z.string().trim().optional(),
  utm_source: z.string().trim().optional(),
  utm_medium: z.string().trim().optional(),
  utm_campaign: z.string().trim().optional(),
  utm_term: z.string().trim().optional(),
  utm_content: z.string().trim().optional(),
  timezone: z.string().trim().optional(),
  device: z.string().trim().optional(),
  first_touch: z.any().optional(),
  latest_touch: z.any().optional(),
});

/**
 * @openapi
 * /attribution/visit:
 *   post:
 *     summary: Capture External Visitor Arrival Attribution
 *     description: Ingests technical attribution (UTMs, referrer, landing page, module) and automatically derives client IP and geographic location, saving the record directly into PostgreSQL.
 *     tags:
 *       - Attribution
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - landingPage
 *             properties:
 *               anonymousId:
 *                 type: string
 *               module:
 *                 type: string
 *                 example: masterclass
 *               landingPage:
 *                 type: string
 *                 example: /masterclass?utm_source=linkedin
 *               referrer:
 *                 type: string
 *                 example: https://www.linkedin.com/
 *               utm_source:
 *                 type: string
 *                 example: linkedin
 *               utm_medium:
 *                 type: string
 *                 example: social
 *               utm_campaign:
 *                 type: string
 *                 example: q4_founder
 *               utm_term:
 *                 type: string
 *               utm_content:
 *                 type: string
 *               timezone:
 *                 type: string
 *                 example: Asia/Dubai
 *     responses:
 *       200:
 *         description: External visit recorded successfully
 */
attributionRouter.post('/visit', async (req: Request, res: Response) => {
  try {
    const parseResult = VisitSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        details: parseResult.error.format(),
      });
    }

    const payload: VisitorAttributionPayload = parseResult.data;
    const visitId = await recordVisitorAttribution(req, payload);
    const ip = extractClientIp(req);
    const loc = extractClientLocation(req);

    return res.status(200).json({
      success: true,
      visitId,
      tracked: {
        module: payload.module || 'general',
        landingPage: payload.landingPage,
        ip,
        country: loc.country || null,
        city: loc.city || null,
      },
    });
  } catch (err: any) {
    console.error('[Attribution Route] Error logging visitor arrival:', err);
    return res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: err?.message || 'Could not record visitor attribution',
    });
  }
});

/**
 * @openapi
 * /attribution/options:
 *   get:
 *     summary: Retrieve Lead Source Options
 *     description: Returns the standardized list of "How did you hear about us?" options for lead-generation forms.
 *     tags:
 *       - Attribution
 *     responses:
 *       200:
 *         description: List of source options
 */
attributionRouter.get('/options', (_req: Request, res: Response) => {
  return res.status(200).json({
    success: true,
    options: HOW_DID_YOU_HEAR_OPTIONS,
  });
});
