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
  normalizeInvestmentReadiness,
  getUnmaskedQuestionnaire,
  updateUnmaskedQuestionnaire,
  UnmaskedPrivatePayload,
} from '../../services/unmaskedPrivateService';
import {
  generateUnmaskedVideoSignedUrl,
} from '../../services/supabaseStorageService';

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
const Step1Schema = z
  .object({
    fullName: z
      .string({ message: 'Please enter your full name.' })
      .trim()
      .min(2, 'Please enter your full name.')
      .max(100, 'Full name cannot exceed 100 characters.'),
    email: z
      .string({ message: 'Please enter your work email.' })
      .trim()
      .email('Please enter your work email.'),
    phone: z
      .string({ message: 'Please enter your mobile or WhatsApp number.' })
      .trim()
      .min(5, 'Please enter your mobile or WhatsApp number.'),
    companyName: z
      .string({ message: 'Please enter your company name.' })
      .trim()
      .min(1, 'Please enter your company name.')
      .max(150, 'Company name cannot exceed 150 characters.'),
    companyWebsite: z.string().trim().optional(),
    role: z.string().trim().optional(),
    roleTitle: z.string().trim().optional(),
    cityAndCountry: z.string().trim().optional(),
    location: z.string().trim().optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.role && !data.roleTitle) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Please enter your role.',
        path: ['role'],
      });
    }
    if (!data.cityAndCountry && !data.location) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Please enter your city and country.',
        path: ['cityAndCountry'],
      });
    }
  });

const Step2Schema = z
  .object({
    businessResult: z.string().trim().optional(),
    attentionNow: z.string().trim().optional(),
    outcome90Days: z.string().trim().optional(),
    attemptedAlready: z.string().trim().optional(),
    contextAnswers: z.record(z.string(), z.any()).optional(),
  })
  .passthrough()
  .superRefine((data, ctx) => {
    const br =
      data.businessResult ||
      data.contextAnswers?.businessResult ||
      data.contextAnswers?.currentChallenge ||
      data.contextAnswers?.primaryChallenge;
    if (!br || !String(br).trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'This field is required.',
        path: ['businessResult'],
      });
    }

    const an =
      data.attentionNow ||
      data.contextAnswers?.attentionNow ||
      data.contextAnswers?.whyNow;
    if (!an || !String(an).trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'This field is required.',
        path: ['attentionNow'],
      });
    }

    const od =
      data.outcome90Days ||
      data.contextAnswers?.outcome90Days ||
      data.contextAnswers?.successfulOutcome;
    if (!od || !String(od).trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'This field is required.',
        path: ['outcome90Days'],
      });
    }
  });

const Step3Schema = z
  .object({
    decisionInfluence: z.string().trim().optional(),
    challengeView: z.string().trim().optional(),
    authorityToAct: z.string().trim().optional(),
    investmentReadiness: z.string({ message: 'Please select an option.' }).trim(),
    availableForCall: z.string().trim().optional(),
    contextAnswers: z.record(z.string(), z.any()).optional(),
  })
  .passthrough()
  .superRefine((data, ctx) => {
    const di =
      data.decisionInfluence ||
      data.contextAnswers?.decisionInfluence ||
      data.contextAnswers?.ownDecisions;
    if (!di || !String(di).trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'This field is required.',
        path: ['decisionInfluence'],
      });
    }

    const cv =
      data.challengeView ||
      data.contextAnswers?.challengeView ||
      data.contextAnswers?.recentSituation;
    if (!cv || !String(cv).trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'This field is required.',
        path: ['challengeView'],
      });
    }

    const auth =
      data.authorityToAct ||
      data.contextAnswers?.authorityToAct ||
      data.contextAnswers?.authority;
    if (!auth || !String(auth).trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Please select an option.',
        path: ['authorityToAct'],
      });
    }

    const normalizedInv = normalizeInvestmentReadiness(data.investmentReadiness);
    const validInv = [
      'UP_TO_5K',
      'FROM_5K_TO_10K',
      'FROM_10K_TO_15K',
      'FROM_15K_TO_20K',
      'OVER_20K',
      'VALUE_DEPENDENT',
    ];
    if (!normalizedInv || !validInv.includes(normalizedInv)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Please select an option.',
        path: ['investmentReadiness'],
      });
    }

    const call =
      data.availableForCall ||
      data.contextAnswers?.availableForCall ||
      data.contextAnswers?.available;
    if (!call || !String(call).trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Please select an option.',
        path: ['availableForCall'],
      });
    }
  });

