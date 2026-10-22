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

import { SimplePdfDocument, getTextWidth, wrapLines, sanitizeText } from './masterclassPdfService';

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
function getApprovedSignalBadge(mean: number): string {
  return mean >= 3.5 ? 'Emerging Signal' : 'Subtle / Balanced';
}

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
    distinctionBadge = 'EQUALLY STRONG REPORTED SIGNALS (ALL 5 DOMAINS EQUAL)';
    distinctionSummary = 'The scan reflects equally strong reported pressure across all five operational domains (5.00/5.00 — Emerging Signals) rather than an isolated functional bottleneck. Any suggestion that they interact or reinforce one another is framed as a possibility to explore in the review, not as an established finding. Recommended review flow: Anchor the opening discussion on the founder\'s immediate acute pain ("Which of these five friction areas caused you the most operational disruption this past week?") to uncover the root domino.';
  } else if (isJoint) {
    const names = topTied.map(d => d.domain).join(' & ');
    distinctionBadge = `JOINT FOCUS SIGNALS (${topTied.length} TIED HIGHEST)`;
    distinctionSummary = `The scan identifies joint standout signals in ${names} (${getApprovedSignalBadge(topTied[0].mean)}), distinguishing them from lower-scoring operational dimensions.`;
  } else {
    const isEmerging = sorted[0].mean >= 3.5;
    distinctionBadge = `PRIMARY SIGNAL: ${sorted[0].domain.toUpperCase()} (${getApprovedSignalBadge(sorted[0].mean).toUpperCase()})`;
    distinctionSummary = `${sorted[0].domain} stands out as the primary focus area at ${sorted[0].mean.toFixed(2)}/5.00 (${sorted[0].normalised.toFixed(0)}% intensity), representing the primary discussion anchor for the review.`;
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
    distinctionSummary += ` Divergent Patterns Note: Contrasting answers observed in ${divergentDomains.map(d => `${d.domain} (${d.desc})`).join('; ')}. The mean domain score masks contrasting operational realities; explore this variance in conversation without drawing a firm conclusion.`;
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
  doc.footerLabel = 'Founder Pressure Scan V1.0';
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
  const rev = (data.submittedContext?.revenue || 'Under EUR 1M').replace(/€/g, 'EUR ');
  const stage = data.submittedContext?.companyStage || data.submittedContext?.stage || 'Scale-stage';
  doc.addText(`Revenue: ${rev}`, col2X, doc.currentY + 41, { font: 'F1', size: 8.5, color: textMuted });
  doc.addText(`Stage: ${stage}`, col2X, doc.currentY + 54, { font: 'F1', size: 8.5, color: textMuted });

  doc.addText('ADVISOR BRIEFING PURPOSE', col3X, doc.currentY + 15, { font: 'F2', size: 7.5, color: goldAccent });
  doc.addText('Mr. Lionel Eersteling (Private)', col3X, doc.currentY + 28, { font: 'F2', size: 9.5, color: navyBg });
  const subDateStr = data.submittedAt ? new Date(data.submittedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : new Date().toLocaleDateString('en-GB');
  doc.addText(`Submitted: ${subDateStr}`, col3X, doc.currentY + 41, { font: 'F1', size: 8.5, color: textMuted });
  doc.addText('Format: 30-Min Strategic Review', col3X, doc.currentY + 54, { font: 'F1', size: 8.5, color: textMuted });

  doc.currentY += 78;

  // Signal Distinction Analysis Box (Dynamic Height)
  const distLines = wrapLines(analysis.distinctionSummary, usableWidth - 28, 8, false);
  const distBoxHeight = 44 + distLines.length * 11.5 + 12;
  doc.addRect(leftX, doc.currentY, usableWidth, distBoxHeight, {
    fillColor: [0.988, 0.980, 0.965],
    strokeColor: goldAccent,
    lineWidth: 1.2,
  });

  doc.addText('SIGNAL DISTINCTION & PRIMARY FOCUS ANALYSIS', leftX + 14, doc.currentY + 15, { font: 'F2', size: 8, color: goldAccent });
  doc.addText(analysis.distinctionBadge, leftX + 14, doc.currentY + 28, { font: 'F2', size: 9.5, color: navyBg });
  let curDistY = doc.currentY + 42;
  for (const line of distLines) {
    doc.addText(line, leftX + 14, curDistY, { font: 'F1', size: 8, color: textDark });
    curDistY += 11.5;
  }

  doc.currentY += distBoxHeight + 12;

  // Five-Domain Intensity Snapshot Table (Approved V1.0 Categories: Emerging Signal vs Subtle / Balanced)
  doc.addText('FIVE-DOMAIN INTENSITY BREAKDOWN (V1.0 SPECIFICATION)', leftX, doc.currentY + 12, { font: 'F2', size: 9.5, color: navyBg });
  doc.addLine(leftX, doc.currentY + 16, leftX + usableWidth, doc.currentY + 16, goldAccent, 0.75);
  doc.currentY += 22;

  doc.addRect(leftX, doc.currentY, usableWidth, 20, { fillColor: navyBg });
  doc.addText('DOMAIN', leftX + 12, doc.currentY + 14, { font: 'F2', size: 8, color: white });
  doc.addText('QUESTIONS', leftX + 165, doc.currentY + 14, { font: 'F2', size: 8, color: white });
  doc.addText('RAW MEAN', leftX + 250, doc.currentY + 14, { font: 'F2', size: 8, color: white });
  doc.addText('INTENSITY', leftX + 325, doc.currentY + 14, { font: 'F2', size: 8, color: white });
  doc.addText('SIGNAL STATUS', leftX + 400, doc.currentY + 14, { font: 'F2', size: 8, color: white });

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
    doc.addText(domName, leftX + 12, doc.currentY + 15, { font: 'F2', size: 8.5, color: textDark });
    doc.addText(`Q${idx * 2 + 1} & Q${idx * 2 + 2}`, leftX + 165, doc.currentY + 15, { font: 'F1', size: 8, color: textMuted });
    doc.addText(scoreItem.mean.toFixed(2), leftX + 250, doc.currentY + 15, { font: 'F2', size: 8.5, color: textDark });
    doc.addText(`${scoreItem.normalised.toFixed(0)}%`, leftX + 325, doc.currentY + 15, { font: 'F2', size: 8.5, color: goldAccent });

    const sigStatus = getApprovedSignalBadge(scoreItem.mean);
    const sigColor: [number, number, number] = scoreItem.mean >= 3.5 ? goldAccent : textDark;
    doc.addText(sigStatus, leftX + 400, doc.currentY + 15, { font: 'F2', size: 8, color: sigColor });
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

    // Point 2: Correct mixed-pattern interpretation without drawing firm conclusion
    let dynamicHypothesis = profile.operationalHypothesis;
    if (domName === 'Founder Involvement' && isMixed) {
      dynamicHypothesis = 'Contrasting responses recorded (Q1: Never vs Q2: Consistently). The founder reports that routine day-to-day operations proceed without constant personal involvement, yet operational momentum reportedly pauses when unavailable. Point to explore: Rather than the founder acting as the daily operational bottleneck, does momentum pause due to specific uncodified decision escalations or key external commitments?';
    } else if (isMixed) {
      dynamicHypothesis = `Contrasting responses recorded (Q${profile.qNums[0]}=${SCALE_LABELS[q1Val]} vs Q${profile.qNums[1]}=${SCALE_LABELS[q2Val]}). The domain mean masks contrasting operational realities. Point to explore: Examine what specific conditions trigger this operational friction rather than assuming a uniform baseline.`;
    }

    const hypoLines = wrapLines(dynamicHypothesis, usableWidth - 28, 7.5, false);
    const hypoTextHeight = hypoLines.length * 10.5;

    // Calculate exact card height dynamically
    const cardContentHeight = 24 + (isMixed ? 30 : 0) + 14 + hypoTextHeight + 8 + 12 + 22 + 14;
    const cardHeight = Math.max(isMixed ? 128 : 98, cardContentHeight);

    const cardTopY = doc.currentY;
    doc.addRect(leftX, cardTopY, usableWidth, cardHeight, { fillColor: cardBg, strokeColor: lineBorder, lineWidth: 0.75 });

    // Domain header & right-aligned score badge (guaranteed no horizontal overlap)
    const sigStatus = getApprovedSignalBadge(scoreItem.mean);
    doc.addText(domName.toUpperCase(), leftX + 14, cardTopY + 15, { font: 'F2', size: 9, color: navyBg });

    const scoreStr = `Mean: ${scoreItem.mean.toFixed(2)}/5.00 (${scoreItem.normalised.toFixed(0)}%)  |  ${sigStatus}`;
    const scoreW = getTextWidth(scoreStr, 8, true);
    const sigColor: [number, number, number] = scoreItem.mean >= 3.5 ? goldAccent : textDark;
    doc.addText(scoreStr, leftX + usableWidth - 14 - scoreW, cardTopY + 15, { font: 'F2', size: 8, color: sigColor });

    let curCardY = cardTopY + 24;

    if (isMixed) {
      // Mixed pattern callout on its OWN line with ample margin - zero collision!
      const pillHeight = 16;
      doc.addRect(leftX + 14, curCardY, usableWidth - 28, pillHeight, { fillColor: [0.99, 0.94, 0.93], strokeColor: [0.85, 0.30, 0.25], lineWidth: 0.5 });
      const mixedText = `[!] CONFLICTING RESPONSES: Q${profile.qNums[0]} (${SCALE_LABELS[q1Val]}) vs Q${profile.qNums[1]} (${SCALE_LABELS[q2Val]}) - DELTA: ${diff} POINTS`;
      doc.addText(mixedText, leftX + 22, curCardY + 11.5, { font: 'F2', size: 7.5, color: [0.75, 0.15, 0.10] });
      curCardY += pillHeight + 14; // Generous 14pt gap before hypothesis heading
    } else {
      curCardY += 6;
    }

    // Operational hypothesis (Framed as point to explore, NOT confirmed fact)
    doc.addText('OPERATIONAL HYPOTHESIS (POINT TO EXPLORE - NOT A CONFIRMED FACT):', leftX + 14, curCardY, { font: 'F2', size: 7.5, color: goldAccent });
    curCardY += 12;
    for (const line of hypoLines) {
      doc.addText(line, leftX + 14, curCardY, { font: 'F1', size: 7.5, color: textDark });
      curCardY += 10.5;
    }
    curCardY += 8;

    // Supporting answers (Rendered strictly below dynamic hypothesis - zero clipping or overlap!)
    doc.addText('RECORDED FOUNDER RESPONSES (EVIDENCE AUDIT):', leftX + 14, curCardY, { font: 'F2', size: 7, color: textMuted });
    curCardY += 11;
    const q1Full = OFFICIAL_QUESTIONS[profile.qNums[0] - 1].text;
    const q2Full = OFFICIAL_QUESTIONS[profile.qNums[1] - 1].text;
    const q1Text = `Q${profile.qNums[0]}: ${q1Full.length > 76 ? q1Full.substring(0, 75) + '...' : q1Full} -> [${SCALE_LABELS[q1Val] || q1Val}]`;
    const q2Text = `Q${profile.qNums[1]}: ${q2Full.length > 76 ? q2Full.substring(0, 75) + '...' : q2Full} -> [${SCALE_LABELS[q2Val] || q2Val}]`;

    doc.addText(q1Text, leftX + 14, curCardY, { font: 'F1', size: 7, color: textDark });
    curCardY += 10;
    doc.addText(q2Text, leftX + 14, curCardY, { font: 'F1', size: 7, color: textDark });

    doc.currentY = cardTopY + cardHeight + 8;
  });

  // ─── PAGE 3: STRATEGIC CONVERSATION BLUEPRINT FOR LIONEL ──────────────────
  doc.startNewPage();

  doc.addRect(leftX, doc.currentY, usableWidth, 34, { fillColor: navyBg });
  doc.addText('STRATEGIC CONVERSATION BLUEPRINT - PREPARED FOR LIONEL EERSTELING', leftX + 14, doc.currentY + 21, { font: 'F2', size: 10, color: white });
  doc.addText(`PAGE 3 OF 3`, leftX + usableWidth - 90, doc.currentY + 21, { font: 'F2', size: 9.5, color: goldAccent });

  doc.currentY += 44;

  // Review Focus & Logical Flow Box (Point 5: describe 5 domains as equally strong signals, interaction framed as possibility to explore)
  let flowFocusText = '';
  if (analysis.isAllTied) {
    flowFocusText = 'Scores are tied across all five domains (5.00 / 5.00 — Emerging Signals). RECOMMENDED REVIEW FLOW: Describe the five domains as equally strong reported signals. Frame any potential interaction or reinforcement between them as a possibility to explore in the review, not as an established finding. Anchor the opening question on immediate acute pain: "Which of these five friction areas caused you the most operational disruption this past week?" to identify the root domino.';
  } else if (analysis.isTied && analysis.topTied.length > 0) {
    flowFocusText = `Joint primary signals in ${analysis.topTied.map(d => d.domain).join(' & ')} (${getApprovedSignalBadge(analysis.topTied[0].mean)}). RECOMMENDED FLOW: Explore how these two areas relate before moving to secondary operational dimensions.`;
  } else {
    flowFocusText = `Primary standout signal in ${analysis.orderedDomains[0]?.domain} (${analysis.orderedDomains[0]?.mean.toFixed(2)}/5.00 — ${getApprovedSignalBadge(analysis.orderedDomains[0]?.mean)}). RECOMMENDED FLOW: Validate this primary friction point first, explore the conflicting answers in any divergent domains without drawing a firm conclusion, and co-design a directional inquiry with the founder.`;
  }

  const flowLines = wrapLines(flowFocusText, usableWidth - 28, 8, false);
  const flowBoxHeight = 28 + flowLines.length * 11.5 + 10;
  doc.addRect(leftX, doc.currentY, usableWidth, flowBoxHeight, { fillColor: [0.988, 0.980, 0.965], strokeColor: goldAccent, lineWidth: 1 });
  doc.addText('RECOMMENDED CONVERSATION FLOW & STRATEGIC FOCUS', leftX + 14, doc.currentY + 16, { font: 'F2', size: 8, color: goldAccent });
  
  let curFlowY = doc.currentY + 28;
  for (const line of flowLines) {
    doc.addText(line, leftX + 14, curFlowY, { font: 'F1', size: 8, color: textDark });
    curFlowY += 11.5;
  }
  doc.currentY += flowBoxHeight + 12;

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
    const qLines = wrapLines(`"${qItem.question}"`, usableWidth - 28, 8, false);
    const qCardHeight = 25 + qLines.length * 10.5 + 8;
    doc.addRect(leftX, doc.currentY, usableWidth, qCardHeight, { fillColor: cardBg, strokeColor: lineBorder, lineWidth: 0.75 });
    doc.addText(qItem.theme, leftX + 14, doc.currentY + 13, { font: 'F2', size: 7.5, color: goldAccent });
    let curQY = doc.currentY + 25;
    for (const line of qLines) {
      doc.addText(line, leftX + 14, curQY, { font: 'F3', size: 8, color: navyBg });
      curQY += 10.5;
    }
    doc.currentY += qCardHeight + 6;
  });

  doc.currentY += 4;

  // Structured Consultation Notes Box
  doc.addRect(leftX, doc.currentY, usableWidth, 84, { fillColor: white, strokeColor: goldAccent, lineWidth: 1 });
  doc.addText('MR. LIONEL EERSTELING - STRATEGIC SESSION NOTES & ACTION DISCOVERY', leftX + 14, doc.currentY + 16, { font: 'F2', size: 8, color: navyBg });
  doc.addText('Record agreed decoupling actions, decision boundaries, or next roadmap priorities:', leftX + 14, doc.currentY + 27, { font: 'F1', size: 7.5, color: textMuted });

  for (let i = 0; i < 3; i++) {
    const lineY = doc.currentY + 41 + i * 15;
    doc.addLine(leftX + 14, lineY, leftX + usableWidth - 14, lineY, [0.92, 0.90, 0.88], 0.5);
  }

  return doc.compileBuffer();
}

