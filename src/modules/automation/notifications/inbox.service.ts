import { automationPrisma } from '../state/transition';
import { getRecipientLists, NotificationService } from './notification.service';
import { SseStreamManager } from '../../analytics/realtime/sseStreamManager';
import { AuthenticatedCrmUser } from '../../../middleware/crmRoleAuth';

export type InboxCategory = 'LEAD' | 'APPROVAL' | 'SYSTEM';
export type InboxRole = 'Approver' | 'Marketing' | 'Advisor';

export interface EmailNotificationPayload {
  recipients?: string[];
  cc?: string[];
  subject: string;
  body: string;
  postId?: string | null;
}

export interface NotifyEventInput {
  category: InboxCategory;
  type: string;
  title: string;
  message: string;
  link?: string | null;
  workspace?: string | null;
  entityId?: string | null;
  dedupeKey: string;
  roles?: InboxRole[];
  recipients?: string[];
  email?: EmailNotificationPayload;
}

export class InboxService {
  private static instance: InboxService;
  private notificationService: NotificationService;

  private constructor() {
    this.notificationService = new NotificationService();
  }

  public static getInstance(): InboxService {
    if (!InboxService.instance) {
      InboxService.instance = new InboxService();
    }
    return InboxService.instance;
  }

  /**
   * Resolves list of recipient identifier strings (emails / user IDs)
   * based on the event's target roles and any explicit named recipients.
   */
  public resolveRecipients(input: NotifyEventInput): string[] {
    const set = new Set<string>();

    if (input.recipients && input.recipients.length > 0) {
      for (const r of input.recipients) {
        if (r && r.trim()) set.add(r.trim().toLowerCase());
      }
    }

    if (input.roles && input.roles.length > 0) {
      const lists = getRecipientLists();

      for (const role of input.roles) {
        if (role === 'Approver') {
          for (const email of lists.approver) set.add(email.toLowerCase());
          for (const email of lists.admin) set.add(email.toLowerCase());
          // Staging developer login receives a standalone copy as an Approver
          set.add('developer');
        } else if (role === 'Marketing') {
          for (const email of lists.editors) set.add(email.toLowerCase());
        } else if (role === 'Advisor') {
          for (const email of lists.approver) set.add(email.toLowerCase());
          for (const email of lists.info) set.add(email.toLowerCase());
          set.add('danielle@eersteling.nl');
        }
      }
    }

    return Array.from(set);
  }

  /**
   * Single backend entrypoint for all notifications:
   * 1. Resolves recipients.
   * 2. Writes one inbox row per recipient (skipping if recipient already has that dedupeKey).
   * 3. Queues email via NotificationService.enqueue() if email payload is provided.
   * 4. Dispatches SSE notifications_changed (empty payload) to connected CRM clients.
   */
  public async notify(input: NotifyEventInput): Promise<{
    createdCount: number;
    recipients: string[];
    emailQueued: boolean;
  }> {
    const recipients = this.resolveRecipients(input);
    let createdCount = 0;

    for (const recipient of recipients) {
      try {
        const existing = await automationPrisma.crmInboxNotification.findUnique({
          where: {
            recipient_dedupeKey: {
              recipient,
              dedupeKey: input.dedupeKey,
            },
          },
        });

        if (!existing) {
          await automationPrisma.crmInboxNotification.create({
            data: {
              recipient,
              category: input.category,
              type: input.type,
              title: input.title,
              message: input.message,
              link: input.link ?? null,
              workspace: input.workspace ?? null,
              entityId: input.entityId ?? null,
              dedupeKey: input.dedupeKey,
              readAt: null,
            },
          });
          createdCount++;
        }
      } catch (err: any) {
        console.warn(`[InboxService] Error creating notification for recipient=${recipient}:`, err?.message || err);
      }
    }

    let emailQueued = false;
    if (input.email) {
      try {
        const lists = getRecipientLists();
        const emailRecipients = input.email.recipients && input.email.recipients.length > 0
          ? input.email.recipients
          : lists.approver;

        await this.notificationService.enqueue({
          type: input.type,
          postId: input.email.postId ?? input.entityId ?? null,
          recipients: emailRecipients,
          cc: input.email.cc ?? [],
          subject: input.email.subject,
          body: input.email.body,
          dedupeKey: input.dedupeKey,
        });
        emailQueued = true;
      } catch (err: any) {
        console.warn(`[InboxService] Error enqueuing email for dedupeKey=${input.dedupeKey}:`, err?.message || err);
      }
    }

    // Ping the CRM bell to refetch without sending personal details on the public stream
    if (createdCount > 0) {
      try {
        SseStreamManager.getInstance().broadcastNotificationsChanged();
      } catch (sseErr: any) {
        console.warn('[InboxService] Error broadcasting SSE notifications_changed:', sseErr?.message);
      }
    }

    return {
      createdCount,
      recipients,
      emailQueued,
    };
  }

