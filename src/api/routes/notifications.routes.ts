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
 * @openapi
 * /notifications:
 *   get:
 *     summary: Retrieve caller's in-app notification feed
 *     description: Returns the authenticated user's newest notifications up to limit (default 50), optionally filtered by category. Key-only requests receive 403.
 *     tags:
 *       - Notifications & CRM Inbox
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Maximum number of notifications to return (1-100)
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *           enum: [LEAD, APPROVAL, SYSTEM]
 *         description: Optional category filter matching CRM tabs
 *     responses:
 *       200:
 *         description: List of notifications returned successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         example: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"
 *                       category:
 *                         type: string
 *                         example: "APPROVAL"
 *                       type:
 *                         type: string
 *                         example: "REVIEW_REQUEST"
 *                       title:
 *                         type: string
 *                         example: "Post waiting for approval"
 *                       message:
 *                         type: string
 *                         example: "LinkedIn · 'Strategic Rest vs Brute Force' submitted for review"
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 *                         example: "2026-11-14T08:30:00.000Z"
 *                       read:
 *                         type: boolean
 *                         example: false
 *                       link:
 *                         type: string
 *                         nullable: true
 *                         example: "/approvals"
 *                       workspace:
 *                         type: string
 *                         nullable: true
 *                         example: "leaders_performance"
 *                       entityId:
 *                         type: string
 *                         nullable: true
 *                         example: "post-123"
 *       401:
 *         description: Unauthorized - missing or invalid session token
 *       403:
 *         description: Forbidden - API key alone cannot access user inboxes
 *       500:
 *         description: Server error
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
 * @openapi
 * /notifications/{id}/read:
 *   post:
 *     summary: Mark a single notification as read
 *     description: Marks the specified notification read for the caller. Returns 404 if not found or belongs to another user.
 *     tags:
 *       - Notifications & CRM Inbox
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Notification UUID
 *     responses:
 *       200:
 *         description: Notification marked read successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       example: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"
 *                     read:
 *                       type: boolean
 *                       example: true
 *       404:
 *         description: Notification not found or belongs to another recipient
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - API key alone cannot access user inboxes
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
 * @openapi
 * /notifications/read-all:
 *   post:
 *     summary: Mark all caller notifications as read
 *     description: Sets readAt = NOW() for all unread notifications belonging to the authenticated caller.
 *     tags:
 *       - Notifications & CRM Inbox
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: All unread notifications marked as read
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     count:
 *                       type: integer
 *                       example: 5
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - API key alone cannot access user inboxes
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
