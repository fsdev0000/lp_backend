/**
 * ============================================================================
 * DAISY AI FOUNDER ADVISOR - FORWARDING ADAPTER & FACADE
 * ============================================================================
 * Re-exports from the independent 4-Layer Daisy AI Architecture:
 * - Layer 1: Backend Runtime & Concurrent State (RuntimeManager)
 * - Layer 2: System Prompt Modules (SystemPrompt, ReportInjector, Rules)
 * - Layer 3: Conversation & Interpretation Engine (ConversationEngine)
 * - Layer 4: Tool Execution & Idempotency Guards (ToolRules, BookingState)
 * ============================================================================
 */

import {
  buildDaisySystemPrompt as getDaisySystemPrompt,
  DaisyContext,
  FounderReport,
  isValidFounderName,
  formatFounderReport,
  extractDaisyRuntimeVariables,
  getDaisyWelcomeMessageText,
  getDaisyWelcomeMessageVoice,
} from '../services/ai/daisy/PromptBuilder';

export {
  getDaisySystemPrompt,
  DaisyContext,
  FounderReport,
  isValidFounderName,
  formatFounderReport,
  extractDaisyRuntimeVariables,
  getDaisyWelcomeMessageText,
  getDaisyWelcomeMessageVoice,
};
