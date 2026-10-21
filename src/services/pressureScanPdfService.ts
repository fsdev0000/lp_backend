/**
 * pressureScanPdfService.ts
 *
 * Standalone PDF generator for Founder Pressure Scan V1.0.
 * Produces standard, 100% compliant PDF 1.4 binary buffers with zero external dependencies.
 * 
 * Supports TWO distinct reports:
 * 1. Internal Advisor Briefing Dossier (for Mr. Lionel Eersteling) - Conversation preparation, operational hypotheses, questions.
 * 2. Participant Results Report (for Participating Founder) - Clear-language directional findings and preparation guide.
 */

import { SimplePdfDocument } from './masterclassPdfService';

export interface PressureScanPdfData {
  referenceNumber: string;
  fullName: string;
  email: string;
  companyName: string;
  phone?: string | null;
  submittedContext?: Record<string, any> | null;
  answers: Array<{ questionNumber?: number; domain?: string; score: number; text?: string }>;
  overallRawMean: number;
  overallNormalised: number;
  domainScores: Array<{ domain: string; mean: number; normalised: number }>;
  primarySignalAreas: string[];
  signalClassification: string;
  submittedAt?: Date | string | null;
  reviewStatus?: string;
  reviewerNotes?: string | null;
  reviewerDecision?: string | null;
  reviewedAt?: Date | string | null;
  reviewedBy?: string | null;
  zoomMeetingUrl?: string | null;
  scheduledReviewAt?: Date | string | null;
}

const SCALE_LABELS: Record<number, string> = {
  1: 'Never (1/5)',
  2: 'Rarely (2/5)',
  3: 'Sometimes (3/5)',
  4: 'Often (4/5)',
  5: 'Consistently (5/5)',
};

export const OFFICIAL_QUESTIONS = [
  { qNum: 1, domain: 'Founder Involvement', text: 'How often does day-to-day progress depend directly on your personal involvement?' },
  { qNum: 2, domain: 'Founder Involvement', text: 'How often does operational momentum pause when you are unavailable or focused elsewhere?' },
  { qNum: 3, domain: 'Decision Load', text: 'How often do important operational or strategic decisions wait for your review before work can proceed?' },
  { qNum: 4, domain: 'Decision Load', text: 'How often do decisions that belong at team level get escalated back to you?' },
  { qNum: 5, domain: 'Execution Rhythm', text: 'How often do strategic priorities or commitments slip without your repeated follow-up?' },
  { qNum: 6, domain: 'Execution Rhythm', text: 'How often does delivery consistency require founder-level intervention to stay on schedule?' },
  { qNum: 7, domain: 'Leadership Ownership', text: 'How often do leaders wait for your explicit direction before taking action on ambiguous challenges?' },
  { qNum: 8, domain: 'Leadership Ownership', text: 'How often do leaders defer consequential accountability back to you instead of resolving outcomes?' },
  { qNum: 9, domain: 'Operational Resilience', text: 'How often does unexpected operational friction disrupt your organisation\'s core rhythm?' },
  { qNum: 10, domain: 'Operational Resilience', text: 'How sensitive is current performance when you or key team members are under sustained demand?' },
];

export const DOMAIN_ADVISORY_PROFILES: Record<string, {
  name: string;
  qNums: [number, number];
  operationalHypothesis: string;
  conversationInquiries: string[];
}> = {
  'Founder Involvement': {
    name: 'Founder Involvement',
    qNums: [1, 2],
    operationalHypothesis: 'Founder involvement acts as the central kinetic engine. Progress stalls when the founder is unavailable. Point to explore: Has the operating model outgrown informal coordination without delegating true execution authority?',
    conversationInquiries: [
      'If you completely detached from all company communications for 14 days, which deliverable or customer commitment would fail first?',
      'Which operational decisions reach your desk purely out of historical habit rather than actual necessity?'
    ]
  },
  'Decision Load': {
    name: 'Decision Load',
    qNums: [3, 4],
    operationalHypothesis: 'The founder functions as an operational clearinghouse. Direct reports escalate ambiguous issues rather than owning choices. Point to explore: Are decision thresholds and risk boundaries codified, or does fear of making mistakes push decisions upwards?',
    conversationInquiries: [
      'What recurring operational decision reached your desk this week that your leaders should have resolved independently?',
      'What would happen if a senior leader made an autonomous $10,000 decision without consulting you first?'
    ]
  },
  'Execution Rhythm': {
    name: 'Execution Rhythm',
    qNums: [5, 6],
    operationalHypothesis: 'Execution velocity relies on constant founder follow-up rather than self-sustaining cadence. Point to explore: Does delivery momentum depend on your emotional vigilance rather than clear operating milestones and accountability?',
    conversationInquiries: [
      'How many times do you find yourself following up on the same priority before it actually reaches completion?',
      'What objective review cadence ensures work progresses when you are not actively checking in?'
    ]
  },
  'Leadership Ownership': {
    name: 'Leadership Ownership',
    qNums: [7, 8],
    operationalHypothesis: 'Leaders function as execution coordinators rather than accountable business owners. Under ambiguity, they wait for directive guidance. Point to explore: Are authorities aligned to reward decisive autonomous ownership?',
    conversationInquiries: [
      'When unexpected problems arise, do direct reports bring you fully thought-out solutions to approve, or open-ended problems to solve?',
      'Who on your executive team is currently ready to take full, unassisted ownership of your biggest operational bottleneck?'
    ]
  },
  'Operational Resilience': {
    name: 'Operational Resilience',
    qNums: [9, 10],
    operationalHypothesis: 'The organization operates with minimal operational buffer. Surges in demand or unforeseen friction cause disproportionate delivery stress. Point to explore: Is capacity stretched due to process bottlenecks or team bandwidth?',
    conversationInquiries: [
      'If business volume increased by 50% next quarter, where would your organization\'s delivery or quality crack first?',
      'Which key individuals, if unavailable for a month, would jeopardize current business commitments?'
    ]
  }
};

