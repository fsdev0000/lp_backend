import { PrismaClient } from '@prisma/client';
import {
  sendBookingReminder24hEmail,
  sendBookingReminder1hEmail,
  sendScanFollowup1Email,
  sendScanFollowup2Email,
  sendCalendarBookingEmails,
  sendParticipantScanResultsEmail,
  resolveScanPdfAttachmentUrl,
  escapeHtml,
} from './email';
import { sendEmail, upsertContact } from './ghl';
import { checkParticipantHasBooked } from './scanFollowupService';

const prisma = new PrismaClient();

let reminderInterval: NodeJS.Timeout | null = null;
let isProcessingBatch = false;

export function formatDubaiDateTime(dateInput: Date | string | number): string {
  try {
    const d = new Date(dateInput);
    return (
      d.toLocaleString('en-GB', {
        dateStyle: 'full',
        timeStyle: 'short',
        timeZone: 'Asia/Dubai',
      }) + ' (Dubai GST)'
    );
  } catch (_) {
    return String(dateInput);
  }
}

export interface ScheduleAppointmentRemindersParams {
  appointmentId?: string;
  referenceNumber?: string;
  contactId?: string;
  email: string;
  participantName: string;
  companyName?: string;
  phone?: string;
  appointmentDate: Date;
  zoomUrl?: string;
}

/**
 * Schedules 24-hour and 1-hour appointment reminders in scheduled_emails table.
 * Strictly avoids scheduling reminders for times that have already passed.
 */
export async function scheduleAppointmentReminders(
  params: ScheduleAppointmentRemindersParams
): Promise<{ reminder24hId?: string; reminder1hId?: string }> {
  const now = new Date();
  const appointmentDate = new Date(params.appointmentDate);
  const cleanEmail = params.email.trim().toLowerCase();
  const cleanRef = (params.referenceNumber || '').trim();
  const cleanApptId = (params.appointmentId || '').trim();
  const formattedDate = formatDubaiDateTime(appointmentDate);
  const zoomUrl =
    params.zoomUrl ||
    process.env.REVIEW_MEETING_URL ||
    'https://zoom.us/j/7114427991?pwd=leadersperformance';

  let reminder24hId: string | undefined;
  let reminder1hId: string | undefined;

  // 1. Calculate 24-Hour Reminder Time (24h prior)
  const sendAt24h = new Date(appointmentDate.getTime() - 24 * 60 * 60 * 1000);
  if (sendAt24h > now) {
    const subject24h = `[Reminder] Your 1-on-1 Strategic Review with Lionel Eersteling Tomorrow (Ref: ${cleanRef || 'N/A'})`;
    const idempotencyKey24h = `reminder_24h:${cleanApptId || cleanRef || cleanEmail}:${appointmentDate.getTime()}`;

    try {
      const emailRecord = await prisma.scheduledEmail.upsert({
        where: { idempotencyKey: idempotencyKey24h },
        create: {
          contactId: params.contactId || '',
          contactEmail: cleanEmail,
          emailType: 'reminder_24h',
          subject: subject24h,
          htmlBody: '', // Pre-rendered or dynamically rendered on dispatch
          sendAt: sendAt24h,
          status: 'pending',
          scanType: 'founder_pressure_scan',
          appointmentId: cleanApptId || undefined,
          referenceNumber: cleanRef || undefined,
          idempotencyKey: idempotencyKey24h,
        },
        update: {
          sendAt: sendAt24h,
          status: 'pending',
          errorMessage: null,
        },
      });
      reminder24hId = emailRecord.id;
      console.log(`[Reminder Service] Scheduled 24h reminder for ${cleanEmail} at ${sendAt24h.toISOString()} (Appt: ${formattedDate})`);
    } catch (err: any) {
      console.warn(`[Reminder Service] Notice scheduling 24h reminder:`, err.message || err);
    }
  } else {
    console.log(`[Reminder Service] Skipping 24h reminder for ${cleanEmail}: appointment is within 24 hours (${formattedDate}).`);
  }

  // 2. Calculate 1-Hour Reminder Time (1h prior)
  const sendAt1h = new Date(appointmentDate.getTime() - 1 * 60 * 60 * 1000);
  if (sendAt1h > now) {
    const subject1h = `[Starting in 1 Hour] Your 1-on-1 Strategic Review with Lionel Eersteling (Ref: ${cleanRef || 'N/A'})`;
    const idempotencyKey1h = `reminder_1h:${cleanApptId || cleanRef || cleanEmail}:${appointmentDate.getTime()}`;

    try {
      const emailRecord = await prisma.scheduledEmail.upsert({
        where: { idempotencyKey: idempotencyKey1h },
        create: {
          contactId: params.contactId || '',
          contactEmail: cleanEmail,
          emailType: 'reminder_1h',
          subject: subject1h,
          htmlBody: '',
          sendAt: sendAt1h,
          status: 'pending',
          scanType: 'founder_pressure_scan',
          appointmentId: cleanApptId || undefined,
          referenceNumber: cleanRef || undefined,
          idempotencyKey: idempotencyKey1h,
        },
        update: {
          sendAt: sendAt1h,
          status: 'pending',
          errorMessage: null,
        },
      });
      reminder1hId = emailRecord.id;
      console.log(`[Reminder Service] Scheduled 1h reminder for ${cleanEmail} at ${sendAt1h.toISOString()} (Appt: ${formattedDate})`);
    } catch (err: any) {
      console.warn(`[Reminder Service] Notice scheduling 1h reminder:`, err.message || err);
    }
  } else {
    console.log(`[Reminder Service] Skipping 1h reminder for ${cleanEmail}: appointment is within 1 hour (${formattedDate}).`);
  }

  return { reminder24hId, reminder1hId };
}

