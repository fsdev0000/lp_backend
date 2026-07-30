import { PrismaClient } from '@prisma/client';
import OpenAI from 'openai';
import { getSecret } from '../secrets';
import { getDaisySystemPrompt, DaisyContext } from '../../config/daisyPrompt';

const prisma = new PrismaClient();

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

export type Message = {
    role: 'system' | 'user' | 'assistant';
    content: string;
};

export async function handleConversationTurn(sessionId: string, userMessage: string): Promise<any> {
    if (!sessionId || sessionId === 'default-session') {
        throw new Error("FATAL: Attempted to process conversation turn with invalid or default session ID");
    }

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

    let messages: Message[] = [];
    if (transcript.conversationLog) {
        try {
            messages = JSON.parse(transcript.conversationLog);
        } catch (e) {
            messages = [];
        }
    }

    // Initialize with system prompt if empty
    if (messages.length === 0) {
        const context: DaisyContext = {
            lead_name: transcript.founder?.name || "Founder",
            company: transcript.founder?.companyName || "your company",
            revenue: (transcript.founder as any)?.revenueBand || "Unknown",
            stage: (transcript.founder as any)?.companyStage || "Unknown"
        };
        messages.push({ role: 'system', content: getDaisySystemPrompt(context) });
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
    } catch (e) {
        console.error("Failed to parse Daisy JSON:", e);
    }
    
    // DEMO OVERRIDE: Force CTA if user explicitly asks to book
    if (userMessage.toLowerCase().includes('book a strategic review') || userMessage.toLowerCase().includes('available times')) {
        parsedResponse.cta = true;
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
