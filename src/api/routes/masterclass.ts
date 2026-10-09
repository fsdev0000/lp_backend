import { Router, Request, Response } from 'express';
import { z } from 'zod';
import Stripe from 'stripe';
import {
  identifyUser,
  createSessionAndEnrollment,
  verifyPayment,
  saveDraft,
  getDraft,
  submitWorkbook,
  getSubmission,
  getAvailableSlots,
  bookReviewSlot,
  getMasterclassAppConfig,
  updateMasterclassQuestionsConfig,
  getMasterclassVideosList,
} from '../../services/masterclassService';
import { createRateLimiter } from '../../middleware/rateLimiter';

export const masterclassRouter = Router();

// Rate limiter for masterclass public forms: 10 requests per IP
const masterclassLimit = Number(process.env.RATE_LIMIT_MASTERCLASS_MAX) || 10;
const masterclassWindowMs = Number(process.env.RATE_LIMIT_MASTERCLASS_WINDOW_MS) || 15 * 60 * 1000;

const masterclassLimiter = createRateLimiter({
  limit: masterclassLimit,
  max: masterclassLimit,
  windowMs: masterclassWindowMs,
  message: {
    success: false,
    error: 'TOO_MANY_REQUESTS',
    message: 'Too many requests. Please try again later.',
  },
});

// ==========================================
// ZOD VALIDATION SCHEMAS
// ==========================================

const IdentifySchema = z.object({
  email: z
    .string({ message: 'Email address is required.' })
    .trim()
    .email('Please enter a valid executive email address.'),
});

const CreateSessionSchema = z.object({
  fullName: z
    .string({ message: 'Full name is required.' })
    .trim()
    .min(2, 'Full name must be at least 2 characters.')
    .max(100, 'Full name cannot exceed 100 characters.'),
  email: z
    .string({ message: 'Email address is required.' })
    .trim()
    .email('Please enter a valid executive email address.'),
  company: z
    .string({ message: 'Company name is required.' })
    .trim()
    .min(1, 'Company name is required.')
    .max(150, 'Company name cannot exceed 150 characters.'),
  role: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  how_did_you_hear: z.string().trim().optional(),
  how_did_you_hear_other: z.string().trim().optional(),
  attribution: z.record(z.string(), z.any()).optional().default({}),
  marketingConsent: z.boolean().optional().default(false),
  privacyConsent: z.boolean().optional().default(true),
  source: z.string().trim().optional(),
  returnUrl: z.string().trim().optional(),
});

const SaveDraftSchema = z.object({
  email: z
    .string({ message: 'Email address is required.' })
    .trim()
    .email('Please enter a valid email address.'),
  currentStage: z.number().int().min(1).max(4).optional().default(1),
  formData: z.record(z.string(), z.any()),
  personalNotes: z.record(z.string(), z.any()).optional().default({}),
});

const SubmitWorkbookSchema = z.object({
  participantDetails: z.object({
    fullName: z
      .string({ message: 'Full name is required.' })
      .trim()
      .min(2, 'Full name must be at least 2 characters.'),
    email: z
      .string({ message: 'Email address is required.' })
      .trim()
      .email('Please enter a valid executive email address.'),
    company: z
      .string({ message: 'Company name is required.' })
      .trim()
      .min(1, 'Company name is required.'),
    role: z.string().trim().optional(),
    phone: z.string().trim().optional(),
  }),
  formData: z.object({
    // Stage 1
    stage1_nextStage: z.string().trim().min(1, 'Stage 1 next stage is required.'),
    stage1_possibility: z.string().trim().min(1, 'Stage 1 possibility is required.'),
    stage1_strength: z.string().trim().min(1, 'Stage 1 core strength is required.'),
    // Stage 2
    stage2_changes: z.string().trim().min(1, 'Stage 2 operational changes is required.'),
    stage2_demand1: z.string().trim().min(1, 'Stage 2 primary demand is required.'),
    stage2_demand2: z.string().trim().optional(),
    stage2_demand3: z.string().trim().optional(),
    stage2_investment: z.string().trim().min(1, 'Stage 2 performance investment is required.'),
    // Stage 3
    stage3_founderStrength: z.string().trim().min(1, 'Stage 3 founder capability is required.'),
    stage3_founderStandard: z.string().trim().optional(),
    stage3_teamStrength: z.string().trim().min(1, 'Stage 3 team capability is required.'),
    stage3_teamStandard: z.string().trim().optional(),
    stage3_orgStrength: z.string().trim().min(1, 'Stage 3 organizational standard is required.'),
    stage3_orgInvestment: z.string().trim().optional(),
    stage3_focusArea: z.string().trim().optional(),
    // Stage 4
    stage4_priority90Days: z.string().trim().min(1, 'Stage 4 90-day priority is required.'),
    stage4_milestone1: z.string().trim().optional(),
    stage4_milestone2: z.string().trim().optional(),
    stage4_milestone3: z.string().trim().optional(),
    stage4_action7Days: z.string().trim().min(1, 'Stage 4 7-day action is required.'),
    stage4_actionTiming: z.string().trim().optional(),
    stage4_evidence: z.string().trim().min(1, 'Stage 4 evidence is required.'),
  }),
  personalNotes: z
    .object({
      stage1_notes: z.string().optional(),
      stage2_notes: z.string().optional(),
      stage3_notes: z.string().optional(),
      stage4_notes: z.string().optional(),
    })
    .optional(),
  submissionRef: z.string().trim().optional(),
});