export interface UpdateRescheduledAppointmentRemindersParams {
  appointmentId?: string;
  referenceNumber?: string;
  email: string;
  newAppointmentDate: Date;
  participantName?: string;
  companyName?: string;
  phone?: string;
  zoomUrl?: string;
}

/**
 * Updates pending appointment reminders when a session is rescheduled.
 * Recalculates reminder send times according to new appointment time in Dubai GST.
 * Automatically cancels reminders whose trigger times have already elapsed.
 */
export async function updateRescheduledAppointmentReminders(
  params: UpdateRescheduledAppointmentRemindersParams
): Promise<{ updatedCount: number; cancelledCount: number }> {
  const now = new Date();
  const newAppointmentDate = new Date(params.newAppointmentDate);
  const cleanEmail = params.email.trim().toLowerCase();
  const cleanRef = (params.referenceNumber || '').trim();
  const cleanApptId = (params.appointmentId || '').trim();
  const formattedNewDate = formatDubaiDateTime(newAppointmentDate);

  let updatedCount = 0;
  let cancelledCount = 0;

  // Find existing pending or failed reminders for this appointment/ref
  const existingReminders = await prisma.scheduledEmail.findMany({
    where: {
      OR: [
        ...(cleanApptId ? [{ appointmentId: cleanApptId }] : []),
        ...(cleanRef ? [{ referenceNumber: cleanRef }] : []),
        ...(cleanEmail ? [{ contactEmail: cleanEmail }] : []),
      ],
      emailType: { in: ['reminder_24h', 'reminder_1h'] },
      status: { in: ['pending', 'failed'] },
    },
  });

  const sendAt24h = new Date(newAppointmentDate.getTime() - 24 * 60 * 60 * 1000);
  const sendAt1h = new Date(newAppointmentDate.getTime() - 1 * 60 * 60 * 1000);

  let found24h = false;
  let found1h = false;

  for (const rem of existingReminders) {
    if (rem.emailType === 'reminder_24h') {
      found24h = true;
      if (sendAt24h <= now) {
        // 24h reminder has already passed under new schedule
        await prisma.scheduledEmail.update({
          where: { id: rem.id },
          data: {
            status: 'cancelled',
            errorMessage: `Cancelled due to reschedule: new 24h reminder time has already passed (${formattedNewDate}).`,
          },
        });
        cancelledCount++;
      } else {
        await prisma.scheduledEmail.update({
          where: { id: rem.id },
          data: {
            sendAt: sendAt24h,
            status: 'pending',
            errorMessage: null,
            idempotencyKey: `reminder_24h:${cleanApptId || cleanRef || cleanEmail}:${newAppointmentDate.getTime()}`,
          },
        });
        updatedCount++;
      }
    } else if (rem.emailType === 'reminder_1h') {
      found1h = true;
      if (sendAt1h <= now) {
        // 1h reminder has already passed under new schedule
        await prisma.scheduledEmail.update({
          where: { id: rem.id },
          data: {
            status: 'cancelled',
            errorMessage: `Cancelled due to reschedule: new 1h reminder time has already passed (${formattedNewDate}).`,
          },
        });
        cancelledCount++;
      } else {
        await prisma.scheduledEmail.update({
          where: { id: rem.id },
          data: {
            sendAt: sendAt1h,
            status: 'pending',
            errorMessage: null,
            idempotencyKey: `reminder_1h:${cleanApptId || cleanRef || cleanEmail}:${newAppointmentDate.getTime()}`,
          },
        });
        updatedCount++;
      }
    }
  }

  // If a reminder did not previously exist (e.g. was previously in the past, but rescheduled further into the future)
  if (!found24h && sendAt24h > now) {
    await scheduleAppointmentReminders({
      appointmentId: cleanApptId,
      referenceNumber: cleanRef,
      email: cleanEmail,
      participantName: params.participantName || 'Founder',
      companyName: params.companyName,
      phone: params.phone,
      appointmentDate: newAppointmentDate,
      zoomUrl: params.zoomUrl,
    });
    updatedCount++;
  } else if (!found1h && sendAt1h > now) {
    await scheduleAppointmentReminders({
      appointmentId: cleanApptId,
      referenceNumber: cleanRef,
      email: cleanEmail,
      participantName: params.participantName || 'Founder',
      companyName: params.companyName,
      phone: params.phone,
      appointmentDate: newAppointmentDate,
      zoomUrl: params.zoomUrl,
    });
    updatedCount++;
  }

  console.log(`[Reminder Service] Reschedule updated: ${updatedCount} reminder(s) adjusted, ${cancelledCount} cancelled for ${cleanEmail} (New time: ${formattedNewDate})`);
  return { updatedCount, cancelledCount };
}

