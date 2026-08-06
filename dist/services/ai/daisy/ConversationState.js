"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initialConversationStatus = void 0;
const initialConversationStatus = () => ({
    phase: 'welcome',
    turns: 0,
    lastAiTurnTimestamp: Date.now(),
});
exports.initialConversationStatus = initialConversationStatus;