const BookSlotSchema = z.object({
  email: z
    .string({ message: 'Email address is required.' })
    .trim()
    .email('Please enter a valid executive email address.'),
  fullName: z
    .string({ message: 'Full name is required.' })
    .trim()
    .min(2, 'Full name is required.'),
  company: z
    .string({ message: 'Company name is required.' })
    .trim()
    .min(1, 'Company name is required.'),
  selectedSlot: z
    .string({ message: 'Selected slot is required.' })
    .trim()
    .min(3, 'Please select a valid meeting slot.'),
  timezone: z.string().trim().optional().default('GST (UTC+4)'),
  scheduledAt: z.string().trim().optional(),
  submissionId: z.string().trim().optional(),
  submissionRef: z.string().trim().optional(),
  notes: z.string().trim().optional(),
});

// ==========================================
// OPENAPI SWAGGER SPECIFICATIONS & ROUTES
// ==========================================

/**
 * @openapi
 * /masterclass/auth/identify:
 *   post:
 *     summary: Recognize and Authenticate User
 *     description: Checks if user/participant exists in system before checkout, returning enrollment status, payment status, active progress, and session token.
 *     tags:
 *       - Masterclass
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: alexander@apexdynamics.com
 *     responses:
 *       200:
 *         description: User recognition response
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 recognized:
 *                   type: boolean
 *                 isExistingUser:
 *                   type: boolean
 *                 hasPaid:
 *                   type: boolean
 *                 accessGranted:
 *                   type: boolean
 *                 token:
 *                   type: string
 *                 user:
 *                   type: object
 *                 submission:
 *                   type: object
 *       400:
 *         description: Invalid email format
 */
masterclassRouter.post('/auth/identify', masterclassLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = IdentifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const result = await identifyUser(parsed.data.email);
    res.status(200).json({
      success: true,
      ...result,
    });
  } catch (err: any) {
    console.error('[Masterclass] Error identifying user:', err);
    res.status(500).json({
      success: false,
      error: 'SERVER_ERROR',
      message: err.message || 'Failed to identify user in system.',
    });
  }
});

/**
 * @openapi
 * /masterclass/auth/login:
 *   post:
 *     summary: Participant Login
 *     description: Alias for participant recognition and session retrieval.
 *     tags:
 *       - Masterclass
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *     responses:
 *       200:
 *         description: Login successful
 */
masterclassRouter.post('/auth/login', masterclassLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = IdentifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const result = await identifyUser(parsed.data.email);
    res.status(200).json({
      success: true,
      ...result,
    });
  } catch (err: any) {
    console.error('[Masterclass] Error during login:', err);
    res.status(500).json({
      success: false,
      error: 'SERVER_ERROR',
      message: err.message || 'Login failed.',
    });
  }
});

/**
 * @openapi
 * /masterclass/auth/me:
 *   get:
 *     summary: Get Current Session Status
 *     description: Returns authenticated participant details, enrollment status, and workbook draft.
 *     tags:
 *       - Masterclass
 *     parameters:
 *       - in: query
 *         name: email
 *         schema:
 *           type: string
 *         description: User email address
 *       - in: header
 *         name: Authorization
 *         schema:
 *           type: string
 *         description: Bearer session token
 *     responses:
 *       200:
 *         description: Session details retrieved
 *       400:
 *         description: Missing email or token
 */
