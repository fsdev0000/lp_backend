import fs from 'fs';
import path from 'path';
import { generateAdvisorBriefingPdf, generateParticipantResultsPdf, PressureScanPdfData } from '../src/services/pressureScanPdfService';

const sampleData: PressureScanPdfData = {
  referenceNumber: 'FPS-2026-8873',
  fullName: 'Lionel Eersteling',
  email: 'founder@example.ae',
  companyName: 'Leaders Performance LLC',
  phone: '+971501234567',
  submittedContext: {
    revenue: '€1M–€5M',
    companyStage: 'Scale-stage',
    initialFrictionArea: 'Founder Overload'
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
  signalClassification: 'Priority Signal',
  submittedAt: new Date(),
  reviewStatus: 'AWAITING_REVIEW',
  scheduledReviewAt: null, // Pre-booking: Zoom link should be hidden
};

const outputDir = path.resolve(__dirname, '../../docs');
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// 1. Generate Revised Internal Advisor Briefing (for Lionel)
const internalPdf = generateAdvisorBriefingPdf(sampleData);
const internalPath = path.join(outputDir, 'SAMPLE_INTERNAL_ADVISOR_BRIEFING_LIONEL.pdf');
fs.writeFileSync(internalPath, internalPdf);
console.log(`[SUCCESS] Generated Internal Advisor Briefing PDF: ${internalPath} (${internalPdf.length} bytes)`);

// 2. Generate Revised Participant Results Report (for Founder)
const participantPdf = generateParticipantResultsPdf(sampleData);
const participantPath = path.join(outputDir, 'SAMPLE_PARTICIPANT_RESULTS_REPORT.pdf');
fs.writeFileSync(participantPath, participantPdf);
console.log(`[SUCCESS] Generated Participant Results PDF: ${participantPath} (${participantPdf.length} bytes)`);
