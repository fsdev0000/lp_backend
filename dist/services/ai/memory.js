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
    // Generate AI response
    const completion = await openai.chat.completions.create({
        model: "gemini-flash-latest",
        messages: messages,
        response_format: { type: "json_object" }
    });
    const aiResponseText = completion.choices[0].message.content || "{}";
    let parsedResponse = {
        reply: "I understand.",
        read: "System analyzing.",
        question: "Shall we continue?",
        cta: false
    };
    try {
        parsedResponse = JSON.parse(aiResponseText);
    }
    catch (e) {
        console.error("Failed to parse Daisy JSON:", e);
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
