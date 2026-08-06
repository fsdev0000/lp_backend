"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runtimeManager = void 0;
const ResponseValidator_1 = require("./ResponseValidator");
/**
 * Concurrent Multi-Tenant Session Runtime & State Machine Store.
 * Ensures strict isolation per founder without shared mutable globals.
 */
class ConcurrentRuntimeManager {
    sessions = new Map();
    voiceSessions = new Map();
    TTL_MS = 1000 * 60 * 60 * 6; // 6-hour memory session retention
    TURN_LOCK_TIMEOUT_MS = 8000; // 8-second turn lock window
    getSession(sessionId) {
        this.cleanupExpired();
        const session = this.sessions.get(sessionId);
        if (session) {
            session.lastAccessed = Date.now();
        }
        return session;
    }
    getOrCreateSession(sessionId, conversationId = sessionId) {
        this.cleanupExpired();
        let session = this.sessions.get(sessionId);
        if (!session) {
            session = {
                sessionId,
                conversationId,
                chatHistory: [],
                conversationPhase: 'WELCOME',
                memoryFlags: {
                    alreadyExplained: false,
                    alreadyDiscussedBottlenecks: false,
                    alreadyDiscussedPainPoints: false,
                    alreadyDiscussedRecommendations: false,
                    bookingRecommended: false,
                    calendarOpened: false,
                    bookingConfirmed: false,
                },
                isProcessingTurn: false,
                lastAccessed: Date.now(),
            };
            this.sessions.set(sessionId, session);
        }
        else {
            session.lastAccessed = Date.now();
        }
        return session;
    }
    /**
     * Concurrency & Turn Lock: Prevents multiple concurrent responses per single user speaking turn
     */
    acquireTurnLock(sessionId) {
        const session = this.getOrCreateSession(sessionId);
        const now = Date.now();
        if (session.isProcessingTurn && session.turnTimestamp && (now - session.turnTimestamp < this.TURN_LOCK_TIMEOUT_MS)) {
            console.warn(`[RUNTIME TURN LOCK] Suppressing duplicate concurrent turn for session ${sessionId}.`);
            return false; // Turn already in progress
        }
        session.isProcessingTurn = true;
        session.turnTimestamp = now;
        return true;
    }
    releaseTurnLock(sessionId) {
        const session = this.getSession(sessionId);
        if (session) {
            session.isProcessingTurn = false;
        }
    }
    setReport(sessionId, report) {
        const session = this.getOrCreateSession(sessionId);
        session.founderReport = report;
    }
    markCalendarOpened(sessionId) {
        const session = this.getOrCreateSession(sessionId);
        if (session.memoryFlags.calendarOpened) {
            console.warn(`[Runtime Guard] show_calendar already triggered for session ${sessionId}. Suppressing repeat invocation.`);
            return false; // Already opened
        }
        session.memoryFlags.calendarOpened = true;
        session.conversationPhase = 'WAITING_FOR_FOUNDER';
        return true;
    }
    updatePhase(sessionId, newPhase) {
        const session = this.getOrCreateSession(sessionId);
        session.conversationPhase = newPhase;
        // Advance matching session memory progress flags automatically upon state progression
        if (newPhase === 'OVERALL_SUMMARY' || newPhase === 'BIGGEST_PRESSURE')
            session.memoryFlags.alreadyExplained = true;
        if (newPhase === 'TOPIC_SELECTION' || newPhase === 'SHORT_EXPLANATION')
            session.memoryFlags.alreadyDiscussedBottlenecks = true;
        if (newPhase === 'TOPIC_QUESTIONS' || newPhase === 'NEXT_TOPIC_EXPLORATION')
            session.memoryFlags.alreadyDiscussedPainPoints = true;
        if (newPhase === 'UNDERSTANDING_ESTABLISHED')
            session.memoryFlags.alreadyDiscussedRecommendations = true;
        if (newPhase === 'STRATEGIC_REVIEW_RECOMMENDED')
            session.memoryFlags.bookingRecommended = true;
        if (newPhase === 'WAITING_FOR_FOUNDER' || newPhase === 'SHOW_CALENDAR_CALLED')
            session.memoryFlags.calendarOpened = true;
        if (newPhase === 'BOOKING_CONFIRMED')
            session.memoryFlags.bookingConfirmed = true;
    }
    /**
     * Output Sanitization & Chain-of-Thought Anti-Leakage Guard
     * Strips internal reasoning tags, stage directions, and planning prompts before reaching the user.
     */
    sanitizeOutput(text) {
        if (!text)
            return "";
        let clean = text;
        // Strip <think>...</think> and <thought>...</thought> blocks
        clean = clean.replace(/<think>[\s\S]*?<\/think>/gi, '');
        clean = clean.replace(/<thought>[\s\S]*?<\/thought>/gi, '');
        // Strip stage directions like [calm], [pause], [thinking], [slow], [soft], [smiles], [Daisy's Read: ...]
        clean = clean.replace(/\[.*?\]/g, '');
        // Remove leaked internal reasoning sentences, system messages, or planning lines
        const lines = clean.split('\n').filter(line => {
            const trimmed = line.trim().toLowerCase();
            if (trimmed.startsWith('daisy\'s read:') || trimmed.startsWith('daisy thinks:'))
                return false;
            if (trimmed.startsWith('the user is silent') || trimmed.startsWith('the founder is silent'))
                return false;
            if (trimmed.startsWith('i should ') || trimmed.startsWith('i need to explain') || trimmed.startsWith('i will '))
                return false;
            if (trimmed.startsWith('internal reasoning:') || trimmed.startsWith('analysis:') || trimmed.startsWith('system message:'))
                return false;
            if (trimmed.startsWith('planning:') || trimmed.startsWith('reasoning:'))
                return false;
            return true;
        });
        const rawSanitized = lines.join(' ').replace(/\s+/g, ' ').trim();
        const validation = ResponseValidator_1.ResponseValidator.validate(rawSanitized);
        if (!validation.passed && validation.interventions.length > 0) {
            console.log(`[ResponseValidator] Interventions executed:`, validation.interventions);
        }
        return validation.sanitizedText;
    }
    /**
     * Silence & Noise Pre-processing Filter
     * Intercepts and discards empty turns caused by silence, breathing, sighs, coughs, background conversations, keyboard taps, mouse clicks, micro-utterance filler, and STT pauses before reaching the LLM.
     */
    shouldDropTurn(userMessage) {
        if (!userMessage)
            return true;
        const rawTrimmed = userMessage.trim().toLowerCase();
        const clean = rawTrimmed.replace(/[^a-z0-9\s]/g, '').trim();
        // Empty or punctuation-only STT artifacts (e.g. '...', '..', '.', '', etc.)
        if (rawTrimmed === '' || /^[\s.?!,\-_~]+$/.test(rawTrimmed)) {
            return true;
        }
        // Explicit audio transcript noise & ambient distraction tags
        const ignoredTags = [
            '[silence]', '(silence)',
            '[breathing]', '(breathing)',
            '[sigh]', '(sigh)', '[sighs]',
            '[cough]', '(cough)', '[coughs]',
            '[noise]', '(noise)', '[background noise]',
            '[background conversation]', '(background conversation)',
            '[keyboard sounds]', '(keyboard typing)', '[typing]',
            '[mouse clicks]', '(mouse clicks)', '[clicking]',
            '[laughter]', '(laughs)', '[inaudible]', '[partial speech]', '[unclear]', '[filler words]'
        ];
        if (ignoredTags.includes(rawTrimmed) || ignoredTags.some(tag => rawTrimmed === tag)) {
            return true;
        }
        // Micro-utterance STT false triggers & conversational hesitation fillers
        // ElevenLabs often transcribes 'mm', 'mhm', 'yeah...', 'okay...', 'ok', 'right', 'uh-huh' during pauses or active listening
        const ignoredFillers = new Set([
            'hm', 'hmm', 'uh', 'um', 'ah', 'er', 'eh',
            'mm', 'mmm', 'mhm', 'mh-mm', 'uh-huh', 'uhhuh',
            'yeah', 'yes', 'yep', 'yup', 'okay', 'ok', 'right', 'sure',
            'yeah okay', 'oh okay', 'mhm yeah', 'yeah right', 'ok sure', 'yes okay'
        ]);
        if (ignoredFillers.has(clean) || ignoredFillers.has(rawTrimmed)) {
            return true;
        }
        // Any short micro-utterance (<= 2 characters) except explicit commands
        if (clean.length <= 2) {
            return true;
        }
        return false;
    }
    // ---- Voice Session State Management ----
    getVoiceState(sessionId) {
        return this.voiceSessions.get(sessionId);
    }
    getOrCreateVoiceState(sessionId) {
        let state = this.voiceSessions.get(sessionId);
        if (!state) {
            state = {
                sessionId,
                lastUserSpeechTime: Date.now(),
                turnState: 'WAITING_FOR_USER',
                sentResponseHashes: new Set(),
                voiceTurnCount: 0,
                lastAssistantMessage: '',
                isGeneratingResponse: false,
                waitingForUser: true, // Set to true upon initialization (waiting for user input)
            };
            this.voiceSessions.set(sessionId, state);
        }
        return state;
    }
    recordUserSpeech(sessionId) {
        const state = this.getOrCreateVoiceState(sessionId);
        state.lastUserSpeechTime = Date.now();
        state.turnState = 'USER_SPEAKING';
        state.waitingForUser = false;
    }
    setTurnState(sessionId, nextState) {
        const state = this.getOrCreateVoiceState(sessionId);
        state.turnState = nextState;
    }
    markAssistantSpeaking(sessionId, responseText) {
        const state = this.getOrCreateVoiceState(sessionId);
        state.turnState = 'ASSISTANT_SPEAKING';
        state.lastAssistantMessage = responseText;
        state.waitingForUser = false;
        state.assistantStartSpeakingTime = Date.now();
        this.recordSentResponse(sessionId, responseText);
    }
    markAssistantFinishedSpeaking(sessionId) {
        const state = this.getOrCreateVoiceState(sessionId);
        state.turnState = 'WAITING_FOR_USER';
        state.waitingForUser = true;
        state.isGeneratingResponse = false;
        state.assistantFinishSpeakingTime = Date.now();
    }
    /**
     * Determine if Daisy is likely currently delivering speech over TTS,
     * protecting against interrupting her own active response window.
     */
    isAssistantCurrentlySpeaking(sessionId, estimatedWords) {
        const state = this.getVoiceState(sessionId);
        if (!state || state.turnState !== 'ASSISTANT_SPEAKING')
            return false;
        if (!state.assistantStartSpeakingTime)
            return false;
        // Estimate ~450ms per spoken word, with minimum 3000ms floor
        const estimatedDurationMs = Math.max(3000, estimatedWords * 450);
        return (Date.now() - state.assistantStartSpeakingTime) < estimatedDurationMs;
    }
    getContentHash(text) {
        return text.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 200);
    }
    isDuplicateResponse(sessionId, text) {
        const state = this.getVoiceState(sessionId);
        if (!state)
            return false;
        const hash = this.getContentHash(text);
        return state.sentResponseHashes.has(hash);
    }
    recordSentResponse(sessionId, text) {
        const state = this.getOrCreateVoiceState(sessionId);
        const hash = this.getContentHash(text);
        if (hash) {
            state.sentResponseHashes.add(hash);
            state.voiceTurnCount++;
        }
    }
    cleanupExpired() {
        const now = Date.now();
        for (const [sid, session] of this.sessions.entries()) {
            if (now - session.lastAccessed > this.TTL_MS) {
                this.sessions.delete(sid);
            }
        }
        for (const [sid, state] of this.voiceSessions.entries()) {
            if (now - state.lastUserSpeechTime > this.TTL_MS) {
                this.voiceSessions.delete(sid);
            }
        }
    }
}
exports.runtimeManager = new ConcurrentRuntimeManager();
