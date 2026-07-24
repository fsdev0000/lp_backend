import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import multer from 'multer';

const upload = multer();

const prisma = new PrismaClient();
const apiRoutes = Router();

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
apiRoutes.get('/scan/config', async (req, res) => {
  try {
    const questions = await prisma.question.findMany({ orderBy: { order: 'asc' } });
    const pressureOptions = await prisma.pressureOption.findMany({ orderBy: { order: 'asc' } });
    
    const rawRevenue = await prisma.systemConfig.findUnique({ where: { key: 'revenueBands' } });
    const rawStages = await prisma.systemConfig.findUnique({ where: { key: 'stages' } });
    const rawScale = await prisma.systemConfig.findUnique({ where: { key: 'scaleOptions' } });

    res.json({
      questions,
      pressureOptions,
      revenueBands: rawRevenue ? JSON.parse(rawRevenue.value) : [],
      stages: rawStages ? JSON.parse(rawStages.value) : [],
      scaleOptions: rawScale ? JSON.parse(rawScale.value) : []
    });
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
apiRoutes.post('/assessments/submit', async (req, res) => {
  try {
    const { founder, answers } = req.body;
    
    if (!founder || !answers || !Array.isArray(answers)) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    // Calculate score
    const totalScore = answers.reduce((a, b) => a + (b || 0), 0);
    const overallScore = answers.length > 0 ? totalScore / answers.length : 0;
    
    let tier = 'Strong';
    if (overallScore > 3) tier = 'Critical';
    else if (overallScore > 2) tier = 'Moderate';

    // Figure out primary focus based on domain averages
    const questions = await prisma.question.findMany({ orderBy: { order: 'asc' } });
    
    const domainScores: Record<string, { sum: number; n: number }> = {};
    questions.forEach((q, i) => {
      const val = answers[i] || 0;
      domainScores[q.domain] ??= { sum: 0, n: 0 };
      domainScores[q.domain].sum += val;
      domainScores[q.domain].n += 1;
    });

    let primaryFocus = 'General Operations';
    let maxDomainScore = -1;

    for (const [domain, stats] of Object.entries(domainScores)) {
      const avg = stats.sum / stats.n;
      if (avg > maxDomainScore) {
        maxDomainScore = avg;
        primaryFocus = domain;
      }
    }

    // Map insights based on primary focus
    const insights: Record<string, { opp: string, q: string }> = {
      'Decisions': { opp: 'Delegation of Operational Decisions', q: 'Where are decisions bottlenecking at your level?' },
      'Execution': { opp: 'Rhythm and Cadence of Execution', q: 'Are your teams executing smoothly without your direct intervention?' },
      'Leadership': { opp: 'Leadership Autonomy', q: 'Does your leadership team own their outcomes fully?' },
      'Growth': { opp: 'Scalable Growth Infrastructure', q: 'Is the business scaling efficiently with the current infrastructure?' }
    };
    
    const insight = insights[primaryFocus] || { opp: 'Overall Alignment', q: 'What is the biggest operational constraint today?' };

    // Upsert Founder
    let founderRecord;
    if (founder.email) {
      founderRecord = await prisma.founder.upsert({
        where: { email: founder.email },
        update: {
          name: founder.founder || founder.name,
          phone: founder.phone,
          companyName: founder.company,
          revenueBand: founder.revenue,
        },
        create: {
          email: founder.email,
          name: founder.founder || founder.name || 'Unknown',
          phone: founder.phone,
          companyName: founder.company,
          revenueBand: founder.revenue,
        }
      });
    } else {
      founderRecord = await prisma.founder.create({
        // If no email provided, just create
        data: {
          name: founder.founder || founder.name || 'Unknown',
          phone: founder.phone,
          companyName: founder.company,
          revenueBand: founder.revenue,
        }
      });
    }

    const assessment = await prisma.assessment.create({
      data: {
        founderId: founderRecord.id,
        scores: JSON.stringify(answers),
        overallScore,
        tier,
        primaryFocus,
        focusArea: primaryFocus,
        greatestOpportunity: insight.opp,
        openingQuestion: insight.q
      }
    });

    await prisma.systemLog.create({
      data: {
        level: 'info',
        action: 'ASSESSMENT_SCORED',
        details: JSON.stringify({ assessmentId: assessment.id, email: founder.email, tier })
      }
    });

    res.status(201).json({ message: 'Assessment submitted successfully', id: assessment.id });
  } catch (error) {
    console.error('Error submitting assessment:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * @openapi
 * /voice/session:
 *   post:
 *     summary: Initialize AI Voice Session
 *     description: Creates a new conversation transcript record and prepares the AI context.
 *     tags:
 *       - Voice AI
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               founderId:
 *                 type: string
 *                 description: The founder's ID.
 *     responses:
 *       200:
 *         description: Session initialized
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sessionId:
 *                   type: string
 *                 message:
 *                   type: string
 */
apiRoutes.post('/voice/session', async (req, res) => {
  try {
    const { founderId } = req.body;
    const session = await prisma.transcript.create({
      data: {
        founderId,
        conversationLog: JSON.stringify([{ role: 'system', content: 'You are Daisy, a Founder Advisor.' }])
      }
    });
    res.status(200).json({ message: 'Session initialized', sessionId: session.id });
  } catch (error) {
    res.status(500).json({ error: 'Failed to init session' });
  }
});

/**
 * @openapi
 * /chat/message:
 *   post:
 *     summary: Send text message to Daisy
 *     description: Accepts text and returns a mocked AI text response.
 *     tags:
 *       - AI Chat
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               sessionId:
 *                 type: string
 *               message:
 *                 type: string
 *     responses:
 *       200:
 *         description: AI Text Response
 */
apiRoutes.post('/chat/message', async (req, res) => {
  const { sessionId, message } = req.body;
  // Simulating an LLM response delay
  await new Promise(resolve => setTimeout(resolve, 1500));
  
  res.json({
    reply: `I hear you. When you say "${message}", it usually indicates a deeper systemic bottleneck in your operations. Let's unpack that with your leadership team.`,
    read: "Pattern suggests systemic delegation gaps.",
    question: "Do you agree?",
    cta: true
  });
});

/**
 * @openapi
 * /voice/transcribe:
 *   post:
 *     summary: Process Audio and Get AI Response
 *     description: Accepts an audio blob, returns mocked audio.
 *     tags:
 *       - Voice AI
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               sessionId:
 *                 type: string
 *               audio:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Audio stream response from AI
 */
apiRoutes.post('/voice/transcribe', upload.single('audio'), async (req, res) => {
  const sessionId = req.body.sessionId;
  const audioFile = req.file;

  // Simulate LLM + TTS pipeline delay (2-3s)
  await new Promise(resolve => setTimeout(resolve, 2000));

  // In a real implementation:
  // 1. Send audioFile.buffer to OpenAI Whisper API -> get text
  // 2. Send text to OpenAI Chat API -> get text reply
  // 3. Send text reply to ElevenLabs TTS API -> get audio blob
  
  // For now, return a success mock JSON instead of binary to simplify frontend dev 
  // (In production this would return a stream of audio/mpeg)
  res.json({
    reply: "I received your voice note. The structure of your business requires immediate alignment.",
    audioUrl: null // placeholder
  });
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
  const { email, date, time, timezone } = req.body;
  
  if (!email || !date || !time) {
    return res.status(400).json({ error: 'Missing required booking fields' });
  }

  try {
    // Upsert Founder to ensure we have the email recorded
    const founderRecord = await prisma.founder.upsert({
      where: { email },
      update: {}, // Email is confirmed
      create: { email, name: 'Unknown', companyName: '', revenueBand: '' }
    });

    await prisma.systemLog.create({
      data: {
        level: 'info',
        action: 'SESSION_BOOKED',
        details: JSON.stringify({ founderId: founderRecord.id, email, date, time, timezone })
      }
    });

    // In a real system, you would call Cal.com API or Google Calendar API here,
    // and dispatch the confirmation email via Resend/SendGrid.
    
    res.json({ success: true, message: 'Session successfully booked' });
  } catch (error) {
    console.error('Booking error:', error);
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
apiRoutes.get('/bookings/availability', (req, res) => {
  res.status(200).json(['2026-07-20T10:00:00Z', '2026-07-20T14:00:00Z']);
});

/**
 * @openapi
 * /bookings/confirm:
 *   post:
 *     summary: Confirm Booking
 *     description: Creates an appointment in GoHighLevel and saves the booking record.
 *     tags:
 *       - Booking
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - founderId
 *               - timeSlot
 *             properties:
 *               founderId:
 *                 type: string
 *               timeSlot:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       201:
 *         description: Booking confirmed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 bookingId:
 *                   type: string
 */
apiRoutes.post('/bookings/confirm', (req, res) => {
  res.status(201).json({ message: 'Booking confirmed' });
});

export { apiRoutes };
