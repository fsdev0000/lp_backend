"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.apiRoutes = void 0;
const express_1 = require("express");
const client_1 = require("@prisma/client");
const multer_1 = __importDefault(require("multer"));
const ghl_1 = require("../../services/ghl");
const email_1 = require("../../services/email");
const elevenlabs_1 = require("elevenlabs");
const memory_1 = require("../../services/ai/memory");
const openai_1 = __importDefault(require("openai"));
const secrets_1 = require("../../services/secrets");
let elevenlabsClient = null;
async function getElevenLabs() {
    if (elevenlabsClient)
        return elevenlabsClient;
    const key = await (0, secrets_1.getSecret)('ELEVENLABS_API_KEY');
    if (key)
        elevenlabsClient = new elevenlabs_1.ElevenLabsClient({ apiKey: key });
    return elevenlabsClient;
}
let openaiClient = null;
async function getOpenAI() {
    if (openaiClient)
        return openaiClient;
    const key = await (0, secrets_1.getSecret)('OPENAI_API_KEY') || await (0, secrets_1.getSecret)('GEMINI_API_KEY') || process.env.GEMINI_API_KEY;
    if (key) {
        openaiClient = new openai_1.default({
            apiKey: key,
            baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/"
        });
    }
    return openaiClient;
}
const upload = (0, multer_1.default)();
const prisma = new client_1.PrismaClient();
const apiRoutes = (0, express_1.Router)();
exports.apiRoutes = apiRoutes;
/**
 * @openapi
 * /voice/transcribe:
 *   post:
 *     summary: Transcribe audio to text
 *     description: Accepts an audio file upload and returns the transcribed text.
 *     tags:
 *       - Voice AI
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               audio:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Transcribed text
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 transcript:
 *                   type: string
 */
