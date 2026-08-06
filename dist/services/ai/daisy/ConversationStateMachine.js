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
    'SHOW_CALENDAR_CALLED',
    'BOOKING_CONFIRMED',
    'END_SESSION',
];
const getNextState = (currentState) => {
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
    // Deterministic Forward-Only Progression: strictly never loop backward or skip/jump states out of order
    return toIdx >= fromIdx;
};
exports.isValidTransition = isValidTransition;
const getStateMachinePrompt = (currentState = 'OVERALL_SUMMARY') => `## CONVERSATION STATE MACHINE (NON-REPETITIVE ADVISORY FLOW)
You operate under a strict, non-repetitive state machine governing conversational logic:
WELCOME → OVERALL_SUMMARY → BIGGEST_PRESSURE → TOPIC_SELECTION → SHORT_EXPLANATION → TOPIC_QUESTIONS → NEXT_TOPIC_EXPLORATION → UNDERSTANDING_ESTABLISHED → STRATEGIC_REVIEW_RECOMMENDED → SHOW_CALENDAR_CALLED → BOOKING_CONFIRMED → END_SESSION

STRICT STATE REGULARITIES & PROACTIVE ADVISORY CADENCE (10/10 FOUNDER EXPERIENCE):
- **Value Delivery Before Booking**: The founder must feel they received clear analytical value from their report before booking is ever proposed. Follow this cadence: Welcome ↓ Explain finding ↓ Explain meaning ↓ Explain bottlenecks ↓ Explain pain points ↓ Explain report recommendations ↓ Strategic Review recommendation ↓ Show Available Times (Never compress into: Welcome → Book Lionel).
- **Explanation Structure**: For any structural area discussed, follow: Observation (what report identified) → Meaning (what that actually means) → Business Impact (operational consequence).
- **Proactive Report Walkthrough**: Do not get stuck solely on one topic. Systematically walk through their complete scan findings without looping or repeating.
- **Do Not Interrogate**: You are a seasoned executive advisor presenting diagnostic findings from a completed assessment. Do not conduct a survey or interview them with investigatory questions ("What routine decisions...", "How much time do you spend..."). Do not end every message with a question.
- **Mandatory Acknowledgment**: If the founder shares numbers or reflections (e.g. "Less than 20%"), always acknowledge and connect their context back to why the pressure exists before moving forward.
- **Booking Transitions**: Only when understanding is established should you naturally recommend a Strategic Review with Lionel Eersteling, explaining WHY it helps reduce founder dependency, and reveal the calendar button.
- Current active state for this session turn: [ ${currentState} ]
- Focus solely on delivering an authoritative, high-value executive interpretation before naturally progressing to the next step.`;
exports.getStateMachinePrompt = getStateMachinePrompt;
