import request from 'supertest';
import express from 'express';
import { PrismaClient } from '@prisma/client';

// Mock external GHL network calls cleanly to prevent outbound traffic during tests
jest.mock('../services/ghl', () => ({
  upsertContact: jest.fn().mockResolvedValue('mock-contact-test-id'),
  bookAppointment: jest.fn().mockResolvedValue({
    id: 'ghl-appt-mock-999',
    calendarEvent: { id: 'ghl-appt-mock-999' },
  }),
  sendEmail: jest.fn().mockResolvedValue({
    success: true,
    messageId: 'ghl-msg-success-123',
  }),
  createOpportunityWithDedup: jest.fn().mockResolvedValue({ duplicated: false, createdId: 'opp-123' }),
  getCalendarInfo: jest.fn().mockResolvedValue({ duration: 30 }),
}));

import { apiRoutes } from '../api/routes/index';
import {
  scheduleScanFollowups,
  checkParticipantHasBooked,
  cancelPendingScanFollowups,
} from '../services/scanFollowupService';
import {
  scheduleAppointmentReminders,
  updateRescheduledAppointmentReminders,
  cancelAppointmentReminders,
  processScheduledEmails,
  formatDubaiDateTime,
  isTransientError,
  resetBatchProcessingLockForTesting,
} from '../services/reminderService';
import { sendEmail } from '../services/ghl';

const prisma = new PrismaClient();
const app = express();
app.use(express.json());
app.use('/api/v1', apiRoutes);

