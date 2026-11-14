import { Router, Request, Response } from 'express';
import { requireCrmAuth } from '../../middleware/crmRoleAuth';
import { inboxService } from '../../modules/automation/notifications/inbox.service';

export const notificationsRouter = Router();

// Apply CRM authentication middleware to all notification endpoints
notificationsRouter.use(requireCrmAuth);

// Guard: API key alone cannot access personal user inboxes (returns 403)
notificationsRouter.use((req: Request, res: Response, next) => {
  if (req.crmUser?.id === 'api-key-admin') {
    res.status(403).json({
      success: false,
      error: 'Forbidden: API key cannot access personal notification inboxes',
    });
    return;
  }
  if (!req.crmUser) {
    res.status(401).json({
      success: false,
      error: 'Unauthorized: valid CRM user session required',
    });
    return;
  }
  next();
});

/**
 * GET /api/v1/notifications
 * Returns the caller's newest inbox notifications up to limit (default 50).
 */
notificationsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
    const category = req.query.category as string | undefined;

    const data = await inboxService.listUserNotifications(req.crmUser!, {
      limit: isNaN(limit) ? 50 : limit,
      category,
    });

    res.status(200).json({
      success: true,
      data,
    });
  } catch (error: any) {
    console.error('[NotificationsRouter] GET / error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve notifications',
    });
  }
});

/**
 * POST /api/v1/notifications/:id/read
 * Marks a single notification as read. Returns 404 if not found or belongs to another user.
 */
notificationsRouter.post('/:id/read', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const updated = await inboxService.markAsRead(id, req.crmUser!);

    if (!updated) {
      res.status(404).json({
        success: false,
        error: 'Notification not found',
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: { id, read: true },
    });
  } catch (error: any) {
    console.error(`[NotificationsRouter] POST /:id/read error:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to mark notification as read',
    });
  }
});

/**
 * POST /api/v1/notifications/read-all
 * Marks all notifications for the caller as read.
 */
notificationsRouter.post('/read-all', async (req: Request, res: Response) => {
  try {
    const count = await inboxService.markAllAsRead(req.crmUser!);

    res.status(200).json({
      success: true,
      data: { count },
    });
  } catch (error: any) {
    console.error('[NotificationsRouter] POST /read-all error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to mark all notifications as read',
    });
  }
});
