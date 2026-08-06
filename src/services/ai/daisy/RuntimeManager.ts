import { DaisyState } from './ConversationStateMachine';
import { ResponseValidator } from './ResponseValidator';

export interface FounderSessionMemoryFlags {
  alreadyExplained: boolean;
  alreadyDiscussedBottlenecks: boolean;
  alreadyDiscussedPainPoints: boolean;
  alreadyDiscussedRecommendations: boolean;
  bookingRecommended: boolean;
  calendarOpened: boolean;
  bookingConfirmed: boolean;
}

export interface FounderSessionState {
  sessionId: string;
  conversationId: string;
  founderReport?: Record<string, any>;
  chatHistory: Array<{ role: string; content: string }>;
  conversationPhase: DaisyState;
  memoryFlags: FounderSessionMemoryFlags;
  isProcessingTurn: boolean;
  turnTimestamp?: number;
  lastAccessed: number;
}

/**
 * Voice conversational turn state machine.
 * Enforces rigid sequential transitions without self-looping or unsolicited AI chatter.
 */
export type VoiceTurnState = 'WAITING_FOR_USER' | 'USER_SPEAKING' | 'PROCESSING' | 'ASSISTANT_SPEAKING';

/**
 * Voice-specific session state for lifecycle management, deduplication, and turn tracking.
 * Kept separate from FounderSessionState to avoid polluting text-chat sessions.
 */
export interface VoiceSessionState {
  sessionId: string;
  lastUserSpeechTime: number;
  turnState: VoiceTurnState;       // Lifecycle: WAITING_FOR_USER -> USER_SPEAKING -> PROCESSING -> ASSISTANT_SPEAKING
  sentResponseHashes: Set<string>; // Deduplication: content hashes of all sent responses
  voiceTurnCount: number;          // Count of genuine voice turns (for booking timing)
  lastAssistantMessage: string;
  isGeneratingResponse: boolean;   // Concurrency flag
  waitingForUser: boolean;         // Conversation Lock: true when Daisy finishes speaking; blocks LLM calls until genuine user speech
  assistantStartSpeakingTime?: number;
  assistantFinishSpeakingTime?: number;
}

/**
 * Concurrent Multi-Tenant Session Runtime & State Machine Store.
 * Ensures strict isolation per founder without shared mutable globals.
 */
class ConcurrentRuntimeManager {
  private sessions = new Map<string, FounderSessionState>();
  private voiceSessions = new Map<string, VoiceSessionState>();
  private readonly TTL_MS = 1000 * 60 * 60 * 6; // 6-hour memory session retention
  private readonly TURN_LOCK_TIMEOUT_MS = 8000; // 8-second turn lock window