/**
 * Analyzes whether scores are tied or if standout areas exist, plus detects intra-domain answer conflicts
 */
function analyzeScoreDistinction(
  domainScores: Array<{ domain: string; mean: number; normalised: number }>,
  answers?: any[]
) {
  if (!domainScores || domainScores.length === 0) {
    return {
      isTied: false,
      isAllTied: false,
      distinctionBadge: 'UNAVAILABLE',
      distinctionSummary: 'No domain scores recorded.',
      orderedDomains: [] as Array<{ domain: string; mean: number; normalised: number }>,
      topTied: [] as Array<{ domain: string; mean: number; normalised: number }>,
      divergentDomains: [] as Array<{ domain: string; q1: number; q2: number; diff: number; desc: string }>
    };
  }

  const sorted = [...domainScores].sort((a, b) => b.mean - a.mean);
  const maxMean = sorted[0].mean;
  const minMean = sorted[sorted.length - 1].mean;
  const topTied = sorted.filter(d => Math.abs(d.mean - maxMean) < 0.05);

  const isAllTied = maxMean === minMean;
  const isJoint = topTied.length > 1;

  let distinctionBadge = 'DISTINCT PRIMARY AREA';
  let distinctionSummary = '';

  if (isAllTied) {
    distinctionBadge = 'UNIFORM / TIED SIGNALS (ALL DOMAINS EQUAL)';
    distinctionSummary = 'The scan does not distinguish a single primary area. Scores are evenly tied across all five operational domains (100% intensity). This reflects diffuse, systemic pressure across both founder involvement and team execution rather than an isolated functional bottleneck. Focus the conversation on uncovering the root domino rather than attempting to fix all five areas at once.';
  } else if (isJoint) {
    const names = topTied.map(d => d.domain).join(' and ');
    distinctionBadge = `JOINT PRIMARY SIGNALS (${topTied.length} TIED HIGHEST)`;
    distinctionSummary = `The scan does not distinguish a single area, but identifies joint standout signals in ${names} (${topTied[0].normalised.toFixed(0)}%), separating them clearly from lower-scoring operational dimensions.`;
  } else {
    distinctionBadge = `STANDOUT AREA: ${sorted[0].domain.toUpperCase()}`;
    distinctionSummary = `${sorted[0].domain} stands out as the primary operational friction area at ${sorted[0].normalised.toFixed(0)}%, clearly exceeding other operational domains and representing the primary discussion anchor.`;
  }

  // Detect intra-domain divergent/conflicting answer patterns
  const divergentDomains: Array<{ domain: string; q1: number; q2: number; diff: number; desc: string }> = [];
  if (answers && Array.isArray(answers) && answers.length >= 10) {
    Object.values(DOMAIN_ADVISORY_PROFILES).forEach(profile => {
      const v1 = getAnswerValue(answers, profile.qNums[0]);
      const v2 = getAnswerValue(answers, profile.qNums[1]);
      const diff = Math.abs(v1 - v2);
      if (diff >= 2) {
        divergentDomains.push({
          domain: profile.name,
          q1: v1,
          q2: v2,
          diff,
          desc: `Q${profile.qNums[0]}=${SCALE_LABELS[v1] || v1} vs Q${profile.qNums[1]}=${SCALE_LABELS[v2] || v2}`
        });
      }
    });
  }

  if (divergentDomains.length > 0 && !isAllTied) {
    distinctionSummary += ` Divergent Patterns Note: Contrasting answers observed in ${divergentDomains.map(d => `${d.domain} (${d.desc})`).join('; ')}. The mean domain score masks contrasting operational realities; explore this variance in conversation.`;
  }

  return {
    isTied: isJoint,
    isAllTied,
    topTied,
    distinctionBadge,
    distinctionSummary,
    orderedDomains: sorted,
    divergentDomains
  };
}

/**
 * Helper to retrieve score value for question
 */
function getAnswerValue(answers: any[], qNum: number): number {
  if (!Array.isArray(answers)) return 3;
  const ansObj = answers.find(
    (a) => (a.questionNumber && a.questionNumber === qNum) || a.text === OFFICIAL_QUESTIONS[qNum - 1]?.text
  ) || answers[qNum - 1];

  if (typeof ansObj === 'number') return ansObj;
  return ansObj?.score ?? 3;
}

