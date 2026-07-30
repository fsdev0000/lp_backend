import { WebSocket, WebSocketServer } from 'ws';
import { handleConversationTurn } from '../../services/ai/memory';

export function setupLlmWebSocket(wss: WebSocketServer) {
  wss.on('connection', (ws: WebSocket) => {
    console.log('ElevenLabs Custom LLM connected');
    let sessionId = 'default-session';
    let lastAssistantMessage = '';

    ws.on('message', async (message: Buffer) => {
      try {
        const data = JSON.parse(message.toString());

        if (data.type === 'conversation_initiation_metadata') {
          // Extract sessionId passed from frontend
          const payload = data.conversation_initiation_metadata_payload;
          sessionId = payload?.custom_llm_extra_body?.sessionId 
                   || payload?.dynamic_variables?.sessionId 
                   || payload?.custom_llm_args?.sessionId;

          if (!sessionId || sessionId === 'default-session') {
            console.error(`[FATAL] ElevenLabs session initialized without a valid sessionId! Preventing cross-user contamination. Payload:`, payload);
            ws.close(1008, "Valid sessionId is required");
            return;
          }

          console.log(`ElevenLabs session initialized: ${sessionId}`);
        } 
        else if (data.type === 'user_message') {
          if (!sessionId || sessionId === 'default-session') {
             console.error("[FATAL] Attempted to handle user message without a valid session. Dropping.");
             return;
          }
          
          // Echo Cancellation Guard: Prevent Daisy from talking to herself
          const userMsgRaw = data.user_message?.trim().toLowerCase() || "";
          const lastMsgRaw = lastAssistantMessage.trim().toLowerCase() || "";
          
          // If the transcribed message is basically what Daisy just said, ignore it to prevent looping
          if (userMsgRaw && lastMsgRaw && (userMsgRaw === lastMsgRaw || lastMsgRaw.includes(userMsgRaw) || userMsgRaw.includes(lastMsgRaw))) {
            console.log(`[ECHO GUARD] Dropping message because it echoes the last AI response: "${data.user_message}"`);
            return;
          }

          console.log(`User message received for session ${sessionId}: ${data.user_message}`);
          
          // Use our Gemini logic via handleConversationTurn
          const aiResponse = await handleConversationTurn(sessionId, data.user_message);
          
          // Send response back to ElevenLabs
          if (aiResponse.reply) {
            lastAssistantMessage = aiResponse.reply;
            ws.send(JSON.stringify({
              type: 'assistant_message',
              message: {
                role: 'assistant',
                content: aiResponse.reply
              }
            }));
          }

          // Trigger tools if returned by Gemini (e.g. SHOW_AVAILABLE_TIMES)
          if (aiResponse.cta) {
            ws.send(JSON.stringify({
              type: 'client_tool_call',
              tool_call_id: `call_${Date.now()}`,
              tool_name: 'show_calendar',
              parameters: {}
            }));
          }
        }
      } catch (err) {
        console.error('WebSocket Error:', err);
      }
    });

    ws.on('close', () => {
      console.log('ElevenLabs Custom LLM disconnected');
    });
  });
}
