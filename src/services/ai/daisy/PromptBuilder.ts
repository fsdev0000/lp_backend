import { DaisyContext, extractDaisyRuntimeVariables, getRuntimeStatePrompt } from './RuntimeState';
import { getIdentityPrompt, getVoiceIdentityPrompt } from './Identity';
import { getStateMachinePrompt, DaisyState } from './ConversationStateMachine';
import { interpretReport, getExecutiveReportPrompt } from './ExecutiveReportInterpreter';
import { getGuardrailsPrompt } from './Guardrails';
import { getBookingRulesPrompt } from './BookingRules';
import { getToolRulesPrompt } from './ToolRules';
import { getVoiceRulesPrompt } from './VoiceRules';
import { getChatRulesPrompt } from './ChatRules';

export const buildDaisySystemPrompt = (
  context: DaisyContext,
  mode: 'chat' | 'voice' = 'chat',
  memoryFlags?: Record<string, boolean>
): string => {
  const vars = extractDaisyRuntimeVariables(context);
  const interpretation = interpretReport(vars);
  const currentPhase = (vars.conversationPhase as DaisyState) || 'PRIMARY_FINDING';

  if (mode === 'voice') {
    // Voice mode: use voice identity (includes live conversation addendum),
    // voice rules, and essential guardrails. Exclude ChatRules (JSON output instructions).
    const modules = [
      getVoiceIdentityPrompt(),
      getStateMachinePrompt(currentPhase),
      getExecutiveReportPrompt(interpretation),
      getGuardrailsPrompt(),
      getBookingRulesPrompt(),
      getToolRulesPrompt(),
      getVoiceRulesPrompt(),
      getRuntimeStatePrompt(vars, memoryFlags),
    ];
    return modules.join('\n\n---\n\n');
  }

  // Text chat mode: standard prompt with JSON output rules
  const modules = [
    getIdentityPrompt(),
    getStateMachinePrompt(currentPhase),
    getExecutiveReportPrompt(interpretation),
    getGuardrailsPrompt(),
    getBookingRulesPrompt(),
    getToolRulesPrompt(),
    getRuntimeStatePrompt(vars, memoryFlags),
    getChatRulesPrompt(),
  ];

  return modules.join('\n\n---\n\n');
};

export {
  DaisyContext,
  FounderReport,
  isValidFounderName,
  formatFounderReport,
  extractDaisyRuntimeVariables,
  getDaisyWelcomeMessageText,
  getDaisyWelcomeMessageVoice,
} from './RuntimeState';

export { DaisyState, STATE_SEQUENCE, getNextState, isValidTransition } from './ConversationStateMachine';
export { ExecutiveInterpretation, interpretReport } from './ExecutiveReportInterpreter';
