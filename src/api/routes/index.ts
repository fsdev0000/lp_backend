import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import multer from 'multer';
import { upsertContact, createOpportunity, createOpportunityWithDedup, bookAppointment, getFreeSlots, getMonthAvailability, getCalendarInfo } from '../../services/ghl';
import { sendAdminBriefing, sendCalendarBookingEmails } from '../../services/email';
import { syncLeadAttribution } from '../../services/attributionService';
import { ElevenLabsClient } from 'elevenlabs';
import { handleConversationTurn } from '../../services/ai/memory';
import OpenAI from 'openai';
import { getSecret } from '../../services/secrets';
import { buildDaisySystemPrompt, getDaisyWelcomeMessageVoice, extractDaisyRuntimeVariables } from '../../services/ai/daisy/PromptBuilder';
import { runtimeManager } from '../../services/ai/daisy/RuntimeManager';
import { consentRoutes } from './consent';
import { assessmentRateLimiter } from '../../middleware/rateLimiter';
import { getMasterclassMonthAvailability } from '../../services/masterclassService';
import { sendNewsletterWelcomeEmail } from './newsletter';
import { validateEmailBasic } from '../../services/emailValidation';
import { generatePressureScanPdf } from '../../services/pressureScanPdfService';

let elevenlabsClient: ElevenLabsClient | null = null;
async function getElevenLabs() {
  if (elevenlabsClient) return elevenlabsClient;
  const key = await getSecret('ELEVENLABS_API_KEY');
  if (key) elevenlabsClient = new ElevenLabsClient({ apiKey: key });
  return elevenlabsClient;
}

let openaiClient: OpenAI | null = null;
async function getOpenAI() {
  if (openaiClient) return openaiClient;
  const key = await getSecret('OPENAI_API_KEY') || await getSecret('GEMINI_API_KEY') || process.env.GEMINI_API_KEY;
  if (key) {
    openaiClient = new OpenAI({
      apiKey: key,
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/"
    });
  }
  return openaiClient;
}

const upload = multer();

const prisma = new PrismaClient();
const apiRoutes = Router();

apiRoutes.use('/consent', consentRoutes);

// Ephemeral in-memory session store (Zero Database Retention)
interface EphemeralSession {
  answers: any[];
  domainScores?: { domain: string; mean: number; normalised: number }[];
  finalScore?: number;
  overallMean?: number;
  tier?: string;
  methodologyVersion?: string;
  founder: {
    name: string;
    company: string;
    email: string;
    phone: string;
    revenue: string;
    reference_number?: string;
  };
  expiresAt: number;
}

const ephemeralSessions = new Map<string, EphemeralSession>();

// Periodically clean up expired ephemeral sessions every 15 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of ephemeralSessions.entries()) {
    if (session.expiresAt < now) {
      ephemeralSessions.delete(id);
    }
  }
}, 15 * 60 * 1000);

