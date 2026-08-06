"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleVoiceConversationTurn = handleVoiceConversationTurn;
const client_1 = require("@prisma/client");
const openai_1 = __importDefault(require("openai"));
const secrets_1 = require("../secrets");
const PromptBuilder_1 = require("./daisy/PromptBuilder");
const RuntimeManager_1 = require("./daisy/RuntimeManager");
const prisma = new client_1.PrismaClient();
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
/**
 * Strip internal reasoning, chain-of-thought, stage directions, and system artifacts
 * from LLM output before it reaches TTS. Only the final spoken response must be delivered.
 */
function stripInternalReasoning(text) {
    let clean = text;
    // Strip <think>...</think> and <thought>...</thought> blocks
    clean = clean.replace(/<think>[\s\S]*?<\/think>/gi, '');
    clean = clean.replace(/<thought>[\s\S]*?<\/thought>/gi, '');
    // Strip stage directions like [calm], [pause], [thinking], [slow], [soft], [smiles]
    clean = clean.replace(/\[.*?\]/g, '');
    // Strip leaked internal reasoning lines
    const lines = clean.split('\n').filter(line => {
        const trimmed = line.trim().toLowerCase();
        if (!trimmed)
            return false;
        // Internal reasoning patterns
        if (trimmed.startsWith('daisy\'s read:') || trimmed.startsWith('daisy thinks:'))
            return false;
        if (trimmed.startsWith('the user is silent') || trimmed.startsWith('the founder is silent'))
            return false;
        if (trimmed.startsWith('the user responded with'))
            return false;
        if (trimmed.startsWith('my instructions state') || trimmed.startsWith('my instructions say'))
            return false;
        if (trimmed.startsWith('i should ') || trimmed.startsWith('i need to ') || trimmed.startsWith('i will '))
            return false;
        if (trimmed.startsWith('internal reasoning:') || trimmed.startsWith('analysis:') || trimmed.startsWith('system message:'))
            return false;
        if (trimmed.startsWith('planning:') || trimmed.startsWith('reasoning:') || trimmed.startsWith('note to self:'))
            return false;
        if (trimmed.startsWith('let me ') && (trimmed.includes('think') || trimmed.includes('check') || trimmed.includes('consider')))
            return false;
        // JSON output artifacts that leaked into voice
        if (trimmed.startsWith('{') && trimmed.includes('"reply"'))
            return false;
        if (trimmed.startsWith('"reply":') || trimmed.startsWith('"chips":') || trimmed.startsWith('"cta":'))
            return false;
        return true;
    });
    clean = lines.join(' ').replace(/\s+/g, ' ').trim();
    // Strip markdown asterisks
    clean = clean.replace(/\*\*Show Available Times\*\*/gi, "'Show Available Times'")
        .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
        .replace(/\*/g, "")
        .trim();
    return clean;
}
/**
 * Handle a voice conversation turn with voice-specific constraints:
 * - Plain text output (no JSON)
 * - Short 2-3 sentence responses
 * - Complete conversation history
 * - Internal reasoning stripping
 * - Response deduplication
 */
