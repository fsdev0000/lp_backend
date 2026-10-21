import { PrismaClient } from '@prisma/client';
import { sendBookingReminder24hEmail, sendBookingReminder2hEmail } from './email';

const prisma = new PrismaClient();

let reminderInterval: NodeJS.Timeout | null = null;

export async function checkAndSendReminders(): Promise<{ checked: number; sent24h: number; sent2h: number }> {
  let sent24h = 0;
  let sent2h = 0;

  try {
    const now = new Date();
    // Look ahead up to 26 hours for upcoming scheduled sessions
    const maxFuture = new Date(now.getTime() + 26 * 60 * 60 * 1000);

    const upcomingSubmissions = await prisma.pressureScanSubmission.findMany({
      where: {
        scheduledReviewAt: {
          gt: now,
          lte: maxFuture,
        },
      },
    });

    for (const sub of upcomingSubmissions) {
      if (!sub.scheduledReviewAt || !sub.email) continue;

      const sessionTime = new Date(sub.scheduledReviewAt).getTime();
      const diffMs = sessionTime - now.getTime();
      const diffHours = diffMs / (1000 * 60 * 60);

      const ctx = (sub.submittedContext as any) || {};
      const reminders = ctx.reminders || {};

      const reminderData = {
        participantName: sub.fullName || 'Founder',
        email: sub.email,
        phone: sub.phone || undefined,
        companyName: sub.companyName || 'Enterprise',
        dateTimeStr: sub.scheduledReviewAt.toISOString(),
        referenceNumber: sub.referenceNumber,
        zoomMeetingUrl: sub.zoomMeetingUrl || process.env.REVIEW_MEETING_URL || 'https://zoom.us/j/7114427991?pwd=leadersperformance',
      };

      // 1. Check for 24-Hour (1 Day Prior) Reminder: triggered between 24h and 2h before session
      if (diffHours <= 24.5 && diffHours > 2.0 && !reminders.reminder24hSentAt) {
        console.log(`[Reminder Service] Dispatching 24h reminder to ${sub.email} for Ref: ${sub.referenceNumber} (in ${diffHours.toFixed(1)}h)`);
        const ok = await sendBookingReminder24hEmail(reminderData);
        if (ok) {
          sent24h++;
          const updatedContext = {
            ...ctx,
            reminders: {
              ...reminders,
              reminder24hSentAt: new Date().toISOString(),
            },
          };
          await prisma.pressureScanSubmission.update({
            where: { id: sub.id },
            data: { submittedContext: updatedContext },
          }).catch((err) => console.warn('[Reminder Service] Failed to record 24h reminder state:', err));
        }
      }

      // 2. Check for 2-Hour Reminder: triggered within 2 hours of session start
      if (diffHours <= 2.0 && diffHours > 0.0 && !reminders.reminder2hSentAt) {
        console.log(`[Reminder Service] Dispatching 2h reminder to ${sub.email} for Ref: ${sub.referenceNumber} (in ${diffHours.toFixed(1)}h)`);
        const ok = await sendBookingReminder2hEmail(reminderData);
        if (ok) {
          sent2h++;
          const updatedContext = {
            ...ctx,
            reminders: {
              ...reminders,
              reminder2hSentAt: new Date().toISOString(),
            },
          };
          await prisma.pressureScanSubmission.update({
            where: { id: sub.id },
            data: { submittedContext: updatedContext },
          }).catch((err) => console.warn('[Reminder Service] Failed to record 2h reminder state:', err));
        }
      }
    }

    return { checked: upcomingSubmissions.length, sent24h, sent2h };
  } catch (error: any) {
    console.error('[Reminder Service] Error running reminder check:', error.message || error);
    return { checked: 0, sent24h, sent2h };
  }
}

/**
 * Initializes the automated appointment reminder background worker
 */
export function initAppointmentReminderWorker() {
  if (reminderInterval) {
    clearInterval(reminderInterval);
  }

  console.log('[Reminder Service] Initializing Automated Appointment Reminder Background Worker (Interval: 5m)...');

  // Initial check after 10 seconds of server boot
  setTimeout(() => {
    checkAndSendReminders().catch((e) => console.warn('[Reminder Service] Initial check notice:', e));
  }, 10 * 1000);

  // Recurring check every 5 minutes
  reminderInterval = setInterval(() => {
    checkAndSendReminders().catch((e) => console.warn('[Reminder Service] Recurring check notice:', e));
  }, 5 * 60 * 1000);
}