/**
 * Cancels all pending appointment reminders when a session is cancelled.
 */
export async function cancelAppointmentReminders(params: {
  appointmentId?: string;
  referenceNumber?: string;
  email?: string;
  reason?: string;
}): Promise<number> {
  const cleanEmail = (params.email || '').trim().toLowerCase();
  const cleanRef = (params.referenceNumber || '').trim();
  const cleanApptId = (params.appointmentId || '').trim();

  try {
    const res = await prisma.scheduledEmail.updateMany({
      where: {
        OR: [
          ...(cleanApptId ? [{ appointmentId: cleanApptId }] : []),
          ...(cleanRef ? [{ referenceNumber: cleanRef }] : []),
          ...(cleanEmail ? [{ contactEmail: cleanEmail }] : []),
        ],
        emailType: { in: ['reminder_24h', 'reminder_1h'] },
        status: 'pending',
      },
      data: {
        status: 'cancelled',
        errorMessage: params.reason || 'Appointment cancelled.',
      },
    });

    console.log(`[Reminder Service] Cancelled ${res.count} pending appointment reminder(s)`);
    return res.count;
  } catch (err: any) {
    console.error('[Reminder Service] Error cancelling appointment reminders:', err.message || err);
    return 0;
  }
}

/**
 * Determines whether a dispatch error represents a transient failure eligible for retry.
 */
export function isTransientError(error: any): boolean {
  if (!error) return false;
  const msg = String(error.message || error).toLowerCase();

  // Network / HTTP 5xx / 429 errors are transient
  if (
    msg.includes('network') ||
    msg.includes('timeout') ||
    msg.includes('etimedout') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('fetch failed') ||
    msg.includes('rate limit') ||
    msg.includes('429') ||
    msg.includes('500') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('504')
  ) {
    return true;
  }

  // Permanent client errors should not retry indefinitely
  if (
    msg.includes('400') ||
    msg.includes('bad request') ||
    msg.includes('not found') ||
    msg.includes('404') ||
    msg.includes('unauthorized') ||
    msg.includes('suppressed') ||
    msg.includes('invalid email')
  ) {
    return false;
  }

  return false;
}

/**
 * Main scheduled email processing engine (process-scheduled-emails).
 * Executes every 5 minutes in background or on-demand.
 * Includes concurrency protection, duplicate prevention, authoritative booking verification,
 * and reliable retry backoff.
 */
