"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getReportInjectionPrompt = exports.formatFounderReport = exports.isValidFounderName = void 0;
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
    const founder_name = hasName ? rawName.trim() : '';
    const company_name = context.company_name || context.company || 'Not specified';
    // Zero fabrication policy: never invent fallback scores or arrays
    const pressureDimensions = context.pressureDimensions ?? [];
    const strengths = context.strengths ?? [];
    const risks = context.risks ?? [];
    const recommendations = context.recommendations ?? [];
    const summary = context.summary ?? null;
    const overallScore = context.overallScore !== undefined ? context.overallScore : null;
    const founderSegment = context.founderSegment || context.stage || null;
    const primaryPressureArea = context.primaryPressureArea || (pressureDimensions.length > 0 ? pressureDimensions[0] : null);
    const calendarOpened = context.calendarOpened ?? false;
    const bookingCompleted = context.bookingCompleted ?? false;
    const conversationPhase = context.conversationPhase || 'welcome';
    const bookingStatus = context.bookingStatus || (bookingCompleted ? 'confirmed' : 'not_started');
    const reportObject = {
        reportId: context.reportId || 'FPR-GEN-01',
        founder_name: hasName ? founder_name : undefined,
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
        bookingStatus,
        calendarOpened,
        bookingCompleted,
        conversationPhase,
    };
    const vars = {
        founder_name,
        company_name,
        overallScore,
        overall_score: overallScore ?? 'Critical',
        founderSegment,
        founder_segment: founderSegment ?? 'Founder Profile',
        primaryPressureArea,
        primary_pressure_area: primaryPressureArea || 'Founder Dependency',
        pressure_tier: context.tier || 'Critical',
        score_tier: context.tier || 'Critical',
        pressureDimensions,
        pressure_dimensions: JSON.stringify(pressureDimensions),
        strengths,
        risks,
        recommendations,
        summary,
        bookingStatus,
        booking_status: bookingStatus,
        calendarOpened,
        calendar_opened: calendarOpened,
        bookingCompleted,
        booking_completed: bookingCompleted,
        conversationPhase,
        conversation_phase: conversationPhase,
        FounderReport: JSON.stringify(reportObject, null, 2),
    };
    return { reportObject, vars };
};
exports.formatFounderReport = formatFounderReport;
const getReportInjectionPrompt = (vars) => `## 5. FOUNDER PRESSURE REPORT (ONLY SOURCE OF TRUTH)
The following diagnostic data has been injected directly from the Leaders Performance backend:
- Founder: ${vars.founder_name || 'Founder'} (${vars.company_name})
- Overall Score: ${vars.overallScore ?? 'Not calculated'}
- Primary Pressure Area: ${vars.primaryPressureArea ?? 'Not identified'}
- Pressure Dimensions: ${JSON.stringify(vars.pressureDimensions)}
- Strengths: ${JSON.stringify(vars.strengths)}
- Risks: ${JSON.stringify(vars.risks)}
- Recommendations: ${JSON.stringify(vars.recommendations)}
- Summary: ${vars.summary ?? 'No summary available.'}

<FounderReport>
${vars.FounderReport}
</FounderReport>

CRITICAL REPORT INTERPRETATION RULES:
- This report is your absolute and ONLY source of truth.
- NEVER invent values, scores, metrics, or dimensions not found in this report.
- NEVER fabricate recommendations or guess at missing data.
- If the founder asks about information not explicitly contained in this report, answer with exactly: "I don't have that information in your Founder Pressure Report."`;
exports.getReportInjectionPrompt = getReportInjectionPrompt;