async function handleVoiceConversationTurn(sessionId, userMessage) {
    if (!sessionId || sessionId === 'default-session') {
        throw new Error("FATAL: Attempted to process voice turn with invalid session ID");
    }
    // Noise filter
    if (RuntimeManager_1.runtimeManager.shouldDropTurn(userMessage)) {
        console.log(`[VOICE MEMORY] Dropping noise/silence: "${userMessage}"`);
        return { reply: "", cta: false };
    }
    // Turn concurrency lock
    if (!RuntimeManager_1.runtimeManager.acquireTurnLock(sessionId)) {
        console.warn(`[VOICE MEMORY] Turn already in progress for ${sessionId}. Dropping.`);
        return { reply: "", cta: false };
    }
    try {
        const openai = await getOpenAI();
        if (!openai) {
            throw new Error("LLM not configured");
        }
        // Load session from database
        let transcript = await prisma.transcript.findUnique({
            where: { id: sessionId },
            include: {
                founder: {
                    include: { assessments: true }
                }
            }
        });
        if (!transcript) {
            throw new Error("Voice session not found");
        }
        const assessment = transcript.founder?.assessments?.[0];
        // Load conversation history
        let messages = [];
        if (transcript.conversationLog) {
            try {
                messages = JSON.parse(transcript.conversationLog);
            }
            catch (e) {
                messages = [];
            }
        }
        // Initialize with voice-specific system prompt if empty
        if (messages.length === 0) {
            const context = {
                lead_name: transcript.founder?.name || "Founder",
                company: transcript.founder?.companyName || "your company",
                revenue: transcript.founder?.revenueBand || "Unknown",
                stage: transcript.founder?.companyStage || "Unknown"
            };
            const systemPrompt = (0, PromptBuilder_1.buildDaisySystemPrompt)(context, 'voice');
            messages.push({ role: 'system', content: systemPrompt });
        }
        // Append user message
        messages.push({ role: 'user', content: userMessage });
        // Conversation history compression (keep system + last 18 turns)
        const MAX_MESSAGES = 20;
        if (messages.length > MAX_MESSAGES) {
            const systemPrompt = messages[0];
            const messagesToSummarize = messages.slice(1, 11);
            const recentMessages = messages.slice(11);
            try {
                const summaryCompletion = await openai.chat.completions.create({
                    model: "gemini-flash-latest",
                    messages: [
                        { role: "system", content: "Summarize this conversation briefly. Focus on: what topics were discussed, what the founder said, what was explained, and what stage the conversation reached. Be factual and concise." },
                        { role: "user", content: JSON.stringify(messagesToSummarize) }
                    ]
                });
                const summaryContext = summaryCompletion.choices[0].message.content || "";
                messages = [
                    systemPrompt,
                    { role: 'system', content: `[Previous conversation summary: ${summaryContext}]` },
                    ...recentMessages
                ];
            }
            catch (e) {
                // If summarization fails, just keep recent messages
                messages = [systemPrompt, ...messages.slice(-15)];
            }
        }
        // Generate voice response (plain text, NOT JSON)
        let aiResponseText = "";
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const completion = await openai.chat.completions.create({
                    model: "gemini-flash-latest",
                    messages: messages,
                    // No response_format: { type: "json_object" } — voice outputs plain text
                });
                aiResponseText = completion.choices[0].message.content || "";
                break;
            }
            catch (apiError) {
                console.error(`[VOICE MEMORY] LLM attempt ${attempt} failed:`, apiError);
                if (attempt === 3) {
                    const focus = assessment?.primaryFocus || assessment?.focusArea || "Decision Load";
                    aiResponseText = `Your Founder Pressure Scan identified ${focus} as your strongest pressure area. This means important decisions are still flowing through you before work can continue. I'd recommend exploring this further during a Strategic Review with Lionel Eersteling.`;
                }
                else {
                    await new Promise(r => setTimeout(r, 600 * attempt));
                }
            }
        }
        // Strip internal reasoning, stage directions, and formatting artifacts
        let reply = stripInternalReasoning(aiResponseText);
        // Run through ResponseValidator for tone, jargon, and scope checks
        reply = RuntimeManager_1.runtimeManager.sanitizeOutput(reply);
        // If reply is empty after sanitization, stay silent
        if (!reply || !reply.trim()) {
            return { reply: "", cta: false };
        }
        // Deduplication: check if this exact response was already sent
        if (RuntimeManager_1.runtimeManager.isDuplicateResponse(sessionId, reply)) {
            console.warn(`[VOICE MEMORY] Duplicate response detected and suppressed for session ${sessionId}`);
            return { reply: "", cta: false };
        }
        // Record this response hash and increment turn count
        RuntimeManager_1.runtimeManager.recordSentResponse(sessionId, reply);
        const voiceState = RuntimeManager_1.runtimeManager.getVoiceState(sessionId);
        // Detect CTA (booking recommendation)
        const cta = /show available times|book.*strategic review|schedule.*review|click it.*calendar/i.test(reply)
            && (voiceState ? voiceState.voiceTurnCount >= 3 : true);
        // Save conversation history
        messages.push({ role: 'assistant', content: reply });
        await prisma.transcript.update({
            where: { id: sessionId },
            data: { conversationLog: JSON.stringify(messages) }
        });
        return { reply, cta };
    }
    finally {
        RuntimeManager_1.runtimeManager.releaseTurnLock(sessionId);
    }
}