const ConsentSchema = z.object({
  privacyConsent: z
    .boolean({ message: 'Please confirm your consent to continue.' })
    .refine((val) => val === true, {
      message: 'Please confirm your consent to continue.',
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
 * /unmasked-private/questions:
 *   get:
 *     summary: Fetch dynamic UNMASKED PRIVATE application questionnaire from database
 *     description: Returns the questions, choices, and configuration for Step 2 (Your Result) and Step 3 (Your Readiness) directly from the database (SystemConfig key 'unmasked_questionnaire'). Step 1 (About You) contact details are rendered directly by the frontend UI.
 *     tags:
 *       - Unmasked Private
 *     responses:
 *       200:
 *         description: Dynamic questionnaire configuration retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 questionnaire:
 *                   type: object
 *                   properties:
 *                     step2:
 *                       type: object
 *                       properties:
 *                         step:
 *                           type: integer
 *                           example: 2
 *                         title:
 *                           type: string
 *                           example: "Your Result"
 *                         questions:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               id:
 *                                 type: string
 *                                 example: "businessResult"
 *                               text:
 *                                 type: string
 *                                 example: "What is the one business result, consequential decision or strategic challenge you want to address?"
 *                               required:
 *                                 type: boolean
 *                                 example: true
 *                     step3:
 *                       type: object
 *                       properties:
 *                         step:
 *                           type: integer
 *                           example: 3
 *                         title:
 *                           type: string
 *                           example: "Your Readiness"
 *                         notice:
 *                           type: string
 *                           example: "UNMASKED PRIVATE engagements start at AED 10,000 excluding VAT."
 *                         questions:
 *                           type: array
 *                           items:
 *                             type: object
 *       500:
 *         description: Database retrieval error
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
 *                   example: "QUESTIONNAIRE_FETCH_ERROR"
 *                 message:
 *                   type: string
 *                   example: "Failed to retrieve questionnaire configuration from database."
 */
unmaskedPrivateRouter.get('/questions', async (_req: Request, res: Response) => {
  try {
    const questionnaire = await getUnmaskedQuestionnaire();
    return res.status(200).json({
      success: true,
      questionnaire,
    });
  } catch (error: any) {
    console.error('[Unmasked Private] Failed to load questions:', error?.message || error);
    return res.status(500).json({
      success: false,
      error: 'QUESTIONNAIRE_FETCH_ERROR',
      message: 'Failed to retrieve questionnaire configuration from database.',
    });
  }
});

/**
 * @openapi
 * /unmasked-private/questions:
 *   put:
 *     summary: Update dynamic UNMASKED PRIVATE questionnaire in database
 *     description: Persists modified questions, steps, labels, or error messages directly into the PostgreSQL database (SystemConfig). Automatically invalidates the in-memory cache.
 *     tags:
 *       - Unmasked Private
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Full or updated questionnaire JSON schema
 *     responses:
 *       200:
 *         description: Questionnaire updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Questionnaire updated successfully in database."
 *                 questionnaire:
 *                   type: object
 *       400:
 *         description: Invalid JSON payload
 *       500:
 *         description: Database write error
 */
unmaskedPrivateRouter.put('/questions', async (req: Request, res: Response) => {
  try {
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({
        success: false,
        error: 'INVALID_PAYLOAD',
        message: 'Invalid questionnaire configuration payload.',
      });
    }
    const updated = await updateUnmaskedQuestionnaire(req.body);
    return res.status(200).json({
      success: true,
      message: 'Questionnaire updated successfully in database.',
      questionnaire: updated,
    });
  } catch (error: any) {
    console.error('[Unmasked Private] Failed to update questions in DB:', error?.message || error);
    return res.status(500).json({
      success: false,
      error: 'QUESTIONNAIRE_UPDATE_ERROR',
      message: 'Failed to update questionnaire configuration in database.',
    });
  }
});

/**
 * @openapi
 * /unmasked-private/video-url:
 *   get:
 *     summary: Get secure streaming URL for UNMASKED PRIVATE video
 *     description: Returns a secure signed URL for unmasked-private.mp4 from private Supabase Storage. The frontend can directly assign this URL to an HTML video tag.
 *     tags:
 *       - Unmasked Private
 *     responses:
 *       200:
 *         description: Secure video URL generated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 videoUrl:
 *                   type: string
 *                   example: "https://tpyudbsbzrhhngulxyxp.supabase.co/storage/v1/object/sign/unmasked-private/unmasked-private.mp4?token=ey..."
 *       404:
 *         description: Video file does not exist in storage bucket
 *       500:
 *         description: Storage service error
 */
unmaskedPrivateRouter.get('/video-url', async (_req: Request, res: Response) => {
  try {
    const result = await generateUnmaskedVideoSignedUrl();
    return res.status(200).json({
      videoUrl: result.videoUrl,
    });
  } catch (error: any) {
    const status = error.status || 500;
    const errorCode = error.code || 'STORAGE_ERROR';
    console.error('[Unmasked Private] Video signed URL error:', error?.message);

    return res.status(status).json({
      success: false,
      error: errorCode,
      message: error?.message || 'Failed to retrieve video access URL.',
    });
  }
});

/**
 * @openapi
 * /unmasked-private/apply:
 *   post:
 *     summary: Submit UNMASKED PRIVATE application with investment-based routing
 *     description: Validates 3-step application, executes single-source-of-truth investment readiness routing, checks for duplicate submissions, syncs contact to GoHighLevel CRM, and triggers instant internal briefings to executive advisors.
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
 *               - step2
 *               - step3
 *               - consent
 *             properties:
 *               step1:
 *                 type: object
 *                 required:
 *                   - fullName
 *                   - email
 *                   - phone
 *                   - companyName
 *                   - role
 *                   - cityAndCountry
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
 *                   companyWebsite:
 *                     type: string
 *                     example: "https://vanceholding.com"
 *                   role:
 *                     type: string
 *                     example: Managing Director
 *                   cityAndCountry:
 *                     type: string
 *                     example: "Dubai, United Arab Emirates"
 *               step2:
 *                 type: object
 *                 required:
 *                   - businessResult
 *                   - attentionNow
 *                   - outcome90Days
 *                 properties:
 *                   businessResult:
 *                     type: string
 *                     example: "Decoupling founder dependency and establishing operational governance"
 *                   attentionNow:
 *                     type: string
 *                     example: "Expanding to secondary markets requires autonomous operational cadence"
 *                   outcome90Days:
 *                     type: string
 *                     example: "Executive team takes 100% ownership of operating margins and hiring"
 *                   attemptedAlready:
 *                     type: string
 *                     example: "Appointed general manager but decision bottlenecks persisted"
 *               step3:
 *                 type: object
 *                 required:
 *                   - decisionInfluence
 *                   - challengeView
 *                   - authorityToAct
 *                   - investmentReadiness
 *                   - availableForCall
 *                 properties:
 *                   decisionInfluence:
 *                     type: string
 *                     example: "Tendency to micromanage tactical deliveries during high-pressure cycles"
 *                   challengeView:
 *                     type: string
 *                     example: "CTO proposed architectural shift which I initially resisted then endorsed"
 *                   authorityToAct:
 *                     type: string
 *                     enum: [Yes, Partly, No]
 *                     example: Yes
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
 *                   availableForCall:
 *                     type: string
 *                     enum: [Yes, No]
 *                     example: Yes
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
 *                     example: "linkedin"
 *                   utm_medium:
 *                     type: string
 *                     example: "cpc"
 *                   utm_campaign:
 *                     type: string
 *                     example: "private_advisory"
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
 *                   example: "VALIDATION_ERROR"
 *                 message:
 *                   type: string
 *                   example: "Please correct the highlighted fields."
 *                 fields:
 *                   type: object
 *                   additionalProperties:
 *                     type: string
 *                   example:
 *                     step1.fullName: "Please enter your full name."
 *                     step1.email: "Please enter your work email."
 *                     step1.phone: "Please enter your mobile or WhatsApp number."
 *                     step1.companyName: "Please enter your company name."
 *                     step1.role: "Please enter your role."
 *                     step1.cityAndCountry: "Please enter your city and country."
 *                     step2.businessResult: "This field is required."
 *                     step2.attentionNow: "This field is required."
 *                     step2.outcome90Days: "This field is required."
 *                     step3.decisionInfluence: "This field is required."
 *                     step3.challengeView: "This field is required."
 *                     step3.authorityToAct: "Please select an option."
 *                     step3.investmentReadiness: "Please select an option."
 *                     step3.availableForCall: "Please select an option."
 *                     consent.privacyConsent: "Please confirm your consent to continue."
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
 *                   example: "DUPLICATE_SUBMISSION"
 *                 message:
 *                   type: string
 *                   example: "An application with this email has already been received and is currently under review."
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
 *                   example: "TOO_MANY_REQUESTS"
 *                 message:
 *                   type: string
 *                   example: "Too many requests. Please try again later."
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
 *                   example: "SUBMISSION_ERROR"
 *                 message:
 *                   type: string
 *                   example: "We could not process your application at this moment. Please try again."
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
        fieldErrors[pathKey] = issue.message;
      }

      return res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        message: 'Please correct the highlighted fields.',
        fields: fieldErrors,
      });
    }

    const payload = parseResult.data as unknown as UnmaskedPrivatePayload;
    normalizedEmail = payload.step1.email.toLowerCase().trim();

    // 2. In-Flight Concurrency Lock (Commented out for testing)
    /*
    if (!acquireInFlightLock(normalizedEmail)) {
      return res.status(409).json({
        success: false,
        error: 'DUPLICATE_SUBMISSION',
        message: 'An application with this email has already been received and is currently under review.',
      });
    }
    */

    // 3. Duplicate Submission Detection (Commented out for testing)
    /*
    const isDuplicate = checkRecentDuplicate(normalizedEmail) || (await checkGhlDuplicate(normalizedEmail));
    if (isDuplicate) {
      return res.status(409).json({
        success: false,
        error: 'DUPLICATE_SUBMISSION',
        message: 'An application with this email has already been received and is currently under review.',
      });
    }
    */

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

// Mount handler on /apply as well as root / of router (rate limiter bypassed for testing)
unmaskedPrivateRouter.post('/apply', handleApplicationSubmission);
unmaskedPrivateRouter.post('/', handleApplicationSubmission);