  public getSession(sessionId: string): FounderSessionState | undefined {
    this.cleanupExpired();
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastAccessed = Date.now();
    }
    return session;
  }

  public getOrCreateSession(sessionId: string, conversationId = sessionId): FounderSessionState {
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
    } else {
      session.lastAccessed = Date.now();
    }
    return session;
  }

  /**
   * Concurrency & Turn Lock: Prevents multiple concurrent responses per single user speaking turn
   */
  public acquireTurnLock(sessionId: string): boolean {
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

  public releaseTurnLock(sessionId: string): void {
    const session = this.getSession(sessionId);
    if (session) {
      session.isProcessingTurn = false;
    }
  }

  public setReport(sessionId: string, report: Record<string, any>): void {
    const session = this.getOrCreateSession(sessionId);
    session.founderReport = report;
  }

  public markCalendarOpened(sessionId: string): boolean {
    const session = this.getOrCreateSession(sessionId);
    if (session.memoryFlags.calendarOpened) {
      console.warn(`[Runtime Guard] show_calendar already triggered for session ${sessionId}. Suppressing repeat invocation.`);
      return false; // Already opened
    }
    session.memoryFlags.calendarOpened = true;
    session.conversationPhase = 'SHOW_CALENDAR_CALLED';
    return true;
  }

  public updatePhase(sessionId: string, newPhase: DaisyState): void {
    const session = this.getOrCreateSession(sessionId);
    session.conversationPhase = newPhase;
    // Advance matching session memory progress flags automatically upon state progression
    if (newPhase === 'OVERALL_SUMMARY' || newPhase === 'BIGGEST_PRESSURE') session.memoryFlags.alreadyExplained = true;
    if (newPhase === 'TOPIC_SELECTION' || newPhase === 'SHORT_EXPLANATION') session.memoryFlags.alreadyDiscussedBottlenecks = true;
    if (newPhase === 'TOPIC_QUESTIONS' || newPhase === 'NEXT_TOPIC_EXPLORATION') session.memoryFlags.alreadyDiscussedPainPoints = true;
    if (newPhase === 'UNDERSTANDING_ESTABLISHED') session.memoryFlags.alreadyDiscussedRecommendations = true;
    if (newPhase === 'STRATEGIC_REVIEW_RECOMMENDED') session.memoryFlags.bookingRecommended = true;
    if (newPhase === 'SHOW_CALENDAR_CALLED') session.memoryFlags.calendarOpened = true;
    if (newPhase === 'BOOKING_CONFIRMED') session.memoryFlags.bookingConfirmed = true;
  }

  /**
   * Output Sanitization & Chain-of-Thought Anti-Leakage Guard
   * Strips internal reasoning tags, stage directions, and planning prompts before reaching the user.
   */
  public sanitizeOutput(text?: string | null): string {
    if (!text) return "";
    let clean = text;

    // Strip <think>...</think> and <thought>...</thought> blocks
    clean = clean.replace(/<think>[\s\S]*?<\/think>/gi, '');
    clean = clean.replace(/<thought>[\s\S]*?<\/thought>/gi, '');

    // Strip stage directions like [calm], [pause], [thinking], [slow], [soft], [smiles], [Daisy's Read: ...]
    clean = clean.replace(/\[.*?\]/g, '');

    // Remove leaked internal reasoning sentences, system messages, or planning lines
    const lines = clean.split('\n').filter(line => {
      const trimmed = line.trim().toLowerCase();
      if (trimmed.startsWith('daisy\'s read:') || trimmed.startsWith('daisy thinks:')) return false;
      if (trimmed.startsWith('the user is silent') || trimmed.startsWith('the founder is silent')) return false;
      if (trimmed.startsWith('i should ') || trimmed.startsWith('i need to explain') || trimmed.startsWith('i will ')) return false;
      if (trimmed.startsWith('internal reasoning:') || trimmed.startsWith('analysis:') || trimmed.startsWith('system message:')) return false;
      if (trimmed.startsWith('planning:') || trimmed.startsWith('reasoning:')) return false;
      return true;
    });

    const rawSanitized = lines.join(' ').replace(/\s+/g, ' ').trim();
    const validation = ResponseValidator.validate(rawSanitized);
    if (!validation.passed && validation.interventions.length > 0) {
      console.log(`[ResponseValidator] Interventions executed:`, validation.interventions);
    }
    return validation.sanitizedText;
  }

  /**
   * Silence & Noise Pre-processing Filter
   * Intercepts and discards empty turns caused by silence, breathing, sighs, coughs, background conversations, keyboard taps, mouse clicks, micro-utterance filler, and STT pauses before reaching the LLM.
   */
  public shouldDropTurn(userMessage?: string | null): boolean {
    if (!userMessage) return true;
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

  public getVoiceState(sessionId: string): VoiceSessionState | undefined {
    return this.voiceSessions.get(sessionId);
  }

  public getOrCreateVoiceState(sessionId: string): VoiceSessionState {
    let state = this.voiceSessions.get(sessionId);
    if (!state) {
      state = {
        sessionId,
        lastUserSpeechTime: Date.now(),
        turnState: 'WAITING_FOR_USER',
        sentResponseHashes: new Set<string>(),
        voiceTurnCount: 0,
        lastAssistantMessage: '',
        isGeneratingResponse: false,
        waitingForUser: true,      // Set to true upon initialization (waiting for user input)
      };
      this.voiceSessions.set(sessionId, state);
    }
    return state;
  }

  public recordUserSpeech(sessionId: string): void {
    const state = this.getOrCreateVoiceState(sessionId);
    state.lastUserSpeechTime = Date.now();
    state.turnState = 'USER_SPEAKING';
    state.waitingForUser = false;
  }

  public setTurnState(sessionId: string, nextState: VoiceTurnState): void {
    const state = this.getOrCreateVoiceState(sessionId);
    state.turnState = nextState;
  }

  public markAssistantSpeaking(sessionId: string, responseText: string): void {
    const state = this.getOrCreateVoiceState(sessionId);
    state.turnState = 'ASSISTANT_SPEAKING';
    state.lastAssistantMessage = responseText;
    state.waitingForUser = false;
    state.assistantStartSpeakingTime = Date.now();
    this.recordSentResponse(sessionId, responseText);
  }

  public markAssistantFinishedSpeaking(sessionId: string): void {
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
  public isAssistantCurrentlySpeaking(sessionId: string, estimatedWords: number): boolean {
    const state = this.getVoiceState(sessionId);
    if (!state || state.turnState !== 'ASSISTANT_SPEAKING') return false;
    if (!state.assistantStartSpeakingTime) return false;
    // Estimate ~450ms per spoken word, with minimum 3000ms floor
    const estimatedDurationMs = Math.max(3000, estimatedWords * 450);
    return (Date.now() - state.assistantStartSpeakingTime) < estimatedDurationMs;
  }

  public getContentHash(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 200);
  }

  public isDuplicateResponse(sessionId: string, text: string): boolean {
    const state = this.getVoiceState(sessionId);
    if (!state) return false;
    const hash = this.getContentHash(text);
    return state.sentResponseHashes.has(hash);
  }

  public recordSentResponse(sessionId: string, text: string): void {
    const state = this.getOrCreateVoiceState(sessionId);
    const hash = this.getContentHash(text);
    if (hash) {
      state.sentResponseHashes.add(hash);
      state.voiceTurnCount++;
    }
  }

  private cleanupExpired(): void {
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

export const runtimeManager = new ConcurrentRuntimeManager();