masterclassRouter.get('/auth/me', async (req: Request, res: Response) => {
  try {
    const email = (req.query.email as string) || '';
    if (!email) {
      res.status(400).json({
        success: false,
        error: 'MISSING_EMAIL',
        message: 'Email query parameter is required.',
      });
      return;
    }

    const result = await identifyUser(email);
    res.status(200).json({
      success: true,
      ...result,
    });
  } catch (err: any) {
    console.error('[Masterclass] Error fetching session:', err);
    res.status(500).json({
      success: false,
      error: 'SERVER_ERROR',
      message: err.message || 'Failed to retrieve current user session.',
    });
  }
});

/**
 * @openapi
 * /masterclass/create-session:
 *   post:
 *     summary: Create Masterclass Registration & Stripe Checkout Session
 *     description: Recognizes user in system, creates or updates enrollment record with validation, and returns a Stripe Checkout Session URL for USD 500 Masterclass enrollment. If user already paid, unlocks direct access immediately.
 *     tags:
 *       - Masterclass
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - fullName
 *               - email
 *               - company
 *             properties:
 *               fullName:
 *                 type: string
 *                 example: Alexander Wright
 *               email:
 *                 type: string
 *                 format: email
 *                 example: alexander@apexdynamics.com
 *               company:
 *                 type: string
 *                 example: Apex Dynamics
 *               role:
 *                 type: string
 *                 example: Founder & CEO
 *               phone:
 *                 type: string
 *                 example: +971 50 123 4567
 *               marketingConsent:
 *                 type: boolean
 *                 example: true
 *               privacyConsent:
 *                 type: boolean
 *                 example: true
 *               source:
 *                 type: string
 *                 example: divalos
 *               returnUrl:
 *                 type: string
 *                 example: /masterclass
 *     responses:
 *       200:
 *         description: Checkout session created or direct access unlocked
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 checkoutUrl:
 *                   type: string
 *                 sessionId:
 *                   type: string
 *                 token:
 *                   type: string
 *                 recognized:
 *                   type: boolean
 *                 alreadyPaid:
 *                   type: boolean
 *                 accessGranted:
 *                   type: boolean
 *       400:
 *         description: Validation failed
 *       500:
 *         description: Internal server error
 */
masterclassRouter.post('/create-session', masterclassLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = CreateSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const sessionData = await createSessionAndEnrollment(parsed.data);
    res.status(200).json({
      success: true,
      ...sessionData,
    });
  } catch (err: any) {
    console.error('[Masterclass] Error creating checkout session:', err);
    res.status(500).json({
      success: false,
      error: 'STRIPE_SESSION_ERROR',
      message: err.message || 'Failed to create enrollment checkout session.',
    });
  }
});

/**
 * @openapi
 * /masterclass/verify-payment:
 *   get:
 *     summary: Verify Masterclass Stripe Payment
 *     description: Verifies Stripe Checkout session status, updates enrollment payment status in DB, grants course access, and returns access token.
 *     tags:
 *       - Masterclass
 *     parameters:
 *       - in: query
 *         name: session_id
 *         required: true
 *         schema:
 *           type: string
 *         description: Stripe Checkout Session ID (cs_...)
 *     responses:
 *       200:
 *         description: Payment verification status
 *       400:
 *         description: Missing session_id parameter
 *       500:
 *         description: Stripe verification failed
 */
masterclassRouter.get('/verify-payment', async (req: Request, res: Response) => {
  try {
    const sessionId = req.query.session_id as string | undefined;
    if (!sessionId) {
      res.status(400).json({
        success: false,
        error: 'MISSING_SESSION_ID',
        message: 'session_id query parameter is required.',
      });
      return;
    }

    const result = await verifyPayment(sessionId);
    res.status(200).json({
      success: true,
      ...result,
    });
  } catch (err: any) {
    console.error('[Masterclass] Error verifying payment:', err);
    res.status(500).json({
      success: false,
      error: 'VERIFICATION_ERROR',
      message: err.message || 'Unable to verify payment status.',
    });
  }
});

