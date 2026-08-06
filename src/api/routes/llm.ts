import { WebSocket, WebSocketServer } from 'ws';
import { handleVoiceConversationTurn } from '../../services/ai/voiceMemory';
import { runtimeManager } from '../../services/ai/daisy/RuntimeManager';

// ============================================================================
// DAISY VOICE PIPELINE — ELEVENLABS CUSTOM LLM WEBSOCKET ORCHESTRATOR
// ============================================================================
// Architecture:
//   ElevenLabs SDK (frontend) ↔ ElevenLabs Cloud (VAD + TTS) ↔ This WebSocket (LLM)
//
// Key constraints:
//   - ElevenLabs controls VAD server-side. We cannot prevent false voice triggers.
//   - When ElevenLabs sends user_message, it has ALREADY interrupted active TTS.
//   - Our strategy: drop noise silently (return nothing), never re-emit old messages,
//     enforce short responses, and manage idle state with progressive timeouts.
// ============================================================================

/**
 * Check if a user message is acoustic loopback (Daisy hearing her own speaker output).
 * Uses token overlap analysis to detect when the mic captures fragments of active speech.
 */
function isAcousticLoopback(userMessage: string, lastAssistantMessage: string): boolean {
  if (!userMessage || !lastAssistantMessage) return false;
  const userClean = userMessage.trim().toLowerCase();
  const lastClean = lastAssistantMessage.trim().toLowerCase();

  if (!userClean || !lastClean) return false;
  if (userClean === lastClean || lastClean.includes(userClean) || userClean.includes(lastClean)) {
    return true;
  }

  const extractTokens = (text: string) => text.match(/\b[a-z0-9]{3,}\b/g) || [];
  const userTokens = extractTokens(userClean);
  const lastTokens = new Set(extractTokens(lastClean));

  if (userTokens.length === 0) return false;

  let matchCount = 0;
  for (const token of userTokens) {
    if (lastTokens.has(token)) matchCount++;
  }

  const overlapRatio = matchCount / userTokens.length;
  return overlapRatio >= 0.5 && userTokens.length <= 15;
}

// Exported for test suite
export { isAcousticLoopback };

/**
 * Determine if a user message is genuine intentional speech vs. noise/echo/filler.
 */
export function isGenuineUserSpeech(
  userMessage: string,
  lastAssistantMessage: string,
  confidence?: number
): { genuine: boolean; reason?: string } {
  if (!userMessage || !userMessage.trim()) {
    return { genuine: false, reason: "Empty transcript" };
  }

  // Check low confidence STT (if confidence score is provided and extremely low)
  if (confidence !== undefined && typeof confidence === 'number' && confidence < 0.35) {
    return { genuine: false, reason: `Low STT confidence score (${confidence})` };
  }

  // Check noise/silence/filler patterns
  if (runtimeManager.shouldDropTurn(userMessage)) {
    return { genuine: false, reason: "Noise, silence, or micro-utterance filler" };
  }

  // Check acoustic loopback (Daisy hearing herself)
  if (isAcousticLoopback(userMessage, lastAssistantMessage)) {
    return { genuine: false, reason: "Acoustic loopback / speaker echo" };
  }

  return { genuine: true };
}

// ============================================================================
// ELEVENLABS VOICE WEBSOCKET ORCHESTRATOR — RIGID STATE MACHINE & TURN LOCKING
// ============================================================================

