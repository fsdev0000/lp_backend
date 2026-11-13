import { Request, Response } from 'express';
import { crmPostsService } from '../review/crmPosts.service';
import { publisherService } from '../publisher/publisher.service';
import { InvalidTransitionError } from '../state/transition';
import { FatalError } from '../publisher/adapters/base.adapter';

function handleControllerError(res: Response, err: any, fallbackMessage: string): void {
  if (err instanceof InvalidTransitionError || err instanceof FatalError) {
    res.status(400).json({
      success: false,
      code: (err as any).code || (err as any).errorCode || 'INVALID_STATUS_TRANSITION',
      error: err.message,
    });
    return;
  }
  if (err?.message?.includes('not found')) {
    res.status(404).json({
      success: false,
      code: 'NOT_FOUND',
      error: err.message,
    });
    return;
  }
  console.error(`[CrmPostsController] error:`, err?.message);
  res.status(500).json({
    success: false,
    code: 'INTERNAL_ERROR',
    error: err?.message || fallbackMessage,
  });
}

export class CrmPostsController {
  public listPosts = async (req: Request, res: Response): Promise<void> => {
    try {
      const workspace = req.query.workspace ? String(req.query.workspace) : undefined;
      const result = await crmPostsService.listPosts({
        workspace,
        status: req.query.status ? String(req.query.status) : undefined,
        platform: req.query.platform ? String(req.query.platform) : undefined,
        from: req.query.from ? String(req.query.from) : undefined,
        to: req.query.to ? String(req.query.to) : undefined,
        search: req.query.search ? String(req.query.search) : undefined,
        page: req.query.page ? Number(req.query.page) : 1,
        limit: req.query.limit ? Number(req.query.limit) : 25,
      });

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err) {
      handleControllerError(res, err, 'Failed to list posts');
    }
  };

  public getPostDetail = async (req: Request, res: Response): Promise<void> => {
    try {
      const postId = String(req.params.id || '').trim();
      const post = await crmPostsService.getPostDetail(postId);
      res.status(200).json({
        success: true,
        data: post,
      });
    } catch (err) {
      handleControllerError(res, err, 'Failed to get post detail');
    }
  };

  public getCaptionFileContent = async (req: Request, res: Response): Promise<void> => {
    try {
      const postId = String(req.params.id || '').trim();
      const assetId = req.query.assetId ? String(req.query.assetId) : undefined;
      const content = await crmPostsService.getCaptionFileContent(postId, assetId);
      res.status(200).json({
        success: true,
        data: content,
      });
    } catch (err) {
      handleControllerError(res, err, 'Failed to get caption file content');
    }
  };

  public updatePost = async (req: Request, res: Response): Promise<void> => {
    try {
      const postId = String(req.params.id || '').trim();
      const updated = await crmPostsService.updatePost(
        postId,
        {
          title: req.body?.title,
          caption: req.body?.caption,
          hashtags: req.body?.hashtags,
          options: req.body?.options,
          scheduledAt: req.body?.scheduledAt,
        },
        req.crmUser!
      );
      res.status(200).json({
        success: true,
        data: updated,
      });
    } catch (err) {
      handleControllerError(res, err, 'Failed to update post');
    }
  };

  public uploadMedia = async (req: Request, res: Response): Promise<void> => {
    try {
      const postId = String(req.params.id || '').trim();
      const file = (req as any).file;

      const fileName = file?.originalname || req.body?.fileName;
      const mimeType = file?.mimetype || req.body?.mimeType || 'application/octet-stream';
      const base64Data = file?.buffer
        ? file.buffer.toString('base64')
        : req.body?.base64Data;

      if (!fileName || !base64Data) {
        res.status(400).json({
          success: false,
          code: 'VALIDATION_ERROR',
          error: 'fileName and base64Data (or multipart file) are required.',
        });
        return;
      }

      const updated = await crmPostsService.replacePostMedia(
        postId,
        {
          fileName,
          mimeType,
          base64Data,
          role: req.body?.role,
          position: req.body?.position !== undefined ? Number(req.body.position) : 0,
          skipStoragePut: req.body?.skipStoragePut,
        },
        req.crmUser!
      );

      res.status(200).json({
        success: true,
        data: updated,
      });
    } catch (err) {
      handleControllerError(res, err, 'Failed to replace post media');
    }
  };