// Voice AI endpoint excluded from production release
// POST /voice/transcribe
apiRoutes.post('/voice/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    const audioBase64 = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype || 'audio/webm';
    const geminiKey = await getSecret('GEMINI_API_KEY') || await getSecret('OPENAI_API_KEY') || process.env.GEMINI_API_KEY;

    const payload = {
      contents: [{
        parts: [
          { text: 'Transcribe this audio accurately. Return ONLY the transcribed text without any conversational filler or quotes.' },
          {
            inline_data: {
              mime_type: mimeType,
              data: audioBase64
            }
          }
        ]
      }]
    };

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${geminiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const json = await response.json();

    if (json.error) {
      console.error('Gemini API Error:', json.error);
      return res.status(500).json({ error: 'Transcription failed via Gemini' });
    }

    const transcript = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    res.json({ transcript });
  } catch (error) {
    console.error('Error transcribing audio:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * @openapi
 * components:
 *   schemas:
 *     Question:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *         domain:
 *           type: string
 *         text:
 *           type: string
 *         order:
 *           type: integer
 *     PressureOption:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *         key:
 *           type: string
 *         title:
 *           type: string
 *         hint:
 *           type: string
 *         order:
 *           type: integer
 *     ScaleOption:
 *       type: object
 *       properties:
 *         key:
 *           type: string
 *         label:
 *           type: string
 *         value:
 *           type: integer
 *     AssessmentSubmission:
 *       type: object
 *       properties:
 *         founder:
 *           type: object
 *           properties:
 *             founder:
 *               type: string
 *             company:
 *               type: string
 *             phone:
 *               type: string
 *             email:
 *               type: string
 *             revenue:
 *               type: string
 *             team:
 *               type: string
 *             industry:
 *               type: string
 *             role:
 *               type: string
 *             stage:
 *               type: string
 *         answers:
 *           type: array
 *           items:
 *             type: integer
 *           description: Array of numeric scores from 1-4
 */

/**
 * @openapi
 * /ping:
 *   get:
 *     summary: Health check ping
 *     description: Returns pong to verify the API is responsive.
 *     tags:
 *       - Health
 *     responses:
 *       200:
 *         description: Success
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: pong
 */
apiRoutes.get('/ping', (req, res) => {
  res.json({ message: 'pong' });
});

/**
 * @openapi
 * /scan/config:
 *   get:
 *     summary: Get Dynamic Scan Configuration
 *     description: Returns the dynamic diagnostic questions, pressure options, and form fields (revenue bands, stages, scale options).
 *     tags:
 *       - Configuration
 *     responses:
 *       200:
 *         description: Scan configuration payload
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 questions:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Question'
 *                 pressureOptions:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/PressureOption'
 *                 revenueBands:
 *                   type: array
 *                   items:
 *                     type: string
 *                 stages:
 *                   type: array
 *                   items:
 *                     type: string
 *                 scaleOptions:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ScaleOption'
 */
let cachedConfig: any = null;
let cacheTime = 0;
const CACHE_TTL = 30 * 1000; // 30 seconds

apiRoutes.get('/scan/config', async (req, res) => {
  try {
    const now = Date.now();
    if (cachedConfig && !req.query.refresh && now - cacheTime < CACHE_TTL) {
      return res.json(cachedConfig);
    }

    const [questions, pressureOptions, rawRevenue, rawStages, rawScale] = await Promise.all([
      prisma.question.findMany({ orderBy: { order: 'asc' } }),
      prisma.pressureOption.findMany({ orderBy: { order: 'asc' } }),
      prisma.systemConfig.findUnique({ where: { key: 'revenueBands' } }),
      prisma.systemConfig.findUnique({ where: { key: 'stages' } }),
      prisma.systemConfig.findUnique({ where: { key: 'scaleOptions' } })
    ]);

    cachedConfig = {
      questions,
      pressureOptions,
      revenueBands: rawRevenue ? JSON.parse(rawRevenue.value) : [],
      stages: rawStages ? JSON.parse(rawStages.value) : [],
      scaleOptions: rawScale ? JSON.parse(rawScale.value) : []
    };
    cacheTime = now;

    res.json(cachedConfig);
  } catch (error) {
    console.error('Error fetching scan config:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * @openapi
 * /assessments/submit:
 *   post:
 *     summary: Submit a new assessment
 *     description: Saves founder assessment data and triggers asynchronous scoring.
 *     tags:
 *       - Assessment
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/AssessmentSubmission'
 *     responses:
 *       201:
 *         description: Assessment submitted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 id:
 *                   type: string
 *                   description: The ID of the saved assessment
 */
/**
 * @openapi
 * /assessments/session/{sessionId}:
 *   get:
 *     summary: Retrieve session data
 *     description: Gets the assessment and founder context by sessionId
 *     tags:
 *       - Assessment
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Session data
 *       404:
 *         description: Not found
 */
apiRoutes.get('/assessments/session/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;

    // 1. Search persistent PostgreSQL PressureScanSubmission first (by ID or referenceNumber)
    const dbSub = await prisma.pressureScanSubmission.findFirst({
      where: {
        OR: [
          { id: sessionId },
          { referenceNumber: sessionId },
        ],
      },
    });

    if (dbSub) {
      const answersArray = Array.isArray(dbSub.answers)
        ? (dbSub.answers as any[]).map((a) => (typeof a === 'number' ? a : a.score ?? a.value ?? a.rating))
        : [];

      return res.json({
        id: dbSub.id,
        sessionId: dbSub.id,
        reference_number: dbSub.referenceNumber,
        referenceNumber: dbSub.referenceNumber,
        answers: answersArray,
        founder: {
          name: dbSub.fullName,
          company: dbSub.companyName,
          email: dbSub.email,
          phone: dbSub.phone || '',
          revenue: (dbSub.submittedContext as any)?.revenue || '',
          reference_number: dbSub.referenceNumber,
        },
        domainScores: dbSub.domainScores,
        primarySignalAreas: dbSub.primarySignalAreas,
        signalClassification: dbSub.signalClassification,
        tier: dbSub.signalClassification,
        overallMean: dbSub.overallRawMean,
        overallNormalised: dbSub.overallNormalised,
        score: Math.round(dbSub.overallNormalised),
        methodologyVersion: dbSub.methodologyVersion,
        reviewStatus: dbSub.reviewStatus,
        reviewerNotes: dbSub.reviewerNotes,
        reviewerDecision: dbSub.reviewerDecision,
        reviewedAt: dbSub.reviewedAt,
        reviewedBy: dbSub.reviewedBy,
        zoomMeetingUrl: dbSub.zoomMeetingUrl || process.env.REVIEW_MEETING_URL || 'https://zoom.us/j/7114427991?pwd=leadersperformance',
        scheduledReviewAt: dbSub.scheduledReviewAt,
        submittedAt: dbSub.createdAt,
      });
    }

    // 2. Fallback to in-memory ephemeral sessions for backward compatibility
    const session = ephemeralSessions.get(sessionId);
    if (session && session.expiresAt > Date.now()) {
      return res.json({
        answers: session.answers,
        founder: session.founder,
        reference_number: session.founder?.reference_number,
        domainScores: session.domainScores,
        score: session.finalScore,
        tier: session.tier,
        overallMean: session.overallMean,
        methodologyVersion: session.methodologyVersion || '1.0',
      });
    }

    return res.status(404).json({ error: 'Session not found or expired' });
  } catch (error) {
    console.error('Error fetching session:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Helper for deterministic domains
const OFFICIAL_DOMAINS = [
  { domain: 'Founder Involvement', qNums: [1, 2] },
  { domain: 'Decision Load', qNums: [3, 4] },
  { domain: 'Execution Rhythm', qNums: [5, 6] },
  { domain: 'Leadership Ownership', qNums: [7, 8] },
  { domain: 'Operational Resilience', qNums: [9, 10] },
];

function domainToSlug(d: string): string {
  return d.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function generateUniqueScanRef(): Promise<string> {
  const year = new Date().getFullYear();
  for (let attempt = 0; attempt < 25; attempt++) {
    const seq = Math.floor(1000 + Math.random() * 9000);
    const candidate = `FPS-${year}-${seq}`;
    const exists = await prisma.pressureScanSubmission.findUnique({
      where: { referenceNumber: candidate },
    });
    if (!exists) {
      return candidate;
    }
  }
  return `FPS-${year}-${Date.now().toString().slice(-4)}`;
}

apiRoutes.post('/assessments/submit', assessmentRateLimiter, async (req, res) => {
  try {
    const { founder, answers } = req.body;

    if (!founder || typeof founder !== 'object') {
      return res.status(400).json({ error: 'Founder information is required.' });
    }

    // ─── Sub-Task 2: Strict Validation Engine ────────────────────────────────
    // 2.1 Exactly 10 answers, integers between 1 and 5 (never drop or filter invalid answers)
    if (!answers || !Array.isArray(answers) || answers.length !== 10) {
      return res.status(400).json({ error: 'Answers array length MUST equal exactly 10 complete answers.' });
    }

    const validatedScores: number[] = [];
    for (let i = 0; i < 10; i++) {
      const item = answers[i];
      let val: any = null;
      if (typeof item === 'number') {
        val = item;
      } else if (item && typeof item === 'object') {
        val = item.score ?? item.value ?? item.rating ?? item.answer ?? item.val;
      }

      if (
        val === null ||
        val === undefined ||
        typeof val !== 'number' ||
        isNaN(val) ||
        !Number.isInteger(val) ||
        val < 1 ||
        val > 5
      ) {
        return res.status(400).json({
          error: `Question ${i + 1} score must be an integer between 1 and 5. Received: ${JSON.stringify(item)}`,
        });
      }
      validatedScores.push(val);
    }

    // 2.2 Mandatory Consent & Disclosures
    const methodologyAcknowledged = Boolean(
      req.body.methodologyAcknowledged ??
      founder.methodologyAcknowledged ??
      req.body.consent?.methodologyAcknowledged
    );
    const privacyAcknowledged = Boolean(
      req.body.privacyAcknowledged ??
      founder.privacyAcknowledged ??
      req.body.consent?.privacyAcknowledged
    );

    if (!methodologyAcknowledged) {
      return res.status(400).json({ error: 'methodologyAcknowledged must be explicitly accepted.' });
    }
    if (!privacyAcknowledged) {
      return res.status(400).json({ error: 'privacyAcknowledged must be explicitly accepted.' });
    }

    const marketingConsent = Boolean(
      req.body.marketingConsent ??
      req.body.consent?.marketingOptional ??
      founder.marketingConsent ??
      founder.marketingOptional
    );

    // 2.3 Email Validation
    const cleanEmail = (founder.email || '').trim().toLowerCase();
    if (!cleanEmail) {
      return res.status(400).json({ error: 'Business email is required.' });
    }
    const emailCheck = validateEmailBasic(cleanEmail);
    if (!emailCheck.valid) {
      return res.status(400).json({ error: emailCheck.error || 'Please enter a valid business email.' });
    }

    // ─── Sub-Task 3: Deterministic Scoring & 5-Domain Engine ───────────────────
    // Domain Means = (Q_a + Q_b) / 2
    const domainScores: Array<{ domain: string; mean: number; normalised: number }> = [];
    let maxDomainMean = -1;

    OFFICIAL_DOMAINS.forEach((dGroup) => {
      const s1 = validatedScores[dGroup.qNums[0] - 1];
      const s2 = validatedScores[dGroup.qNums[1] - 1];
      const mean = Number(((s1 + s2) / 2).toFixed(2));
      const normalised = Number((((mean - 1) / 4) * 100).toFixed(2));
      domainScores.push({ domain: dGroup.domain, mean, normalised });
      if (mean > maxDomainMean) {
        maxDomainMean = mean;
      }
    });

    // Overall Raw Mean = Sum(10) / 10
    const rawSum = validatedScores.reduce((sum, s) => sum + s, 0);
    const overallRawMean = Number((rawSum / 10).toFixed(2));

    // Normalised Score = ((Mean - 1) / 4) * 100
    const overallNormalised = Number((((overallRawMean - 1) / 4) * 100).toFixed(2));

    // Classify signal
    let signalClassification = 'Limited Signal';
    if (overallNormalised >= 75) signalClassification = 'Priority Signal';
    else if (overallNormalised >= 50) signalClassification = 'Active Signal';
    else if (overallNormalised >= 25) signalClassification = 'Emerging Signal';

    // Primary Signal Area(s) (supports joint ties)
    const primarySignalAreas = domainScores
      .filter((d) => Math.abs(d.mean - maxDomainMean) < 0.001)
      .map((d) => d.domain);

    const primaryJoined = primarySignalAreas.join(' & ');

    // Qualitative Copy
    const insights: Record<string, { opp: string; q: string; interp: string }> = {
      'Founder Involvement': {
        opp: 'Delegation of Operational Execution',
        q: 'Where does progress slow down when you are not directly involved?',
        interp: 'Your responses indicate that organizational momentum and daily progress remain concentrated around your personal oversight.',
      },
      'Decision Load': {
        opp: 'Distribution of Strategic and Operational Decision Rights',
        q: 'Which decisions continue to bottleneck around you?',
        interp: 'Your responses indicate that a relatively high proportion of operational and strategic decisions may still require your direct involvement.',
      },
      'Execution Rhythm': {
        opp: 'Operating Cadence and Delivery Consistency',
        q: 'Are priorities holding their schedule without repeated founder intervention?',
        interp: 'Your responses indicate that strategic delivery cadence and commitments require continuous founder intervention to stay on schedule.',
      },
      'Leadership Ownership': {
        opp: 'Executive Mandates and Autonomous Ownership',
        q: 'Do your leaders resolve ambiguous issues within clear boundaries?',
        interp: 'Your responses indicate that leadership accountability repeatedly defers consequential decisions back to you instead of resolving outcomes autonomously.',
      },
      'Operational Resilience': {
        opp: 'Scalable Operating Systems and Team Resilience',
        q: 'How well does the organisation absorb pressure without losing cadence?',
        interp: 'Your responses indicate that the organisation experiences operational friction and strain when key leaders are under sustained demand.',
      },
    };

    const firstPrimary = primarySignalAreas[0] || 'Founder Involvement';
    const primaryInsight = insights[firstPrimary] || insights['Founder Involvement'];

    // ─── Sub-Task 4: Reference Generation & PostgreSQL Persistence ───────────
    const referenceNumber = await generateUniqueScanRef();

    const structuredAnswers = validatedScores.map((score, i) => ({
      questionNumber: i + 1,
      domain: OFFICIAL_DOMAINS[Math.floor(i / 2)].domain,
      score,
    }));

    const participantName = (founder.founder || founder.name || 'Anonymous Founder').trim();
    const companyName = (founder.company || 'Confidential').trim();

    const submission = await prisma.pressureScanSubmission.create({
      data: {
        referenceNumber,
        methodologyVersion: '1.0',
        questionSetVersion: '1.0',
        fullName: participantName,
        email: cleanEmail,
        companyName,
        phone: founder.phone || null,
        submittedContext: {
          revenue: founder.revenue || null,
          companyStage: founder.companyStage || founder.stage || null,
          role: founder.role || 'Founder / CEO',
          industry: founder.industry || null,
          initial_reason: founder.initial_reason || founder.reason || founder.pressure || null,
          howDidYouHear: founder.howDidYouHear || req.body.howDidYouHear || null,
        },
        answers: structuredAnswers,
        overallRawMean,
        overallNormalised,
        domainScores,
        primarySignalAreas,
        signalClassification,
        methodologyAcknowledged: true,
        privacyAcknowledged: true,
        marketingConsent,
        reviewStatus: 'AWAITING_REVIEW',
        zoomMeetingUrl: process.env.REVIEW_MEETING_URL || 'https://zoom.us/j/7114427991?pwd=leadersperformance',
      },
    });

    // Also cache in memory for backwards compatibility with legacy session polling
    ephemeralSessions.set(submission.id, {
      answers: validatedScores,
      domainScores,
      finalScore: Math.round(overallNormalised),
      overallMean: overallRawMean,
      tier: signalClassification,
      methodologyVersion: '1.0',
      founder: {
        name: participantName,
        company: companyName,
        email: cleanEmail,
        phone: founder.phone || '',
        revenue: founder.revenue || '',
        reference_number: referenceNumber,
      },
      expiresAt: Date.now() + 30 * 60 * 1000,
    });

    // ─── Sub-Task 4 & 6: GHL Smart Deduplication & Secure Staff Alert ─────────
    try {
      const primarySlug = domainToSlug(primarySignalAreas[0] || 'founder-involvement');
      const contactTags = [
        'founder-pressure-scan',
        'scan-v1.0',
        `primary-${primarySlug}`,
        ...(marketingConsent ? ['Newsletter'] : []),
      ];

      const contactId = await upsertContact({
        email: cleanEmail,
        firstName: participantName,
        phone: founder.phone,
        tags: contactTags,
        customFields: [
          { name: 'Last Scan Ref', value: referenceNumber },
          { name: 'Primary Signal Area', value: primaryJoined },
          { name: 'Normalised Score', value: `${overallNormalised}%` },
        ],
        howDidYouHear: founder.howDidYouHear || req.body.howDidYouHear,
        attribution: req.body.attribution,
      });

      // Persist lead attribution to PostgreSQL
      syncLeadAttribution(
        {
          email: cleanEmail,
          leadName: participantName,
          leadForm: 'founder_pressure_scan',
          howDidYouHear: founder.howDidYouHear || req.body.howDidYouHear,
          attribution: req.body.attribution,
          phone: founder.phone,
          ghlContactId: contactId,
          tags: contactTags,
        },
        req
      ).catch((attrErr) => console.warn('[Pressure Scan] Attribution tracking notice:', attrErr));

      // Enroll in newsletter if opted in
      if (marketingConsent) {
        try {
          const existingSub = await prisma.newsletterSubscriber.findUnique({
            where: { email: cleanEmail },
          });
          let token: string = randomUUID();
          if (!existingSub) {
            await prisma.newsletterSubscriber.create({
              data: {
                email: cleanEmail,
                firstName: participantName || null,
                consentGiven: true,
                consentDate: new Date(),
                consentSource: 'founder_pressure_scan',
                privacyPolicyVersion: 'v2026.3',
                subscribed: true,
                status: 'subscribed',
                unsubscribeToken: token,
                source: 'Founder Pressure Scan',
                ghlContactId: contactId || null,
                subscribedAt: new Date(),
              },
            });
          } else if (!existingSub.subscribed) {
            token = existingSub.unsubscribeToken || token;
            await prisma.newsletterSubscriber.update({
              where: { email: cleanEmail },
              data: {
                subscribed: true,
                status: 'subscribed',
                unsubscribedAt: null,
                subscribedAt: new Date(),
                ghlContactId: contactId || existingSub.ghlContactId,
              },
            });
          } else {
            token = existingSub.unsubscribeToken || token;
          }

          sendNewsletterWelcomeEmail(cleanEmail, contactId, token, participantName).catch((nlErr) =>
            console.warn('[Pressure Scan] Newsletter subscriber record notice:', nlErr)
          );
        } catch (nlErr) {
          console.warn('[Pressure Scan] Newsletter subscriber record notice:', nlErr);
        }
      }

      if (contactId) {
        // GHL Opportunity Deduplication: Checks for existing open opportunities first
        await createOpportunityWithDedup(
          contactId,
          `Founder Pressure Scan - ${companyName || participantName}`,
          referenceNumber
        );

        // Send alert email to Lionel & Staff with secure frontend review link ONLY
        const frontendUrl = process.env.FRONTEND_URL || 'https://staging.leadersperformance.ae';
        const secureReviewUrl = `${frontendUrl}/diagnostics?id=${referenceNumber}`;

        const lionelContactId = await upsertContact({
          email: 'lionel@leadersperformance.ae',
          firstName: 'Lionel',
          lastName: 'Eersteling',
          tags: ['lp-staff'],
        });
        const infoContactId = await upsertContact({
          email: 'info@leadersperformance.ae',
          firstName: 'Leaders',
          lastName: 'Performance',
          tags: ['lp-staff'],
        });

        const adminRecipients = [lionelContactId, infoContactId].filter(Boolean);
        await sendAdminBriefing(
          {
            name: participantName,
            participant_name: participantName,
            email: cleanEmail,
            company: companyName,
            company_name: companyName,
            phone: founder.phone,
            revenue: founder.revenue,
            stage: founder.companyStage || founder.stage,
            signal_classification: signalClassification,
            reference_number: referenceNumber,
            initial_reason: founder.initial_reason || founder.reason || founder.pressure,
            primary_focus: primaryJoined,
            review_url: secureReviewUrl,
          },
          adminRecipients
        );
      }
    } catch (ghlError) {
      console.error('[Pressure Scan] GHL/Email integration non-fatal error:', ghlError);
    }

    // ─── Sub-Task 5: Public API Response Sanitization ─────────────────────────
    // Strictly ZERO numerical percentages or diagnostic risk tiers returned!
    return res.status(201).json({
      success: true,
      referenceNumber,
      primarySignalAreas,
      openingCopy: `Based on your responses, the strongest current signal appears in ${primaryJoined}.`,
      qualitativeInterpretation: primaryInsight.interp,
      humanReviewNotice:
        "The automated outcome identifies directional signals based on your answers. Lionel Eersteling's Human Review will examine the context, interpretation, and deliberate control structures.",
      nextSteps: {
        title: 'Begin a Strategic Conversation',
        actionUrl: '/connect',
      },
      id: submission.id,
      sessionId: submission.id,
    });
  } catch (error) {
    console.error('Error submitting assessment:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ─── Sub-Task 6: Secure Human Review Dossier APIs ─────────────────────────────

/**
 * GET /api/v1/scan/review/:referenceNumber
 * Protected dossier view for Mr. Lionel
 */
apiRoutes.get('/scan/review/:referenceNumber', async (req, res) => {
  try {
    const { referenceNumber } = req.params;
    const submission = await prisma.pressureScanSubmission.findFirst({
      where: {
        OR: [{ referenceNumber }, { id: referenceNumber }],
      },
    });

    if (!submission) {
      return res.status(404).json({ error: 'Review dossier not found for given reference.' });
    }

    return res.json({
      success: true,
      referenceNumber: submission.referenceNumber,
      fullName: submission.fullName,
      email: submission.email,
      companyName: submission.companyName,
      phone: submission.phone,
      submittedContext: submission.submittedContext,
      answers: submission.answers,
      overallRawMean: submission.overallRawMean,
      overallNormalised: submission.overallNormalised,
      domainScores: submission.domainScores,
      primarySignalAreas: submission.primarySignalAreas,
      signalClassification: submission.signalClassification,
      reviewStatus: submission.reviewStatus,
      reviewerNotes: submission.reviewerNotes,
      reviewerDecision: submission.reviewerDecision,
      reviewedAt: submission.reviewedAt,
      reviewedBy: submission.reviewedBy,
      zoomMeetingUrl: submission.zoomMeetingUrl || process.env.REVIEW_MEETING_URL || 'https://zoom.us/j/7114427991?pwd=leadersperformance',
      scheduledReviewAt: submission.scheduledReviewAt,
      submittedAt: submission.createdAt,
    });
  } catch (error) {
    console.error('Error fetching review dossier:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * PATCH /api/v1/scan/review/:referenceNumber
 * Allows Lionel to save reviewer notes, decision, and update reviewStatus
 */
apiRoutes.patch('/scan/review/:referenceNumber', async (req, res) => {
  try {
    const { referenceNumber } = req.params;
    const { reviewerNotes, reviewerDecision, reviewStatus, zoomMeetingUrl, scheduledReviewAt, reviewedBy } = req.body;

    const existing = await prisma.pressureScanSubmission.findFirst({
      where: {
        OR: [{ referenceNumber }, { id: referenceNumber }],
      },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Submission not found to update.' });
    }

    const updated = await prisma.pressureScanSubmission.update({
      where: { id: existing.id },
      data: {
        reviewerNotes: reviewerNotes !== undefined ? reviewerNotes : existing.reviewerNotes,
        reviewerDecision: reviewerDecision !== undefined ? reviewerDecision : existing.reviewerDecision,
        reviewStatus: reviewStatus !== undefined ? reviewStatus : existing.reviewStatus,
        zoomMeetingUrl: zoomMeetingUrl !== undefined ? zoomMeetingUrl : existing.zoomMeetingUrl,
        scheduledReviewAt: scheduledReviewAt ? new Date(scheduledReviewAt) : existing.scheduledReviewAt,
        reviewedAt: new Date(),
        reviewedBy: reviewedBy || existing.reviewedBy || 'Lionel Eersteling',
      },
    });

    return res.json({ success: true, submission: updated });
  } catch (error) {
    console.error('Error updating review dossier:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * GET /api/v1/scan/review/:referenceNumber/pdf
 * Downloads standard PDF 1.4 Dossier
 */
apiRoutes.get('/scan/review/:referenceNumber/pdf', async (req, res) => {
  try {
    const { referenceNumber } = req.params;
    const submission = await prisma.pressureScanSubmission.findFirst({
      where: {
        OR: [{ referenceNumber }, { id: referenceNumber }],
      },
    });

    if (!submission) {
      return res.status(404).json({ error: 'Submission not found for PDF export' });
    }

    const answersList = Array.isArray(submission.answers) ? (submission.answers as any[]) : [];
    const domainScoresList = Array.isArray(submission.domainScores) ? (submission.domainScores as any[]) : [];

    const pdfBuffer = generatePressureScanPdf({
      referenceNumber: submission.referenceNumber,
      fullName: submission.fullName,
      email: submission.email,
      companyName: submission.companyName,
      phone: submission.phone,
      submittedContext: submission.submittedContext as any,
      answers: answersList,
      overallRawMean: submission.overallRawMean,
      overallNormalised: submission.overallNormalised,
      domainScores: domainScoresList,
      primarySignalAreas: submission.primarySignalAreas,
      signalClassification: submission.signalClassification,
      submittedAt: submission.createdAt,
      reviewStatus: submission.reviewStatus,
      reviewerNotes: submission.reviewerNotes,
      reviewerDecision: submission.reviewerDecision,
      reviewedAt: submission.reviewedAt,
      reviewedBy: submission.reviewedBy,
      zoomMeetingUrl: submission.zoomMeetingUrl,
      scheduledReviewAt: submission.scheduledReviewAt,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="Founder_Pressure_Scan_${submission.referenceNumber}.pdf"`
    );
    res.setHeader('Content-Length', pdfBuffer.length);
    return res.end(pdfBuffer);
  } catch (error) {
    console.error('Error generating PDF dossier:', error);
    res.status(500).json({ error: 'Failed to generate PDF dossier' });
  }
});

// Voice AI endpoint excluded from production release
// POST /voice/session
apiRoutes.post('/chat/init', async (req, res) => {
  try {
    const sessionId = randomUUID();
    res.status(200).json({ message: 'Session initialized', sessionId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to init session' });
  }
});

// AI Chat endpoint excluded from production Swagger docs
// POST /chat/message
apiRoutes.post('/chat/message', async (req, res) => {
  const { sessionId, message } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  try {
    const aiResponse = await handleConversationTurn(sessionId, message || req.body.text);

    return res.json(aiResponse);
  } catch (e) {
    console.error('Chat Error:', e);
    return res.status(500).json({ error: 'Failed to process message' });
  }
});

apiRoutes.get('/voice/state', (req, res) => {
  const sessionId = req.query.sessionId as string;
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId required' });
  }

  const sessionState = runtimeManager.getOrCreateSession(sessionId);
  if (!sessionState) {
    return res.status(404).json({ error: 'Session state not found' });
  }

  const ctaVisible = sessionState.memoryFlags.bookingRecommended || sessionState.memoryFlags.calendarOpened;
  res.json({ ctaVisible });
});

// Voice AI endpoint excluded from production release
// POST /voice/token
apiRoutes.post('/voice/token', async (req, res) => {
  try {
    const apiKey = await getSecret('ELEVENLABS_API_KEY');
    const agentId = process.env.ELEVENLABS_AGENT_ID || (await getSecret('ELEVENLABS_AGENT_ID')) || 'agent_0501kz5sjfqbfyevzt7kqkmd9gz4';

    if (!apiKey) {
      return res.status(500).json({ error: 'ElevenLabs API key not configured' });
    }
    if (!agentId) {
      return res.status(500).json({ error: 'ElevenLabs Agent ID not configured' });
    }

    const response = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentId}`, {
      method: 'GET',
      headers: {
        'xi-api-key': apiKey
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('ElevenLabs token error:', errorText);
      return res.status(500).json({ error: `Failed to get signed URL from ElevenLabs: ${errorText}` });
    }

    const data = await response.json();

    // Generate prompt and runtime variables if sessionId is provided
    let systemPrompt = "";
    let firstMessage = "";
    let dynamicVariables: any = {};
    if (req.body && req.body.sessionId) {
      try {
        const transcript = await prisma.transcript.findUnique({
          where: { id: req.body.sessionId },
          include: {
            founder: {
              include: {
                assessments: {
                  orderBy: { createdAt: 'desc' },
                  take: 1
                }
              }
            }
          }
        });

        if (transcript) {
          const latestAssessment = (transcript.founder as any)?.assessments?.[0];
          const primaryArea = latestAssessment?.primaryFocus || latestAssessment?.focusArea || 'Founder Dependency';
          const scoreTier = latestAssessment?.tier || 'Critical';
          const overallScore = latestAssessment?.overallScore !== null && latestAssessment?.overallScore !== undefined ? latestAssessment.overallScore : 78;

          const context = {
            lead_name: transcript.founder?.name || 'Founder',
            founder: transcript.founder?.name || 'Founder',
            company_name: transcript.founder?.companyName || 'your company',
            company: transcript.founder?.companyName || 'your company',
            revenue: transcript.founder?.revenueBand || undefined,
            stage: (transcript.founder as any)?.companyStage || 'Growth Stage',
            primaryPressureArea: primaryArea,
            primary_pressure_area: primaryArea,
            score_tier: scoreTier,
            overallScore: overallScore
          };
          systemPrompt = buildDaisySystemPrompt(context, 'voice');
          const baseVars = extractDaisyRuntimeVariables(context);
          dynamicVariables = {
            ...baseVars,
            primary_pressure_area: primaryArea,
            primaryPressureArea: primaryArea,
            score_tier: String(scoreTier),
            overall_score: String(overallScore),
            founder_name: transcript.founder?.name || 'Founder',
            company_name: transcript.founder?.companyName || 'your company'
          };
          firstMessage = getDaisyWelcomeMessageVoice(transcript.founder?.name, primaryArea, scoreTier);
        }
      } catch (err) {
        console.error("Failed to generate custom prompt:", err);
      }
    }

    // If no sessionId or error, fallback to un-guessed greeting and default variables
    if (!systemPrompt) {
      const fallbackCtx = {
        lead_name: 'Founder',
        company: 'your company',
        primaryPressureArea: 'Founder Dependency',
        primary_pressure_area: 'Founder Dependency',
        score_tier: 'Critical',
        overallScore: 78
      };
      systemPrompt = buildDaisySystemPrompt(fallbackCtx, 'voice');
      const baseVars = extractDaisyRuntimeVariables(fallbackCtx);
      dynamicVariables = {
        ...baseVars,
        primary_pressure_area: 'Founder Dependency',
        primaryPressureArea: 'Founder Dependency',
        score_tier: 'Critical',
        overall_score: '78',
        founder_name: 'Founder',
        company_name: 'your company'
      };
      firstMessage = getDaisyWelcomeMessageVoice('Founder', dynamicVariables.primary_pressure_area, dynamicVariables.score_tier);
    }

    return res.json({ signedUrl: data.signed_url, prompt: systemPrompt, firstMessage, dynamicVariables });
  } catch (e: any) {
    console.error('Token Error:', e);
    res.status(500).json({ error: 'Failed to generate token', details: e.message });
  }
});

// Voice AI endpoint excluded from production release
// POST /voice/tts
apiRoutes.post('/voice/tts', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'text is required' });

    // Use voice ID from vault if available, otherwise default to a standard voice
    const voiceId = await getSecret('ELEVENLABS_VOICE_ID') || process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';

    const elevenlabs = await getElevenLabs();
    if (!elevenlabs) {
      return res.status(500).json({ error: 'ElevenLabs API key not configured' });
    }

    const audioStream = await elevenlabs.textToSpeech.convert(voiceId, {
      text,
      model_id: "eleven_turbo_v2",
      output_format: "mp3_44100_128"
    });

    // Write the audio stream to the response
    res.setHeader('Content-Type', 'audio/mpeg');
    for await (const chunk of audioStream) {
      res.write(chunk);
    }
    res.end();
  } catch (e: any) {
    console.error('TTS Error:', e);
    res.status(500).json({ error: 'Failed to generate audio', details: e.message, stack: e.stack });
  }
});

/**
 * @openapi
 * /booking/schedule:
 *   post:
 *     summary: Schedule a strategic review session
 *     description: Accepts founder info and selected time, stores booking, and returns success.
 *     tags:
 *       - Booking
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email:
 *                 type: string
 *               date:
 *                 type: string
 *               time:
 *                 type: string
 *               timezone:
 *                 type: string
 *     responses:
 *       200:
 *         description: Booking scheduled
 */
apiRoutes.post('/booking/schedule', async (req, res) => {
  const { email, date, time, timezone, name, phone, reference } = req.body;

  if (!email || !date || !time) {
    return res.status(400).json({ error: 'Missing required booking fields' });
  }

  try {
    const contactId = await upsertContact({
      email,
      firstName: name,
      phone,
      tags: ['Booking']
    });

    // Convert '02:30 PM' to '14:30'
    let formattedTime = time;
    const timeMatch = time.match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1], 10);
      const minutes = timeMatch[2];
      const modifier = timeMatch[3].toUpperCase();
      if (modifier === 'PM' && hours < 12) hours += 12;
      if (modifier === 'AM' && hours === 12) hours = 0;
      formattedTime = `${hours.toString().padStart(2, '0')}:${minutes}`;
    }

    if (formattedTime < '13:30' || formattedTime > '18:00') {
      return res.status(400).json({ error: 'Bookings are limited to 1:30 PM - 7:00 PM (Dubai time).' });
    }

    const dateTimeStr = `${date}T${formattedTime}:00`;
    const appointmentTitle = `Personal Review Conversation - ${name || email}${reference ? ` (${reference})` : ''}`;
    await bookAppointment(contactId, dateTimeStr, appointmentTitle);

    console.log(`[Booking Scheduled] Successfully booked for ${email} (${name || 'Founder'}) at ${dateTimeStr} [Ref: ${reference || 'N/A'}]`);

    if (reference) {
      await prisma.pressureScanSubmission.updateMany({
        where: {
          OR: [
            { referenceNumber: reference },
            { id: reference },
          ],
        },
        data: {
          scheduledReviewAt: new Date(dateTimeStr),
          zoomMeetingUrl: process.env.REVIEW_MEETING_URL || 'https://zoom.us/j/7114427991?pwd=leadersperformance',
        },
      }).catch((e) => console.warn('[Pressure Scan] Could not link booking to scan ref:', e));
    }

    // Resolve founder name/company from scan submission if not directly provided in booking body
    let finalName = name;
    let finalCompany = req.body.company;
    let finalPhone = phone;

    if (reference && (!finalName || !finalCompany || !finalPhone)) {
      try {
        const existingSub = await prisma.pressureScanSubmission.findFirst({
          where: {
            OR: [{ referenceNumber: reference }, { id: reference }],
          },
          select: { fullName: true, companyName: true, phone: true },
        });
        if (existingSub) {
          if (!finalName && existingSub.fullName) finalName = existingSub.fullName;
          if (!finalCompany && existingSub.companyName) finalCompany = existingSub.companyName;
          if (!finalPhone && existingSub.phone) finalPhone = existingSub.phone;
        }
      } catch (_) {}
    }

    // Dispatch Calendar Booking Emails:
    // 1) Founder receives calendar confirmation with confirmed time & Zoom meeting link
    // 2) Lionel's side receives notification alert with founder details and link to review
    sendCalendarBookingEmails({
      participantName: finalName || 'Founder',
      email: email,
      phone: finalPhone || undefined,
      companyName: finalCompany || 'Enterprise',
      dateTimeStr: dateTimeStr,
      referenceNumber: reference || 'FPS-2026-N/A',
      zoomMeetingUrl: process.env.REVIEW_MEETING_URL || 'https://zoom.us/j/7114427991?pwd=leadersperformance',
    }).catch((e) => console.error('[Pressure Scan] Error sending calendar booking emails:', e));

    // Emit event to connected clients for real-time update
    const io = req.app.get('io');
    if (io) {
      io.emit('booking_updated', { date });
    }

    res.json({
      success: true,
      message: 'Session successfully booked',
      scheduledReviewAt: dateTimeStr,
      zoomMeetingUrl: process.env.REVIEW_MEETING_URL || 'https://zoom.us/j/7114427991?pwd=leadersperformance',
    });
  } catch (error) {
    console.error('Error scheduling booking:', error);
    res.status(500).json({ error: 'Failed to schedule booking' });
  }
});

/**
 * @openapi
 * /bookings/availability:
 *   get:
 *     summary: Get Available Booking Slots
 *     description: Fetches available calendar slots from GoHighLevel adapter.
 *     tags:
 *       - Booking
 *     responses:
 *       200:
 *         description: List of available time slots in ISO 8601 format
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: string
 *                 format: date-time
 */
apiRoutes.get('/bookings/availability', async (req, res) => {
  try {
    const date = (req.query.date as string) || new Date().toISOString().split('T')[0];
    const slots = await getFreeSlots(date);
    res.status(200).json(slots);
  } catch (error) {
    console.error('Failed to get availability:', error);
    res.status(500).json({ error: 'Failed to fetch availability' });
  }
});

/**
 * @openapi
 * /bookings/availability/month:
 *   get:
 *     summary: Get Month Availability
 *     description: Fetches available calendar slots for an entire month from GoHighLevel.
 *     tags:
 *       - Booking
 *     parameters:
 *       - in: query
 *         name: year
 *         schema:
 *           type: integer
 *         required: true
 *       - in: query
 *         name: month
 *         schema:
 *           type: integer
 *         required: true
 *     responses:
 *       200:
 *         description: Dictionary mapping date strings to arrays of available time slots
 */
apiRoutes.get('/bookings/availability/month', async (req, res) => {
  try {
    const year = parseInt(req.query.year as string);
    const month = parseInt(req.query.month as string); // 1-12
    if (!year || !month) return res.status(400).json({ error: 'Year and month required' });

    const availability = await getMasterclassMonthAvailability(year, month);
    res.status(200).json(availability);
  } catch (error) {
    console.error('Failed to get month availability:', error);
    res.status(500).json({ error: 'Failed to fetch month availability' });
  }
});

/**
 * @openapi
 * /bookings/calendar-info:
 *   get:
 *     summary: Get Calendar Info
 *     description: Returns the GHL calendar name and slot duration for dynamic session label display.
 *     tags:
 *       - Booking
 *     responses:
 *       200:
 *         description: Calendar name and duration
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 name:
 *                   type: string
 *                 duration:
 *                   type: number
 *                 sessionLabel:
 *                   type: string
 */
apiRoutes.get('/bookings/calendar-info', async (_req, res) => {
  try {
    const info = await getCalendarInfo();
    const duration = process.env.REVIEW_SESSION_DURATION ? parseInt(process.env.REVIEW_SESSION_DURATION, 10) : info.duration;
    res.status(200).json({
      name: info.name,
      duration,
      sessionLabel: `Personal Review Conversation · ${duration} min`,
    });
  } catch (error) {
    console.error('Failed to get calendar info:', error);
    // Fallback so the UI always has something to show
    const fallbackDuration = process.env.REVIEW_SESSION_DURATION ? parseInt(process.env.REVIEW_SESSION_DURATION, 10) : 30;
    res.status(200).json({
      name: 'Personal Review Conversation',
      duration: fallbackDuration,
      sessionLabel: `Personal Review Conversation · ${fallbackDuration} min`,
    });
  }
});

export { apiRoutes };
