import { Request, Response } from 'express';
import { publisherService } from '../publisher/publisher.service';
import { notificationService } from '../notifications/notification.service';

export class PublisherController {
  /**
   * POST /internal/publisher/run
   * Triggered by Flow 2 (n8n) every 5 minutes.
   * Executes due APPROVED posts, polls PROCESSING posts, marks overdue posts MISSED,
   * queues reminders, and automatically dispatches all pending email notifications via verified SMTP.
   */
  public runPublisher = async (req: Request, res: Response): Promise<void> => {
    try {
      const now = req.body?.now ? new Date(req.body.now) : new Date();
      const summary = await publisherService.run({ now });
      const outbox = await notificationService.dispatchPendingOutbox();

      res.status(200).json({
        success: true,
        data: {
          ...summary,
          outbox,
        },
      });
    } catch (err: any) {
      console.error(`[PublisherController] postId=batch runPublisher error:`, err?.message);
      res.status(500).json({
        success: false,
        code: 'PUBLISHER_RUN_ERROR',
        error: err?.message || 'Failed to run publisher',
      });
    }
  };
}

export const publisherController = new PublisherController();