// ─────────────────────────────────────────────────────────────────────────────
// REPORT 2: PARTICIPANT-FACING RESULTS REPORT (FOR THE FOUNDER)
// ─────────────────────────────────────────────────────────────────────────────
export function generateParticipantResultsPdf(data: PressureScanPdfData): Buffer {
  const doc = new SimplePdfDocument();
  doc.footerLabel = 'Founder Pressure Scan V1.0';
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

  // Directional Executive Summary Box (Point 3 & 5: Match leading signal directionally & frame tied scores as possibility to explore)
  let headline = '';
  let explanation = '';

  if (analysis.isAllTied) {
    headline = 'Equally Strong Reported Signals Across All Five Domains';
    explanation = 'Your responses reflect equally strong reported pressure across all five operational domains (5.00 / 5.00 — Emerging Signals) rather than an isolated functional bottleneck. Any potential interaction between these domains represents a possibility to explore during your review with Lionel Eersteling, helping anchor which operational lever to address first.';
  } else {
    const primaryName = data.primarySignalAreas[0] || analysis.orderedDomains[0]?.domain;
    const isEmerging = (analysis.orderedDomains[0]?.mean ?? 0) >= 3.5;
    const signalTag = isEmerging ? 'Emerging Signal' : 'Subtle / Balanced';
    headline = `Primary Focus Concentration: ${primaryName} (${signalTag})`;

    if (primaryName === 'Operational Resilience') {
      explanation = 'Your responses highlight Operational Resilience as the primary focus area, where capacity buffer and delivery consistency under demand surges warrant exploration. The 30-minute review with Lionel Eersteling will explore practical ways to strengthen operational elasticity and protect delivery consistency under peak volume without overburdening key contributors.';
    } else if (primaryName === 'Founder Involvement') {
      explanation = 'Your responses highlight Founder Involvement as the primary focus area, where operational momentum during founder absence warrants exploration. The 30-minute review with Lionel Eersteling will explore practical ways to codify key workflows so execution continues smoothly without direct founder presence.';
    } else if (primaryName === 'Decision Load') {
      explanation = 'Your responses highlight Decision Load as the primary focus area, where the volume of operational decisions escalating to the founder warrants exploration. The 30-minute review with Lionel Eersteling will explore practical ways to define clear decision thresholds so your leadership team acts with greater autonomy.';
    } else if (primaryName === 'Execution Rhythm') {
      explanation = 'Your responses highlight Execution Rhythm as the primary focus area, where strategic follow-through and delivery consistency warrant exploration. The 30-minute review with Lionel Eersteling will explore objective review cadences that sustain execution without continuous prompting.';
    } else if (primaryName === 'Leadership Ownership') {
      explanation = 'Your responses highlight Leadership Ownership as the primary focus area, where proactive initiative under ambiguous challenges warrants exploration. The 30-minute review with Lionel Eersteling will explore ways to empower leaders to resolve consequential challenges autonomously.';
    } else {
      explanation = `Your responses highlight ${primaryName} as the primary operational focus area. The upcoming 30-minute review with Lionel Eersteling will explore practical reflections and next steps tailored to your operating context.`;
    }
  }

  const expLines = wrapLines(explanation, usableWidth - 28, 8, false);
  const summaryBoxHeight = 44 + expLines.length * 11.5 + 12;
  doc.addRect(leftX, doc.currentY, usableWidth, summaryBoxHeight, { fillColor: [0.988, 0.980, 0.965], strokeColor: goldAccent, lineWidth: 1.2 });
  doc.addText('DIRECTIONAL SUMMARY & ORGANISATIONAL FOCUS', leftX + 14, doc.currentY + 16, { font: 'F2', size: 8, color: goldAccent });
  doc.addText(headline, leftX + 14, doc.currentY + 30, { font: 'F2', size: 9.5, color: navyBg });
  let curExpY = doc.currentY + 44;
  for (const line of expLines) {
    doc.addText(line, leftX + 14, curExpY, { font: 'F1', size: 8, color: textDark });
    curExpY += 11.5;
  }
  doc.currentY += summaryBoxHeight + 12;

  // Directional Scale Legend (Official V1.0 Two-Tier Specification)
  const legendBoxHeight = 48;
  doc.addRect(leftX, doc.currentY, usableWidth, legendBoxHeight, { fillColor: cardBg, strokeColor: lineBorder, lineWidth: 0.5 });
  doc.addText('APPROVED V1.0 DIRECTIONAL SCALE (OPERATIONAL DRAG INDICATOR, NOT A RISK PERCENTAGE):', leftX + 14, doc.currentY + 12, { font: 'F2', size: 7.5, color: goldAccent });
  doc.addText('- Emerging Signal (Score >= 3.50 / 5.00): Active operational friction reported; candidate for exploration in review', leftX + 14, doc.currentY + 24, { font: 'F1', size: 7.5, color: textDark });
  doc.addText('- Subtle / Balanced (Score < 3.50 / 5.00): Lower reported friction; relative operational autonomy and balance', leftX + 14, doc.currentY + 36, { font: 'F1', size: 7.5, color: textDark });

  doc.currentY += legendBoxHeight + 12;

  // 5 Domains Summary Table
  doc.addText('THE FIVE OPERATIONAL DOMAINS - OBSERVED LEVELS (V1.0 SPECIFICATION)', leftX, doc.currentY + 12, { font: 'F2', size: 9.5, color: navyBg });
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
    const rowH = 34;

    doc.addRect(leftX, doc.currentY, usableWidth, rowH, { fillColor: rowBg, strokeColor: lineBorder, lineWidth: 0.5 });
    doc.addText(item.name.toUpperCase(), leftX + 14, doc.currentY + 13, { font: 'F2', size: 8.5, color: navyBg });

    const sigLabel = getApprovedSignalBadge(scoreItem.mean);
    const sigColor: [number, number, number] = scoreItem.mean >= 3.5 ? goldAccent : textDark;
    const badgeText = `${sigLabel} (${scoreItem.mean.toFixed(2)}/5.00)`;
    const badgeW = getTextWidth(badgeText, 8, true);
    doc.addText(badgeText, leftX + usableWidth - 14 - badgeW, doc.currentY + 13, { font: 'F2', size: 8, color: sigColor });
    doc.addText(item.desc, leftX + 14, doc.currentY + 25, { font: 'F1', size: 7.5, color: textMuted });

    doc.currentY += rowH + 4;
  });

  doc.currentY += 6;

  // Next Step Box: Review Conversation
  doc.addRect(leftX, doc.currentY, usableWidth, 52, { fillColor: cardBg, strokeColor: goldAccent, lineWidth: 1 });
  doc.addText('YOUR 1-ON-1 STRATEGIC REVIEW CONVERSATION', leftX + 14, doc.currentY + 15, { font: 'F2', size: 7.5, color: goldAccent });
  const reviewNote = data.scheduledReviewAt
    ? `Your 30-minute private consultation with Lionel Eersteling is confirmed for ${new Date(data.scheduledReviewAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}. Check your inbox for Zoom access coordinates.`
    : 'You are invited to a private 30-minute Strategic Review Conversation with Lionel Eersteling to translate these signals into clear organizational reflections.';
  doc.addWrappedText(reviewNote, leftX + 14, doc.currentY + 27, usableWidth - 28, 10, { font: 'F1', size: 7.5, color: textDark });

  doc.currentY += 62;

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
    const ptLines = wrapLines(pt.text, usableWidth - 28, 7.5, false);
    const ptCardH = 22 + ptLines.length * 10.5 + 8;
    doc.addRect(leftX, doc.currentY, usableWidth, ptCardH, { fillColor: cardBg, strokeColor: lineBorder, lineWidth: 0.75 });
    doc.addText(pt.title, leftX + 14, doc.currentY + 13, { font: 'F2', size: 8, color: navyBg });
    let curPtY = doc.currentY + 25;
    for (const line of ptLines) {
      doc.addText(line, leftX + 14, curPtY, { font: 'F1', size: 7.5, color: textDark });
      curPtY += 10.5;
    }
    doc.currentY += ptCardH + 6;
  });

  doc.currentY += 4;

  // Complete Audit Question Answers Reference for Founder (Clean Tabular Layout)
  doc.addText('YOUR RECORDED RESPONSES', leftX, doc.currentY + 12, { font: 'F2', size: 9.5, color: navyBg });
  doc.addLine(leftX, doc.currentY + 16, leftX + usableWidth, doc.currentY + 16, goldAccent, 0.75);
  doc.currentY += 22;

  // Header row for responses
  doc.addRect(leftX, doc.currentY, usableWidth, 18, { fillColor: navyBg });
  doc.addText('Q#', leftX + 8, doc.currentY + 12, { font: 'F2', size: 7.5, color: white });
  doc.addText('DOMAIN', leftX + 32, doc.currentY + 12, { font: 'F2', size: 7.5, color: white });
  doc.addText('ASSESSMENT INQUIRY AUDIT', leftX + 155, doc.currentY + 12, { font: 'F2', size: 7.5, color: white });
  doc.addText('RECORDED RESPONSE', leftX + usableWidth - 110, doc.currentY + 12, { font: 'F2', size: 7.5, color: white });
  doc.currentY += 18;

  OFFICIAL_QUESTIONS.forEach((q, qIdx) => {
    const val = getAnswerValue(data.answers, q.qNum);
    const rowBg: [number, number, number] = qIdx % 2 === 0 ? white : cardBg;
    const rowH = 18;

    doc.addRect(leftX, doc.currentY, usableWidth, rowH, { fillColor: rowBg, strokeColor: lineBorder, lineWidth: 0.5 });
    doc.addText(`Q${q.qNum}`, leftX + 8, doc.currentY + 12, { font: 'F2', size: 7.5, color: navyBg });
    doc.addText(q.domain, leftX + 32, doc.currentY + 12, { font: 'F2', size: 7.5, color: textDark });
    
    // Question text neatly fitted with ellipsis if needed
    const qShort = q.text.length > 56 ? q.text.substring(0, 54) + '...' : q.text;
    doc.addText(qShort, leftX + 155, doc.currentY + 12, { font: 'F1', size: 7.5, color: textMuted });

    const respStr = `${SCALE_LABELS[val] || val}`;
    const respW = getTextWidth(respStr, 7.5, true);
    const respColor: [number, number, number] = val >= 4 ? goldAccent : textDark;
    doc.addText(respStr, leftX + usableWidth - 10 - respW, doc.currentY + 12, { font: 'F2', size: 7.5, color: respColor });

    doc.currentY += rowH;
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