/**
 * @openapi
 * /masterclass/payment-status:
 *   get:
 *     summary: Payment Status Check (Alias)
 *     description: Same verification logic as /verify-payment.
 *     tags:
 *       - Masterclass
 *     parameters:
 *       - in: query
 *         name: session_id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Payment status
 */
masterclassRouter.get('/payment-status', async (req: Request, res: Response) => {
  try {
    const sessionId = req.query.session_id as string | undefined;
    if (!sessionId) {
      res.status(400).json({
        success: false,
        error: 'MISSING_SESSION_ID',
        message: 'session_id query parameter is required.',
      });
      return;
    }

    const result = await verifyPayment(sessionId);
    res.status(200).json({
      success: true,
      ...result,
    });
  } catch (err: any) {
    console.error('[Masterclass] Error in payment status check:', err);
    res.status(500).json({
      success: false,
      error: 'VERIFICATION_ERROR',
      message: err.message || 'Unable to check payment status.',
    });
  }
});

/**
 * @openapi
 * /masterclass/modules:
 *   get:
 *     summary: Get Masterclass Curriculum & Video Modules
 *     description: Returns the structured curriculum for all 4 video modules, reflection pauses, and strategic review outline.
 *     tags:
 *       - Masterclass
 *     responses:
 *       200:
 *         description: Curriculum modules metadata
 */
masterclassRouter.get('/modules', (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    title: 'The Founder’s Next Move — Executive Masterclass',
    host: 'Lionel Eersteling',
    investment: 'USD 500',
    totalModules: 4,
    reflectionPauseDurationSeconds: 45,
    modules: [
      {
        stageNumber: 1,
        title: 'Define the Next Stage',
        videoTitle: 'Module 1: Operating System & Shift',
        summary:
          'Clarity on the business stage you are building for and what makes it distinct from where you stand today.',
        keyPrompts: [
          'What is the next stage of business growth you are preparing for?',
          'What will that stage make possible that is not possible today?',
          'What single core strength from today remains essential?',
        ],
      },
      {
        stageNumber: 2,
        title: 'Success Changes the Game',
        videoTitle: 'Module 2: Evaluation & Resonance',
        summary:
          'Recognizing how scale changes the demands on leadership, time allocation, and organizational standards.',
        keyPrompts: [
          'How does the operational pace and complexity change as you scale?',
          'What 3 new operational demands will be placed on your leadership?',
          'What performance investment must you make to prepare?',
        ],
      },
      {
        stageNumber: 3,
        title: 'Prepare for Performance',
        videoTitle: 'Module 3: Capabilities & Standards',
        summary:
          'Aligning personal founder capabilities, leadership team ownership, and organizational standards.',
        keyPrompts: [
          'What founder capability must you elevate?',
          'What standard must your leadership team embody?',
          'What organizational system requires reinforcement?',
        ],
      },
      {
        stageNumber: 4,
        title: 'Your Next Move',
        videoTitle: 'Module 4: Exploration Blueprint & Execution',
        summary:
          'Transforming reflections into a high-leverage 90-day roadmap and one immediate action within 7 days.',
        keyPrompts: [
          'What is your main preparation priority for the next 90 days?',
          'What three milestones will prove progress?',
          'What single action will you take within 7 days?',
        ],
      },
    ],
  });
});

/**
 * @openapi
 * /masterclass/save-draft:
 *   post:
 *     summary: Auto-Save Workbook Progress & Personal Notes
 *     description: Persists interactive workbook responses and personal notes to the database in real-time.
 *     tags:
 *       - Masterclass
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - formData
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               currentStage:
 *                 type: integer
 *                 example: 2
 *               formData:
 *                 type: object
 *               personalNotes:
 *                 type: object
 *     responses:
 *       200:
 *         description: Draft saved successfully
 *       400:
 *         description: Validation error
 */
masterclassRouter.post('/save-draft', async (req: Request, res: Response) => {
  try {
    const parsed = SaveDraftSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const result = await saveDraft(parsed.data);
    res.status(200).json(result);
  } catch (err: any) {
    console.error('[Masterclass] Error saving draft:', err);
    res.status(500).json({
      success: false,
      error: 'DRAFT_SAVE_ERROR',
      message: err.message || 'Failed to auto-save workbook draft.',
    });
  }
});

