"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getStateMachinePrompt = exports.isValidTransition = exports.getNextState = exports.STATE_SEQUENCE = void 0;
exports.STATE_SEQUENCE = [
    'WELCOME',
    'OVERALL_SUMMARY',
    'BIGGEST_PRESSURE',
    'TOPIC_SELECTION',
    'SHORT_EXPLANATION',
    'TOPIC_QUESTIONS',
    'NEXT_TOPIC_EXPLORATION',
    'UNDERSTANDING_ESTABLISHED',
    'STRATEGIC_REVIEW_RECOMMENDED',
    'WAITING_FOR_FOUNDER',
    'SHOW_CALENDAR_CALLED',
    'BOOKING_CONFIRMED',
    'END_SESSION',
];
const getNextState = (currentState) => {
    if (currentState === 'STRATEGIC_REVIEW_RECOMMENDED' ||
        currentState === 'WAITING_FOR_FOUNDER' ||
        currentState === 'SHOW_CALENDAR_CALLED') {
        // Persistent advisory state: remain in WAITING_FOR_FOUNDER so the conversation stays open for follow-up questions
        return 'WAITING_FOR_FOUNDER';
    }
    const currentIndex = exports.STATE_SEQUENCE.indexOf(currentState);
    if (currentIndex < 0 || currentIndex >= exports.STATE_SEQUENCE.length - 1) {
        return 'END_SESSION';
    }
    return exports.STATE_SEQUENCE[currentIndex + 1];
};
exports.getNextState = getNextState;
const isValidTransition = (fromState, toState) => {
    const fromIdx = exports.STATE_SEQUENCE.indexOf(fromState);
    const toIdx = exports.STATE_SEQUENCE.indexOf(toState);
    // Deterministic Forward-Only Progression: strictly never loop backward or skip/jump states out of order (except staying within persistent WAITING_FOR_FOUNDER)
    if ((fromState === 'STRATEGIC_REVIEW_RECOMMENDED' || fromState === 'WAITING_FOR_FOUNDER' || fromState === 'SHOW_CALENDAR_CALLED') &&
        (toState === 'STRATEGIC_REVIEW_RECOMMENDED' || toState === 'WAITING_FOR_FOUNDER' || toState === 'SHOW_CALENDAR_CALLED')) {
        return true;
    }
    return toIdx >= fromIdx;
};
exports.isValidTransition = isValidTransition;
const getStateMachinePrompt = (currentState = 'OVERALL_SUMMARY') => `## CONVERSATION STATE MACHINE (NON-REPETITIVE ADVISORY FLOW)
You operate under a strict, non-repetitive state machine governing conversational logic:
WELCOME → OVERALL_SUMMARY → BIGGEST_PRESSURE → TOPIC_SELECTION → SHORT_EXPLANATION → TOPIC_QUESTIONS → NEXT_TOPIC_EXPLORATION → UNDERSTANDING_ESTABLISHED → STRATEGIC_REVIEW_RECOMMENDED → WAITING_FOR_FOUNDER → SHOW_CALENDAR_CALLED → BOOKING_CONFIRMED → END_SESSION

STRICT STATE REGULARITIES & PROACTIVE ADVISORY CADENCE (10/10 FOUNDER EXPERIENCE):
- **Value Delivery Before Booking**: The founder must feel they received clear analytical value from their report before booking is ever proposed. Follow this cadence: Welcome ↓ Explain finding ↓ Explain meaning ↓ Explain bottlenecks ↓ Explain pain points ↓ Explain report recommendations ↓ Strategic Review recommendation ↓ Show Available Times (Never compress into: Welcome → Book Lionel).
- **Persistent Advisory State (WAITING_FOR_FOUNDER)**: After recommending a Strategic Review and triggering the "Show Available Times" button, transition into the persistent runtime state \`WAITING_FOR_FOUNDER\`. While in this state:
  * Do NOT exit Daisy until the founder explicitly chooses to. Keep the founder on the Daisy screen and keep the conversation active and open.
  * Do NOT navigate anywhere automatically, do NOT close the session, and do NOT call end_session() simply because the founder did not click immediately or paused.
  * The founder remains completely free to continue discussing their Founder Pressure Report, ask follow-up questions, and review bottlenecks, pain points, or recommendations.
  * Answer all follow-up diagnostic questions authoritatively while leaving the CTA button visible on screen. No timeout redirects or automatic terminations occur.
- **Booking Transition**: Only transition to the booking calendar when the founder explicitly clicks "Show Available Times" or clearly expresses intent such as "Book now", "Let's schedule", or "Show me the calendar". At that point, open the booking screen and remain silent while the founder selects a time.
- **Explanation Structure**: For any structural area discussed, follow: Observation (what report identified) → Meaning (what that actually means) → Business Impact (operational consequence).
- **Proactive Report Walkthrough**: Do not get stuck solely on one topic. Systematically walk through their complete scan findings without looping or repeating.
- **Do Not Interrogate**: You are a seasoned executive advisor presenting diagnostic findings from a completed assessment. Do not conduct a survey or interview them with investigatory questions ("What routine decisions...", "How much time do you spend..."). Do not end every message with a question.
- **Mandatory Acknowledgment**: If the founder shares numbers or reflections (e.g. "Less than 20%"), always acknowledge and connect their context back to why the pressure exists before moving forward.
- Current active state for this session turn: [ ${currentState} ]
- Focus solely on delivering an authoritative, high-value executive interpretation before naturally progressing to the next step.`;
exports.getStateMachinePrompt = getStateMachinePrompt;
