import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { createRateLimiter } from '../../middleware/rateLimiter';
import { upsertContact } from '../../services/ghl';
import {
  evaluateInvestmentRouting,
  generateUnmaskedReferenceNumber,
  checkRecentDuplicate,
  acquireInFlightLock,
  releaseInFlightLock,
  checkGhlDuplicate,
  recordRecentSubmission,
  sendUnmaskedPrivateNotification,
  withRetry,
  INVESTMENT_LABELS,
} from '../../services/unmaskedPrivateService';

export const unmaskedPrivateRouter = Router();

// Rate limiter dedicated to UNMASKED PRIVATE submissions (5 per hour per IP)
const unmaskedPrivateLimiter = createRateLimiter({
  message: {
    success: false,
    error: 'TOO_MANY_REQUESTS',
    message: 'Too many requests. Please try again later.',
  },
});

// Zod Validation Schemas
const Step1Schema = z.object({
  fullName: z
    .string({ message: 'Full name is required.' })
    .trim()
    .min(2, 'Full name must be at least 2 characters.')
    .max(100, 'Full name cannot exceed 100 characters.'),
  email: z
    .string({ message: 'A valid corporate email address is required.' })
    .trim()
    .email('A valid corporate email address is required.'),
  phone: z.string().trim().optional(),
  companyName: z.string().trim().optional(),
  roleTitle: z.string().trim().optional(),
});

const Step2Schema = z
  .object({
    contextAnswers: z.record(z.string(), z.any()).optional(),
  })
  .passthrough()
  .optional()
  .default({});

const InvestmentReadinessEnum = z.enum([
  'UP_TO_5K',
  'FROM_5K_TO_10K',
  'FROM_10K_TO_15K',
  'FROM_15K_TO_20K',
  'OVER_20K',
  'VALUE_DEPENDENT',
]);

const Step3Schema = z.object({
  investmentReadiness: InvestmentReadinessEnum,
});

const ConsentSchema = z.object({
  privacyConsent: z.boolean({ message: 'Privacy consent is required.' }).refine((val) => val === true, {
    message: 'Privacy consent must be explicitly granted.',
  }),
  privacyPolicyVersion: z.string().optional().default('2026.1'),
});

const TrackingSchema = z
  .object({
    utm_source: z.string().optional(),
    utm_medium: z.string().optional(),
    utm_campaign: z.string().optional(),
    utm_term: z.string().optional(),
    utm_content: z.string().optional(),
    referrer: z.string().optional(),
  })
  .optional();

const UnmaskedApplySchema = z.object({
  step1: Step1Schema,
  step2: Step2Schema,
  step3: Step3Schema,
  consent: ConsentSchema,
  tracking: TrackingSchema,
});

/**
 * @openapi
 * /unmasked-private/apply:
 *   post:
 *     summary: Submit UNMASKED PRIVATE application with investment-based routing
 *     description: Validates multi-step application, executes single-source-of-truth investment readiness routing, checks for duplicate submissions, syncs contact to GoHighLevel CRM, and triggers instant internal briefings to executive advisors.
 *     tags:
 *       - Unmasked Private
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - step1
 *               - step3
 *               - consent
 *             properties:
 *               step1:
 *                 type: object
 *                 required:
 *                   - fullName
 *                   - email
 *                 properties:
 *                   fullName:
 *                     type: string
 *                     example: Alexander Vance
 *                   email:
 *                     type: string
 *                     format: email
 *                     example: a.vance@example.com
 *                   phone:
 *                     type: string
 *                     example: "+971 50 123 4567"
 *                   companyName:
 *                     type: string
 *                     example: Vance Holding Ltd
 *                   roleTitle:
 *                     type: string
 *                     example: Managing Director
 *               step2:
 *                 type: object
 *                 properties:
 *                   contextAnswers:
 *                     type: object
 *                     example:
 *                       primaryChallenge: "Executive scaling and leadership alignment"
 *               step3:
 *                 type: object
 *                 required:
 *                   - investmentReadiness
 *                 properties:
 *                   investmentReadiness:
 *                     type: string
 *                     enum:
 *                       - UP_TO_5K
 *                       - FROM_5K_TO_10K
 *                       - FROM_10K_TO_15K
 *                       - FROM_15K_TO_20K
 *                       - OVER_20K
 *                       - VALUE_DEPENDENT
 *                     example: FROM_15K_TO_20K
 *               consent:
 *                 type: object
 *                 required:
 *                   - privacyConsent
 *                 properties:
 *                   privacyConsent:
 *                     type: boolean
 *                     example: true
 *                   privacyPolicyVersion:
 *                     type: string
 *                     example: "2026.1"
 *               tracking:
 *                 type: object
 *                 properties:
 *                   utm_source:
 *                     type: string
 *                     example: linkedin
 *                   utm_medium:
 *                     type: string
 *                     example: cpc
 *                   utm_campaign:
 *                     type: string
 *                     example: private_advisory
 *     responses:
 *       200:
 *         description: Application accepted and evaluated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 outcome:
 *                   type: string
 *                   enum: [PENDING_PERSONAL_REVIEW, BELOW_INVESTMENT_THRESHOLD]
 *                   example: PENDING_PERSONAL_REVIEW
 *                 redirectUrl:
 *                   type: string
 *                   example: /unmasked-private/thank-you
 *                 applicationId:
 *                   type: string
 *                   example: unm_app_9f82d1c4
 *                 referenceNumber:
 *                   type: string
 *                   example: UNM-2026-6418
 *       400:
 *         description: Validation error on input fields
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: VALIDATION_ERROR
 *                 message:
 *                   type: string
 *                   example: Please correct the highlighted fields.
 *                 fields:
 *                   type: object
 *                   additionalProperties:
 *                     type: string
 *                   example:
 *                     step1.email: "A valid corporate email address is required."
 *                     step3.investmentReadiness: "Please select an investment readiness option."
 *       409:
 *         description: Duplicate application detected within window
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: DUPLICATE_SUBMISSION
 *                 message:
 *                   type: string
 *                   example: An application with this email has already been received and is currently under review.
 *       429:
 *         description: Rate limit exceeded (maximum 5 submissions per hour per IP)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: TOO_MANY_REQUESTS
 *                 message:
 *                   type: string
 *                   example: Too many requests. Please try again later.
 *       500:
 *         description: Server fault during processing
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: SUBMISSION_ERROR
 *                 message:
 *                   type: string
 *                   example: We could not process your application at this moment. Please try again.
 */