  public submitPost = async (req: Request, res: Response): Promise<void> => {
    try {
      const postId = String(req.params.id || '').trim();
      const updated = await crmPostsService.submitForReview(
        postId,
        req.crmUser!,
        req.body?.comment
      );
      res.status(200).json({
        success: true,
        data: updated,
      });
    } catch (err) {
      handleControllerError(res, err, 'Failed to submit post for review');
    }
  };

  public approvePost = async (req: Request, res: Response): Promise<void> => {
    try {
      const postId = String(req.params.id || '').trim();
      const updated = await crmPostsService.approvePost(
        postId,
        req.crmUser!,
        req.body?.comment
      );
      res.status(200).json({
        success: true,
        data: updated,
      });
    } catch (err) {
      handleControllerError(res, err, 'Failed to approve post');
    }
  };

  public requestChanges = async (req: Request, res: Response): Promise<void> => {
    try {
      const postId = String(req.params.id || '').trim();
      const comment = String(req.body?.comment || '');
      const updated = await crmPostsService.requestChanges(
        postId,
        req.crmUser!,
        comment
      );
      res.status(200).json({
        success: true,
        data: updated,
      });
    } catch (err) {
      handleControllerError(res, err, 'Failed to request changes');
    }
  };

  public rejectPost = async (req: Request, res: Response): Promise<void> => {
    try {
      const postId = String(req.params.id || '').trim();
      const comment = String(req.body?.comment || '');
      const updated = await crmPostsService.rejectPost(
        postId,
        req.crmUser!,
        comment
      );
      res.status(200).json({
        success: true,
        data: updated,
      });
    } catch (err) {
      handleControllerError(res, err, 'Failed to reject post');
    }
  };

  public addComment = async (req: Request, res: Response): Promise<void> => {
    try {
      const postId = String(req.params.id || '').trim();
      const comment = String(req.body?.comment || '');
      const event = await crmPostsService.addComment(
        postId,
        req.crmUser!,
        comment
      );
      res.status(201).json({
        success: true,
        data: event,
      });
    } catch (err) {
      handleControllerError(res, err, 'Failed to add comment');
    }
  };

  public retryPost = async (req: Request, res: Response): Promise<void> => {
    try {
      const postId = String(req.params.id || '').trim();
      const updated = await crmPostsService.adminRetryPost(
        postId,
        req.crmUser!,
        req.body?.comment
      );
      res.status(200).json({
        success: true,
        data: updated,
      });
    } catch (err) {
      handleControllerError(res, err, 'Failed to retry post');
    }
  };

  public manualDone = async (req: Request, res: Response): Promise<void> => {
    try {
      const postId = String(req.params.id || '').trim();
      const url = String(req.body?.url || req.body?.platformUrl || '').trim();
      const updated = await crmPostsService.markManualDone(
        postId,
        req.crmUser!,
        url,
        req.body?.comment
      );
      res.status(200).json({
        success: true,
        data: updated,
      });
    } catch (err) {
      handleControllerError(res, err, 'Failed to mark manual post done');
    }
  };

  public publishNow = async (req: Request, res: Response): Promise<void> => {
    try {
      const postId = String(req.params.id || '').trim();
      const outcome = await publisherService.publishSinglePost(postId, {
        now: new Date(),
        forceImmediate: true,
        actorId: req.crmUser?.email || 'crm-publish-now',
      });
      const detail = await crmPostsService.getPostDetail(postId);
      res.status(200).json({
        success: true,
        data: detail,
        publishStatus: outcome.status,
      });
    } catch (err) {
      handleControllerError(res, err, 'Failed to publish post immediately');
    }
  };
}

export const crmPostsController = new CrmPostsController();

