import { PrismaClient } from '@prisma/client';
import { buildScanFollowup1Email, buildScanFollowup2Email, FollowupEmailData } from './email';

const prisma = new PrismaClient();

export interface ScheduleScanFollowupsParams {
  contactId: string;
  email: string;
  participantName: string;
  companyName?: string;
  referenceNumber: string;
  primarySignalArea: string;
  submittedAt?: Date;
}

/**
 * Authoritatively checks whether a participant has already booked a strategic review call.
 * Checks both scan review appointments and any active calendar bookings in the database.
 */
export async function checkParticipantHasBooked(email: string, referenceNumber?: string): Promise<boolean> {
  const cleanEmail = (email || '').trim().toLowerCase();
  const cleanRef = (referenceNumber || '').trim();

  // 1. Check PressureScanSubmission for scheduled review timestamp
  if (cleanRef || cleanEmail) {
    const scanWithBooking = await prisma.pressureScanSubmission.findFirst({
      where: {
        OR: [
          ...(cleanRef ? [{ referenceNumber: cleanRef }] : []),
          ...(cleanEmail ? [{ email: cleanEmail }] : []),
        ],
        scheduledReviewAt: { not: null },
      },
      select: { id: true, scheduledReviewAt: true },
    });
    if (scanWithBooking && scanWithBooking.scheduledReviewAt) {
      return true;
    }
  }

  // 2. Check scheduled_emails for confirmed booking email
  if (cleanRef || cleanEmail) {
    const confirmedBookingEmail = await prisma.scheduledEmail.findFirst({
      where: {
        OR: [
          ...(cleanRef ? [{ referenceNumber: cleanRef }] : []),
          ...(cleanEmail ? [{ contactEmail: cleanEmail }] : []),
        ],
        emailType: 'booking_confirmation',
        status: { in: ['pending', 'sent'] },
      },
      select: { id: true },
    });
    if (confirmedBookingEmail) {
      return true;
    }
  }

  // 3. Check general Founder / Booking model
  if (cleanEmail) {
    const generalBooking = await prisma.booking.findFirst({
      where: {
        founder: { email: cleanEmail },
        scheduledAt: { not: null },
        status: { notIn: ['cancelled', 'failed'] },
      },
      select: { id: true },
    });
    if (generalBooking) {
      return true;
    }
  }

  return false;
}

/**
 * Schedules Day 2 and Day 5 follow-up emails in scheduled_emails table upon successful scan submission.
 */
export async function scheduleScanFollowups(params: ScheduleScanFollowupsParams): Promise<{ followup1Id?: string; followup2Id?: string }> {
  const submittedAt = params.submittedAt ? new Date(params.submittedAt) : new Date();
  const cleanEmail = params.email.trim().toLowerCase();
  const cleanRef = params.referenceNumber.trim();

  // 1. Calculate send dates (Day 2 = +48h, Day 5 = +120h)
  const sendAtDay2 = new Date(submittedAt.getTime() + 2 * 24 * 60 * 60 * 1000);
  const sendAtDay5 = new Date(submittedAt.getTime() + 5 * 24 * 60 * 60 * 1000);

  const emailData: FollowupEmailData = {
    participantName: params.participantName,
    email: cleanEmail,
    companyName: params.companyName,
    referenceNumber: cleanRef,
    primarySignalArea: params.primarySignalArea,
    contactId: params.contactId,
  };

  const { subject: subject1, html: html1 } = buildScanFollowup1Email(emailData);
  const { subject: subject2, html: html2 } = buildScanFollowup2Email(emailData);

  let followup1Id: string | undefined;
  let followup2Id: string | undefined;

  // Insert Day 2 Follow-up
  const key1 = `followup_1:${cleanRef}`;
  try {
    const f1 = await prisma.scheduledEmail.upsert({
      where: { idempotencyKey: key1 },
      create: {
        contactId: params.contactId,
        contactEmail: cleanEmail,
        emailType: 'followup_1',
        subject: subject1,
        htmlBody: html1,
        sendAt: sendAtDay2,
        status: 'pending',
        scanType: 'founder_pressure_scan',
        referenceNumber: cleanRef,
        idempotencyKey: key1,
      },
      update: {},
    });
    followup1Id = f1.id;
    console.log(`[Scan Follow-up Service] Scheduled Day 2 follow-up for ${cleanEmail} at ${sendAtDay2.toISOString()} (Ref: ${cleanRef})`);
  } catch (err: any) {
    console.warn(`[Scan Follow-up Service] Notice scheduling Day 2 follow-up for ${cleanRef}:`, err.message || err);
  }

  // Insert Day 5 Follow-up
  const key2 = `followup_2:${cleanRef}`;
  try {
    const f2 = await prisma.scheduledEmail.upsert({
      where: { idempotencyKey: key2 },
      create: {
        contactId: params.contactId,
        contactEmail: cleanEmail,
        emailType: 'followup_2',
        subject: subject2,
        htmlBody: html2,
        sendAt: sendAtDay5,
        status: 'pending',
        scanType: 'founder_pressure_scan',
        referenceNumber: cleanRef,
        idempotencyKey: key2,
      },
      update: {},
    });
    followup2Id = f2.id;
    console.log(`[Scan Follow-up Service] Scheduled Day 5 follow-up for ${cleanEmail} at ${sendAtDay5.toISOString()} (Ref: ${cleanRef})`);
  } catch (err: any) {
    console.warn(`[Scan Follow-up Service] Notice scheduling Day 5 follow-up for ${cleanRef}:`, err.message || err);
  }

  return { followup1Id, followup2Id };
}

/**
 * Cancels all pending follow-ups for a participant/scan reference when a consultation is booked.
 */
export async function cancelPendingScanFollowups(email: string, referenceNumber?: string): Promise<number> {
  const cleanEmail = (email || '').trim().toLowerCase();
  const cleanRef = (referenceNumber || '').trim();

  try {
    const res = await prisma.scheduledEmail.updateMany({
      where: {
        OR: [
          ...(cleanRef ? [{ referenceNumber: cleanRef }] : []),
          ...(cleanEmail ? [{ contactEmail: cleanEmail }] : []),
        ],
        emailType: { in: ['followup_1', 'followup_2'] },
        status: 'pending',
      },
      data: {
        status: 'cancelled',
        errorMessage: 'Cancelled: Strategic review call booked by participant.',
      },
    });

    if (res.count > 0) {
      console.log(`[Scan Follow-up Service] Cancelled ${res.count} pending follow-up email(s) for ${cleanEmail} (Ref: ${cleanRef})`);
    }
    return res.count;
  } catch (err: any) {
    console.error(`[Scan Follow-up Service] Error cancelling pending follow-ups:`, err.message || err);
    return 0;
  }
}
