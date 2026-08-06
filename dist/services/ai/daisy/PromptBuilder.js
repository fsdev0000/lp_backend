"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.interpretReport = exports.isValidTransition = exports.getNextState = exports.STATE_SEQUENCE = exports.getDaisyWelcomeMessageVoice = exports.getDaisyWelcomeMessageText = exports.extractDaisyRuntimeVariables = exports.formatFounderReport = exports.isValidFounderName = exports.buildDaisySystemPrompt = void 0;
const RuntimeState_1 = require("./RuntimeState");
const Identity_1 = require("./Identity");
const ConversationStateMachine_1 = require("./ConversationStateMachine");
const ExecutiveReportInterpreter_1 = require("./ExecutiveReportInterpreter");
const Guardrails_1 = require("./Guardrails");
const BookingRules_1 = require("./BookingRules");
const ToolRules_1 = require("./ToolRules");
const VoiceRules_1 = require("./VoiceRules");
const ChatRules_1 = require("./ChatRules");
const buildDaisySystemPrompt = (context, mode = 'chat', memoryFlags) => {
    const vars = (0, RuntimeState_1.extractDaisyRuntimeVariables)(context);
    const interpretation = (0, ExecutiveReportInterpreter_1.interpretReport)(vars);
    const currentPhase = vars.conversationPhase || 'PRIMARY_FINDING';
    if (mode === 'voice') {
        // Voice mode: use voice identity (includes live conversation addendum),
        // voice rules, and essential guardrails. Exclude ChatRules (JSON output instructions).
        const modules = [
            (0, Identity_1.getVoiceIdentityPrompt)(),
            (0, ConversationStateMachine_1.getStateMachinePrompt)(currentPhase),
            (0, ExecutiveReportInterpreter_1.getExecutiveReportPrompt)(interpretation),
            (0, Guardrails_1.getGuardrailsPrompt)(),
            (0, BookingRules_1.getBookingRulesPrompt)(),
            (0, ToolRules_1.getToolRulesPrompt)(),
            (0, VoiceRules_1.getVoiceRulesPrompt)(),
            (0, RuntimeState_1.getRuntimeStatePrompt)(vars, memoryFlags),
        ];
        return modules.join('\n\n---\n\n');
    }
    // Text chat mode: standard prompt with JSON output rules
    const modules = [
        (0, Identity_1.getIdentityPrompt)(),
        (0, ConversationStateMachine_1.getStateMachinePrompt)(currentPhase),
        (0, ExecutiveReportInterpreter_1.getExecutiveReportPrompt)(interpretation),
        (0, Guardrails_1.getGuardrailsPrompt)(),
        (0, BookingRules_1.getBookingRulesPrompt)(),
        (0, ToolRules_1.getToolRulesPrompt)(),
        (0, RuntimeState_1.getRuntimeStatePrompt)(vars, memoryFlags),
        (0, ChatRules_1.getChatRulesPrompt)(),
    ];
    return modules.join('\n\n---\n\n');
};
exports.buildDaisySystemPrompt = buildDaisySystemPrompt;
var RuntimeState_2 = require("./RuntimeState");
Object.defineProperty(exports, "isValidFounderName", { enumerable: true, get: function () { return RuntimeState_2.isValidFounderName; } });
Object.defineProperty(exports, "formatFounderReport", { enumerable: true, get: function () { return RuntimeState_2.formatFounderReport; } });
Object.defineProperty(exports, "extractDaisyRuntimeVariables", { enumerable: true, get: function () { return RuntimeState_2.extractDaisyRuntimeVariables; } });
Object.defineProperty(exports, "getDaisyWelcomeMessageText", { enumerable: true, get: function () { return RuntimeState_2.getDaisyWelcomeMessageText; } });
Object.defineProperty(exports, "getDaisyWelcomeMessageVoice", { enumerable: true, get: function () { return RuntimeState_2.getDaisyWelcomeMessageVoice; } });
var ConversationStateMachine_2 = require("./ConversationStateMachine");
Object.defineProperty(exports, "STATE_SEQUENCE", { enumerable: true, get: function () { return ConversationStateMachine_2.STATE_SEQUENCE; } });
Object.defineProperty(exports, "getNextState", { enumerable: true, get: function () { return ConversationStateMachine_2.getNextState; } });
Object.defineProperty(exports, "isValidTransition", { enumerable: true, get: function () { return ConversationStateMachine_2.isValidTransition; } });
var ExecutiveReportInterpreter_2 = require("./ExecutiveReportInterpreter");
Object.defineProperty(exports, "interpretReport", { enumerable: true, get: function () { return ExecutiveReportInterpreter_2.interpretReport; } });