async function handleApplicationSubmission(req: Request, res: Response) {
  let normalizedEmail = '';

  try {
    // 1. Zod Request Payload Validation
    const parseResult = UnmaskedApplySchema.safeParse(req.body);
    if (!parseResult.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parseResult.error.issues) {
        const pathKey = issue.path.join('.');
        if (pathKey === 'step3.investmentReadiness') {
          fieldErrors[pathKey] = 'Please select an investment readiness option.';
        } else {
          fieldErrors[pathKey] = issue.message;
        }
      }

      return res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        message: 'Please correct the highlighted fields.',
        fields: fieldErrors,
      });
    }

    const payload = parseResult.data;
    normalizedEmail = payload.step1.email.toLowerCase().trim();

    // 2. In-Flight Concurrency Lock (prevents rapid double-clicks on submit button)
    if (!acquireInFlightLock(normalizedEmail)) {
      return res.status(409).json({
        success: false,
        error: 'DUPLICATE_SUBMISSION',
        message: 'An application with this email has already been received and is currently under review.',
      });
    }

    // 3. Duplicate Submission Detection (409 Conflict)
    // Tier 1: In-memory cache (<1ms response)
    // Tier 2: GoHighLevel CRM lookup (persists across server restarts / deploys)
    const isDuplicate = checkRecentDuplicate(normalizedEmail) || (await checkGhlDuplicate(normalizedEmail));
    if (isDuplicate) {
      return res.status(409).json({
        success: false,
        error: 'DUPLICATE_SUBMISSION',
        message: 'An application with this email has already been received and is currently under review.',
      });
    }

    // 4. Investment-Based Routing Logic
    const routing = evaluateInvestmentRouting(payload.step3.investmentReadiness);
    const referenceNumber = generateUnmaskedReferenceNumber();
    const applicationId = `unm_app_${randomUUID().replace(/-/g, '').substring(0, 8)}`;

    // 5. Record submission in duplicate protection cache
    recordRecentSubmission(normalizedEmail, referenceNumber, routing.outcome);

    // 6. Asynchronous GoHighLevel CRM Sync & Notification Dispatch with Retry Logic
    const nameParts = payload.step1.fullName.trim().split(/\s+/);
    const firstName = nameParts[0] || 'Applicant';
    const lastName = nameParts.slice(1).join(' ') || '';

    const tags = ['unmasked-private'];
    if (routing.isQualified) {
      tags.push('unmasked-qualified-review');
    } else {
      tags.push('unmasked-below-threshold');
    }

    // CRM synchronization with exponential backoff retries
    try {
      const contactId = await withRetry(
        () =>
          upsertContact({
            email: payload.step1.email,
            firstName,
            lastName,
            phone: payload.step1.phone,
            source: 'UNMASKED PRIVATE Application',
            tags,
          }),
        { retries: 3, delayMs: 500, context: 'GHL Contact Upsert' }
      );

      // If qualified, trigger immediate briefing email to Lionel (strictly disabled during tests)
      if (
        routing.isQualified &&
        process.env.NODE_ENV !== 'test' &&
        process.env.SKIP_EMAIL !== 'true' &&
        process.env.CI !== 'true'
      ) {
        sendUnmaskedPrivateNotification(payload, referenceNumber, contactId).catch((err) => {
          console.error('[Unmasked Private] Background notification error:', err?.message || err);
        });
      }
    } catch (crmError: any) {
      // Non-fatal for client: log failure with context without breaking the user experience
      console.warn('[Unmasked Private] CRM sync non-fatal warning:', crmError?.message || crmError);
    }

    // 7. Return deterministic response with outcome and redirectUrl
    return res.status(200).json({
      success: true,
      outcome: routing.outcome,
      redirectUrl: routing.redirectUrl,
      applicationId,
      referenceNumber,
    });
  } catch (error: any) {
    console.error('[Unmasked Private] Unhandled submission error:', {
      message: error?.message,
      stack: error?.stack,
      timestamp: new Date().toISOString(),
    });

    return res.status(500).json({
      success: false,
      error: 'SUBMISSION_ERROR',
      message: 'We could not process your application at this moment. Please try again.',
    });
  } finally {
    if (normalizedEmail) {
      releaseInFlightLock(normalizedEmail);
    }
  }
}

// Mount handler on /apply as well as root / of router
unmaskedPrivateRouter.post('/apply', unmaskedPrivateLimiter, handleApplicationSubmission);
unmaskedPrivateRouter.post('/', unmaskedPrivateLimiter, handleApplicationSubmission);