// ─────────────────────────────────────────────────────────────────────────────
// REPORT 1: INTERNAL ADVISOR BRIEFING DOSSIER (FOR MR. LIONEL EERSTELING)
// ─────────────────────────────────────────────────────────────────────────────
export function generateAdvisorBriefingPdf(data: PressureScanPdfData): Buffer {
  const doc = new SimplePdfDocument();
  const usableWidth = doc.getUsableWidth();
  const leftX = 40;

  // Obsidian & Gold luxury palette
  const navyBg: [number, number, number] = [0.008, 0.075, 0.161]; // #021329
  const goldAccent: [number, number, number] = [0.816, 0.639, 0.353]; // #D0A35A
  const textDark: [number, number, number] = [0.067, 0.082, 0.118]; // #11151E
  const textMuted: [number, number, number] = [0.412, 0.443, 0.502]; // #697180
  const lineBorder: [number, number, number] = [0.886, 0.867, 0.847]; // #E2DDD8
  const cardBg: [number, number, number] = [0.976, 0.969, 0.957]; // #F9F7F4
  const white: [number, number, number] = [1, 1, 1];

  const analysis = analyzeScoreDistinction(data.domainScores, data.answers);

  // ─── PAGE 1: STRATEGIC BRIEFING & SIGNAL DISTINCTION ───────────────────────
  doc.addRect(leftX, doc.currentY, usableWidth, 68, { fillColor: navyBg });
  doc.addText('LEADERS PERFORMANCE', leftX + 16, doc.currentY + 20, { font: 'F2', size: 9.5, color: goldAccent });
  doc.addText(`REF: ${data.referenceNumber}`, leftX + usableWidth - 130, doc.currentY + 20, { font: 'F2', size: 10, color: goldAccent });
  doc.addText('FOUNDER PRESSURE SCAN V1.0 - INTERNAL ADVISOR BRIEFING', leftX + 16, doc.currentY + 44, { font: 'F2', size: 12.5, color: white });

  doc.currentY += 76;

  // Founder Profile & Context Box
  doc.addRect(leftX, doc.currentY, usableWidth, 68, { fillColor: cardBg, strokeColor: lineBorder, lineWidth: 1 });
  const col1X = leftX + 14;
  const col2X = leftX + 185;
  const col3X = leftX + 355;

  doc.addText('FOUNDER / PARTICIPANT', col1X, doc.currentY + 15, { font: 'F2', size: 7.5, color: textMuted });
  doc.addText(data.fullName || 'Confidential Founder', col1X, doc.currentY + 28, { font: 'F2', size: 10.5, color: textDark });
  doc.addText(data.email || '—', col1X, doc.currentY + 41, { font: 'F1', size: 8.5, color: textMuted });
  if (data.phone) doc.addText(data.phone, col1X, doc.currentY + 54, { font: 'F1', size: 8.5, color: textMuted });

  doc.addText('ORGANISATION & SCALE', col2X, doc.currentY + 15, { font: 'F2', size: 7.5, color: textMuted });
  doc.addText(data.companyName || 'Confidential Enterprise', col2X, doc.currentY + 28, { font: 'F2', size: 10.5, color: textDark });
  const rev = data.submittedContext?.revenue || 'Under €1M';
  const stage = data.submittedContext?.companyStage || data.submittedContext?.stage || 'Scale-stage';
  doc.addText(`Revenue: ${rev}`, col2X, doc.currentY + 41, { font: 'F1', size: 8.5, color: textMuted });
  doc.addText(`Stage: ${stage}`, col2X, doc.currentY + 54, { font: 'F1', size: 8.5, color: textMuted });

  doc.addText('ADVISOR BRIEFING PURPOSE', col3X, doc.currentY + 15, { font: 'F2', size: 7.5, color: goldAccent });
  doc.addText('Mr. Lionel Eersteling (Private)', col3X, doc.currentY + 28, { font: 'F2', size: 9.5, color: navyBg });
  const subDateStr = data.submittedAt ? new Date(data.submittedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : new Date().toLocaleDateString('en-GB');
  doc.addText(`Submitted: ${subDateStr}`, col3X, doc.currentY + 41, { font: 'F1', size: 8.5, color: textMuted });
  doc.addText('Format: 30-Min Strategic Review', col3X, doc.currentY + 54, { font: 'F1', size: 8.5, color: textMuted });

  doc.currentY += 78;

  // Signal Distinction Analysis Box (Directly addresses Lionel's request for tied/standout distinction)
  const distBoxHeight = 90;
  doc.addRect(leftX, doc.currentY, usableWidth, distBoxHeight, {
    fillColor: [0.988, 0.980, 0.965],
    strokeColor: goldAccent,
    lineWidth: 1.2,
  });

  doc.addText('SIGNAL DISTINCTION & PRIMARY FOCUS ANALYSIS', leftX + 14, doc.currentY + 16, { font: 'F2', size: 8, color: goldAccent });
  doc.addText(analysis.distinctionBadge, leftX + 14, doc.currentY + 30, { font: 'F2', size: 10, color: navyBg });
  doc.addWrappedText(analysis.distinctionSummary, leftX + 14, doc.currentY + 44, usableWidth - 28, 11.5, {
    font: 'F1',
    size: 8,
    color: textDark,
  });

  doc.currentY += distBoxHeight + 14;

  // Five-Domain Intensity Snapshot Table
  doc.addText('FIVE-DOMAIN INTENSITY BREAKDOWN', leftX, doc.currentY + 12, { font: 'F2', size: 10, color: navyBg });
  doc.addLine(leftX, doc.currentY + 16, leftX + usableWidth, doc.currentY + 16, goldAccent, 0.75);
  doc.currentY += 22;

  doc.addRect(leftX, doc.currentY, usableWidth, 20, { fillColor: navyBg });
  doc.addText('DOMAIN', leftX + 10, doc.currentY + 14, { font: 'F2', size: 8, color: white });
  doc.addText('QUESTIONS', leftX + 180, doc.currentY + 14, { font: 'F2', size: 8, color: white });
  doc.addText('RAW MEAN', leftX + 270, doc.currentY + 14, { font: 'F2', size: 8, color: white });
  doc.addText('INTENSITY', leftX + 355, doc.currentY + 14, { font: 'F2', size: 8, color: white });
  doc.addText('DIRECTIONAL SIGNAL', leftX + 440, doc.currentY + 14, { font: 'F2', size: 8, color: white });

  doc.currentY += 20;

  const domainOrder = [
    'Founder Involvement',
    'Decision Load',
    'Execution Rhythm',
    'Leadership Ownership',
    'Operational Resilience'
  ];

  domainOrder.forEach((domName, idx) => {
    const scoreItem = data.domainScores.find(d => d.domain === domName) || { mean: 0, normalised: 0 };
    const rowBg: [number, number, number] = idx % 2 === 0 ? white : cardBg;

    doc.addRect(leftX, doc.currentY, usableWidth, 22, { fillColor: rowBg, strokeColor: lineBorder, lineWidth: 0.5 });
    doc.addText(domName, leftX + 10, doc.currentY + 15, { font: 'F2', size: 8.5, color: textDark });
    doc.addText(`Q${idx * 2 + 1} & Q${idx * 2 + 2}`, leftX + 180, doc.currentY + 15, { font: 'F1', size: 8, color: textMuted });
    doc.addText(scoreItem.mean.toFixed(2), leftX + 270, doc.currentY + 15, { font: 'F2', size: 8.5, color: textDark });
    doc.addText(`${scoreItem.normalised.toFixed(0)}%`, leftX + 355, doc.currentY + 15, { font: 'F2', size: 8.5, color: goldAccent });

    let sigLabel = 'Limited';
    if (scoreItem.normalised >= 75) sigLabel = 'Priority Signal';
    else if (scoreItem.normalised >= 50) sigLabel = 'Active Signal';
    else if (scoreItem.normalised >= 25) sigLabel = 'Emerging Signal';

    doc.addText(sigLabel, leftX + 440, doc.currentY + 15, { font: 'F2', size: 8, color: textDark });
    doc.currentY += 22;
  });

  doc.currentY += 12;

  // Scheduled Consultation Coordinates Box (Only shows Zoom link if scheduled!)
  if (data.scheduledReviewAt) {
    doc.addRect(leftX, doc.currentY, usableWidth, 54, { fillColor: cardBg, strokeColor: goldAccent, lineWidth: 1 });
    doc.addText('SCHEDULED 1-ON-1 CONVERSATION COORDINATES', leftX + 14, doc.currentY + 16, { font: 'F2', size: 8, color: goldAccent });
    const zoomUrl = data.zoomMeetingUrl || 'https://zoom.us/j/7114427991?pwd=leadersperformance';
    const dateStr = new Date(data.scheduledReviewAt).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', dateStyle: 'full', timeStyle: 'short' }) + ' (Dubai GST)';
    doc.addText(`Confirmed Slot: ${dateStr}`, leftX + 14, doc.currentY + 30, { font: 'F1', size: 8.5, color: textDark });
    doc.addText(`Zoom Meeting URL: ${zoomUrl}`, leftX + 14, doc.currentY + 43, { font: 'F2', size: 8.5, color: navyBg });
    doc.currentY += 66;
  } else {
    doc.addRect(leftX, doc.currentY, usableWidth, 42, { fillColor: cardBg, strokeColor: lineBorder, lineWidth: 0.75 });
    doc.addText('1-ON-1 REVIEW STATUS', leftX + 14, doc.currentY + 15, { font: 'F2', size: 8, color: goldAccent });
    doc.addText('Status: Pending Founder Scheduling | Slot reservation available via /diagnostics', leftX + 14, doc.currentY + 29, { font: 'F1', size: 8.5, color: textMuted });
    doc.currentY += 52;
  }

  // Footer for Page 1
  doc.addText('Strictly Confidential | Internal Executive Dossier for Lionel Eersteling | Leaders Performance', leftX, doc.currentY + 10, { font: 'F1', size: 7.5, color: textMuted });

  // ─── PAGE 2: OPERATIONAL HYPOTHESES & SUPPORTING EVIDENCE ──────────────────
  doc.startNewPage();

  doc.addRect(leftX, doc.currentY, usableWidth, 34, { fillColor: navyBg });
  doc.addText('DOMAIN OPERATIONAL HYPOTHESES & SUPPORTING EVIDENCE', leftX + 14, doc.currentY + 21, { font: 'F2', size: 10, color: white });
  doc.addText(`PAGE 2 OF 3`, leftX + usableWidth - 90, doc.currentY + 21, { font: 'F2', size: 9.5, color: goldAccent });

  doc.currentY += 44;

  domainOrder.forEach((domName) => {
    const profile = DOMAIN_ADVISORY_PROFILES[domName];
    const scoreItem = data.domainScores.find(d => d.domain === domName) || { mean: 0, normalised: 0 };
    const q1Val = getAnswerValue(data.answers, profile.qNums[0]);
    const q2Val = getAnswerValue(data.answers, profile.qNums[1]);
    const diff = Math.abs(q1Val - q2Val);
    const isMixed = diff >= 2;

    const cardHeight = isMixed ? 122 : 100;
    doc.addRect(leftX, doc.currentY, usableWidth, cardHeight, { fillColor: cardBg, strokeColor: lineBorder, lineWidth: 0.75 });

    // Domain header & score badge
    doc.addText(domName.toUpperCase(), leftX + 12, doc.currentY + 15, { font: 'F2', size: 9, color: navyBg });
    doc.addText(`Intensity: ${scoreItem.mean.toFixed(2)}/5.00 (${scoreItem.normalised.toFixed(0)}%)`, leftX + usableWidth - 140, doc.currentY + 15, { font: 'F2', size: 8, color: goldAccent });

    if (isMixed) {
      doc.addText(`[!] MIXED PATTERN (DELTA: ${diff} PTS)`, leftX + 175, doc.currentY + 15, { font: 'F2', size: 7.5, color: [0.75, 0.2, 0.1] });
    }

    // Operational hypothesis (Framed as point to explore, NOT confirmed fact)
    doc.addText('OPERATIONAL HYPOTHESIS (POINT TO EXPLORE - NOT A CONFIRMED FACT):', leftX + 12, doc.currentY + 28, { font: 'F2', size: 7, color: goldAccent });
    doc.addWrappedText(profile.operationalHypothesis, leftX + 12, doc.currentY + 38, usableWidth - 24, 10, {
      font: 'F1',
      size: 7.5,
      color: textDark,
    });

    let evidenceStartY = doc.currentY + 68;

    if (isMixed) {
      // Divergent answers qualification note
      doc.addText('EVIDENCE QUALIFICATION (DIVERGENT ANSWERS):', leftX + 12, doc.currentY + 68, { font: 'F2', size: 7, color: [0.75, 0.2, 0.1] });
      const qualNote = `Q${profile.qNums[0]} scored "${SCALE_LABELS[q1Val]}" while Q${profile.qNums[1]} scored "${SCALE_LABELS[q2Val]}". Note for Lionel: The average score (${scoreItem.mean.toFixed(2)}) masks internal polarity. Treat as situational variance to explore, not a uniform baseline.`;
      doc.addWrappedText(qualNote, leftX + 12, doc.currentY + 77, usableWidth - 24, 9, { font: 'F1', size: 7, color: textDark });
      evidenceStartY = doc.currentY + 95;
    }

    // Supporting answers
    doc.addText('RECORDED FOUNDER RESPONSES:', leftX + 12, evidenceStartY, { font: 'F2', size: 7, color: textMuted });
    const q1Text = `Q${profile.qNums[0]}: ${OFFICIAL_QUESTIONS[profile.qNums[0] - 1].text.substring(0, 72)}... -> [${SCALE_LABELS[q1Val] || q1Val}]`;
    const q2Text = `Q${profile.qNums[1]}: ${OFFICIAL_QUESTIONS[profile.qNums[1] - 1].text.substring(0, 72)}... -> [${SCALE_LABELS[q2Val] || q2Val}]`;

    doc.addText(q1Text, leftX + 12, evidenceStartY + 10, { font: 'F1', size: 7, color: textDark });
    doc.addText(q2Text, leftX + 12, evidenceStartY + 20, { font: 'F1', size: 7, color: textDark });

    doc.currentY += cardHeight + 8;
  });

  // Footer for Page 2
  doc.addText('Strictly Confidential | Operational Diagnostics & Evidence Trail | Leaders Performance', leftX, doc.currentY + 8, { font: 'F1', size: 7.5, color: textMuted });

  // ─── PAGE 3: STRATEGIC CONVERSATION BLUEPRINT FOR LIONEL ──────────────────
  doc.startNewPage();

  doc.addRect(leftX, doc.currentY, usableWidth, 34, { fillColor: navyBg });
  doc.addText('STRATEGIC CONVERSATION BLUEPRINT - PREPARED FOR LIONEL EERSTELING', leftX + 14, doc.currentY + 21, { font: 'F2', size: 10, color: white });
  doc.addText(`PAGE 3 OF 3`, leftX + usableWidth - 90, doc.currentY + 21, { font: 'F2', size: 9.5, color: goldAccent });

  doc.currentY += 44;

  // Review Focus & Logical Flow Box
  doc.addRect(leftX, doc.currentY, usableWidth, 68, { fillColor: [0.988, 0.980, 0.965], strokeColor: goldAccent, lineWidth: 1 });
  doc.addText('RECOMMENDED CONVERSATION FLOW & STRATEGIC FOCUS', leftX + 14, doc.currentY + 16, { font: 'F2', size: 8, color: goldAccent });
  
  let flowFocusText = '';
  if (analysis.isAllTied) {
    flowFocusText = 'Scores are tied across all five domains (100% intensity). RECOMMENDED FLOW: Do not attempt to tackle all five domains during the 30-minute review. Anchor the conversation by asking: "Which of these five friction areas caused you the most operational disruption this past week?" to identify their immediate psychological priority and root domino.';
  } else if (analysis.isTied && analysis.topTied.length > 0) {
    flowFocusText = `Joint primary signals in ${analysis.topTied.map(d => d.domain).join(' & ')} (${analysis.topTied[0].normalised.toFixed(0)}%). RECOMMENDED FLOW: Explore how these two areas interact before moving to secondary operational domains.`;
  } else {
    flowFocusText = `Primary standout signal in ${analysis.orderedDomains[0]?.domain} (${analysis.orderedDomains[0]?.normalised.toFixed(0)}%). RECOMMENDED FLOW: Open by validating this primary friction point, explore the operational hypotheses, examine any contrasting answers, and co-design a single high-leverage delegation shift.`;
  }

  doc.addWrappedText(flowFocusText, leftX + 14, doc.currentY + 28, usableWidth - 28, 11, { font: 'F1', size: 8, color: textDark });
  doc.currentY += 78;

  doc.addText('CURATED EXPLORATION QUESTIONS FOR 1-ON-1 REVIEW', leftX, doc.currentY + 12, { font: 'F2', size: 9.5, color: navyBg });
  doc.addText('Framed as collaborative exploration rather than confirmed clinical diagnoses:', leftX, doc.currentY + 23, { font: 'F1', size: 8, color: textMuted });
  doc.addLine(leftX, doc.currentY + 27, leftX + usableWidth, doc.currentY + 27, goldAccent, 0.75);

  doc.currentY += 34;

  const curatedQuestions = [
    {
      theme: '1. UNHOOKING THE FOUNDER AS THE OPERATIONAL BOTTLE NECK',
      question: 'If you stepped away completely for 14 consecutive days with zero phone or message connectivity, which deliverable or customer commitment would fail first?'
    },
    {
      theme: '2. DECENTRALIZING DECISION-MAKING & CODIFYING THRESHOLDS',
      question: 'What recurring operational decision reached your desk this past week that your leadership team should have made with 100% autonomy?'
    },
    {
      theme: '3. AUTONOMOUS LEADERSHIP & DEFERRAL OF CONSEQUENCE',
      question: 'When unexpected operational challenges arise, do direct reports bring you fully thought-out solutions to approve, or open-ended problems to solve?'
    },
    {
      theme: '4. ACCOUNTABILITY CADENCE VS. EMOTIONAL PROMPTING',
      question: 'How many times do you find yourself following up on the same key strategic priority before your organization actually brings it to completion?'
    },
    {
      theme: '5. ORGANIZATIONAL CAPACITY & FAILURE LIMITS',
      question: 'If business volume surged by 50% next quarter, where would your organization\'s delivery consistency or team quality crack first?'
    }
  ];

  curatedQuestions.forEach((qItem) => {
    doc.addRect(leftX, doc.currentY, usableWidth, 40, { fillColor: cardBg, strokeColor: lineBorder, lineWidth: 0.75 });
    doc.addText(qItem.theme, leftX + 12, doc.currentY + 13, { font: 'F2', size: 7.5, color: goldAccent });
    doc.addWrappedText(`"${qItem.question}"`, leftX + 12, doc.currentY + 25, usableWidth - 24, 10, { font: 'F3', size: 8, color: navyBg });
    doc.currentY += 46;
  });

  doc.currentY += 6;

  // Structured Consultation Notes Box
  doc.addRect(leftX, doc.currentY, usableWidth, 90, { fillColor: white, strokeColor: goldAccent, lineWidth: 1 });
  doc.addText('MR. LIONEL EERSTELING - STRATEGIC SESSION NOTES & ACTION DISCOVERY', leftX + 14, doc.currentY + 16, { font: 'F2', size: 8, color: navyBg });
  doc.addText('Record agreed decoupling actions, decision boundaries, or next roadmap priorities:', leftX + 14, doc.currentY + 27, { font: 'F1', size: 7.5, color: textMuted });

  for (let i = 0; i < 3; i++) {
    const lineY = doc.currentY + 42 + i * 16;
    doc.addLine(leftX + 14, lineY, leftX + usableWidth - 14, lineY, [0.92, 0.90, 0.88], 0.5);
  }

  doc.currentY += 100;

  // Footer for Page 3
  doc.addText('Strictly Confidential | Advisors Executive Preparation Blueprint | Leaders Performance', leftX, doc.currentY + 8, { font: 'F1', size: 7.5, color: textMuted });

  return doc.compileBuffer();
}

// ─────────────────────────────────────────────────────────────────────────────
// REPORT 2: PARTICIPANT-FACING RESULTS REPORT (FOR THE FOUNDER)
// ─────────────────────────────────────────────────────────────────────────────
export function generateParticipantResultsPdf(data: PressureScanPdfData): Buffer {
  const doc = new SimplePdfDocument();
  const usableWidth = doc.getUsableWidth();
  const leftX = 40;

  // Obsidian & Warm Cream luxury branding
  const navyBg: [number, number, number] = [0.008, 0.075, 0.161]; // #021329
  const goldAccent: [number, number, number] = [0.816, 0.639, 0.353]; // #D0A35A
  const textDark: [number, number, number] = [0.067, 0.082, 0.118]; // #11151E
  const textMuted: [number, number, number] = [0.412, 0.443, 0.502]; // #697180
  const lineBorder: [number, number, number] = [0.886, 0.867, 0.847]; // #E2DDD8
  const cardBg: [number, number, number] = [0.976, 0.969, 0.957]; // #F9F7F4
  const white: [number, number, number] = [1, 1, 1];

  const analysis = analyzeScoreDistinction(data.domainScores, data.answers);

  // ─── PAGE 1: PARTICIPANT EXECUTIVE SUMMARY ──────────────────────────────────
  doc.addRect(leftX, doc.currentY, usableWidth, 68, { fillColor: navyBg });
  doc.addText('LEADERS PERFORMANCE', leftX + 16, doc.currentY + 20, { font: 'F2', size: 9.5, color: goldAccent });
  doc.addText(`REF: ${data.referenceNumber}`, leftX + usableWidth - 130, doc.currentY + 20, { font: 'F2', size: 10, color: goldAccent });
  doc.addText('FOUNDER PRESSURE SCAN V1.0 - EXECUTIVE RESULTS REPORT', leftX + 16, doc.currentY + 44, { font: 'F2', size: 12.5, color: white });

  doc.currentY += 76;

  // Participant Metadata Box
  doc.addRect(leftX, doc.currentY, usableWidth, 60, { fillColor: cardBg, strokeColor: lineBorder, lineWidth: 1 });
  doc.addText('PREPARED EXCLUSIVELY FOR', leftX + 14, doc.currentY + 15, { font: 'F2', size: 7.5, color: goldAccent });
  doc.addText(data.fullName || 'Participating Founder', leftX + 14, doc.currentY + 28, { font: 'F2', size: 10.5, color: textDark });
  doc.addText(data.companyName || 'Enterprise', leftX + 14, doc.currentY + 42, { font: 'F1', size: 8.5, color: textMuted });

  const rightMetaX = leftX + usableWidth - 190;
  doc.addText('DIAGNOSTIC VERIFICATION', rightMetaX, doc.currentY + 15, { font: 'F2', size: 7.5, color: textMuted });
  const subDateStr = data.submittedAt ? new Date(data.submittedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : new Date().toLocaleDateString('en-GB');
  doc.addText(`Completed: ${subDateStr}`, rightMetaX, doc.currentY + 28, { font: 'F1', size: 8.5, color: textDark });
  doc.addText('Advisory Host: Lionel Eersteling', rightMetaX, doc.currentY + 42, { font: 'F1', size: 8.5, color: textMuted });

  doc.currentY += 70;

  // Directional Executive Summary Box
  const summaryBoxHeight = 84;
  doc.addRect(leftX, doc.currentY, usableWidth, summaryBoxHeight, { fillColor: [0.988, 0.980, 0.965], strokeColor: goldAccent, lineWidth: 1.2 });
  doc.addText('DIRECTIONAL SUMMARY & ORGANISATIONAL FOCUS', leftX + 14, doc.currentY + 16, { font: 'F2', size: 8, color: goldAccent });
  
  const headline = analysis.isAllTied
    ? 'Systemic Operational Demand Distributed Across All Five Domains'
    : `Primary Focus Concentration: ${data.primarySignalAreas.join(' & ')}`;
  doc.addText(headline, leftX + 14, doc.currentY + 30, { font: 'F2', size: 10, color: navyBg });

  const explanation = analysis.isAllTied
    ? 'Your responses reflect that operational demand is distributed evenly across your organization rather than bottlenecked in a single department. Founder involvement, decision escalations, and execution cadence are interacting simultaneously. Your upcoming review with Lionel Eersteling will focus on identifying the primary lever to decouple this cycle.'
    : `Your responses highlight ${data.primarySignalAreas.join(' and ')} as the key area where operational dependency concentrates. Clarifying decision boundaries and operational cadence in this domain will yield the highest immediate organizational velocity.`;

  doc.addWrappedText(explanation, leftX + 14, doc.currentY + 44, usableWidth - 28, 11.5, { font: 'F1', size: 8, color: textDark });

  doc.currentY += summaryBoxHeight + 12;

  // Directional Scale Legend (Explaining labels without risk percentages)
  doc.addRect(leftX, doc.currentY, usableWidth, 38, { fillColor: cardBg, strokeColor: lineBorder, lineWidth: 0.5 });
  doc.addText('DIRECTIONAL SCALE DEFINITIONS (OPERATIONAL DRAG INDICATOR, NOT A RISK PERCENTAGE):', leftX + 10, doc.currentY + 12, { font: 'F2', size: 7, color: goldAccent });
  doc.addText('Priority (75-100%): Concentrated friction', leftX + 10, doc.currentY + 24, { font: 'F1', size: 7, color: textDark });
  doc.addText('Active (50-74%): Operational drag present', leftX + 140, doc.currentY + 24, { font: 'F1', size: 7, color: textDark });
  doc.addText('Emerging (25-49%): Occasional friction', leftX + 275, doc.currentY + 24, { font: 'F1', size: 7, color: textDark });
  doc.addText('Limited (0-24%): Healthy autonomy', leftX + 395, doc.currentY + 24, { font: 'F1', size: 7, color: textDark });

  doc.currentY += 46;

  // 5 Domains Summary Table
  doc.addText('THE FIVE OPERATIONAL DOMAINS - OBSERVED LEVELS', leftX, doc.currentY + 12, { font: 'F2', size: 9.5, color: navyBg });
  doc.addLine(leftX, doc.currentY + 16, leftX + usableWidth, doc.currentY + 16, goldAccent, 0.75);
  doc.currentY += 22;

  const domainExplanations = [
    { name: 'Founder Involvement', desc: 'Day-to-day progress dependency and operational momentum during founder absence.' },
    { name: 'Decision Load', desc: 'Volume of operational choices waiting on founder approval versus autonomous resolution.' },
    { name: 'Execution Rhythm', desc: 'Reliability of delivery commitments proceeding without continuous founder prompting.' },
    { name: 'Leadership Ownership', desc: 'Senior leaders taking proactive ownership of ambiguity versus escalating accountability.' },
    { name: 'Operational Resilience', desc: 'Organizational elasticity and performance stability under sustained demand surges.' },
  ];

  domainExplanations.forEach((item, idx) => {
    const scoreItem = data.domainScores.find(d => d.domain === item.name) || { mean: 0, normalised: 0 };
    const rowBg: [number, number, number] = idx % 2 === 0 ? white : cardBg;

    doc.addRect(leftX, doc.currentY, usableWidth, 34, { fillColor: rowBg, strokeColor: lineBorder, lineWidth: 0.5 });
    doc.addText(item.name.toUpperCase(), leftX + 12, doc.currentY + 13, { font: 'F2', size: 8, color: navyBg });

    let sigLabel = 'Limited Signal';
    if (scoreItem.normalised >= 75) sigLabel = 'Priority Signal';
    else if (scoreItem.normalised >= 50) sigLabel = 'Active Signal';
    else if (scoreItem.normalised >= 25) sigLabel = 'Emerging Signal';

    doc.addText(`${sigLabel} (${scoreItem.normalised.toFixed(0)}%)`, leftX + usableWidth - 130, doc.currentY + 13, { font: 'F2', size: 7.5, color: goldAccent });
    doc.addWrappedText(item.desc, leftX + 12, doc.currentY + 24, usableWidth - 24, 9, { font: 'F1', size: 7, color: textMuted });

    doc.currentY += 38;
  });

  doc.currentY += 8;

  // Next Step Box: Review Conversation
  doc.addRect(leftX, doc.currentY, usableWidth, 52, { fillColor: cardBg, strokeColor: goldAccent, lineWidth: 1 });
  doc.addText('YOUR 1-ON-1 STRATEGIC REVIEW CONVERSATION', leftX + 14, doc.currentY + 15, { font: 'F2', size: 7.5, color: goldAccent });
  const reviewNote = data.scheduledReviewAt
    ? `Your 30-minute private consultation with Lionel Eersteling is confirmed for ${new Date(data.scheduledReviewAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}. Check your inbox for Zoom access coordinates.`
    : 'You are invited to a private 30-minute Strategic Review Conversation with Lionel Eersteling to translate these signals into clear organizational decoupling actions.';
  doc.addWrappedText(reviewNote, leftX + 14, doc.currentY + 27, usableWidth - 28, 10, { font: 'F1', size: 7.5, color: textDark });

  doc.currentY += 62;

  // Footer for Page 1
  doc.addText('Leaders Performance | Confidential Founder Results Dossier | Leaders Performance LLC', leftX, doc.currentY + 8, { font: 'F1', size: 7.5, color: textMuted });

  // ─── PAGE 2: METHODOLOGY LIMITS & RECORDED AUDIT RESPONSES ─────────────────
  doc.startNewPage();

  doc.addRect(leftX, doc.currentY, usableWidth, 34, { fillColor: navyBg });
  doc.addText('METHODOLOGY LIMITS & RECORDED RESPONSES', leftX + 14, doc.currentY + 21, { font: 'F2', size: 10, color: white });
  doc.addText(`PAGE 2 OF 2`, leftX + usableWidth - 90, doc.currentY + 21, { font: 'F2', size: 9.5, color: goldAccent });

  doc.currentY += 44;

  doc.addText('HOW TO INTERPRET YOUR DIRECTIONAL RESULTS', leftX, doc.currentY + 12, { font: 'F2', size: 9.5, color: navyBg });
  doc.addLine(leftX, doc.currentY + 16, leftX + usableWidth, doc.currentY + 16, goldAccent, 0.75);
  doc.currentY += 22;

  const guidancePoints = [
    {
      title: '1. Directional, Not Diagnostic or Clinical',
      text: 'The Founder Pressure Scan is an executive operational inquiry designed to reveal where founder dependency limits organizational velocity. It is not an assessment of personal capability or psychological stress.'
    },
    {
      title: '2. Natural Stages of Scaling',
      text: 'Heavy dependency on personal founder involvement is standard and effective during early scaling. However, as an enterprise scales, informal oversight becomes a ceiling on organizational execution.'
    },
    {
      title: '3. Focus on the Root Domino',
      text: 'Rather than trying to resolve every friction point at once, executive decoupling focuses on one high-leverage shift—typically codifying decision thresholds so your leadership team can act autonomously without upward escalation.'
    }
  ];

  guidancePoints.forEach((pt) => {
    doc.addRect(leftX, doc.currentY, usableWidth, 50, { fillColor: cardBg, strokeColor: lineBorder, lineWidth: 0.75 });
    doc.addText(pt.title, leftX + 14, doc.currentY + 14, { font: 'F2', size: 8, color: navyBg });
    doc.addWrappedText(pt.text, leftX + 14, doc.currentY + 26, usableWidth - 28, 10, { font: 'F1', size: 7.5, color: textDark });
    doc.currentY += 56;
  });

  doc.currentY += 6;

  // Complete Audit Question Answers Reference for Founder
  doc.addText('YOUR RECORDED RESPONSES', leftX, doc.currentY + 12, { font: 'F2', size: 9, color: navyBg });
  doc.addLine(leftX, doc.currentY + 16, leftX + usableWidth, doc.currentY + 16, goldAccent, 0.75);
  doc.currentY += 22;

  OFFICIAL_QUESTIONS.forEach((q) => {
    const val = getAnswerValue(data.answers, q.qNum);
    doc.addText(`Q${q.qNum} (${q.domain}):`, leftX + 10, doc.currentY + 11, { font: 'F2', size: 7, color: textDark });
    doc.addText(SCALE_LABELS[val] || `${val}/5`, leftX + usableWidth - 110, doc.currentY + 11, { font: 'F2', size: 7, color: goldAccent });
    doc.addText(q.text.substring(0, 78) + '...', leftX + 130, doc.currentY + 11, { font: 'F1', size: 7, color: textMuted });
    doc.currentY += 16;
  });

  doc.currentY += 10;

  // Regulatory Governance Notice
  doc.addRect(leftX, doc.currentY, usableWidth, 38, { fillColor: [0.95, 0.95, 0.95], strokeColor: lineBorder, lineWidth: 0.5 });
  doc.addText('LEADERS PERFORMANCE - GOVERNANCE & LEGAL COMPLIANCE', leftX + 10, doc.currentY + 13, { font: 'F2', size: 7, color: textMuted });
  doc.addWrappedText(
    'This directional report is non-clinical and intended solely for organizational performance analysis. Data is handled under strict UAE PDPL and GDPR compliance. Leaders Performance LLC, Dubai, UAE.',
    leftX + 10,
    doc.currentY + 24,
    usableWidth - 20,
    9,
    { font: 'F1', size: 6.5, color: textMuted }
  );

  return doc.compileBuffer();
}

/**
 * Main export: Defaults to internal advisor briefing, but supports participant report
 */
export function generatePressureScanPdf(
  data: PressureScanPdfData,
  audience: 'internal' | 'participant' = 'internal'
): Buffer {
  if (audience === 'participant') {
    return generateParticipantResultsPdf(data);
  }
  return generateAdvisorBriefingPdf(data);
}