export function setupLlmWebSocket(wss: WebSocketServer) {
  wss.on('connection', (ws: WebSocket) => {
    console.log('[VOICE] WebSocket connected');
    let sessionId = 'default-session';

    ws.on('message', async (message: Buffer) => {
      try {
        const data = JSON.parse(message.toString());
        
        // Log incoming event types (filtering routine pings)
        if (data.type !== 'ping' && data.type !== 'pong') {
          console.log(`[VOICE INCOMING] Event Type: ${data.type}`);
        }

        if (data.type === 'conversation_initiation_metadata') {
          const payload = data.conversation_initiation_metadata_payload;
          sessionId = payload?.custom_llm_extra_body?.sessionId
                   || payload?.dynamic_variables?.sessionId
                   || payload?.custom_llm_args?.sessionId;

          if (!sessionId || sessionId === 'default-session') {
            console.error(`[VOICE FATAL] No valid sessionId in initiation payload:`, payload);
            ws.close(1008, "Valid sessionId is required");
            return;
          }

          console.log(`[VOICE] Session initialized: ${sessionId}`);
          runtimeManager.getOrCreateVoiceState(sessionId);
          
          // Initial greeting is spoken by ElevenLabs native configuration upon session connect.
          // Instantly enter ASSISTANT_SPEAKING state with estimated 5-second initial greeting window,
          // then automatically drop into strict WAITING_FOR_USER conversation lock.
          runtimeManager.markAssistantSpeaking(sessionId, "Hi Test0012, ready when you are.");
          console.log(`[VOICE STATE] Transition -> ASSISTANT_SPEAKING (initial greeting)`);
          console.log(`[VOICE] Assistant started speaking (initial greeting)`);
          
          setTimeout(() => {
            const current = runtimeManager.getVoiceState(sessionId);
            if (current && current.turnState === 'ASSISTANT_SPEAKING') {
              runtimeManager.markAssistantFinishedSpeaking(sessionId);
              console.log(`[VOICE STATE] Transition -> WAITING_FOR_USER (initial greeting completed)`);
              console.log(`[VOICE] Assistant finished speaking`);
              console.log(`[VOICE] Waiting for user input (WAITING_FOR_USER lock active)`);
            }
          }, 4500);
        }
        else if (data.type === 'user_message' || data.type === 'user_message_transcript') {
          if (!sessionId || sessionId === 'default-session') {
            console.error("[VOICE FATAL] User message without valid session. Dropping.");
            return;
          }

          const userText = (data.user_message || data.user_message_transcript || "").trim();
          const confidence = data.confidence !== undefined ? data.confidence : undefined;
          const voiceState = runtimeManager.getOrCreateVoiceState(sessionId);

          console.log(`[VOICE] Event: ${data.type}`);
          console.log(`[VOICE] User transcript received: "${userText}"`);
          if (confidence !== undefined) console.log(`[VOICE] Confidence: ${confidence}`);
          console.log(`[VOICE] Timestamp: ${new Date().toISOString()}`);
          console.log(`[VOICE] Current Turn State: ${voiceState.turnState}`);

          // ── TTS COMPLETION & ACTIVE SPEECH GUARD (Problem 3 & 7) ──
          // If Daisy is currently in ASSISTANT_SPEAKING within estimated vocal duration, ignore interrupting packets
          const approxWords = voiceState.lastAssistantMessage ? voiceState.lastAssistantMessage.split(/\s+/).length : 20;
          if (runtimeManager.isAssistantCurrentlySpeaking(sessionId, approxWords)) {
            console.log(`[VOICE GUARD] Transcript received while Daisy is actively speaking over TTS -> ignored to prevent self-interruption.`);
            return;
          }

          // ── SPEECH VALIDATION & CONVERSATION LOCK ENFORCEMENT ──
          const speechCheck = isGenuineUserSpeech(userText, voiceState.lastAssistantMessage, confidence);
          if (!speechCheck.genuine) {
            console.log(`[VOICE GUARD] Transcript dropped (${speechCheck.reason})`);
            if (voiceState.waitingForUser || voiceState.turnState === 'WAITING_FOR_USER') {
              console.log(`[VOICE STATE] Remaining in WAITING_FOR_USER lock. Consecutive assistant speech strictly prohibited.`);
            }
            // Return NOTHING. Do not call LLM. Do not transmit assistant_message.
            return;
          }

          // ── CONCURRENCY GUARD ──
          if (voiceState.isGeneratingResponse || voiceState.turnState === 'PROCESSING') {
            console.warn(`[VOICE GUARD] Turn currently PROCESSING for ${sessionId}. Dropping concurrent transcript packet.`);
            return;
          }

          // ── GENUINE SPEECH ACCEPTED: Step 1: USER_SPEAKING -> Step 2: PROCESSING ──
          runtimeManager.recordUserSpeech(sessionId); // Transitions to USER_SPEAKING, waitingForUser = false
          console.log(`[VOICE STATE] Transition -> USER_SPEAKING (genuine input accepted: "${userText}")`);
          
          runtimeManager.setTurnState(sessionId, 'PROCESSING');
          voiceState.isGeneratingResponse = true;
          console.log(`[VOICE STATE] Transition -> PROCESSING (calling LLM)`);
          console.log(`[VOICE] Calling LLM`);

          try {
            const response = await handleVoiceConversationTurn(sessionId, userText);

            if (response.reply && response.reply.trim()) {
              // ── DUPLICATE TRANSMISSION PROTECTION (Problem 4) ──
              if (runtimeManager.isDuplicateResponse(sessionId, response.reply)) {
                console.warn(`[VOICE GUARD] Duplicate response detected at WebSocket transmission layer -> suppressing speech.`);
                runtimeManager.markAssistantFinishedSpeaking(sessionId);
                console.log(`[VOICE STATE] Transition -> WAITING_FOR_USER lock re-engaged (duplicate suppressed)`);
                return;
              }

              // Step 3: ASSISTANT_SPEAKING
              runtimeManager.markAssistantSpeaking(sessionId, response.reply);
              console.log(`[VOICE STATE] Transition -> ASSISTANT_SPEAKING (${response.reply.split(/\s+/).length} words)`);
              console.log(`[VOICE] Sending assistant response (${response.reply.split(/\s+/).length} words)`);
              console.log(`[VOICE] Assistant started speaking`);
              
              ws.send(JSON.stringify({
                type: 'assistant_message',
                message: {
                  role: 'assistant',
                  content: response.reply
                }
              }));

              // Handle CTA button flag without interrupting audio delivery
              if (response.cta) {
                runtimeManager.markCalendarOpened(sessionId);
                console.log(`[VOICE] CTA flagged; UI sync via transcript observer.`);
              }

              // Step 4: Automated TTS Completion Lifecycle -> Return to WAITING_FOR_USER (Problem 3 & 7)
              const wordCount = response.reply.split(/\s+/).length;
              const estimatedAudioDurationMs = Math.max(3000, wordCount * 450);
              
              setTimeout(() => {
                const current = runtimeManager.getVoiceState(sessionId);
                if (current && current.turnState === 'ASSISTANT_SPEAKING') {
                  runtimeManager.markAssistantFinishedSpeaking(sessionId);
                  console.log(`[VOICE STATE] Transition -> ASSISTANT_SPEAKING completed -> WAITING_FOR_USER lock re-engaged`);
                  console.log(`[VOICE] Assistant finished speaking`);
                  console.log(`[VOICE] Waiting for user input (WAITING_FOR_USER lock active)`);
                }
              }, estimatedAudioDurationMs);

            } else {
              // If reply was suppressed/empty by LLM filters, revert straight to waiting state
              runtimeManager.markAssistantFinishedSpeaking(sessionId);
              console.log(`[VOICE STATE] Transition -> WAITING_FOR_USER (LLM reply suppressed)`);
              console.log(`[VOICE] Waiting for user input`);
            }
          } finally {
            voiceState.isGeneratingResponse = false;
          }
        }
        else {
          const currentState = runtimeManager.getVoiceState(sessionId)?.turnState || 'WAITING_FOR_USER';
          console.log(`[VOICE] Unhandled event type (${data.type}) received; ignoring in ${currentState} state.`);
        }
      } catch (err) {
        console.error('[VOICE] WebSocket error:', err);
        const voiceState = runtimeManager.getVoiceState(sessionId);
        if (voiceState) {
          runtimeManager.markAssistantFinishedSpeaking(sessionId);
        }
      }
    });

    ws.on('close', () => {
      console.log(`[VOICE] WebSocket disconnected: ${sessionId}`);
      console.log(`[VOICE] Session ended`);
    });
  });
}
