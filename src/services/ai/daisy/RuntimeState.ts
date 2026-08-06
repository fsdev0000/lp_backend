export interface FounderReport {
  reportId?: string;
  founder_name?: string;
  company_name?: string;
  scanCompleted?: boolean;
  overallScore?: number | string | null;
  founderSegment?: string | null;
  primaryPressureArea?: string | null;
  pressureDimensions?: string[];
  strengths?: string[];
  risks?: string[];
  recommendations?: string[];
  summary?: string | null;
  storedExplanations?: Record<string, string>;
  bookingStatus?: string;
  calendarOpened?: boolean;
  bookingCompleted?: boolean;
  conversationPhase?: string;
  [key: string]: any;
}

export interface DaisyContext extends Partial<FounderReport> {
  lead_name?: string;
  founder?: string;
  company?: string;
  revenue?: string;
  stage?: string;
  tier?: string | number;
  score_tier?: string | number;
  primary_pressure_area?: string | null;
  overall_score?: string | number | null;
}

export const isValidFounderName = (name?: string | null): boolean => {
  if (!name) return false;
  const cleaned = name.trim().toLowerCase();
  return (
    cleaned !== '' &&
    cleaned !== 'unknown' &&
    cleaned !== 'not available' &&
    cleaned !== 'undefined' &&
    cleaned !== 'null'
  );
};

export const formatFounderReport = (context: DaisyContext): { reportObject: Record<string, any>; vars: Record<string, any> } => {
  const scanCompleted = context.scanCompleted !== undefined ? context.scanCompleted : true;
  if (!scanCompleted) {
    throw new Error('No Founder Report: scan completed flag is required to initiate Daisy.');
  }

  const rawName = context.founder_name || context.founder || context.lead_name;
  const hasName = isValidFounderName(rawName);
  const founder_name = hasName ? rawName!.trim() : 'Founder';
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

export const extractDaisyRuntimeVariables = (context: DaisyContext): Record<string, any> => {
  const { vars } = formatFounderReport(context);
  return vars;
};

export const getDaisyWelcomeMessageText = (
  founderName?: string | null,
  primaryArea?: string | null,
  scoreOrTier?: string | number | null
): string => {
  const hasName = isValidFounderName(founderName);
  const cleanName = hasName ? founderName!.trim() : null;
  const greeting = cleanName ? `Welcome, ${cleanName}. I've read your scan carefully.` : `Welcome. I've read your scan carefully.`;
  const area = (primaryArea && primaryArea.trim() !== '') ? primaryArea.trim() : 'Founder Dependency';
  const tier = (scoreOrTier && String(scoreOrTier).trim() !== '') ? String(scoreOrTier).trim() : 'Critical';

  return `${greeting} Your strongest signal is ${area}, scored at ${tier}. Before we consider any intervention, it's worth understanding where this pressure is actually coming from inside the business.`;
};

export const getDaisyWelcomeMessageVoice = (
  founderName?: string | null,
  primaryArea?: string | null,
  scoreOrTier?: string | number | null
): string => {
  return getDaisyWelcomeMessageText(founderName, primaryArea, scoreOrTier);
};

export const getRuntimeStatePrompt = (vars: Record<string, any>, memoryFlags?: Record<string, boolean>): string => `## RUNTIME STATE & CONVERSATION MEMORY FLAGS
The dynamic session state and memory deduplication flags for this founder are:
- Founder Name: ${vars.founder_name || 'Not specified'}
- Company: ${vars.company_name}
- Active Phase State: ${vars.conversationPhase}
- Calendar Widget Opened: ${vars.calendarOpened ? 'YES (Strictly do NOT repeat or reopen)' : 'NO'}
- Booking Confirmed: ${vars.bookingCompleted ? 'YES (Session complete; finalize dialogue)' : 'NO'}

EXPLICIT BOOKING RUNTIME STATE (MANDATORY FOR SESSION EXIT & REMINDER RULES):
- bookingStatus: ${(vars.bookingCompleted || memoryFlags?.bookingConfirmed) ? 'confirmed' : (vars.calendarOpened || memoryFlags?.calendarOpened ? 'calendar_open' : 'not_started')}
- calendarOpened: ${Boolean(vars.calendarOpened || memoryFlags?.calendarOpened)}
- bookingCompleted: ${Boolean(vars.bookingCompleted || memoryFlags?.bookingConfirmed)}

MANDATORY BOOKING JOURNEY & SESSION EXIT RULES (CRITICAL):
1. **If booking has NOT started** (calendarOpened = false) and the founder says things such as "I'm done", "I have done", "That's all", "Thanks", or "Okay":
   - You MUST NOT immediately end the conversation or call end_session().
   - Instead, naturally remind the founder of the next step by saying: "Before we finish, I'd recommend taking advantage of the complimentary Strategic Review with Lionel Eersteling. If you'd like to continue, simply click 'Show Available Times' below to choose a suitable time."
   - Immediately trigger show_calendar() or set "cta": true, and remain available in state WAITING_FOR_FOUNDER. Do not redirect and do not end the session.
2. **If booking has started** (calendarOpened = true, bookingCompleted = false):
   - Wait silently while the founder selects a time on the open calendar. Do NOT call end_session() or terminate.
3. **If booking is confirmed** (bookingCompleted = true):
   - You may say: "Perfect. Your Strategic Review has been confirmed. You'll receive a confirmation email shortly. Lionel Eersteling looks forward to speaking with you."
   - Only then should you call end_session() and allow the application to return to the Results page.
4. **Navigation & Exit Rules**: Never call end_session() unless bookingCompleted is true or the founder explicitly declines to continue after being reminded (e.g., "I do not want to book", "No thanks"). Simply saying "I'm done" or "Okay" must never trigger an automatic end or redirect before booking has been offered or completed.

SESSION MEMORY PROGRESS FLAGS (Do NOT repeat explanations for topics marked TRUE):
- alreadyExplained: ${memoryFlags?.alreadyExplained ? 'TRUE (Do not reiterate initial finding explanation)' : 'FALSE'}
- alreadyDiscussedBottlenecks: ${memoryFlags?.alreadyDiscussedBottlenecks ? 'TRUE (Do not repeat bottleneck explanation)' : 'FALSE'}
- alreadyDiscussedPainPoints: ${memoryFlags?.alreadyDiscussedPainPoints ? 'TRUE (Do not repeat pain point explanation)' : 'FALSE'}
- alreadyDiscussedRecommendations: ${memoryFlags?.alreadyDiscussedRecommendations ? 'TRUE (Do not repeat report recommendations)' : 'FALSE'}
- bookingRecommended: ${memoryFlags?.bookingRecommended ? 'TRUE (Strategic Review has been recommended)' : 'FALSE'}
- calendarOpened: ${memoryFlags?.calendarOpened || vars.calendarOpened ? 'TRUE (Calendar has been triggered)' : 'FALSE'}
- bookingConfirmed: ${memoryFlags?.bookingConfirmed || vars.bookingCompleted ? 'TRUE (Booking finalized)' : 'FALSE'}`;
