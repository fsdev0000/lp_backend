/**
 * pressureScanPdfService.ts
 *
 * Standalone PDF generator for Founder Pressure Scan V1.0 Executive Review Dossier.
 * Produces standard, 100% compliant PDF 1.4 binary buffers with zero external dependencies.
 * Designed for Mr. Lionel Eersteling's executive reviews with Leaders Performance luxury obsidian & gold branding.
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

const OFFICIAL_QUESTIONS = [
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

export function generatePressureScanPdf(data: PressureScanPdfData): Buffer {
  const doc = new SimplePdfDocument();
  const usableWidth = doc.getUsableWidth();
  const leftX = 40;

  // Colors
  const navyBg: [number, number, number] = [0.008, 0.075, 0.161]; // #021329
  const goldAccent: [number, number, number] = [0.816, 0.639, 0.353]; // #D0A35A
  const textDark: [number, number, number] = [0.067, 0.082, 0.118]; // #11151E
  const textMuted: [number, number, number] = [0.412, 0.443, 0.502]; // #697180
  const lineBorder: [number, number, number] = [0.886, 0.867, 0.847]; // #E2DDD8
  const cardBg: [number, number, number] = [0.976, 0.969, 0.957]; // #F9F7F4
  const white: [number, number, number] = [1, 1, 1];

  // ─── PAGE 1: EXECUTIVE SUMMARY & DOMAIN MATRIX ─────────────────────────────

  // Top Obsidian Header Banner
  doc.addRect(leftX, doc.currentY, usableWidth, 68, { fillColor: navyBg });
  doc.addText('LEADERS PERFORMANCE', leftX + 16, doc.currentY + 22, {
    font: 'F2',
    size: 10,
    color: goldAccent,
  });
  doc.addText(`REF: ${data.referenceNumber}`, leftX + usableWidth - 130, doc.currentY + 22, {
    font: 'F2',
    size: 10.5,
    color: goldAccent,
  });
  doc.addText('FOUNDER PRESSURE SCAN V1.0 — EXECUTIVE DOSSIER', leftX + 16, doc.currentY + 46, {
    font: 'F2',
    size: 13.5,
    color: white,
  });

  doc.currentY += 78;

  // Participant Metadata Box
  doc.addRect(leftX, doc.currentY, usableWidth, 74, {
    fillColor: cardBg,
    strokeColor: lineBorder,
    lineWidth: 1,
  });

  const col1X = leftX + 14;
  const col2X = leftX + 190;
  const col3X = leftX + 360;

  doc.addText('FOUNDER / PARTICIPANT', col1X, doc.currentY + 16, { font: 'F2', size: 8, color: textMuted });
  doc.addText(data.fullName || 'Confidential Founder', col1X, doc.currentY + 30, { font: 'F2', size: 11, color: textDark });
  doc.addText(data.email || '—', col1X, doc.currentY + 44, { font: 'F1', size: 9, color: textMuted });
  if (data.phone) {
    doc.addText(data.phone, col1X, doc.currentY + 58, { font: 'F1', size: 9, color: textMuted });
  }

  doc.addText('ORGANISATION & SCALE', col2X, doc.currentY + 16, { font: 'F2', size: 8, color: textMuted });
  doc.addText(data.companyName || 'Confidential Enterprise', col2X, doc.currentY + 30, { font: 'F2', size: 11, color: textDark });
  const rev = data.submittedContext?.revenue || 'Under €1M';
  const stage = data.submittedContext?.companyStage || data.submittedContext?.stage || 'Growth-stage';
  doc.addText(`Revenue Band: ${rev}`, col2X, doc.currentY + 44, { font: 'F1', size: 9, color: textMuted });
  doc.addText(`Operating Stage: ${stage}`, col2X, doc.currentY + 58, { font: 'F1', size: 9, color: textMuted });

  doc.addText('REVIEW STATUS & DATE', col3X, doc.currentY + 16, { font: 'F2', size: 8, color: textMuted });
  doc.addText(data.reviewStatus || 'AWAITING_REVIEW', col3X, doc.currentY + 30, { font: 'F2', size: 10, color: goldAccent });
  const subDateStr = data.submittedAt ? new Date(data.submittedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : new Date().toLocaleDateString('en-GB');
  doc.addText(`Submitted: ${subDateStr}`, col3X, doc.currentY + 44, { font: 'F1', size: 9, color: textMuted });
  doc.addText('Methodology: V1.0 (5 Domains)', col3X, doc.currentY + 58, { font: 'F1', size: 8.5, color: textMuted });

  doc.currentY += 86;

  // Signal Classification & Primary Focus Banner
  const signalBg: [number, number, number] = [0.988, 0.976, 0.949];
  const isMultiDomain = data.primarySignalAreas.length > 1;
  const bannerHeight = isMultiDomain ? 70 : 58;

  doc.addRect(leftX, doc.currentY, usableWidth, bannerHeight, {
    fillColor: signalBg,
    strokeColor: goldAccent,
    lineWidth: 1.2,
  });

  const colLeftWidth = 205;
  doc.addText('DIRECTIONAL SIGNAL CLASSIFICATION', leftX + 14, doc.currentY + 16, {
    font: 'F2',
    size: 8,
    color: textMuted,
  });
  doc.addText(`${data.signalClassification} (${data.overallNormalised.toFixed(1)} / 100)`, leftX + 14, doc.currentY + 34, {
    font: 'F2',
    size: 13,
    color: navyBg,
  });

  // Vertical subtle divider inside banner
  doc.addLine(leftX + colLeftWidth, doc.currentY + 10, leftX + colLeftWidth, doc.currentY + bannerHeight - 10, lineBorder, 0.75);

  const primX = leftX + colLeftWidth + 14;
  const primMaxWidth = usableWidth - colLeftWidth - 28;
  const primLabel = isMultiDomain
    ? `PRIMARY SIGNAL AREAS (${data.primarySignalAreas.length} TIED HIGHEST)`
    : 'PRIMARY SIGNAL AREA';

  doc.addText(primLabel, primX, doc.currentY + 16, {
    font: 'F2',
    size: 8,
    color: textMuted,
  });

  const primaryText = data.primarySignalAreas.length > 0
    ? data.primarySignalAreas.join('  ·  ')
    : 'General Operating Cadence';

  doc.addWrappedText(primaryText, primX, doc.currentY + 32, primMaxWidth, 13, {
    font: 'F2',
    size: isMultiDomain ? 9 : 11,
    color: goldAccent,
  });

  doc.currentY += bannerHeight + 14;

  // Section Heading: 5-Domain Evaluation Matrix
  doc.addText('FIVE-DOMAIN EVALUATION MATRIX', leftX, doc.currentY + 14, { font: 'F2', size: 11, color: navyBg });
  doc.addLine(leftX, doc.currentY + 18, leftX + usableWidth, doc.currentY + 18, goldAccent, 1);

  doc.currentY += 26;

  // Domain Table Header
  doc.addRect(leftX, doc.currentY, usableWidth, 22, { fillColor: navyBg });
  doc.addText('DOMAIN', leftX + 10, doc.currentY + 15, { font: 'F2', size: 8.5, color: white });
  doc.addText('QUESTIONS', leftX + 180, doc.currentY + 15, { font: 'F2', size: 8.5, color: white });
  doc.addText('RAW MEAN', leftX + 280, doc.currentY + 15, { font: 'F2', size: 8.5, color: white });
  doc.addText('NORMALISED (0-100)', leftX + 360, doc.currentY + 15, { font: 'F2', size: 8.5, color: white });
  doc.addText('SIGNAL LEVEL', leftX + 445, doc.currentY + 15, { font: 'F2', size: 8.5, color: white });

  doc.currentY += 22;

  const domainRows = [
    { name: 'Founder Involvement', q: 'Q1 & Q2' },
    { name: 'Decision Load', q: 'Q3 & Q4' },
    { name: 'Execution Rhythm', q: 'Q5 & Q6' },
    { name: 'Leadership Ownership', q: 'Q7 & Q8' },
    { name: 'Operational Resilience', q: 'Q9 & Q10' },
  ];

  domainRows.forEach((row, idx) => {
    const scoreItem = data.domainScores.find((d) => d.domain === row.name) || { mean: 0, normalised: 0 };
    const rowBg: [number, number, number] = idx % 2 === 0 ? white : cardBg;

    doc.addRect(leftX, doc.currentY, usableWidth, 24, {
      fillColor: rowBg,
      strokeColor: lineBorder,
      lineWidth: 0.5,
    });

    const isPrimary = data.primarySignalAreas.includes(row.name);
    const domainColor: [number, number, number] = isPrimary ? goldAccent : textDark;

    doc.addText(row.name, leftX + 10, doc.currentY + 16, { font: isPrimary ? 'F2' : 'F1', size: 9, color: domainColor });
    doc.addText(row.q, leftX + 180, doc.currentY + 16, { font: 'F1', size: 8.5, color: textMuted });
    doc.addText(scoreItem.mean.toFixed(2), leftX + 280, doc.currentY + 16, { font: 'F2', size: 9, color: textDark });
    doc.addText(`${scoreItem.normalised.toFixed(1)}%`, leftX + 360, doc.currentY + 16, { font: 'F2', size: 9, color: domainColor });

    let sigLabel = 'Limited';
    if (scoreItem.normalised >= 75) sigLabel = 'Priority';
    else if (scoreItem.normalised >= 50) sigLabel = 'Active';
    else if (scoreItem.normalised >= 25) sigLabel = 'Emerging';

    doc.addText(sigLabel, leftX + 445, doc.currentY + 16, { font: 'F2', size: 8.5, color: textDark });

    doc.currentY += 24;
  });

  doc.currentY += 14;

  // 1-to-1 Session & Zoom Link Card
  doc.addRect(leftX, doc.currentY, usableWidth, 64, {
    fillColor: cardBg,
    strokeColor: goldAccent,
    lineWidth: 1,
  });

  doc.addText('ONE-TO-ONE REVIEW SESSION & MEETING LINK', leftX + 14, doc.currentY + 18, {
    font: 'F2',
    size: 8.5,
    color: goldAccent,
  });

  const zoomUrl = data.zoomMeetingUrl || process.env.REVIEW_MEETING_URL || process.env.ZOOM_MEETING_URL || 'https://zoom.us/j/7114427991?pwd=leadersperformance';
  const meetingDateStr = data.scheduledReviewAt
    ? new Date(data.scheduledReviewAt).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', dateStyle: 'medium', timeStyle: 'short' }) + ' (Dubai GST)'
    : 'Slot reservation available via /diagnostics booking drawer';

  doc.addText(`Schedule: ${meetingDateStr}`, leftX + 14, doc.currentY + 34, { font: 'F1', size: 9, color: textDark });
  doc.addText(`Zoom Meeting URL: ${zoomUrl}`, leftX + 14, doc.currentY + 48, { font: 'F2', size: 9, color: navyBg });

  doc.currentY += 76;

  // Reviewer Governance & Decision Box
  doc.addRect(leftX, doc.currentY, usableWidth, 72, {
    fillColor: white,
    strokeColor: lineBorder,
    lineWidth: 1,
  });

  doc.addText('MR. LIONEL EERSTELING — HUMAN REVIEW DECISION', leftX + 14, doc.currentY + 18, {
    font: 'F2',
    size: 8.5,
    color: textMuted,
  });

  const decision = data.reviewerDecision || 'Pending Executive Consultation Review';
  doc.addText(`Decision: ${decision}`, leftX + 14, doc.currentY + 34, { font: 'F2', size: 9.5, color: navyBg });
  const notes = data.reviewerNotes || 'No preliminary notes recorded. Assessment validated for strategic conversation.';
  doc.addWrappedText(`Notes: ${notes}`, leftX + 14, doc.currentY + 48, usableWidth - 28, 12, {
    font: 'F1',
    size: 8.5,
    color: textMuted,
  });

  // ─── PAGE 2: COMPLETE 10-QUESTION AUDIT BREAKDOWN ─────────────────────────
  doc.startNewPage();

  doc.addRect(leftX, doc.currentY, usableWidth, 34, { fillColor: navyBg });
  doc.addText('FOUNDER PRESSURE SCAN V1.0 — AUDIT TRAIL', leftX + 14, doc.currentY + 21, {
    font: 'F2',
    size: 10,
    color: white,
  });
  doc.addText(`REF: ${data.referenceNumber}`, leftX + usableWidth - 130, doc.currentY + 21, {
    font: 'F2',
    size: 10,
    color: goldAccent,
  });

  doc.currentY += 44;

  OFFICIAL_QUESTIONS.forEach((qItem) => {
    doc.ensureSpace(52);

    // Find answer
    const ansObj = data.answers.find(
      (a) => (a.questionNumber && a.questionNumber === qItem.qNum) || a.text === qItem.text
    ) || (Array.isArray(data.answers) ? data.answers[qItem.qNum - 1] : null);

    const scoreVal = typeof ansObj === 'number' ? ansObj : (ansObj?.score ?? 3);
    const scaleText = SCALE_LABELS[scoreVal] || `${scoreVal} / 5`;

    doc.addRect(leftX, doc.currentY, usableWidth, 46, {
      fillColor: cardBg,
      strokeColor: lineBorder,
      lineWidth: 0.5,
    });

    // Question Number badge & domain
    doc.addText(`QUESTION ${qItem.qNum} · ${qItem.domain.toUpperCase()}`, leftX + 10, doc.currentY + 14, {
      font: 'F2',
      size: 8,
      color: goldAccent,
    });

    // Score badge on right
    doc.addText(`Rating: ${scaleText}`, leftX + usableWidth - 110, doc.currentY + 14, {
      font: 'F2',
      size: 8.5,
      color: navyBg,
    });

    // Question text
    doc.addWrappedText(qItem.text, leftX + 10, doc.currentY + 28, usableWidth - 20, 11, {
      font: 'F1',
      size: 8.5,
      color: textDark,
    });

    doc.currentY += 52;
  });

  doc.currentY += 10;

  // Confidentiality Legal Notice
  doc.ensureSpace(50);
  doc.addRect(leftX, doc.currentY, usableWidth, 42, {
    fillColor: [0.95, 0.95, 0.95],
    strokeColor: lineBorder,
    lineWidth: 0.5,
  });
  doc.addText('STRICTLY CONFIDENTIAL · METHODOLOGY VERSION 1.0', leftX + 10, doc.currentY + 14, {
    font: 'F2',
    size: 7.5,
    color: textMuted,
  });
  doc.addWrappedText(
    'This dossier is generated exclusively for Lionel Eersteling and the participating founder. The Founder Pressure Scan is a non-clinical, directional executive inquiry identifying operational and leadership leverage points. All data subject to UAE PDPL & GDPR privacy compliance.',
    leftX + 10,
    doc.currentY + 26,
    usableWidth - 20,
    9.5,
    { font: 'F1', size: 7, color: textMuted }
  );

  return doc.compileBuffer();
}