describe('Founder Pressure Scan — Complete Email Audit & Verification Suite', () => {
  jest.setTimeout(45000);
  const TEST_REF = `TEST-FPS-${Date.now()}`;
  const TEST_EMAIL = `test.founder.${Date.now()}@leadersperformance.ae`;

  beforeEach(() => {
    jest.clearAllMocks();
    resetBatchProcessingLockForTesting();
  });

  afterAll(async () => {
    // Cleanup test records
    await prisma.scheduledEmail.deleteMany({
      where: {
        OR: [
          { referenceNumber: { startsWith: 'TEST-FPS' } },
          { contactEmail: { contains: 'leadersperformance.ae' } },
        ],
      },
    }).catch(() => {});

    await prisma.pressureScanSubmission.deleteMany({
      where: {
        OR: [
          { referenceNumber: { startsWith: 'TEST-FPS' } },
          { email: { contains: 'leadersperformance.ae' } },
        ],
      },
    }).catch(() => {});

    await prisma.$disconnect();
  });

  // ─── SCENARIO 1: RESULTS EMAIL ─────────────────────────────────────────────
  it('Scenario 1: Results Email — Sent immediately upon scan submission & recorded in ledger', async () => {
    const payload = {
      founder: {
        founder: 'Test Executive',
        company: 'Test Org Ltd',
        email: TEST_EMAIL,
        phone: '+971500000001',
      },
      answers: [4, 4, 3, 3, 4, 4, 5, 5, 3, 3],
      methodologyAcknowledged: true,
      privacyAcknowledged: true,
    };

    const res = await request(app).post('/api/v1/assessments/submit').send(payload);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    const assignedRef = res.body.referenceNumber;
    expect(assignedRef).toBeDefined();

    // Verify Results email was recorded in scheduled_emails ledger as 'sent'
    const resultsEmail = await prisma.scheduledEmail.findFirst({
      where: {
        referenceNumber: assignedRef,
        emailType: 'results',
      },
    });

    expect(resultsEmail).not.toBeNull();
    expect(resultsEmail?.status).toBe('sent');
    expect(resultsEmail?.sentAt).not.toBeNull();
    expect(resultsEmail?.subject).toContain('[Founder Pressure Scan] Your Executive Results Report');
  });

  // ─── SCENARIO 2 & 3: FOLLOW-UPS (DAY 2 AND DAY 5) ─────────────────────────
  it('Scenario 2 & 3: Follow-ups — Day 2 and Day 5 scheduled upon scan submission', async () => {
    const scanRef = `TEST-FPS-FOLLOW-${Date.now()}`;
    const scanEmail = `followup.${Date.now()}@leadersperformance.ae`;

    const subDate = new Date();
    await scheduleScanFollowups({
      contactId: 'mock-contact-test-id',
      email: scanEmail,
      participantName: 'Sarah Jenkins',
      companyName: 'Apex Dynamics',
      referenceNumber: scanRef,
      primarySignalArea: 'Decision Load',
      submittedAt: subDate,
    });

    const f1 = await prisma.scheduledEmail.findFirst({
      where: { referenceNumber: scanRef, emailType: 'followup_1' },
    });
    const f2 = await prisma.scheduledEmail.findFirst({
      where: { referenceNumber: scanRef, emailType: 'followup_2' },
    });

    expect(f1).not.toBeNull();
    expect(f1?.status).toBe('pending');
    expect(f1?.subject).toContain('Reviewing your scan results & next steps');
    // Day 2 should be approx 48 hours after subDate
    expect(f1?.sendAt.getTime()).toBeCloseTo(subDate.getTime() + 2 * 24 * 60 * 60 * 1000, -4);

    expect(f2).not.toBeNull();
    expect(f2?.status).toBe('pending');
    expect(f2?.subject).toContain('Final note regarding your strategic review');
    // Day 5 should be approx 120 hours after subDate
    expect(f2?.sendAt.getTime()).toBeCloseTo(subDate.getTime() + 5 * 24 * 60 * 60 * 1000, -4);
  });

  it('Scenario 2 & 3: Follow-ups — Dispatched by processor when no call is booked', async () => {
    const scanRef = `TEST-FPS-DISPATCH-${Date.now()}`;
    const scanEmail = `dispatch.${Date.now()}@leadersperformance.ae`;

    // Create a scan submission in DB
    await prisma.pressureScanSubmission.create({
      data: {
        referenceNumber: scanRef,
        fullName: 'Alex Vance',
        companyName: 'Vance Capital',
        email: scanEmail,
        answers: Array(10).fill(3),
        overallRawMean: 3.0,
        overallNormalised: 50.0,
        domainScores: [],
        primarySignalAreas: ['Leadership Ownership'],
        signalClassification: 'Active Signal',
        methodologyAcknowledged: true,
        privacyAcknowledged: true,
      },
    });

    // Schedule a due Day 2 follow-up (sendAt in past)
    await prisma.scheduledEmail.create({
      data: {
        contactId: 'mock-contact-test-id',
        contactEmail: scanEmail,
        emailType: 'followup_1',
        subject: `[Founder Pressure Scan] Reviewing your scan results & next steps (Ref: ${scanRef})`,
        htmlBody: '<p>Followup</p>',
        sendAt: new Date(Date.now() - 60 * 1000), // Due 1 minute ago
        status: 'pending',
        referenceNumber: scanRef,
        idempotencyKey: `due_f1_${scanRef}`,
      },
    });

    const result = await processScheduledEmails();
    expect(result.sent).toBeGreaterThanOrEqual(1);

    const updated = await prisma.scheduledEmail.findUnique({
      where: { idempotencyKey: `due_f1_${scanRef}` },
    });
    expect(updated?.status).toBe('sent');
    expect(updated?.sentAt).not.toBeNull();
  });

  it('Scenario 2 & 3: Authoritative Verification — Follow-up cancelled if call was booked before due date', async () => {
    const scanRef = `TEST-FPS-BOOKED-${Date.now()}`;
    const scanEmail = `booked.${Date.now()}@leadersperformance.ae`;

    // Create submission that ALREADY has a booked appointment
    await prisma.pressureScanSubmission.create({
      data: {
        referenceNumber: scanRef,
        fullName: 'Marcus Reed',
        companyName: 'Reed Global',
        email: scanEmail,
        answers: Array(10).fill(4),
        overallRawMean: 4.0,
        overallNormalised: 75.0,
        domainScores: [],
        primarySignalAreas: ['Execution Rhythm'],
        signalClassification: 'Priority Signal',
        methodologyAcknowledged: true,
        privacyAcknowledged: true,
        scheduledReviewAt: new Date(Date.now() + 48 * 60 * 60 * 1000), // Call is booked!
      },
    });

    // Schedule a due Day 2 follow-up
    await prisma.scheduledEmail.create({
      data: {
        contactId: 'mock-contact-test-id',
        contactEmail: scanEmail,
        emailType: 'followup_1',
        subject: `[Founder Pressure Scan] Follow-up (Ref: ${scanRef})`,
        htmlBody: '<p>Body</p>',
        sendAt: new Date(Date.now() - 60 * 1000), // Due now
        status: 'pending',
        referenceNumber: scanRef,
        idempotencyKey: `due_f1_booked_${scanRef}`,
      },
    });

    const result = await processScheduledEmails();
    expect(result.cancelled).toBeGreaterThanOrEqual(1);

    const emailAfter = await prisma.scheduledEmail.findUnique({
      where: { idempotencyKey: `due_f1_booked_${scanRef}` },
    });
    expect(emailAfter?.status).toBe('cancelled');
    expect(emailAfter?.errorMessage).toContain('already booked');
  });

  // ─── SCENARIO 4: BOOKING CONFIRMATION & REMINDER SCHEDULING ───────────────
  it('Scenario 4: Booking — Cancels pending follow-ups & sends confirmation immediately', async () => {
    const bookRef = `TEST-FPS-CALL-${Date.now()}`;
    const bookEmail = `call.${Date.now()}@leadersperformance.ae`;

    // 1. Initial follow-up scheduled
    await prisma.scheduledEmail.create({
      data: {
        contactId: 'mock-contact-test-id',
        contactEmail: bookEmail,
        emailType: 'followup_1',
        subject: 'Pending followup',
        htmlBody: '<p>Pending</p>',
        sendAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
        status: 'pending',
        referenceNumber: bookRef,
        idempotencyKey: `f1_to_cancel_${bookRef}`,
      },
    });

    // 2. Founder books a call 4 days in future
    const futureDate = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000);
    const dateStr = futureDate.toISOString().split('T')[0];

    const bookRes = await request(app)
      .post('/api/v1/booking/schedule')
      .send({
        email: bookEmail,
        name: 'David Kim',
        company: 'Kim Logistics',
        date: dateStr,
        time: '02:30 PM',
        reference: bookRef,
      });

    expect(bookRes.status).toBe(200);
    expect(bookRes.body.success).toBe(true);

    // Verify pending follow-up was cancelled
    const cancelledFollowup = await prisma.scheduledEmail.findUnique({
      where: { idempotencyKey: `f1_to_cancel_${bookRef}` },
    });
    expect(cancelledFollowup?.status).toBe('cancelled');

    // Verify booking confirmation was recorded in ledger
    const bookingConf = await prisma.scheduledEmail.findFirst({
      where: { referenceNumber: bookRef, emailType: 'booking_confirmation' },
    });
    expect(bookingConf).not.toBeNull();
    expect(bookingConf?.status).toBe('sent');

    // Verify 24h and 1h reminders were scheduled
    const rem24 = await prisma.scheduledEmail.findFirst({
      where: { referenceNumber: bookRef, emailType: 'reminder_24h' },
    });
    const rem1 = await prisma.scheduledEmail.findFirst({
      where: { referenceNumber: bookRef, emailType: 'reminder_1h' },
    });

    expect(rem24).not.toBeNull();
    expect(rem24?.status).toBe('pending');
    expect(rem1).not.toBeNull();
    expect(rem1?.status).toBe('pending');
  });

  // ─── SCENARIO 5 & 6: 24-HOUR AND 1-HOUR REMINDERS ─────────────────────────
  it('Scenario 5 & 6: Reminders — Does NOT schedule reminders for times that have already passed', async () => {
    const nearAppt = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2 hours from now
    const nearRef = `TEST-FPS-NEAR-${Date.now()}`;
    const nearEmail = `near.${Date.now()}@leadersperformance.ae`;

    const { reminder24hId, reminder1hId } = await scheduleAppointmentReminders({
      email: nearEmail,
      participantName: 'Elena Rostova',
      referenceNumber: nearRef,
      appointmentDate: nearAppt,
    });

    // 24h prior has ALREADY passed (since appt is in 2 hours), so reminder24hId must be undefined
    expect(reminder24hId).toBeUndefined();
    // 1h prior is in 1 hour (still future), so reminder1hId must be scheduled
    expect(reminder1hId).toBeDefined();

    const stored24h = await prisma.scheduledEmail.findFirst({
      where: { referenceNumber: nearRef, emailType: 'reminder_24h' },
    });
    expect(stored24h).toBeNull();

    const stored1h = await prisma.scheduledEmail.findFirst({
      where: { referenceNumber: nearRef, emailType: 'reminder_1h' },
    });
    expect(stored1h).not.toBeNull();
    expect(stored1h?.status).toBe('pending');
  });

  // ─── RESCHEDULING & CANCELLATION ──────────────────────────────────────────
  it('Rescheduling — Updates pending reminders to match new appointment time in Dubai GST', async () => {
    const reschedRef = `TEST-FPS-RESCHED-${Date.now()}`;
    const reschedEmail = `resched.${Date.now()}@leadersperformance.ae`;
    const origAppt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

    // Schedule initial reminders
    await scheduleAppointmentReminders({
      email: reschedEmail,
      participantName: 'Robert Vance',
      referenceNumber: reschedRef,
      appointmentDate: origAppt,
    });

    // Reschedule appointment to 7 days from now
    const newAppt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const newDateStr = newAppt.toISOString().split('T')[0];

    const res = await request(app)
      .post('/api/v1/booking/reschedule')
      .send({
        email: reschedEmail,
        reference: reschedRef,
        date: newDateStr,
        time: '03:00 PM',
        reason: 'Executive conflict',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify 24h reminder sendAt was updated to newAppt - 24h
    const rem24 = await prisma.scheduledEmail.findFirst({
      where: { referenceNumber: reschedRef, emailType: 'reminder_24h', status: 'pending' },
    });
    expect(rem24).not.toBeNull();
    const expectedAppt = new Date(`${newDateStr}T15:00:00`);
    const expected24 = new Date(expectedAppt.getTime() - 24 * 60 * 60 * 1000);
    expect(rem24?.sendAt.getTime()).toBe(expected24.getTime());
  });

  it('Cancellation — Cancels all pending appointment reminders', async () => {
    const cancelRef = `TEST-FPS-CANCEL-${Date.now()}`;
    const cancelEmail = `cancel.${Date.now()}@leadersperformance.ae`;
    const appt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

    await scheduleAppointmentReminders({
      email: cancelEmail,
      participantName: 'Linda Bell',
      referenceNumber: cancelRef,
      appointmentDate: appt,
    });

    const res = await request(app)
      .post('/api/v1/booking/cancel')
      .send({
        email: cancelEmail,
        reference: cancelRef,
        reason: 'Founder postponed indefinitely',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.cancelledReminders).toBeGreaterThanOrEqual(1);

    const pendingReminders = await prisma.scheduledEmail.findMany({
      where: { referenceNumber: cancelRef, status: 'pending' },
    });
    expect(pendingReminders.length).toBe(0);
  });

  // ─── DELIVERY RELIABILITY & RETRIES ───────────────────────────────────────
  it('Delivery Reliability — Transient GHL errors retry with backoff, permanent errors fail immediately', async () => {
    expect(isTransientError(new Error('fetch failed: network timeout'))).toBe(true);
    expect(isTransientError(new Error('502 Bad Gateway from upstream'))).toBe(true);
    expect(isTransientError(new Error('Rate limit exceeded (429)'))).toBe(true);
    expect(isTransientError(new Error('Contact upsert failed: 400 Bad Request'))).toBe(false);
    expect(isTransientError(new Error('Contact 404 not found'))).toBe(false);

    // Test transient failure retry in worker
    const retryRef = `TEST-FPS-RETRY-${Date.now()}`;
    const retryEmail = `retry.${Date.now()}@leadersperformance.ae`;

    const failKey = `fail_transient_${retryRef}`;
    await prisma.scheduledEmail.create({
      data: {
        contactId: 'mock-contact-test-id',
        contactEmail: retryEmail,
        emailType: 'followup_1',
        subject: 'Transient Test',
        htmlBody: '<p>Retry test</p>',
        sendAt: new Date(Date.now() - 30 * 1000), // Due
        status: 'pending',
        retryCount: 0,
        maxRetries: 3,
        referenceNumber: retryRef,
        idempotencyKey: failKey,
      },
    });

    // Mock sendEmail to throw a transient network error once
    (sendEmail as jest.Mock).mockRejectedValueOnce(new Error('Network timeout (ECONNRESET)'));

    await processScheduledEmails();

    const retriedRecord = await prisma.scheduledEmail.findUnique({
      where: { idempotencyKey: failKey },
    });

    expect(retriedRecord?.status).toBe('pending');
    expect(retriedRecord?.retryCount).toBe(1);
    expect(retriedRecord?.errorMessage).toContain('Network timeout');
    expect(retriedRecord?.sendAt.getTime()).toBeGreaterThan(Date.now()); // Scheduled in future for backoff
  });

  // ─── TIMEZONE CONSISTENCY ─────────────────────────────────────────────────
  it('Timezone — Consistently formats dates in Dubai time (UTC+4 GST)', () => {
    // 2026-10-25 10:00:00 UTC = 14:00:00 Dubai (GST, UTC+4)
    const testUtc = new Date('2026-10-25T10:00:00Z');
    const formatted = formatDubaiDateTime(testUtc);
    expect(formatted).toContain('25 October 2026');
    expect(formatted).toContain('14:00');
    expect(formatted).toContain('Dubai GST');
  });
});
