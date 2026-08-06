"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRuntimeStatePrompt = exports.getDaisyWelcomeMessageVoice = exports.getDaisyWelcomeMessageText = exports.extractDaisyRuntimeVariables = void 0;
const ReportInjector_1 = require("./ReportInjector");
const extractDaisyRuntimeVariables = (context) => {
    const { vars } = (0, ReportInjector_1.formatFounderReport)(context);
    return vars;
};
exports.extractDaisyRuntimeVariables = extractDaisyRuntimeVariables;
const getDaisyWelcomeMessageText = (founderName, primaryArea, scoreOrTier) => {
    const hasName = (0, ReportInjector_1.isValidFounderName)(founderName);
    const cleanName = hasName ? founderName.trim() : null;
    const greeting = cleanName ? `Welcome, ${cleanName}. I've read your scan carefully.` : `Welcome. I've read your scan carefully.`;
    const area = (primaryArea && primaryArea.trim() !== '') ? primaryArea.trim() : 'Founder Dependency';
    const tier = (scoreOrTier && String(scoreOrTier).trim() !== '') ? String(scoreOrTier).trim() : 'Critical';
    return `${greeting} Your strongest signal is ${area}, scored at ${tier}. Before we consider any intervention, it's worth understanding where this pressure is actually coming from inside the business.`;
};
exports.getDaisyWelcomeMessageText = getDaisyWelcomeMessageText;
const getDaisyWelcomeMessageVoice = (founderName, primaryArea, scoreOrTier) => {
    return (0, exports.getDaisyWelcomeMessageText)(founderName, primaryArea, scoreOrTier);
};
exports.getDaisyWelcomeMessageVoice = getDaisyWelcomeMessageVoice;
const getRuntimeStatePrompt = (vars) => `## 5. CURRENT APPLICATION & RUNTIME STATE
The application is currently operating under the following dynamic state for this founder:
- Conversation Phase: ${vars.conversationPhase}
- Booking Status: ${vars.bookingStatus}
- Calendar Widget Opened: ${vars.calendarOpened ? 'YES (Do not prompt or invoke tool again)' : 'NO'}
- Booking Completed: ${vars.bookingCompleted ? 'YES (Session goals achieved)' : 'NO'}
- Application Welcome: Delivered by system interface. Do not repeat greeting.`;
exports.getRuntimeStatePrompt = getRuntimeStatePrompt;
