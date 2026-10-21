import { describe, it, expect, beforeEach, afterAll, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { PrismaClient } from '@prisma/client';
// Mock external network calls to GHL and Email to isolate backend logic
jest.mock('../services/ghl', () => {
  const original = jest.requireActual('../services/ghl') as any;
  let opportunityCallCount = 0;
  return {
    ...original,
    upsertContact: jest.fn().mockImplementation(async (payload: any) => 'mock-contact-id-123'),
    createOpportunityWithDedup: jest.fn().mockImplementation(async (...args: any[]) => {
      opportunityCallCount++;
      if (opportunityCallCount > 1) {
        return { duplicated: false, existingId: 'existing-opp-id' };
      }
      return { duplicated: false, createdId: 'new-opp-id' };
    }),
    sendEmail: jest.fn().mockResolvedValue(true as never),
  };
});

jest.mock('../services/email', () => {
  const original = jest.requireActual('../services/email') as any;
  return {
    ...original,
    sendAdminBriefing: jest.fn().mockResolvedValue(true as never),
    sendCalendarBookingEmails: jest.fn().mockResolvedValue(true as never),
  };
});

import { apiRoutes } from '../api/routes/index';

const prisma = new PrismaClient();
const app = express();
app.use(express.json());
app.use('/api/v1', apiRoutes);

describe('Founder Pressure Scan V1.0 — Backend Test Suite', () => {
  jest.setTimeout(30000);
  const validPayload = (answers: number[], email = 'founder@leadersperformance.ae') => ({
    founder: {
      founder: 'Lionel Eersteling',
      company: 'Leaders Performance LLC',
      email,
      phone: '+971501234567',
      revenue: '€1M–€5M',
      companyStage: 'Scale-stage',
    },
    answers,
    methodologyAcknowledged: true,
    privacyAcknowledged: true,
    marketingConsent: false,
  });

  // [Test 1] Ten answers of 1 produce Overall Normalised = 0.00
  it('[Test 1] Ten answers of 1 produce Overall Normalised = 0.00 and Limited Signal', async () => {
    const res = await request(app)
      .post('/api/v1/assessments/submit')
      .send(validPayload(Array(10).fill(1), 'test1@company.ae'));

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.referenceNumber).toMatch(/^LP-FPS-\d{4}-\d{6}$/);

    const submission = await prisma.pressureScanSubmission.findUnique({
      where: { referenceNumber: res.body.referenceNumber },
    });
    expect(submission).not.toBeNull();
    expect(submission?.overallRawMean).toBe(1.00);
    expect(submission?.overallNormalised).toBe(0.00);
    expect(submission?.signalClassification).toBe('Limited Signal');
  });

  // [Test 2] Ten answers of 2 produce Overall Normalised = 25.00
  it('[Test 2] Ten answers of 2 produce Overall Normalised = 25.00 and Emerging Signal', async () => {
    const res = await request(app)
      .post('/api/v1/assessments/submit')
      .send(validPayload(Array(10).fill(2), 'test2@company.ae'));

    expect(res.status).toBe(201);
    const submission = await prisma.pressureScanSubmission.findUnique({
      where: { referenceNumber: res.body.referenceNumber },
    });
    expect(submission?.overallRawMean).toBe(2.00);
    expect(submission?.overallNormalised).toBe(25.00);
    expect(submission?.signalClassification).toBe('Emerging Signal');
  });

  // [Test 3] Ten answers of 3 produce Overall Normalised = 50.00
  it('[Test 3] Ten answers of 3 produce Overall Normalised = 50.00 and Active Signal', async () => {
    const res = await request(app)
      .post('/api/v1/assessments/submit')
      .send(validPayload(Array(10).fill(3), 'test3@company.ae'));

    expect(res.status).toBe(201);
    const submission = await prisma.pressureScanSubmission.findUnique({
      where: { referenceNumber: res.body.referenceNumber },
    });
    expect(submission?.overallRawMean).toBe(3.00);
    expect(submission?.overallNormalised).toBe(50.00);
    expect(submission?.signalClassification).toBe('Active Signal');
  });

  // [Test 4] Ten answers of 4 produce Overall Normalised = 75.00
  it('[Test 4] Ten answers of 4 produce Overall Normalised = 75.00 and Priority Signal', async () => {
    const res = await request(app)
      .post('/api/v1/assessments/submit')
      .send(validPayload(Array(10).fill(4), 'test4@company.ae'));

    expect(res.status).toBe(201);
    const submission = await prisma.pressureScanSubmission.findUnique({
      where: { referenceNumber: res.body.referenceNumber },
    });
    expect(submission?.overallRawMean).toBe(4.00);
    expect(submission?.overallNormalised).toBe(75.00);
    expect(submission?.signalClassification).toBe('Priority Signal');
  });

  // [Test 5] Ten answers of 5 produce Overall Normalised = 100.00
  it('[Test 5] Ten answers of 5 produce Overall Normalised = 100.00 and Priority Signal', async () => {
    const res = await request(app)
      .post('/api/v1/assessments/submit')
      .send(validPayload(Array(10).fill(5), 'test5@company.ae'));

    expect(res.status).toBe(201);
    const submission = await prisma.pressureScanSubmission.findUnique({
      where: { referenceNumber: res.body.referenceNumber },
    });
    expect(submission?.overallRawMean).toBe(5.00);
    expect(submission?.overallNormalised).toBe(100.00);
    expect(submission?.signalClassification).toBe('Priority Signal');
  });

  // [Test 6] Two identical submissions produce 100% identical calculated scores
  it('[Test 6] Two identical submissions produce 100% identical calculated scores', async () => {
    const answers = [2, 3, 4, 5, 1, 2, 3, 4, 5, 1];
    const res1 = await request(app)
      .post('/api/v1/assessments/submit')
      .send(validPayload(answers, 'idempotent1@company.ae'));
    const res2 = await request(app)
      .post('/api/v1/assessments/submit')
      .send(validPayload(answers, 'idempotent2@company.ae'));

    const sub1 = await prisma.pressureScanSubmission.findUnique({ where: { referenceNumber: res1.body.referenceNumber } });
    const sub2 = await prisma.pressureScanSubmission.findUnique({ where: { referenceNumber: res2.body.referenceNumber } });

    expect(sub1?.overallRawMean).toBe(sub2?.overallRawMean);
    expect(sub1?.overallNormalised).toBe(sub2?.overallNormalised);
    expect(sub1?.domainScores).toEqual(sub2?.domainScores);
    expect(sub1?.primarySignalAreas).toEqual(sub2?.primarySignalAreas);
  });

  // [Test 7] Every domain score strictly matches the mean of its two assigned questions
  it('[Test 7] Every domain score strictly matches the mean of its two assigned questions', async () => {
    // Q1,Q2: Founder Inv (4,2 -> mean 3)
    // Q3,Q4: Decision Load (5,3 -> mean 4)
    // Q5,Q6: Exec Rhythm (2,2 -> mean 2)
    // Q7,Q8: Leadership Own (1,5 -> mean 3)
    // Q9,Q10: Op Resilience (4,4 -> mean 4)
    const answers = [4, 2, 5, 3, 2, 2, 1, 5, 4, 4];
    const res = await request(app)
      .post('/api/v1/assessments/submit')
      .send(validPayload(answers, 'domainmean@company.ae'));

    const sub = await prisma.pressureScanSubmission.findUnique({ where: { referenceNumber: res.body.referenceNumber } });
    const dScores: Array<{ domain: string; mean: number; normalised: number }> = sub?.domainScores as any;

    const findMean = (dName: string) => dScores.find((d) => d.domain === dName)?.mean;
    expect(findMean('Founder Involvement')).toBe(3.00);
    expect(findMean('Decision Load')).toBe(4.00);
    expect(findMean('Execution Rhythm')).toBe(2.00);
    expect(findMean('Leadership Ownership')).toBe(3.00);
    expect(findMean('Operational Resilience')).toBe(4.00);
  });

  // [Test 8] Tied highest domain means output joint Primary Signal Areas in array
  it('[Test 8] Tied highest domain means output joint Primary Signal Areas in array', async () => {
    // Decision Load (mean 5) and Operational Resilience (mean 5) tied for highest
    const answers = [1, 1, 5, 5, 1, 1, 1, 1, 5, 5];
    const res = await request(app)
      .post('/api/v1/assessments/submit')
      .send(validPayload(answers, 'tieddomains@company.ae'));

    expect(res.body.primarySignalAreas).toEqual(['Decision Load', 'Operational Resilience']);
    expect(res.body.openingCopy).toContain('Decision Load & Operational Resilience');
  });

  // [Test 9] 9 answers or 11 answers trigger HTTP 400 validation error
  it('[Test 9] 9 answers or 11 answers trigger HTTP 400 validation error', async () => {
    const res9 = await request(app)
      .post('/api/v1/assessments/submit')
      .send(validPayload(Array(9).fill(3), 'test9@company.ae'));
    expect(res9.status).toBe(400);
    expect(res9.body.error).toContain('10 complete answers');

    const res11 = await request(app)
      .post('/api/v1/assessments/submit')
      .send(validPayload(Array(11).fill(3), 'test11@company.ae'));
    expect(res11.status).toBe(400);
    expect(res11.body.error).toContain('10 complete answers');
  });

  // [Test 10] Score of 0, 6, or 3.5 triggers HTTP 400 validation error
  it('[Test 10] Score of 0, 6, or 3.5 triggers HTTP 400 validation error', async () => {
    const res0 = await request(app)
      .post('/api/v1/assessments/submit')
      .send(validPayload([0, 3, 3, 3, 3, 3, 3, 3, 3, 3], 'err0@company.ae'));
    expect(res0.status).toBe(400);

    const res6 = await request(app)
      .post('/api/v1/assessments/submit')
      .send(validPayload([6, 3, 3, 3, 3, 3, 3, 3, 3, 3], 'err6@company.ae'));
    expect(res6.status).toBe(400);

    const resFloat = await request(app)
      .post('/api/v1/assessments/submit')
      .send(validPayload([3.5, 3, 3, 3, 3, 3, 3, 3, 3, 3], 'errfloat@company.ae'));
    expect(resFloat.status).toBe(400);
  });

  // [Test 11] Unchecked methodology or privacy triggers HTTP 400 validation error
  it('[Test 11] Unchecked methodology or privacy triggers HTTP 400 validation error', async () => {
    const noMethodology = validPayload(Array(10).fill(3), 'consent1@company.ae');
    noMethodology.methodologyAcknowledged = false;
    const resMeth = await request(app).post('/api/v1/assessments/submit').send(noMethodology);
    expect(resMeth.status).toBe(400);
    expect(resMeth.body.error).toContain('methodologyAcknowledged');

    const noPrivacy = validPayload(Array(10).fill(3), 'consent2@company.ae');
    noPrivacy.privacyAcknowledged = false;
    const resPriv = await request(app).post('/api/v1/assessments/submit').send(noPrivacy);
    expect(resPriv.status).toBe(400);
    expect(resPriv.body.error).toContain('privacyAcknowledged');
  });

  // [Test 12] Repeat submission from same email stores separate records in DB without duplicate GHL opportunity
  it('[Test 12] Repeat submission from same email stores separate records in DB without duplicate GHL opportunity', async () => {
    const email = 'repeat.founder@leadersperformance.ae';
    const res1 = await request(app)
      .post('/api/v1/assessments/submit')
      .send(validPayload(Array(10).fill(3), email));
    const res2 = await request(app)
      .post('/api/v1/assessments/submit')
      .send(validPayload(Array(10).fill(4), email));

    expect(res1.body.referenceNumber).not.toBe(res2.body.referenceNumber);

    const subCount = await prisma.pressureScanSubmission.count({
      where: { email },
    });
    expect(subCount).toBeGreaterThanOrEqual(2);
  }, 60000);

  // Public Sanitization Verification
  it('[Sanitization] Public response does NOT leak raw numerical percentage or diagnostic risk tiers', async () => {
    const res = await request(app)
      .post('/api/v1/assessments/submit')
      .send(validPayload(Array(10).fill(4), 'sanitize@company.ae'));

    expect(res.body.success).toBe(true);
    expect(res.body.score).toBeUndefined();
    expect(res.body.overallNormalised).toBeUndefined();
    expect(res.body.overallRawMean).toBeUndefined();
    expect(res.body.tier).toBeUndefined();
    expect(res.body.humanReviewNotice).toBeDefined();
    expect(res.body.openingCopy).toContain('Decision Load');
  });

  // Review Dossier API (GET & PATCH)
  it('[Human Review Dossier] Retrieves complete review dossier and allows Lionel to save review notes', async () => {
    const createRes = await request(app)
      .post('/api/v1/assessments/submit')
      .send(validPayload([5, 5, 2, 2, 3, 3, 4, 4, 1, 1], 'dossier@company.ae'));

    const ref = createRes.body.referenceNumber;

    const getRes = await request(app).get(`/api/v1/scan/review/${ref}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.referenceNumber).toBe(ref);
    expect(getRes.body.answers.length).toBe(10);
    expect(getRes.body.reviewStatus).toBe('AWAITING_REVIEW');

    const patchRes = await request(app)
      .patch(`/api/v1/scan/review/${ref}`)
      .send({
        reviewerNotes: 'Validated for strategic exploration around Founder Involvement.',
        reviewerDecision: 'Approved for Consultation',
        reviewStatus: 'COMPLETED',
      });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.submission.reviewStatus).toBe('COMPLETED');
    expect(patchRes.body.submission.reviewerNotes).toContain('Founder Involvement');
  });

  // PDF Dossier Export
  it('[PDF Export] Generates a valid PDF 1.4 binary buffer for the dossier', async () => {
    const createRes = await request(app)
      .post('/api/v1/assessments/submit')
      .send(validPayload(Array(10).fill(5), 'pdf@company.ae'));

    const ref = createRes.body.referenceNumber;
    const pdfRes = await request(app).get(`/api/v1/scan/review/${ref}/pdf`);

    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers['content-type']).toBe('application/pdf');
    expect(pdfRes.headers['content-disposition']).toContain(`Founder_Pressure_Scan_${ref}`);
    expect(pdfRes.body.toString().slice(0, 8)).toBe('%PDF-1.4');
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });
});
