"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleConversationTurn = handleConversationTurn;
const client_1 = require("@prisma/client");
const openai_1 = __importDefault(require("openai"));
const secrets_1 = require("../secrets");
const daisyPrompt_1 = require("../../config/daisyPrompt");
const RuntimeManager_1 = require("./daisy/RuntimeManager");
const ContextBuilder_1 = require("./daisy/ContextBuilder");
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
async function handleConversationTurn(sessionId, userMessage) {
    if (!sessionId || sessionId === 'default-session') {
        throw new Error("FATAL: Attempted to process conversation turn with invalid or default session ID");
    }
    // Upstream noise & silence filter: discard empty turns without calling LLM or writing to database
    if (RuntimeManager_1.runtimeManager.shouldDropTurn(userMessage)) {
        console.log(`[RUNTIME GUARD] Dropping silence or ambient noise turn in handleConversationTurn: "${userMessage}"`);
        return { reply: "", read: "", question: "", cta: false };
    }
    // Turn Concurrency Lock: Ensure exactly one response is generated per speaker turn
    if (!RuntimeManager_1.runtimeManager.acquireTurnLock(sessionId)) {
        console.warn(`[RUNTIME GUARD] Turn in progress for ${sessionId}. Dropping duplicate/concurrent request.`);
        return { reply: "", read: "", question: "", cta: false };
    }
    try {
        const openai = await getOpenAI();
        if (!openai) {
            throw new Error("OpenAI not configured");
        }
        let transcript = await prisma.transcript.findUnique({
            where: { id: sessionId },
            include: {
                founder: {
                    include: { assessments: true }
                }
            }
        });
        if (!transcript) {
            throw new Error("Session not found");
        }
        const assessment = transcript.founder?.assessments?.[0];
        let messages = [];
        if (transcript.conversationLog) {
            try {
                messages = JSON.parse(transcript.conversationLog);
            }
            catch (e) {
                messages = [];
            }
        }
        // Initialize with system prompt if empty
        if (messages.length === 0) {
            const context = {
                lead_name: transcript.founder?.name || "Founder",
                company: transcript.founder?.companyName || "your company",
                revenue: transcript.founder?.revenueBand || "Unknown",
                stage: transcript.founder?.companyStage || "Unknown"
            };
            messages.push({ role: 'system', content: (0, daisyPrompt_1.getDaisySystemPrompt)(context) });
        }
        // Append new user message
        messages.push({ role: 'user', content: userMessage });
        // Compression / Summarization Strategy
        const MAX_MESSAGES = 20; // e.g. system prompt + 19 turns
        if (messages.length > MAX_MESSAGES) {
            // Exclude the first message (which is the system prompt)
            const systemPrompt = messages[0];
            // Take the oldest 10 messages that we want to summarize
            const messagesToSummarize = messages.slice(1, 11);
            // Keep the remaining recent messages
            const recentMessages = messages.slice(11);
            const summaryPrompt = "Summarize the following conversation context briefly, focusing on the founder's pain points, business details, goals, and emotional state. Be concise and factual.";
            const summaryCompletion = await openai.chat.completions.create({
                model: "gemini-flash-latest",
                messages: [
                    { role: "system", content: summaryPrompt },
                    { role: "user", content: JSON.stringify(messagesToSummarize) }
                ]
            });
            const summaryContext = summaryCompletion.choices[0].message.content || "No previous context available.";
            // Reconstruct the array: System Prompt -> Summary Context -> Recent Messages
            messages = [
                systemPrompt,
                { role: 'system', content: `[Previous Context: ${summaryContext}]` },
                ...recentMessages
            ];
        }
        const turnCount = messages.filter(m => m.role === 'user').length;
        const contextPackage = ContextBuilder_1.ContextBuilder.buildContextPackage({
            founderName: transcript.founder?.name || "Founder",
            companyName: transcript.founder?.companyName || "your company",
            assessment: assessment ? { ...assessment } : {},
            turnNumber: turnCount,
            userMessage: userMessage,
            history: messages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }))
        });
        const llmMessages = [...messages];
        llmMessages[llmMessages.length - 1] = {
            role: 'user',
            content: `${userMessage}\n\n${contextPackage}`
        };
        // Generate AI response with automatic retry loop & silent fallback regeneration (Zero Error Exposure)
        let aiResponseText = "{}";
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const completion = await openai.chat.completions.create({
                    model: "gemini-flash-latest",
                    messages: llmMessages,
                    response_format: { type: "json_object" }
                });
                aiResponseText = completion.choices[0].message.content || "{}";
                break;
            }
            catch (apiError) {
                console.error(`LLM completion attempt ${attempt} failed:`, apiError);
                if (attempt === 3) {
                    // Silent fallback regeneration from report data - NEVER expose connection/API errors to the founder
                    const focus = assessment?.primaryFocus || assessment?.focusArea || "Decision Load";
                    aiResponseText = JSON.stringify({
                        reply: `Your Founder Pressure Scan identified ${focus} as your most critical structural bottleneck. This indicates that major operational decisions continually route through you, creating delays at pivotal moments. Exploring the root cause behind this dynamic is what we examine during a Strategic Review with Lionel Eersteling.`,
                        chips: ["Why is this important?", "Explain bottlenecks", "Give me the big picture"],
                        cta: false
                    });
                }
                else {
                    await new Promise(r => setTimeout(r, 600 * attempt)); // Backoff wait before retry
                }
            }
        }
        let parsedResponse = {
            reply: "I understand.",
            read: "",
            question: "",
            chips: ["Why is this important?", "Explain bottlenecks", "Give me the big picture"],
            cta: false
        };
        try {
            const jsonOutput = JSON.parse(aiResponseText);
            parsedResponse = {
                reply: RuntimeManager_1.runtimeManager.sanitizeOutput(jsonOutput.reply || parsedResponse.reply),
                read: "",
                question: "",
                chips: Array.isArray(jsonOutput.chips) ? jsonOutput.chips : (!jsonOutput.cta ? ["Why is this important?", "Explain bottlenecks", "Give me the big picture"] : undefined),
                cta: Boolean(jsonOutput.cta)
            };
        }
        catch (e) {
            console.error("Failed to parse Daisy JSON:", e);
        }
        // PREMATURE BOOKING GUARD & INTENT OVERRIDE
        // For both Text and Voice, the Show Available Times button and chips are strictly forbidden
        // during introductory analysis or whenever cta is false, unless explicit scheduling is recommended or requested.
        const isExplicitBooking = /book|schedule|available times|review with lionel|calendar/i.test(userMessage.trim());
        const aiRecommendsBooking = /recommend.*strategic review|show available times.*button is now visible|help you book/i.test(parsedResponse.reply || "");
        if (turnCount < 3 && !isExplicitBooking && !aiRecommendsBooking) {
            parsedResponse.cta = false;
            parsedResponse.reply = parsedResponse.reply.replace(/The ['"]?Show Available Times['"]? button is now visible on your screen\.? Click it to open the calendar and choose your preferred time\.?/gi, "").trim();
            parsedResponse.reply = parsedResponse.reply.replace(/Please click ['"]?Show Available Times['"]? below to choose a time that works best for you\.?/gi, "").trim();
        }
        else if (isExplicitBooking || aiRecommendsBooking) {
            parsedResponse.cta = true;
        }
        // Ensure chips never contain calendar booking strings unless CTA is active
        if (!parsedResponse.cta && Array.isArray(parsedResponse.chips)) {
            parsedResponse.chips = parsedResponse.chips.filter((c) => !c.toLowerCase().includes("available times") && !c.toLowerCase().includes("book"));
            if (parsedResponse.chips.length === 0) {
                parsedResponse.chips = ["Why is this important?", "Explain bottlenecks", "Give me the big picture"];
            }
        }
        // Append AI response
        messages.push({ role: 'assistant', content: aiResponseText });
        // Save back to DB
        await prisma.transcript.update({
            where: { id: sessionId },
            data: { conversationLog: JSON.stringify(messages) }
        });
        return parsedResponse;
    }
    finally {
        RuntimeManager_1.runtimeManager.releaseTurnLock(sessionId);
    }
}