export async function processScheduledEmails(): Promise<{
  processed: number;
  sent: number;
  failed: number;
  cancelled: number;
}> {
  if (isProcessingBatch) {
    console.log('[Reminder Service] Previous email processing job still active. Skipping concurrent execution.');
    return { processed: 0, sent: 0, failed: 0, cancelled: 0 };
  }

  isProcessingBatch = true;
  let sent = 0;
  let failed = 0;
  let cancelled = 0;

  try {
    const now = new Date();

    // 1. Fetch pending emails whose scheduled send time has arrived
    const candidateEmails = await prisma.scheduledEmail.findMany({
      where: {
        status: 'pending',
        sendAt: { lte: now },
      },
      orderBy: { sendAt: 'asc' },
      take: 25,
    });

    if (candidateEmails.length === 0) {
      return { processed: 0, sent: 0, failed: 0, cancelled: 0 };
    }

    console.log(`[Reminder Service] Processing batch of ${candidateEmails.length} due scheduled email(s)...`);

    for (const emailRecord of candidateEmails) {
      // 2. Concurrency Lock: Atomically claim row
      const claimed = await prisma.scheduledEmail.updateMany({
        where: { id: emailRecord.id, status: 'pending' },
        data: { status: 'processing' },
      });

      if (claimed.count === 0) {
        // Claimed by another concurrent process
        continue;
      }

      // 3. Authoritative verification for Follow-Up Emails (Day 2 & Day 5):
      // Before sending either follow-up, verify that participant has not booked a call
      if (emailRecord.emailType === 'followup_1' || emailRecord.emailType === 'followup_2') {
        const hasBooked = await checkParticipantHasBooked(emailRecord.contactEmail, emailRecord.referenceNumber || undefined);
        if (hasBooked) {
          console.log(`[Reminder Service] Participant ${emailRecord.contactEmail} has booked a call. Cancelling ${emailRecord.emailType} (Ref: ${emailRecord.referenceNumber}).`);
          await prisma.scheduledEmail.update({
            where: { id: emailRecord.id },
            data: {
              status: 'cancelled',
              errorMessage: 'Cancelled: Participant has already booked a strategic review session.',
            },
          });
          cancelled++;
          continue;
        }
      }

      // 4. Resolve Contact ID & Details
      let contactId = emailRecord.contactId;
      let submission: any = null;
      if (emailRecord.referenceNumber) {
        submission = await prisma.pressureScanSubmission.findFirst({
          where: {
            OR: [
              { referenceNumber: emailRecord.referenceNumber },
              { id: emailRecord.referenceNumber },
            ],
          },
        });
      }

      const participantName = submission?.fullName || 'Founder';
      const companyName = submission?.companyName || undefined;
      const phone = submission?.phone || undefined;
      const zoomMeetingUrl =
        submission?.zoomMeetingUrl ||
        process.env.REVIEW_MEETING_URL ||
        'https://zoom.us/j/7114427991?pwd=leadersperformance';

      if (!contactId) {
        try {
          contactId = await upsertContact({
            email: emailRecord.contactEmail,
            firstName: participantName.split(' ')[0],
            lastName: participantName.split(' ').slice(1).join(' ') || undefined,
            companyName: companyName,
            phone: phone,
            tags: ['founder-pressure-scan'],
          });
        } catch (e: any) {
          console.warn(`[Reminder Service] Notice resolving contact for ${emailRecord.contactEmail}:`, e.message || e);
        }
      }

      // 5. Dispatch based on emailType
      try {
        let dispatchSuccess = false;

        if (emailRecord.emailType === 'followup_1') {
          const primarySignal = submission?.primarySignalAreas?.[0] || 'Operational Resilience';
          dispatchSuccess = await sendScanFollowup1Email({
            participantName,
            email: emailRecord.contactEmail,
            companyName,
            referenceNumber: emailRecord.referenceNumber || 'FPS-2026-N/A',
            primarySignalArea: primarySignal,
            contactId,
          });
        } else if (emailRecord.emailType === 'followup_2') {
          const primarySignal = submission?.primarySignalAreas?.[0] || 'Operational Resilience';
          dispatchSuccess = await sendScanFollowup2Email({
            participantName,
            email: emailRecord.contactEmail,
            companyName,
            referenceNumber: emailRecord.referenceNumber || 'FPS-2026-N/A',
            primarySignalArea: primarySignal,
            contactId,
          });
        } else if (emailRecord.emailType === 'reminder_24h') {
          const apptTimeStr = submission?.scheduledReviewAt
            ? submission.scheduledReviewAt.toISOString()
            : emailRecord.sendAt.toISOString();

          dispatchSuccess = await sendBookingReminder24hEmail({
            participantName,
            email: emailRecord.contactEmail,
            companyName,
            phone,
            dateTimeStr: apptTimeStr,
            referenceNumber: emailRecord.referenceNumber || 'FPS-2026-N/A',
            zoomMeetingUrl,
          });
        } else if (emailRecord.emailType === 'reminder_1h') {
          const apptTimeStr = submission?.scheduledReviewAt
            ? submission.scheduledReviewAt.toISOString()
            : emailRecord.sendAt.toISOString();

          dispatchSuccess = await sendBookingReminder1hEmail({
            participantName,
            email: emailRecord.contactEmail,
            companyName,
            phone,
            dateTimeStr: apptTimeStr,
            referenceNumber: emailRecord.referenceNumber || 'FPS-2026-N/A',
            zoomMeetingUrl,
          });
        } else {
          // Generic HTML body send
          if (!contactId) throw new Error('Contact ID missing for generic scheduled email dispatch');
          const pdfAttachmentUrl = emailRecord.referenceNumber
            ? await resolveScanPdfAttachmentUrl(emailRecord.referenceNumber, 'participant')
            : null;
          const attachments = pdfAttachmentUrl ? [pdfAttachmentUrl] : undefined;

          await sendEmail(contactId, emailRecord.subject, emailRecord.htmlBody, undefined, attachments);
          dispatchSuccess = true;
        }

        // An email is marked 'sent' ONLY unless the GHL request is accepted
        if (dispatchSuccess) {
          await prisma.scheduledEmail.update({
            where: { id: emailRecord.id },
            data: {
              status: 'sent',
              sentAt: new Date(),
              errorMessage: null,
            },
          });
          sent++;
          console.log(`[Reminder Service] Successfully dispatched ${emailRecord.emailType} to ${emailRecord.contactEmail} (ID: ${emailRecord.id})`);
        } else {
          throw new Error('GHL API delivery failed: request was rejected or not accepted');
        }
      } catch (dispatchError: any) {
        const errorMsg = dispatchError?.message || String(dispatchError);
        console.error(`[Reminder Service] Dispatch error on ${emailRecord.id} (${emailRecord.emailType}):`, errorMsg);

        const currentRetries = (emailRecord.retryCount || 0) + 1;
        const transient = isTransientError(dispatchError);

        if (transient && currentRetries < (emailRecord.maxRetries || 3)) {
          // Exponential backoff retry: 5m, 10m, 20m
          const backoffMinutes = Math.pow(2, currentRetries) * 5;
          const nextSendAt = new Date(Date.now() + backoffMinutes * 60 * 1000);

          await prisma.scheduledEmail.update({
            where: { id: emailRecord.id },
            data: {
              status: 'pending',
              retryCount: currentRetries,
              sendAt: nextSendAt,
              errorMessage: `Transient error (attempt ${currentRetries}): ${errorMsg}`,
            },
          });
          console.warn(`[Reminder Service] Scheduled retry ${currentRetries}/${emailRecord.maxRetries} for ${emailRecord.id} at ${nextSendAt.toISOString()}`);
        } else {
          // Permanent failure or max retries exceeded
          await prisma.scheduledEmail.update({
            where: { id: emailRecord.id },
            data: {
              status: 'failed',
              retryCount: currentRetries,
              errorMessage: errorMsg,
            },
          });
          failed++;

          // Log failure to SystemLog for auditing
          await prisma.systemLog.create({
            data: {
              level: 'error',
              action: 'SCHEDULED_EMAIL_FAILED',
              details: JSON.stringify({
                scheduledEmailId: emailRecord.id,
                emailType: emailRecord.emailType,
                contactEmail: emailRecord.contactEmail,
                retries: currentRetries,
                error: errorMsg,
              }),
            },
          }).catch(() => {});
        }
      }
    }

    return { processed: candidateEmails.length, sent, failed, cancelled };
  } catch (globalError: any) {
    console.error('[Reminder Service] Global error in processScheduledEmails:', globalError.message || globalError);
    return { processed: 0, sent, failed, cancelled };
  } finally {
    isProcessingBatch = false;
  }
}

