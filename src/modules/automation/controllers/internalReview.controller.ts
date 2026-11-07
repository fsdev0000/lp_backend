import { Request, Response } from 'express';
import { geminiDraftService } from '../review/geminiDraft.service';
import { notificationService } from '../notifications/notification.service';

export class InternalReviewController {
  /**
   * POST /internal/posts/:id/draft
   * Formats or saves the Gemini draft for a post, transitions to PENDING_REVIEW, and queues REVIEW_REQUEST email.
   */
  public saveDraft = async (req: Request, res: Response): Promise<void> => {
    try {
      const postId = String(req.params.id || '').trim();
      if (!postId) {
        res.status(400).json({
          success: false,
          code: 'VALIDATION_ERROR',
          error: 'Post ID is required in URL path.',
        });
        return;
      }

      const result = await geminiDraftService.saveDraftForPost(postId, {
        title: req.body?.title,
        caption: req.body?.caption,
        hashtags: req.body?.hashtags,
        category: req.body?.category,
        useBackendGemini: req.body?.useBackendGemini,
        channelToneReference: req.body?.channelToneReference,
      });

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      const status = err?.message?.includes('not found') ? 404 : 500;
      console.error(`[InternalReviewController] postId=${req.params.id} saveDraft error:`, err?.message);
      res.status(status).json({
        success: false,
        code: status === 404 ? 'NOT_FOUND' : 'DRAFT_SAVE_ERROR',
        error: err?.message || 'Failed to save draft for post',
      });
    }
  };

  /**
   * GET /internal/notifications?status=PENDING&limit=50&page=1
   */
  public listNotifications = async (req: Request, res: Response): Promise<void> => {
    try {
      const result = await notificationService.listOutbox({
        status: req.query.status ? String(req.query.status) : 'PENDING',
        limit: req.query.limit ? Number(req.query.limit) : 50,
        page: req.query.page ? Number(req.query.page) : 1,
      });

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      console.error(`[InternalReviewController] postId=none listNotifications error:`, err?.message);
      res.status(500).json({
        success: false,
        code: 'LIST_NOTIFICATIONS_ERROR',
        error: err?.message || 'Failed to list notifications',
      });
    }
  };

  /**
   * POST /internal/notifications/:id/sent
   */
  public markNotificationSent = async (req: Request, res: Response): Promise<void> => {
    try {
      const id = String(req.params.id || '').trim();
      const updated = await notificationService.markSent(id);
      res.status(200).json({
        success: true,
        data: updated,
      });
    } catch (err: any) {
      const status = err?.message?.includes('not found') ? 404 : 500;
      res.status(status).json({
        success: false,
        code: status === 404 ? 'NOT_FOUND' : 'MARK_SENT_ERROR',
        error: err?.message || 'Failed to mark notification sent',
      });
    }
  };

  /**
   * POST /internal/notifications/:id/failed
   */
  public markNotificationFailed = async (req: Request, res: Response): Promise<void> => {
    try {
      const id = String(req.params.id || '').trim();
      const errorMessage = String(req.body?.error || 'Email send failed');
      const updated = await notificationService.markFailed(id, errorMessage);
      res.status(200).json({
        success: true,
        data: updated,
      });
    } catch (err: any) {
      const status = err?.message?.includes('not found') ? 404 : 500;
      res.status(status).json({
        success: false,
        code: status === 404 ? 'NOT_FOUND' : 'MARK_FAILED_ERROR',
        error: err?.message || 'Failed to mark notification failed',
      });
    }
  };
}

export const internalReviewController = new InternalReviewController();

