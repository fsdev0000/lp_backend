/// <reference types="node" />
import fs from 'fs';
import path from 'path';
import { generateAdvisorBriefingPdf, generateParticipantResultsPdf, PressureScanPdfData } from '../src/services/pressureScanPdfService';

const outputDir = path.resolve(__dirname, '../../docs');
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 1: DISTINCT LEADING DOMAIN WITH MIXED / DIVERGENT ANSWERS
// Demonstrates:
// - Standout Primary Signal: Operational Resilience (100%)
// - Intra-Domain Mixed Pattern: Founder Involvement Q1=1 (Never) vs Q2=5 (Consistently)
// - Scheduled Review: Confirmed booking with Zoom coordinates
// ─────────────────────────────────────────────────────────────────────────────
const scenario1Data: PressureScanPdfData = {
  referenceNumber: 'LP-FPS-2026-9482',
  fullName: 'Dr. Tariq Al-Hashimi',
  email: 'tariq.hashimi@example.com',
  companyName: 'Apex Logistics Middle East',
  phone: '+971 50 000 0000',
  submittedContext: {
    revenue: '€5M–€20M',
    companyStage: 'Scale-stage',
    initialFrictionArea: 'Operational Bottlenecks'
  },
  // Q1=1 (Never) vs Q2=5 (Consistently) in Founder Involvement -> Delta=4 points!
  answers: [
    { questionNumber: 1, score: 1 }, // Never: Day-to-day progress doesn't depend directly on personal involvement
    { questionNumber: 2, score: 5 }, // Consistently: Yet operational momentum pauses when founder is away
    { questionNumber: 3, score: 4 }, // Often
    { questionNumber: 4, score: 4 }, // Often
    { questionNumber: 5, score: 3 }, // Sometimes
    { questionNumber: 6, score: 3 }, // Sometimes
    { questionNumber: 7, score: 3 }, // Sometimes
    { questionNumber: 8, score: 4 }, // Often
    { questionNumber: 9, score: 5 }, // Consistently
    { questionNumber: 10, score: 5 }, // Consistently
  ],
  overallRawMean: 3.7,
  overallNormalised: 67.5,
  domainScores: [
    { domain: 'Founder Involvement', mean: 3.0, normalised: 50.0 }, // Mixed pattern (1 vs 5)
    { domain: 'Decision Load', mean: 4.0, normalised: 75.0 },
    { domain: 'Execution Rhythm', mean: 3.0, normalised: 50.0 },
    { domain: 'Leadership Ownership', mean: 3.5, normalised: 62.5 },
    { domain: 'Operational Resilience', mean: 5.0, normalised: 100.0 }, // Standout primary area
  ],
  primarySignalAreas: ['Operational Resilience'],
  signalClassification: 'Emerging Signal',
  submittedAt: new Date('2026-10-21T09:30:00Z'),
  reviewStatus: 'SCHEDULED',
  scheduledReviewAt: new Date('2026-10-24T14:00:00Z'),
  zoomMeetingUrl: 'https://zoom.us/j/0000000000?pwd=samplepasscode'
};

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 2: TIED SCORES ACROSS ALL 5 DOMAINS (DIFFUSE SYSTEMIC PRESSURE)
// Demonstrates:
// - All five domains tied equally (100%)
// - Clear indication that the scan does not distinguish a single primary focus
// - Practical guidance on opening question to identify the root domino
// - Pre-booking state: Review invitation status
// ─────────────────────────────────────────────────────────────────────────────
const scenario2Data: PressureScanPdfData = {
  referenceNumber: 'LP-FPS-2026-5120',
  fullName: 'Alexander Wright',
  email: 'alex.wright@example.com',
  companyName: 'Vanguard FinTech Group',
  phone: '+44 20 7000 0000',
  submittedContext: {
    revenue: '€1M–€5M',
    companyStage: 'Scale-stage',
    initialFrictionArea: 'Systemic Overwhelm'
  },
  answers: Array(10).fill({ score: 5 }),
  overallRawMean: 5.0,
  overallNormalised: 100.0,
  domainScores: [
    { domain: 'Founder Involvement', mean: 5.0, normalised: 100.0 },
    { domain: 'Decision Load', mean: 5.0, normalised: 100.0 },
    { domain: 'Execution Rhythm', mean: 5.0, normalised: 100.0 },
    { domain: 'Leadership Ownership', mean: 5.0, normalised: 100.0 },
    { domain: 'Operational Resilience', mean: 5.0, normalised: 100.0 },
  ],
  primarySignalAreas: [
    'Founder Involvement',
    'Decision Load',
    'Execution Rhythm',
    'Leadership Ownership',
    'Operational Resilience'
  ],
  signalClassification: 'Emerging Signal',
  submittedAt: new Date('2026-10-21T11:15:00Z'),
  reviewStatus: 'AWAITING_REVIEW',
  scheduledReviewAt: null
};

// Generate Scenario 1 PDFs
const s1AdvisorPdf = generateAdvisorBriefingPdf(scenario1Data);
const s1AdvisorPath = path.join(outputDir, 'SAMPLE_1_INTERNAL_ADVISOR_BRIEFING_LEADING_AND_MIXED.pdf');
fs.writeFileSync(s1AdvisorPath, s1AdvisorPdf);
console.log(`[OK] Generated Scenario 1 Advisor Briefing PDF: ${s1AdvisorPath} (${s1AdvisorPdf.length} bytes)`);

const s1ParticipantPdf = generateParticipantResultsPdf(scenario1Data);
const s1ParticipantPath = path.join(outputDir, 'SAMPLE_1_FOUNDER_RESULTS_REPORT_LEADING_AND_MIXED.pdf');
fs.writeFileSync(s1ParticipantPath, s1ParticipantPdf);
console.log(`[OK] Generated Scenario 1 Participant Report PDF: ${s1ParticipantPath} (${s1ParticipantPdf.length} bytes)`);

// Generate Scenario 2 PDFs
const s2AdvisorPdf = generateAdvisorBriefingPdf(scenario2Data);
const s2AdvisorPath = path.join(outputDir, 'SAMPLE_2_INTERNAL_ADVISOR_BRIEFING_TIED_SCORES.pdf');
fs.writeFileSync(s2AdvisorPath, s2AdvisorPdf);
console.log(`[OK] Generated Scenario 2 Advisor Briefing PDF: ${s2AdvisorPath} (${s2AdvisorPdf.length} bytes)`);

const s2ParticipantPdf = generateParticipantResultsPdf(scenario2Data);
const s2ParticipantPath = path.join(outputDir, 'SAMPLE_2_FOUNDER_RESULTS_REPORT_TIED_SCORES.pdf');
fs.writeFileSync(s2ParticipantPath, s2ParticipantPdf);
console.log(`[OK] Generated Scenario 2 Participant Report PDF: ${s2ParticipantPath} (${s2ParticipantPdf.length} bytes)`);