/**
 * Backward compatibility alias for checkAndSendReminders
 */
export async function checkAndSendReminders(): Promise<{ checked: number; sent24h: number; sent2h: number }> {
  const result = await processScheduledEmails();
  return {
    checked: result.processed,
    sent24h: result.sent,
    sent2h: 0,
  };
}

/**
 * Initializes the automated appointment reminder background worker (5-minute interval).
 */
export function initAppointmentReminderWorker() {
  if (reminderInterval) {
    clearInterval(reminderInterval);
    reminderInterval = null;
  }

  if (process.env.NODE_ENV === 'test' && !process.env.ENABLE_TEST_WORKER_INTERVAL) {
    return;
  }

  console.log('[Reminder Service] Initializing Automated Appointment Reminder Background Worker (Interval: 5m)...');

  // Initial check after 10 seconds of server boot
  setTimeout(() => {
    processScheduledEmails().catch((e) => console.warn('[Reminder Service] Initial batch notice:', e));
  }, 10 * 1000);

  // Recurring check every 5 minutes
  reminderInterval = setInterval(() => {
    processScheduledEmails().catch((e) => console.warn('[Reminder Service] Recurring batch notice:', e));
  }, 5 * 60 * 1000);
}

export function stopAppointmentReminderWorker() {
  if (reminderInterval) {
    clearInterval(reminderInterval);
    reminderInterval = null;
  }
}

export function resetBatchProcessingLockForTesting() {
  isProcessingBatch = false;
}
