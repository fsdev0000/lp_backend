import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import multer from 'multer';
import { upsertContact, createOpportunity, bookAppointment, getFreeSlots, getMonthAvailability, getCalendarInfo } from '../../services/ghl';
import { sendAdminBriefing } from '../../services/email';
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

apiRoutes.post('/assessments/submit', assessmentRateLimiter, async (req, res) => {
  try {
    const { founder, answers } = req.body;

    if (!founder || !answers || !Array.isArray(answers)) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    // Robust answer extraction helper: handles numbers, numeric strings, or object wrappers ({score, value, etc.})
    const numericAnswers: number[] = answers
      .map((item: any) => {
        if (item === null || item === undefined) return null;
        if (typeof item === 'number') return isNaN(item) ? null : item;
        if (typeof item === 'string') {
          const n = parseFloat(item);
          return isNaN(n) ? null : n;
        }
        if (typeof item === 'object') {
          const cand = item.score ?? item.value ?? item.answer ?? item.val ?? item.rating;
          if (typeof cand === 'number' && !isNaN(cand)) return cand;
          if (typeof cand === 'string') {
            const n = parseFloat(cand);
            if (!isNaN(n)) return n;
          }
        }
        return null;
      })
      .filter((n): n is number => n !== null);

    const validCount = numericAnswers.length;
    const totalScore = numericAnswers.reduce((sum, val) => sum + val, 0);
    const overallMean = validCount > 0 ? totalScore / validCount : 1;

    // Correct conversion from 1-5 scale to 0-100 scale: ((Mean - 1) / 4) * 100
    const finalScore = validCount > 0 ? Math.min(100, Math.max(0, Math.round(((overallMean - 1) / 4) * 100))) : 0;

    // Directional signal framework labels per Founder Pressure Scan V1.0 specifications
    let tier = 'Limited Signal';
    if (finalScore >= 75) tier = 'Priority Signal';
    else if (finalScore >= 50) tier = 'Active Signal';
    else if (finalScore >= 25) tier = 'Emerging Signal';

    // Figure out primary focus based on domain averages
    const questions = await prisma.question.findMany({ orderBy: { order: 'asc' } });

    const domainScores: Record<string, { sum: number; n: number }> = {};
    questions.forEach((q, i) => {
      const raw = answers[i];
      let val: number | null = null;
      if (typeof raw === 'number' && !isNaN(raw)) val = raw;
      else if (typeof raw === 'string') {
        const n = parseFloat(raw);
        if (!isNaN(n)) val = n;
      } else if (raw && typeof raw === 'object') {
        const cand = raw.score ?? raw.value ?? raw.answer;
        if (typeof cand === 'number' && !isNaN(cand)) val = cand;
      }

      if (val !== null) {
        domainScores[q.domain] ??= { sum: 0, n: 0 };
        domainScores[q.domain].sum += val;
        domainScores[q.domain].n += 1;
      }
    });

    const domainAverages: { domain: string, mean: number, normalised: number }[] = [];
    let maxDomainScore = -1;

    for (const [domain, stats] of Object.entries(domainScores)) {
      if (stats.n > 0) {
        const avg = stats.sum / stats.n;
        const norm = Math.round(((avg - 1) / 4) * 100);
        domainAverages.push({ domain, mean: avg, normalised: norm });
        if (avg > maxDomainScore) {
          maxDomainScore = avg;
        }
      }
    }

    const highestDomains = domainAverages.filter(d => Math.abs(d.mean - maxDomainScore) < 0.01).map(d => d.domain);
    const primaryFocus = highestDomains.length > 1 ? highestDomains.join(' & ') : (highestDomains[0] || 'Founder Involvement');

    // Map insights based on the 5 official domains
    const insights: Record<string, { opp: string, q: string }> = {
      'Founder Involvement': { opp: 'Delegation of Operational Execution', q: 'Where does progress slow down when you are not directly involved?' },
      'Decision Load': { opp: 'Distribution of Strategic and Operational Decision Rights', q: 'Which decisions continue to bottleneck around you?' },
      'Execution Rhythm': { opp: 'Operating Cadence and Delivery Consistency', q: 'Are priorities holding their schedule without repeated founder intervention?' },
      'Leadership Ownership': { opp: 'Executive Mandates and Autonomous Ownership', q: 'Do your leaders resolve ambiguous issues within clear boundaries?' },
      'Operational Resilience': { opp: 'Scalable Operating Systems and Team Resilience', q: 'How well does the organisation absorb pressure without losing cadence?' },
    };

    const insight = insights[primaryFocus] || { opp: 'Operational Alignment', q: 'What is the most significant operational pressure pattern today?' };

    // Zero Database Retention: Generate ephemeral IDs and cache in temporary memory
    const assessmentId = randomUUID();
    const sessionId = randomUUID();

    ephemeralSessions.set(sessionId, {
      answers,
      domainScores: domainAverages,
      finalScore,
      overallMean,
      tier,
      methodologyVersion: '1.0',
      founder: {
        name: founder.founder || founder.name || 'Unknown',
        company: founder.company || '',
        email: founder.email || '',
        phone: founder.phone || '',
        revenue: founder.revenue || '',
        reference_number: founder.reference_number || founder.ref || '',
      },
      expiresAt: Date.now() + 30 * 60 * 1000,
    });

    // --- GHL & Email Integration ---
    if (founder.email) {
      try {
        const isMarketingOptedIn = Boolean(
          req.body.consent?.marketingOptional ?? founder.marketingConsent ?? founder.marketingOptional
        );
        const contactTags = isMarketingOptedIn
          ? ['Founder Pressure Scan', 'Newsletter']
          : ['Founder Pressure Scan'];

        const contactId = await upsertContact({
          email: founder.email,
          firstName: founder.founder || founder.name,
          phone: founder.phone,
          tags: contactTags,
          howDidYouHear: founder.howDidYouHear || req.body.howDidYouHear,
          attribution: req.body.attribution,
        });

        // Persist lead attribution to PostgreSQL
        syncLeadAttribution(
          {
            email: founder.email,
            leadName: founder.founder || founder.name,
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
        if (isMarketingOptedIn) {
          try {
            const cleanEmail = founder.email.toLowerCase().trim();
            const existingSub = await prisma.newsletterSubscriber.findUnique({
              where: { email: cleanEmail },
            });
            let token: string = randomUUID();
            if (!existingSub) {
              await prisma.newsletterSubscriber.create({
                data: {
                  email: cleanEmail,
                  firstName: (founder.founder || founder.name || '').trim() || null,
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
              console.log(`[Pressure Scan] Enrolled ${cleanEmail} into Newsletter subscribers.`);
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
              console.log(`[Pressure Scan] Reactivated Newsletter subscription for ${cleanEmail}.`);
            } else {
              token = existingSub.unsubscribeToken || token;
            }

            // Send Welcome Email
            await sendNewsletterWelcomeEmail(
              cleanEmail,
              contactId,
              token,
              (founder.founder || founder.name || '').trim() || null
            );
            console.log(`[Pressure Scan] Dispatched welcome newsletter email to ${cleanEmail}`);
          } catch (nlErr) {
            console.warn('[Pressure Scan] Newsletter subscriber record notice:', nlErr);
          }
        }

        if (contactId) {
          await createOpportunity(contactId, `Founder Pressure Scan - ${founder.founder || founder.name}`);

          // Send scan result briefing strictly to Lionel and Info
          const lionelContactId = await upsertContact({
            email: 'lionel@leadersperformance.ae',
            firstName: 'Lionel',
            lastName: 'Eersteling',
            tags: ['lp-staff']
          });
          const infoContactId = await upsertContact({
            email: 'info@leadersperformance.ae',
            firstName: 'Leaders',
            lastName: 'Performance',
            tags: ['lp-staff']
          });

          const adminRecipients = [lionelContactId, infoContactId].filter(Boolean);
          await sendAdminBriefing({
            name: founder.founder || founder.name,
            email: founder.email,
            score: finalScore,
            tier,
            company: founder.company,
            phone: founder.phone,
            reference_number: founder.reference_number || founder.ref,
            initial_reason: founder.initial_reason || founder.reason || founder.pressure,
            primary_focus: primaryFocus,
            focus_area: primaryFocus,
            greatest_opportunity: insight.opp,
            opening_question: insight.q
          }, adminRecipients);
        }
      } catch (ghlError) {
        console.error('GHL integration failed (non-fatal):', ghlError);
      }
    }

    console.log(`[Assessment Scored] Zero-DB Mode: Scored for ${founder.email || 'anonymous'}, Tier: ${tier}`);

    res.status(201).json({ message: 'Assessment submitted successfully', id: assessmentId, sessionId });
  } catch (error) {
    console.error('Error submitting assessment:', error);
    res.status(500).json({ error: 'Internal Server Error' });
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

    // Emit event to connected clients for real-time update
    const io = req.app.get('io');
    if (io) {
      io.emit('booking_updated', { date });
    }

    res.json({ success: true, message: 'Session successfully booked' });
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
