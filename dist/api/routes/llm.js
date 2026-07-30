"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupLlmWebSocket = setupLlmWebSocket;
const memory_1 = require("../../services/ai/memory");
function setupLlmWebSocket(wss) {
    wss.on('connection', (ws) => {
        console.log('ElevenLabs Custom LLM connected');
        let sessionId = 'default-session';
        ws.on('message', async (message) => {
            try {
                const data = JSON.parse(message.toString());
                if (data.type === 'conversation_initiation_metadata') {
                    // You can pass dynamic variables from frontend to ElevenLabs which appear here
                    sessionId = data.conversation_initiation_metadata_payload?.custom_llm_extra_body?.sessionId || 'default-session';
                    console.log(`ElevenLabs session initialized: ${sessionId}`);
                }
                else if (data.type === 'user_message') {
                    console.log(`User message received: ${data.user_message}`);
                    // Use our Gemini logic via handleConversationTurn
                    const aiResponse = await (0, memory_1.handleConversationTurn)(sessionId, data.user_message);
                    // Send response back to ElevenLabs
                    if (aiResponse.reply) {
                        ws.send(JSON.stringify({
                            type: 'assistant_message',
                            message: {
                                role: 'assistant',
                                content: aiResponse.reply
                            }
                        }));
                    }
                    // Trigger tools if returned by Gemini (e.g. SHOW_AVAILABLE_TIMES)
                    // We can return this to ElevenLabs as an assistant message that tells the user we're opening the calendar,
                    // or we can just send client tools.
                    // Since the user is relying purely on ElevenLabs Agent Dashboard settings for client tools,
                    // We might not even need Custom LLM WebSocket if the ElevenLabs Dashboard acts as the LLM natively!
                }
            }
            catch (err) {
                console.error('WebSocket Error:', err);
            }
        });
        ws.on('close', () => {
            console.log('ElevenLabs Custom LLM disconnected');
        });
    });
}