/**
 * @openapi
 * /masterclass/draft:
 *   get:
 *     summary: Fetch Saved Workbook Draft
 *     description: Retrieves the participant's saved answers and personal notes from the database.
 *     tags:
 *       - Masterclass
 *     parameters:
 *       - in: query
 *         name: email
 *         required: true
 *         schema:
 *           type: string
 *         description: Participant email
 *     responses:
 *       200:
 *         description: Draft returned
 *       400:
 *         description: Missing email parameter
 */
masterclassRouter.get('/draft', async (req: Request, res: Response) => {
  try {
    const email = req.query.email as string | undefined;
    if (!email) {
      res.status(400).json({
        success: false,
        error: 'MISSING_EMAIL',
        message: 'email query parameter is required.',
      });
      return;
    }

    const result = await getDraft(email);
    res.status(200).json({
      success: true,
      ...result,
    });
  } catch (err: any) {
    console.error('[Masterclass] Error fetching draft:', err);
    res.status(500).json({
      success: false,
      error: 'SERVER_ERROR',
      message: err.message || 'Failed to retrieve saved draft.',
    });
  }
});

/**
 * @openapi
 * /masterclass/submit-workbook:
 *   post:
 *     summary: Submit Completed 4-Stage Workbook
 *     description: Validates all required responses across all 4 stages, stores data in PostgreSQL database, generates submission reference (FNM-2026-XXXX), and triggers notifications.
 *     tags:
 *       - Masterclass
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - participantDetails
 *               - formData
 *             properties:
 *               participantDetails:
 *                 type: object
 *                 required:
 *                   - fullName
 *                   - email
 *                   - company
 *                 properties:
 *                   fullName:
 *                     type: string
 *                   email:
 *                     type: string
 *                     format: email
 *                   company:
 *                     type: string
 *                   role:
 *                     type: string
 *               formData:
 *                 type: object
 *                 properties:
 *                   stage1_nextStage:
 *                     type: string
 *                   stage1_possibility:
 *                     type: string
 *                   stage1_strength:
 *                     type: string
 *                   stage2_changes:
 *                     type: string
 *                   stage2_demand1:
 *                     type: string
 *                   stage2_investment:
 *                     type: string
 *                   stage3_founderStrength:
 *                     type: string
 *                   stage3_teamStrength:
 *                     type: string
 *                   stage3_orgStrength:
 *                     type: string
 *                   stage4_priority90Days:
 *                     type: string
 *                   stage4_action7Days:
 *                     type: string
 *                   stage4_evidence:
 *                     type: string
 *               personalNotes:
 *                 type: object
 *     responses:
 *       200:
 *         description: Workbook submitted and reference created
 *       400:
 *         description: Validation error
 *       500:
 *         description: Server error
 */
masterclassRouter.post('/submit-workbook', masterclassLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = SubmitWorkbookSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const result = await submitWorkbook(parsed.data);
    res.status(200).json(result);
  } catch (err: any) {
    console.error('[Masterclass] Error submitting workbook:', err);
    res.status(500).json({
      success: false,
      error: 'SUBMISSION_ERROR',
      message: err.message || 'Failed to submit workbook.',
    });
  }
});

/**
 * @openapi
 * /masterclass/submission/{submissionId}:
 *   get:
 *     summary: Get Submission by Reference or ID
 *     description: Retrieves submitted workbook data by submission reference (FNM-2026-XXXX) or ID.
 *     tags:
 *       - Masterclass
 *     parameters:
 *       - in: path
 *         name: submissionId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Submission details
 *       404:
 *         description: Submission not found
 */
masterclassRouter.get('/submission/:submissionId', async (req: Request, res: Response) => {
  try {
    const rawId = req.params.submissionId;
    const submissionId = Array.isArray(rawId) ? rawId[0] : rawId;
    const submission = await getSubmission(submissionId);

    if (!submission) {
      res.status(404).json({
        success: false,
        error: 'NOT_FOUND',
        message: `Submission ${submissionId} was not found.`,
      });
      return;
    }

    res.status(200).json({
      success: true,
      submission,
    });
  } catch (err: any) {
    console.error('[Masterclass] Error retrieving submission:', err);
    res.status(500).json({
      success: false,
      error: 'SERVER_ERROR',
      message: err.message || 'Failed to fetch submission.',
    });
  }
});

