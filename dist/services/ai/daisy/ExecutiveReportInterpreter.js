"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getExecutiveReportPrompt = exports.interpretReport = void 0;
/**
 * Converts the raw Founder Pressure Report into a pre-digested executive interpretation before the LLM is invoked.
 * Pre-generates personalized conversational topic reflections at report creation time, each terminating in exactly ONE follow-up question.
 */
const interpretReport = (vars) => {
    const primaryFinding = vars.primaryPressureArea || (vars.pressureDimensions && vars.pressureDimensions[0]) || "Founder Dependency";
    let topBottlenecks = [];
    if (Array.isArray(vars.pressureDimensions) && vars.pressureDimensions.length > 0) {
        topBottlenecks = vars.pressureDimensions.slice(0, 3).map((d) => `Operational bottleneck centering around ${d}`);
    }
    else {
        topBottlenecks = [`Decision and approval bottleneck centering around ${primaryFinding}`];
    }
    let topPainPoints = [];
    if (Array.isArray(vars.risks) && vars.risks.length > 0) {
        topPainPoints = vars.risks.slice(0, 3);
    }
    else {
        topPainPoints = [
            "Founders carrying excessive operational responsibility while team execution stalls waiting for guidance and approval"
        ];
    }
    const topRecommendations = Array.isArray(vars.recommendations) && vars.recommendations.length > 0
        ? vars.recommendations.slice(0, 3)
        : [
            "Strengthening decision ownership and reducing unnecessary founder dependency so execution can continue without relying on your approval for every important step"
        ];
    const businessImpact = vars.summary ||
        `The business has reached an operational capacity threshold where executive involvement is required for daily momentum, actively restricting scalable execution speed and decision flow.`;
    const bookingReason = `To examine the structural causes behind ${primaryFinding} and establish operational alignment during a Strategic Review with Lionel Eersteling.`;
    // Pre-generate conversational explanations following strict 10/10 Founder Experience structure: Observation → Meaning → Business Impact
    const storedExplanations = {
        "Tell me about Decision Load": "Your Founder Pressure Scan identified Decision Load as one of the strongest structural pressure areas. This suggests that important decisions are still depending on your involvement before work can continue. Over time this slows execution, reduces leadership autonomy, and limits the company's ability to move independently.",
        "Decisions": "Your Founder Pressure Scan identified Decision Load as one of the strongest structural pressure areas. This suggests that important decisions are still depending on your involvement before work can continue. Over time this slows execution, reduces leadership autonomy, and limits the company's ability to move independently.",
        "Decision Load": "Your Founder Pressure Scan identified Decision Load as one of the strongest structural pressure areas. This suggests that important decisions are still depending on your involvement before work can continue. Over time this slows execution, reduces leadership autonomy, and limits the company's ability to move independently.",
        "Explain Execution": "Your report identified team execution as one of the areas creating pressure and delay. This indicates that day-to-day initiatives tend to slow down or stall whenever your personal involvement pauses. Over time, this forces you to carry too much operational responsibility and makes it harder for your team to drive progress independently.",
        "Execution": "Your report identified team execution as one of the areas creating pressure and delay. This indicates that day-to-day initiatives tend to slow down or stall whenever your personal involvement pauses. Over time, this forces you to carry too much operational responsibility and makes it harder for your team to drive progress independently.",
        "Explain Leadership Alignment": "Your Founder Pressure Scan shows that Leadership Alignment is one of the areas creating pressure in your business. The report suggests that ownership isn't always clear, so important decisions and unresolved issues continue finding their way back to you instead of being handled by your leadership team. Over time, this slows execution and makes it harder for your team to operate independently.",
        "Leadership Alignment": "Your Founder Pressure Scan shows that Leadership Alignment is one of the areas creating pressure in your business. The report suggests that ownership isn't always clear, so important decisions and unresolved issues continue finding their way back to you instead of being handled by your leadership team. Over time, this slows execution and makes it harder for your team to operate independently.",
        "Give me the big picture": "Looking across all your diagnostic signals, your Founder Pressure Scan reveals that your business has reached a point where daily momentum depends too heavily on your personal bandwidth. Because important decisions and problem-solving route back to you, personal effort alone cannot scale the business further without strengthening team accountability and independent decision flow.",
        "More": "Looking across all your diagnostic signals, your Founder Pressure Scan reveals that your business has reached a point where daily momentum depends too heavily on your personal bandwidth. Because important decisions and problem-solving route back to you, personal effort alone cannot scale the business further without strengthening team accountability and independent decision flow.",
        "Why is this important?": "When daily decisions and project execution rely on your personal involvement, your bandwidth naturally becomes the bottleneck for the entire business. Clarifying ownership and strengthening team accountability ensures that execution speed continues smoothly without waiting for your personal approval.",
        "Operational Dependency": "Your scan indicates that daily momentum depends heavily on your personal supervision rather than clear team ownership and independent systems. Over time, this reliance on your personal bandwidth creates delays and sets a structural ceiling on scalable execution and growth.",
        ...vars.storedExplanations,
    };
    return {
        primaryFinding,
        topBottlenecks,
        topPainPoints,
        topRecommendations,
        businessImpact,
        bookingReason,
        storedExplanations,
    };
};
exports.interpretReport = interpretReport;
const getExecutiveReportPrompt = (interpretation) => `## EXECUTIVE REPORT INTERPRETATION & DYNAMIC AI PROHIBITIONS
You are supplied with the executive interpretation of the founder's scan report.
The report and Runtime Context are the ONLY source of truth. Your mission is strictly to interpret these findings dynamically in a natural executive conversation. NEVER invent alternative analyses, scores, frameworks, or recommendations.
If any information or detail requested by the founder is missing from this briefing or questionnaire data, you MUST reply verbatim: "I don't have that information in your report."

- PRIMARY FINDING (Highest Priority): ${interpretation.primaryFinding}
- TOP OPERATIONAL BOTTLENECKS:
  ${interpretation.topBottlenecks.map(b => `• ${b}`).join('\n  ')}
- TOP BUSINESS PAIN POINTS:
  ${interpretation.topPainPoints.map(p => `• ${p}`).join('\n  ')}
- REPORT RECOMMENDATIONS (Mandatory to explain before proposing booking):
  ${interpretation.topRecommendations.map(r => `• ${r}`).join('\n  ')}
- CORE BUSINESS IMPACT: ${interpretation.businessImpact}
- WHY BOOKING IS RECOMMENDED: ${interpretation.bookingReason}

MANDATORY DYNAMIC INTERPRETATION (FINAL PRODUCTION SPECIFICATION):
1. ZERO HARDCODED OR FAQ BEHAVIOUR: Synthesize every answer dynamically from the founder's specific data. Adapt your wording dynamically to the founder's report, previous questions, conversation history, and current context without sounding like an AI, ChatGPT, or support bot.
2. NEVER EXPOSE INTERNAL METRICS: Do not expose raw numbers like "Decision Load (1.8/100)", vectors, or confidence scores. Use founder-facing terminology ("assessed at a Moderate level").
3. EXPLANATION SEQUENCE: Follow this mandatory 7-step order across the engagement: Report Finding → Interpretation → Bottlenecks → Business Impact → Report Recommendations → Strategic Review Recommendation → Booking Guidance.
4. DO NOT INTERROGATE OR CONDUCT A SURVEY: You are a senior executive advisor presenting insights, not an interviewer or survey taker. You already have their scan results and questionnaire answers. Do NOT ask investigatory questions about daily routines ("What routine decisions...", "How much of your week..."). Do NOT restart the scan or ask the founder to explain their report.
5. MANDATORY ACKNOWLEDGMENT OF FOUNDER CONTEXT: When the founder inputs context or metrics (e.g. "Less than 20% of my time is spent on operations"), acknowledge and interpret their input with executive insight BEFORE connecting it back to the scan findings. Never ignore or talk past their statement.
6. ZERO ERROR EXPOSURE: If connection delays or retries occur, never expose technical failures or connection error messages to the founder. Sustain a seamless executive demeanor at all times.`;
exports.getExecutiveReportPrompt = getExecutiveReportPrompt;
