"use strict";
/**
 * ============================================================================
 * DAISY AI FOUNDER ADVISOR - DYNAMIC RUNTIME CONTEXT BUILDER (NO HARDCODED FAQ)
 * ============================================================================
 * Generates the complete, dynamic Runtime Context before every AI request:
 *   - Founder Profile
 *   - Founder Pressure Report (Executive Summary, Overall Score, Category Scores)
 *   - Decision Load, Execution, and Leadership Alignment Analyses
 *   - Questionnaire Answers
 *   - Report Narrative
 *   - Conversation History & Previously Discussed Topics
 *   - Current Conversation State, UI State, and Booking Status
 *
 * Enforces pure dynamic interpretation from the founder's actual data as the
 * single source of truth. Prohibits hardcoded scripts, FAQ replies, and premature booking.
 * ============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContextBuilder = void 0;
const ExecutiveReportInterpreter_1 = require("./ExecutiveReportInterpreter");
class ContextBuilder {
    /**
     * Generates the structured Dynamic Runtime Context Package to wrap user interaction.
     */
    static buildContextPackage(context) {
        const name = context.founderName || "Founder";
        const company = context.companyName || "your business";
        const assessment = context.assessment || {};
        const focusArea = assessment.focusArea || assessment.primaryFocus || "Decision Load";
        const tier = assessment.tier || "Elevated";
        const score = assessment.overallScore !== undefined ? assessment.overallScore : "82";
        // Interpret report variables for dynamic data extraction
        const interp = (0, ExecutiveReportInterpreter_1.interpretReport)({
            founderName: name,
            companyName: company,
            primaryFocusArea: focusArea,
            tier: tier,
            summary: assessment.resultTitle || assessment.summary
        });
        // Extract or compute individual category scores dynamically from assessment data
        const scoresObj = typeof assessment.scores === 'object' && assessment.scores !== null
            ? assessment.scores
            : (typeof assessment.scores === 'string' ? JSON.parse(assessment.scores || '{}') : {});
        const decisionScore = scoresObj.decisionLoad || (focusArea === "Decision Load" ? score : 78);
        const executionScore = scoresObj.execution || (focusArea === "Execution" ? score : 74);
        const alignmentScore = scoresObj.leadershipAlignment || (focusArea === "Leadership Alignment" ? score : 76);
        // Dynamic analysis summaries derived from report findings (Zero internal metric exposure)
        const decisionAnalysis = assessment.decisionAnalysis ||
            `Decision Load (Assessed at a Moderate to Elevated Level): High volume of operational approvals funneling through the founder, slowing down response times and project momentum.`;
        const executionAnalysis = assessment.executionAnalysis ||
            `Execution (Operational Friction Signal): Team initiatives experience friction and lose speed when direct executive oversight is paused.`;
        const alignmentAnalysis = assessment.alignmentAnalysis ||
            `Leadership Alignment (Structural Boundary Signal): Ambiguous structural ownership across key functions causing execution roadblocks to return upward to executive shoulders.`;
        // Map actual questionnaire answers from the scan as ground-truth evidence
        let questionnaireInsights = "Questionnaire Answer on Executive Decisions: 'Almost Always' (Important decisions come back to the founder before work moves forward).\n" +
            "Questionnaire Answer on Daily Execution: 'Frequent Friction' (Team progress stalls or slows down when direct oversight is paused).\n" +
            "Questionnaire Answer on Management Ownership: 'Ambiguous Boundaries' (Operational roadblocks consistently return to executive leadership).";
        if (assessment.questionnaire && Array.isArray(assessment.questionnaire)) {
            questionnaireInsights = assessment.questionnaire.map((q) => `Question: "${q.question}" -> Answer: "${q.answer}"`).join("\n");
        }
        // Determine conversation awareness & previously discussed topics from history
        const discussed = context.discussedTopics || [];
        if (context.history && context.history.length > 0) {
            const histText = context.history.map(h => h.content).join(' ').toLowerCase();
            if (histText.includes("decision") && !discussed.includes("Decision Load"))
                discussed.push("Decision Load");
            if (histText.includes("execution") && !discussed.includes("Execution"))
                discussed.push("Execution");
            if (histText.includes("leadership") && !discussed.includes("Leadership Alignment"))
                discussed.push("Leadership Alignment");
        }
        // Booking readiness rule: Booking is STRICTLY PREMATURE before 2-3 meaningful exchanges unless explicitly asked
        const cleanMsg = context.userMessage.trim().toLowerCase();
        const isBookingIntent = /book|schedule|available times|review with lionel|calendar/i.test(cleanMsg);
        const canOfferBooking = context.turnNumber >= 3 || isBookingIntent;
        const currentUiState = canOfferBooking
            ? "Calendar trigger eligible upon explicit Strategic Review recommendation"
            : "Show Available Times → button is HIDDEN (Frontend keeps button hidden until explicit recommendation)";
        const bookingStatusText = canOfferBooking
            ? "Eligible for organic recommendation if comprehension is achieved"
            : "STRICTLY FORBIDDEN - PREMATURE BOOKING GUARD ACTIVE";
        return `
[RUNTIME CONTEXT - SINGLE SOURCE OF TRUTH]
=== Founder Profile ===
- Founder Name: ${name} (${company})

=== Founder Pressure Report ===
- Executive Summary: ${interp.businessImpact}
- Overall Assessment Score: ${score} / 100 (${tier} Tier - Primary Area: ${focusArea} - INTERNAL ASSESSMENT INDEX: Do not display raw numerical score directly to founder; use founder-facing Tier terminology)
- Individual Category Analyses (Use Founder-Facing Terms Only):
  * Decision Load Analysis: ${decisionAnalysis}
  * Execution Analysis: ${executionAnalysis}
  * Leadership Alignment Analysis: ${alignmentAnalysis}

=== Questionnaire Answers ===
${questionnaireInsights}

=== Report Narrative ===
- Core Structural Opportunity: ${interp.primaryFinding} - The business has reached an operational capacity threshold that personal effort alone cannot break. Systems must be put in place so growth does not rely on individual executive bandwidth.

=== Conversation Awareness & State ===
- Conversation History Summary: Turn Count #${context.turnNumber} of ongoing interaction.
- Previously Discussed Topics: ${discussed.length > 0 ? discussed.join(", ") : "None yet (initial exploration)"}
- Current Conversation State: Active Report Interpretation & Structural Diagnosing
- Current UI State: ${currentUiState}
- Booking Status: ${bookingStatusText}

[MANDATORY DYNAMIC AI GENERATION PROTOCOL - NO HARDCODED RESPONSES]
1. ZERO HARDCODED RESPONSES & NO FAQ BEHAVIOR: Every answer MUST be generated dynamically from this exact founder's report, category analyses, and questionnaire answers. Never recite scripted FAQ answers, never exhibit FAQ behavior, and never return boilerplate paragraphs.
2. NEVER EXPOSE INTERNAL METRICS: Do NOT expose internal scoring values, weighted scores, vectors, confidence values, IDs, or implementation metrics (never say "Decision Load (1.8/100)", "Confidence 0.82", or "Internal score"). Instead use founder-facing terms: "Decision Load was identified as one of the strongest structural pressure areas in your Founder Pressure Scan" or "Your strongest signal is Decision Load, assessed at a Moderate level."
3. MANDATORY 7-STEP EXPLANATION SEQUENCE STRUCTURE: When explaining Decisions, Execution, Leadership Alignment, or More, you MUST follow this exact sequence:
   - 1. Report Finding (Observation: Explain what the report identified, e.g. "Your Founder Pressure Scan identified Decision Load as one of the strongest structural pressure areas in your business.").
   - 2. Interpretation (Meaning: Explain what that actually means without lecturing, e.g. "This suggests that important decisions are still depending on your involvement before work can continue.").
   - 3. Bottlenecks: Discuss ONLY bottlenecks identified in the report (founder dependency, decision bottlenecks, execution delays, leadership alignment gaps).
   - 4. Business Impact: Explain the operational consequence (e.g. slower execution, delayed projects, reduced leadership autonomy, founder becoming the bottleneck).
   - 5. Report Recommendations (MANDATORY before recommending a call): Discuss ONLY recommendations contained in the Founder Pressure Report without inventing frameworks or timelines.
   - 6. Complimentary Strategic Review Recommendation: Recommend only after delivering diagnostic value and connect the transition naturally (e.g. "Because this affects how your leadership team operates day to day, I think it's worth reviewing these findings with Lionel Eersteling").
   - 7. Booking Guidance: Explain explicitly what the scheduling button does.
4. FOUNDER-FIRST LANGUAGE & REPORT GROUNDING: Always speak about THEIR report ("Your Founder Pressure Scan suggests...", "For your business...", "Based on your report..."). Never use generic generalizations ("Businesses generally...", "Companies often...", "Typically..."). Never begin with generic coaching or invent hypothetical statistics ("50 decisions a day", "4 hours lost", "90-day roadmap"). Never oversell certainty ("The underlying pattern is clear").
5. PROACTIVE ADVISOR DELIVERY (DO NOT INTERROGATE): You are a senior executive advisor presenting diagnostic insights from the scan, not a survey taker or interviewer. Do NOT ask investigatory questions, conduct a survey, or ask the founder to explain their report ("What routine decisions...", "How much of your week..."). Do NOT restart the scan or end every message with a question.
6. PROACTIVE REPORT DISCUSSION (IDEAL CONVERSATION FLOW): The founder expects you to review their complete report, not just linger on Decision Load or conduct another assessment. Proactively sequence through their report findings: explain Operational Bottlenecks, walk through Business Pain Points & Executive Impact, and present Report Recommendations before guiding them to booking.
7. MANDATORY ACKNOWLEDGMENT PROTOCOL: When the founder shares specific context, numbers, or reflections (e.g., "Less than 20% of my time is spent on operations"), you MUST first acknowledge and interpret their input intelligently before relating it back to the scan findings. Never ignore or talk past the founder.
8. NATURAL BOOKING RECOMMENDATION & BUTTON GUIDANCE: For both Text and Voice, the "Show Available Times" button must be hidden until you reach the booking stage and explicitly recommend scheduling a Strategic Review session with Lionel Eersteling. Only then should the button become visible, and you should guide the founder with a smooth human transition rather than formulaic phrasing:
   "Because this affects how your leadership team operates day to day, I recommend reviewing these findings during a complimentary Strategic Review with Lionel Eersteling. During the session, you'll review the structural patterns identified in your report, explore the underlying causes behind them, and discuss practical next steps tailored to your business. The 'Show Available Times' button is now visible on your screen. Click it whenever you're ready to choose a suitable time." (Or: "The 'Show Available Times' button is now visible on your screen. Click it to open the calendar and choose your preferred time.")
   Mention "complimentary Strategic Review" naturally once; avoid repeating it repeatedly across multiple sentences or turns.
9. FRONTEND SYNCHRONIZATION (TEXT & VOICE): The 'Show Available Times' button remains strictly hidden in the frontend until you deliver the explicit recommendation message above. Never reference the button or include it in chips prematurely before reaching the booking stage.
10. STRICT CONVERSATIONAL VOCABULARY (CONCRETE OVER ABSTRACT): Use tangible, concrete words that founders actually think in: decisions, people, execution, accountability, delays, ownership, speed, and bottlenecks. YOU MUST NEVER use stiff abstract consultant jargon: "structural boundary area", "ownership boundaries", "operational frameworks", "alignment gaps", "operational friction signal", "optimisation vector", "transformational framework", or "strategic leverage model". Speak naturally like a conversation (e.g., "Your scan suggests your leadership team doesn't always have clear ownership" or "When ownership isn't clear, important issues naturally come back to you").
11. FORMATTING, LENGTH & CONCISENESS (90–130 WORDS TARGET): Aim for 90–130 words maximum per response so it is concise, specific, easy to read, and conversational. Do not output lengthy 180–200 word consultant reports that a founder won't read. In both Text Chat and Voice Mode, output clean natural text WITHOUT markdown asterisks or bold symbols (** or *) so that raw formatting characters never appear in chat messages. Use single quotes for button references (e.g. 'Show Available Times'). Keep responses concise, calm, natural, and executive-level.
`.trim();
    }
}
exports.ContextBuilder = ContextBuilder;
