import { automationPrisma } from '../state/transition';
import { notificationSettingsService } from './settings.service';
import { notificationService } from './notification.service';

export interface ProcessRemindersResult {
  checked: number;
  remindersSent: number;
  autoResolved: number;
  errors: number;
}

class ReminderService {
  /**
   * Schedules a 24h / 48h escalating reminder chain for a post pending Lionel's approval.
   */
  public async scheduleReminderForPost(params: {
    notificationId: string;
    postId: string;
  }): Promise<any> {
    try {
      const settings = await notificationSettingsService.getSettings();
      const firstIntervalHours = settings.reminderIntervalHours[0] || 24;
      const nextReminderAt = new Date(Date.now() + firstIntervalHours * 3600 * 1000);

      const reminder = await (automationPrisma as any).notificationReminder.create({
        data: {
          notificationId: params.notificationId,
          type: 'APPROVAL_REMINDER',
          relatedItemId: params.postId,
          sentAt: new Date(),
          reminderCount: 0,
          nextReminderAt,
          resolvedAt: null,
        },
      });

      console.log(
        `[ReminderService] Scheduled reminder 1 for post=${params.postId} at ${nextReminderAt.toISOString()}`
      );
      return reminder;
    } catch (err: any) {
      console.warn('[ReminderService] scheduleReminderForPost notice:', err?.message || err);
      return null;
    }
  }

  /**
   * Resolves and stops any active reminders for a post once action (Approved / Changes / Rejected) is taken.
   */
  public async resolveRemindersForPost(postId: string, action = 'ACTION_TAKEN'): Promise<number> {
    try {
      const res = await (automationPrisma as any).notificationReminder.updateMany({
        where: {
          relatedItemId: postId,
          resolvedAt: null,
        },
        data: {
          resolvedAt: new Date(),
        },
      });

      if (res.count > 0) {
        console.log(`[ReminderService] Auto-resolved ${res.count} reminders for post=${postId} on ${action}`);
      }
      return res.count;
    } catch (err: any) {
      console.warn('[ReminderService] resolveRemindersForPost notice:', err?.message || err);
      return 0;
    }
  }

  /**
   * Periodically called (hourly / cron / manual) to process due reminders.
   */
  public async processPendingReminders(): Promise<ProcessRemindersResult> {
    const result: ProcessRemindersResult = {
      checked: 0,
      remindersSent: 0,
      autoResolved: 0,
      errors: 0,
    };

    try {
      const now = new Date();
      const dueReminders = await (automationPrisma as any).notificationReminder.findMany({
        where: {
          resolvedAt: null,
          nextReminderAt: { lte: now },
        },
        take: 50,
      });

      result.checked = dueReminders.length;
      if (dueReminders.length === 0) return result;

      const settings = await notificationSettingsService.getSettings();
      const intervals = settings.reminderIntervalHours || [24, 48];
      const maxReminders = settings.maxReminders || 2;

      for (const rem of dueReminders) {
        try {
          if (!rem.relatedItemId) {
            await (automationPrisma as any).notificationReminder.update({
              where: { id: rem.id },
              data: { resolvedAt: now },
            });
            result.autoResolved++;
            continue;
          }

          // Verify post state in database
          const post = await automationPrisma.post.findUnique({
            where: { id: rem.relatedItemId },
          });

          if (!post) {
            await (automationPrisma as any).notificationReminder.update({
              where: { id: rem.id },
              data: { resolvedAt: now },
            });
            result.autoResolved++;
            continue;
          }

          // If post is no longer in PENDING_REVIEW (e.g. APPROVED, REJECTED, CHANGES_REQUESTED, CANCELLED), resolve immediately!
          if (post.status !== 'PENDING_REVIEW') {
            await (automationPrisma as any).notificationReminder.update({
              where: { id: rem.id },
              data: { resolvedAt: now },
            });
            result.autoResolved++;
            continue;
          }

          const currentCount = rem.reminderCount;
          const nextCount = currentCount + 1;

          if (nextCount > maxReminders) {
            // Reached maximum allowed reminders
            await (automationPrisma as any).notificationReminder.update({
              where: { id: rem.id },
              data: { resolvedAt: now, nextReminderAt: null },
            });
            result.autoResolved++;
            continue;
          }

          // Compute next reminder time if another reminder remains
          let nextReminderTime: Date | null = null;
          if (nextCount < maxReminders) {
            const currentInterval = intervals[currentCount] || 24;
            const nextInterval = intervals[nextCount] || 48;
            const diffHours = Math.max(1, nextInterval - currentInterval);
            nextReminderTime = new Date(Date.now() + diffHours * 3600 * 1000);
          }

          // Dispatch reminder via notification service
          const hoursElapsed = intervals[currentCount] || (nextCount === 1 ? 24 : 48);
          await notificationService.queueApprovalSlaReminder({
            post: {
              id: post.id,
              platform: post.platform,
              scheduledAt: post.scheduledAt,
              title: post.title,
              caption: post.caption,
              revision: post.revision,
            },
            hoursRemaining: Math.max(0, 48 - hoursElapsed),
            reminderLevel: nextCount === 1 ? 1 : 2,
            reminderLabel: `Reminder ${nextCount} · ${hoursElapsed}h after submission`,
          });

          await (automationPrisma as any).notificationReminder.update({
            where: { id: rem.id },
            data: {
              reminderCount: nextCount,
              nextReminderAt: nextReminderTime,
              sentAt: now,
              ...(nextCount >= maxReminders ? { resolvedAt: now } : {}),
            },
          });

          result.remindersSent++;
          console.log(
            `[ReminderService] Dispatched reminder ${nextCount}/${maxReminders} for post=${post.id} (next=${nextReminderTime?.toISOString() || 'none'})`
          );
        } catch (itemErr: any) {
          result.errors++;
          console.error(`[ReminderService] Error processing reminder ${rem.id}:`, itemErr?.message || itemErr);
        }
      }
    } catch (err: any) {
      console.error('[ReminderService] processPendingReminders failure:', err?.message || err);
      result.errors++;
    }

    return result;
  }

  /**
   * Returns reminder status for a specific post.
   */
  public async getReminderStatusForPost(postId: string): Promise<any[]> {
    try {
      return await (automationPrisma as any).notificationReminder.findMany({
        where: { relatedItemId: postId },
        orderBy: { createdAt: 'desc' },
      });
    } catch {
      return [];
    }
  }
}

export const reminderService = new ReminderService();