apiRoutes.post('/voice/transcribe', upload.single('audio'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No audio file provided' });
        }
        const audioBase64 = req.file.buffer.toString('base64');
        const mimeType = req.file.mimetype || 'audio/webm';
        const geminiKey = await (0, secrets_1.getSecret)('GEMINI_API_KEY') || await (0, secrets_1.getSecret)('OPENAI_API_KEY') || process.env.GEMINI_API_KEY;
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
    }
    catch (error) {
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
    }
    catch (error) {
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
        const transcript = await prisma.transcript.findUnique({
            where: { id: sessionId },
            include: { founder: true }
        });
        if (!transcript) {
            return res.status(404).json({ error: 'Session not found' });
        }
        const assessment = await prisma.assessment.findFirst({
            where: { founderId: transcript.founderId },
            orderBy: { createdAt: 'desc' }
        });
        if (!assessment) {
            return res.status(404).json({ error: 'Assessment not found' });
        }
        res.json({
            answers: JSON.parse(assessment.scores || '[]'),
            founder: {
                name: transcript.founder.name,
                company: transcript.founder.companyName || '',
                email: transcript.founder.email || '',
                phone: transcript.founder.phone || '',
                revenue: transcript.founder.revenueBand || '',
            }
        });
    }
    catch (error) {
        console.error('Error fetching session:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
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
        if (overallScore > 3)
            tier = 'Critical';
        else if (overallScore > 2)
            tier = 'Moderate';
        // Figure out primary focus based on domain averages
        const questions = await prisma.question.findMany({ orderBy: { order: 'asc' } });
        const domainScores = {};
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
        const insights = {
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
        }
        else {
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
        const transcript = await prisma.transcript.create({
            data: {
                founderId: founderRecord.id
            }
        });
        // --- GHL & Email Integration ---
        if (founder.email) {
            try {
                const contactId = await (0, ghl_1.upsertContact)({
                    email: founder.email,
                    firstName: founder.founder || founder.name,
                    phone: founder.phone,
                    tags: ['Founder Pressure Scan']
                });
                if (contactId) {
                    await (0, ghl_1.createOpportunity)(contactId, `Founder Pressure Scan - ${founder.founder || founder.name}`);
                    await (0, email_1.sendAssessmentEmail)(contactId, {
                        tier,
                        firstName: founder.founder || founder.name,
                        score: Math.round((overallScore / 4) * 100),
                        sessionId: transcript.id,
                    });
                    const admin1Id = await (0, ghl_1.upsertContact)({ email: 'info@leadersperformance.ae', firstName: 'Internal', tags: ['lp-staff'] });
                    const admin2Id = await (0, ghl_1.upsertContact)({ email: 'lionel@leadersperformance.ae', firstName: 'Internal', tags: ['lp-staff'] });
                    await (0, email_1.sendAdminBriefing)({
                        name: founder.founder || founder.name,
                        email: founder.email,
                        score: Math.round((overallScore / 4) * 100),
                        tier,
                        company: founder.company,
                        phone: founder.phone,
                        primary_focus: primaryFocus,
                        focus_area: primaryFocus,
                        greatest_opportunity: insight.opp,
                        opening_question: insight.q
                    }, [admin1Id, admin2Id]);
                }
            }
            catch (ghlError) {
                console.error('GHL integration failed (non-fatal):', ghlError);
            }
        }
        // ---------------------------------
        await prisma.systemLog.create({
            data: {
                level: 'info',
                action: 'ASSESSMENT_SCORED',
                details: JSON.stringify({ assessmentId: assessment.id, email: founder.email, tier })
            }
        });
        res.status(201).json({ message: 'Assessment submitted successfully', id: assessment.id, sessionId: transcript.id });
    }
    catch (error) {
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
apiRoutes.post('/chat/init', async (req, res) => {
    try {
        const { founder } = req.body;
        let founderRecord;
        if (founder.email) {
            founderRecord = await prisma.founder.upsert({
                where: { email: founder.email },
                update: {
                    name: founder.founder || founder.name,
                    phone: founder.phone,
                    companyName: founder.company,
                    revenueBand: founder.revenue,
                    stage: founder.stage || founder.companyStage,
                },
                create: {
                    email: founder.email,
                    name: founder.founder || founder.name || 'Unknown',
                    phone: founder.phone,
                    companyName: founder.company,
                    revenueBand: founder.revenue,
                    stage: founder.stage || founder.companyStage,
                }
            });
        }
        else {
            founderRecord = await prisma.founder.create({
                data: {
                    name: founder.founder || founder.name || 'Unknown',
                    phone: founder.phone,
                    companyName: founder.company,
                    revenueBand: founder.revenue,
                    stage: founder.stage || founder.companyStage,
                }
            });
        }
        const session = await prisma.transcript.create({
            data: {
                founderId: founderRecord.id
            }
        });
        res.status(200).json({ message: 'Session initialized', sessionId: session.id });
    }
    catch (error) {
        console.error(error);
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
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId is required' });
    }
    try {
        const aiResponse = await (0, memory_1.handleConversationTurn)(sessionId, message || req.body.text);
        return res.json(aiResponse);
    }
    catch (e) {
        console.error('Chat Error:', e);
        return res.status(500).json({ error: 'Failed to process message' });
    }
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
apiRoutes.post('/voice/tts', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text)
            return res.status(400).json({ error: 'text is required' });
        // Use voice ID from vault if available, otherwise default to a standard voice
        const voiceId = await (0, secrets_1.getSecret)('ELEVENLABS_VOICE_ID') || process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
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
    }
    catch (e) {
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
    const { email, date, time, timezone, name, phone } = req.body;
    if (!email || !date || !time) {
        return res.status(400).json({ error: 'Missing required booking fields' });
    }
    try {
        const founderRecord = await prisma.founder.upsert({
            where: { email },
            update: {},
            create: { email, name: name || 'Unknown', phone: phone || '' }
        });
        const contactId = await (0, ghl_1.upsertContact)({
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
            if (modifier === 'PM' && hours < 12)
                hours += 12;
            if (modifier === 'AM' && hours === 12)
                hours = 0;
            formattedTime = `${hours.toString().padStart(2, '0')}:${minutes}`;
        }
        const dateTimeStr = `${date}T${formattedTime}:00`;
        await (0, ghl_1.bookAppointment)(contactId, dateTimeStr, `Strategy Session - ${name || email}`);
        await prisma.systemLog.create({
            data: {
                level: 'info',
                action: 'SESSION_BOOKED',
                details: JSON.stringify({ founderId: founderRecord.id, email, date, time, timezone })
            }
        });
        // Emit event to connected clients for real-time update
        const io = req.app.get('io');
        if (io) {
            io.emit('booking_updated', { date });
        }
        res.json({ success: true, message: 'Session successfully booked' });
    }
    catch (error) {
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
apiRoutes.get('/bookings/availability', async (req, res) => {
    try {
        const date = req.query.date || new Date().toISOString().split('T')[0];
        const slots = await (0, ghl_1.getFreeSlots)(date);
        res.status(200).json(slots);
    }
    catch (error) {
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
        const year = parseInt(req.query.year);
        const month = parseInt(req.query.month); // 1-12
        if (!year || !month)
            return res.status(400).json({ error: 'Year and month required' });
        const availability = await (0, ghl_1.getMonthAvailability)(year, month);
        res.status(200).json(availability);
    }
    catch (error) {
        console.error('Failed to get month availability:', error);
        res.status(500).json({ error: 'Failed to fetch month availability' });
    }
});
