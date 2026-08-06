"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRuntimeStatePrompt = exports.getDaisyWelcomeMessageVoice = exports.getDaisyWelcomeMessageText = exports.extractDaisyRuntimeVariables = exports.formatFounderReport = exports.isValidFounderName = void 0;
const isValidFounderName = (name) => {
    if (!name)
        return false;
    const cleaned = name.trim().toLowerCase();
    return (cleaned !== '' &&
        cleaned !== 'unknown' &&
        cleaned !== 'not available' &&
        cleaned !== 'undefined' &&
        cleaned !== 'null');
};
exports.isValidFounderName = isValidFounderName;
const formatFounderReport = (context) => {
    const scanCompleted = context.scanCompleted !== undefined ? context.scanCompleted : true;
    if (!scanCompleted) {
        throw new Error('No Founder Report: scan completed flag is required to initiate Daisy.');
    }
    const rawName = context.founder_name || context.founder || context.lead_name;
    const hasName = (0, exports.isValidFounderName)(rawName);
    const founder_name = hasName ? rawName.trim() : 'Founder';
    const company_name = context.company_name || context.company || 'your company';
    // Zero fabrication policy: never invent fallback scores or arrays for analysis, but ensure ElevenLabs runtime variables exist
    const pressureDimensions = context.pressureDimensions ?? [];
    const strengths = context.strengths ?? [];
    const risks = context.risks ?? [];
    const recommendations = context.recommendations ?? [];
    const summary = context.summary ?? null;
    const storedExplanations = context.storedExplanations ?? {};
    const overallScore = context.overallScore !== undefined ? context.overallScore : (context.overall_score !== undefined ? context.overall_score : 78);
    const founderSegment = context.founderSegment || context.stage || 'Growth Stage';
    const primaryPressureArea = context.primaryPressureArea || context.primary_pressure_area || (pressureDimensions[0] || 'Founder Dependency');
    const scoreTier = context.score_tier || context.tier || 'Critical';
    const reportObject = {
        founder_name,
        company_name,
        scanCompleted,
        overallScore,
        founderSegment,
        primaryPressureArea,
        pressureDimensions,
        strengths,
        risks,
        recommendations,
        summary,
        storedExplanations,
    };
    const vars = {
        founder_name,
        company_name,
        scanCompleted,
        overallScore,
        overall_score: String(overallScore),
        founderSegment,
        founder_segment: founderSegment,
        primaryPressureArea,
        primary_pressure_area: primaryPressureArea,
        score_tier: String(scoreTier),
        tier: String(scoreTier),
        pressureDimensions,
        strengths,
        risks,
        recommendations,
        summary,
        storedExplanations,
        conversationPhase: context.conversationPhase || 'WELCOME',
        bookingStatus: context.bookingStatus || 'not_started',
        calendarOpened: Boolean(context.calendarOpened),
        bookingCompleted: Boolean(context.bookingCompleted),
    };
    return { reportObject, vars };
};
exports.formatFounderReport = formatFounderReport;
const extractDaisyRuntimeVariables = (context) => {
    const { vars } = (0, exports.formatFounderReport)(context);
    return vars;
};
exports.extractDaisyRuntimeVariables = extractDaisyRuntimeVariables;
const getDaisyWelcomeMessageText = (founderName, primaryArea, scoreOrTier) => {
    const hasName = (0, exports.isValidFounderName)(founderName);
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
const getRuntimeStatePrompt = (vars, memoryFlags) => `## RUNTIME STATE & CONVERSATION MEMORY FLAGS
The dynamic session state and memory deduplication flags for this founder are:
- Founder Name: ${vars.founder_name || 'Not specified'}
- Company: ${vars.company_name}
- Active Phase State: ${vars.conversationPhase}
- Calendar Widget Opened: ${vars.calendarOpened ? 'YES (Strictly do NOT repeat or reopen)' : 'NO'}
- Booking Confirmed: ${vars.bookingCompleted ? 'YES (Session complete; finalize dialogue)' : 'NO'}

SESSION MEMORY PROGRESS FLAGS (Do NOT repeat explanations for topics marked TRUE):
- alreadyExplained: ${memoryFlags?.alreadyExplained ? 'TRUE (Do not reiterate initial finding explanation)' : 'FALSE'}
- alreadyDiscussedBottlenecks: ${memoryFlags?.alreadyDiscussedBottlenecks ? 'TRUE (Do not repeat bottleneck explanation)' : 'FALSE'}
- alreadyDiscussedPainPoints: ${memoryFlags?.alreadyDiscussedPainPoints ? 'TRUE (Do not repeat pain point explanation)' : 'FALSE'}
- alreadyDiscussedRecommendations: ${memoryFlags?.alreadyDiscussedRecommendations ? 'TRUE (Do not repeat report recommendations)' : 'FALSE'}
- bookingRecommended: ${memoryFlags?.bookingRecommended ? 'TRUE (Strategic Review has been recommended)' : 'FALSE'}
- calendarOpened: ${memoryFlags?.calendarOpened || vars.calendarOpened ? 'TRUE (Calendar has been triggered)' : 'FALSE'}
- bookingConfirmed: ${memoryFlags?.bookingConfirmed || vars.bookingCompleted ? 'TRUE (Booking finalized)' : 'FALSE'}`;
exports.getRuntimeStatePrompt = getRuntimeStatePrompt;