  /**
   * Builds the candidate recipient keys matching the authenticated CRM user.
   */
  public getUserRecipientKeys(user: AuthenticatedCrmUser): string[] {
    const keys = new Set<string>();
    if (user.email) keys.add(user.email.toLowerCase().trim());
    if (user.id) keys.add(user.id.toLowerCase().trim());

    return Array.from(keys);
  }

  /**
   * Lists the caller's newest notifications with read/unread state.
   */
  public async listUserNotifications(
    user: AuthenticatedCrmUser,
    options: { limit?: number; category?: string } = {}
  ) {
    const limit = Math.min(Math.max(options.limit || 50, 1), 100);
    const recipientKeys = this.getUserRecipientKeys(user);

    const where: any = {
      recipient: { in: recipientKeys },
    };

    if (options.category && ['LEAD', 'APPROVAL', 'SYSTEM'].includes(options.category.toUpperCase())) {
      where.category = options.category.toUpperCase();
    }

    const items = await automationPrisma.crmInboxNotification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return items.map((item) => ({
      id: item.id,
      category: item.category,
      type: item.type,
      title: item.title,
      message: item.message,
      createdAt: item.createdAt.toISOString(),
      read: item.readAt !== null,
      link: item.link,
      workspace: item.workspace,
      entityId: item.entityId,
    }));
  }

  /**
   * Marks a single notification as read.
   * Returns true if updated; returns false if not found or belongs to another user.
   */
  public async markAsRead(id: string, user: AuthenticatedCrmUser): Promise<boolean> {
    const recipientKeys = this.getUserRecipientKeys(user);

    const item = await automationPrisma.crmInboxNotification.findFirst({
      where: {
        id,
        recipient: { in: recipientKeys },
      },
    });

    if (!item) return false;

    if (!item.readAt) {
      await automationPrisma.crmInboxNotification.update({
        where: { id: item.id },
        data: { readAt: new Date() },
      });
    }

    return true;
  }

  /**
   * Marks all unread notifications for the caller as read.
   */
  public async markAllAsRead(user: AuthenticatedCrmUser): Promise<number> {
    const recipientKeys = this.getUserRecipientKeys(user);

    const result = await automationPrisma.crmInboxNotification.updateMany({
      where: {
        recipient: { in: recipientKeys },
        readAt: null,
      },
      data: {
        readAt: new Date(),
      },
    });

    return result.count;
  }

  /**
   * Nightly cleanup job: deletes notifications older than 90 days.
   */
  public async deleteOldNotifications(retentionDays = 90): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);

    const result = await automationPrisma.crmInboxNotification.deleteMany({
      where: {
        createdAt: { lt: cutoff },
      },
    });

    console.log(`[InboxService] Cleaned up ${result.count} inbox notifications older than ${retentionDays} days.`);
    return result.count;
  }
}

export const inboxService = InboxService.getInstance();