/**
 * @openapi
 * /masterclass/available-slots:
 *   get:
 *     summary: Available 1-on-1 Review Slots
 *     description: Returns available time slots for the 45-minute private 1-on-1 strategic review with Lionel Eersteling.
 *     tags:
 *       - Masterclass
 *     parameters:
 *       - in: query
 *         name: timezone
 *         schema:
 *           type: string
 *           example: GST (UTC+4)
 *       - in: query
 *         name: date
 *         schema:
 *           type: string
 *           example: "2026-10-24"
 *     responses:
 *       200:
 *         description: Available calendar slots
 */
masterclassRouter.get('/available-slots', async (req: Request, res: Response) => {
  try {
    const timezone = (req.query.timezone as string) || 'GST (UTC+4)';
    const date = req.query.date as string | undefined;

    const slotsData = await getAvailableSlots(date, timezone);
    res.status(200).json({
      success: true,
      ...slotsData,
    });
  } catch (err: any) {
    console.error('[Masterclass] Error fetching slots:', err);
    res.status(500).json({
      success: false,
      error: 'CALENDAR_ERROR',
      message: err.message || 'Failed to retrieve available review slots.',
    });
  }
});

/**
 * @openapi
 * /masterclass/book-slot:
 *   post:
 *     summary: Book 1-on-1 Strategic Review Slot
 *     description: Confirms calendar booking with selected time slot and timezone, generates booking reference (MBK-2026-XXXX), saves to database, and triggers calendar invite confirmation email.
 *     tags:
 *       - Masterclass
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - fullName
 *               - company
 *               - selectedSlot
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               fullName:
 *                 type: string
 *               company:
 *                 type: string
 *               selectedSlot:
 *                 type: string
 *                 example: Thursday, Oct 24 • 4:00 PM GST
 *               timezone:
 *                 type: string
 *                 example: GST (UTC+4)
 *               submissionRef:
 *                 type: string
 *                 example: FNM-2026-8942
 *     responses:
 *       200:
 *         description: Strategic review booked successfully
 *       400:
 *         description: Validation error
 */
masterclassRouter.post('/book-slot', masterclassLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = BookSlotSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const result = await bookReviewSlot(parsed.data);
    res.status(200).json(result);
  } catch (err: any) {
    console.error('[Masterclass] Error booking slot:', err);
    res.status(500).json({
      success: false,
      error: 'BOOKING_ERROR',
      message: err.message || 'Failed to confirm 1-on-1 review booking.',
    });
  }
});

/**
 * @openapi
 * /masterclass/webhook:
 *   post:
 *     summary: Stripe Webhook for Masterclass Payments
 *     description: Listens to checkout.session.completed events from Stripe to automatically fulfill Masterclass enrollments and grant access asynchronously.
 *     tags:
 *       - Masterclass
 *     responses:
 *       200:
 *         description: Webhook received and processed
 *       400:
 *         description: Webhook signature verification failed
 */
masterclassRouter.post('/webhook', async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret || !sig) {
    // If webhook secret isn't configured, acknowledge receipt
    res.status(200).json({ received: true });
    return;
  }

  let event: Stripe.Event;
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');
    const rawBody = (req as any).rawBody || req.body;
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err: any) {
    console.error('[Stripe Webhook] Verification failed:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    try {
      await verifyPayment(session.id);
      console.log(`[Stripe Webhook] Verified and unlocked Masterclass session: ${session.id}`);
    } catch (err: any) {
      console.error('[Stripe Webhook] Error fulfilling session:', err.message);
    }
  }

  res.status(200).json({ received: true });
});

/**
 * @openapi
 * /masterclass/config:
 *   get:
 *     summary: Get Masterclass Dynamic Config, Questions & Videos
 *     description: Checks if the participant email exists in system and returns the 4-stage questions, dynamic prompts, reflection pauses, and the 6 private video signed URLs generated from Supabase storage.
 *     tags:
 *       - Masterclass
 *     parameters:
 *       - in: query
 *         name: email
 *         schema:
 *           type: string
 *         description: Optional participant email to check recognition and unlock private session
 *     responses:
 *       200:
 *         description: Masterclass configuration, dynamic questions, and private video stream URLs
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 userExists:
 *                   type: boolean
 *                 isEnrolled:
 *                   type: boolean
 *                 hasPaid:
 *                   type: boolean
 *                 accessGranted:
 *                   type: boolean
 *                 videos:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: integer
 *                       stage:
 *                         type: integer
 *                       stageName:
 *                         type: string
 *                       title:
 *                         type: string
 *                       fileName:
 *                         type: string
 *                       signedUrl:
 *                         type: string
 *                       isAvailable:
 *                         type: boolean
 *                 stages:
 *                   type: array
 *                   items:
 *                     type: object
 *   post:
 *     summary: Check Email & Get Masterclass Config
 *     description: POST variant allowing email submission in request body to verify enrollment and fetch 6 private videos with signed URLs plus all 4-stage questions.
 *     tags:
 *       - Masterclass
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: alexander@apexdynamics.com
 *     responses:
 *       200:
 *         description: Configuration, videos, and stage questions returned
 */
masterclassRouter.get('/config', async (req: Request, res: Response) => {
  try {
    const email = (req.query.email as string) || '';
    const config = await getMasterclassAppConfig(email);
    res.status(200).json(config);
  } catch (err: any) {
    console.error('[Masterclass] Error fetching app config:', err);
    res.status(500).json({
      success: false,
      error: 'CONFIG_FETCH_ERROR',
      message: err.message || 'Failed to retrieve masterclass configuration.',
    });
  }
});

masterclassRouter.post('/config', async (req: Request, res: Response) => {
  try {
    const email = (req.body?.email as string) || (req.query?.email as string) || '';
    const config = await getMasterclassAppConfig(email);
    res.status(200).json(config);
  } catch (err: any) {
    console.error('[Masterclass] Error in POST config:', err);
    res.status(500).json({
      success: false,
      error: 'CONFIG_FETCH_ERROR',
      message: err.message || 'Failed to retrieve masterclass configuration.',
    });
  }
});

/**
 * @openapi
 * /masterclass/config/questions:
 *   put:
 *     summary: Update Masterclass 4-Stage Questions (Backend / Admin)
 *     description: Dynamically updates the questions, labels, placeholders, and reflection prompts stored in the database without frontend redeployment.
 *     tags:
 *       - Masterclass
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               stages:
 *                 type: array
 *                 items:
 *                   type: object
 *     responses:
 *       200:
 *         description: Questions configuration updated in database
 */
masterclassRouter.put('/config/questions', async (req: Request, res: Response) => {
  try {
    const updated = await updateMasterclassQuestionsConfig(req.body);
    res.status(200).json({
      success: true,
      message: 'Masterclass questions configuration updated successfully.',
      config: updated,
    });
  } catch (err: any) {
    console.error('[Masterclass] Error updating questions config:', err);
    res.status(500).json({
      success: false,
      error: 'CONFIG_UPDATE_ERROR',
      message: err.message || 'Failed to update masterclass questions config.',
    });
  }
});

masterclassRouter.put('/config', async (req: Request, res: Response) => {
  try {
    const updated = await updateMasterclassQuestionsConfig(req.body);
    res.status(200).json({
      success: true,
      message: 'Masterclass configuration updated successfully.',
      config: updated,
    });
  } catch (err: any) {
    console.error('[Masterclass] Error updating config:', err);
    res.status(500).json({
      success: false,
      error: 'CONFIG_UPDATE_ERROR',
      message: err.message || 'Failed to update masterclass configuration.',
    });
  }
});

/**
 * @openapi
 * /masterclass/videos:
 *   get:
 *     summary: Get All 6 Masterclass Videos with Signed URLs
 *     description: Returns the catalog of all 6 private videos with signed URLs directly generated from Supabase private storage bucket.
 *     tags:
 *       - Masterclass
 *     parameters:
 *       - in: query
 *         name: expiresIn
 *         schema:
 *           type: integer
 *         description: Optional signed URL expiry in seconds (defaults to long-lived)
 *     responses:
 *       200:
 *         description: 6 Masterclass video objects with private signed URLs
 */
masterclassRouter.get('/videos', async (req: Request, res: Response) => {
  try {
    const expiresIn = req.query.expiresIn ? Number(req.query.expiresIn) : 315360000;
    const videos = await getMasterclassVideosList(expiresIn);
    res.status(200).json({
      success: true,
      totalVideos: videos.length,
      videos,
    });
  } catch (err: any) {
    console.error('[Masterclass] Error fetching video streams:', err);
    res.status(500).json({
      success: false,
      error: 'VIDEOS_FETCH_ERROR',
      message: err.message || 'Failed to generate private video signed URLs.',
    });
  }
});

