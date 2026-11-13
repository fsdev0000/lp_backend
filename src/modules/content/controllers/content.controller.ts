import { Request, Response } from 'express';
import path from 'path';
import { ContentService } from '../services/content.service';
import { uploadContentMedia } from '../../../services/supabaseStorageService';
import { isLinkedInPublishingEnabled } from '../../social/config/linkedin.config';

export class ContentController {
  private service = new ContentService();

  /**
   * Uploads image or video file for Content Studio posts.
   * Multipart field: 'file'.
   * Validates JPG/PNG/GIF (up to 10MB) and MP4 (up to 200MB).
   */
  public uploadMedia = async (req: Request, res: Response): Promise<void> => {
    try {
      const file = req.file;
      if (!file) {
        res.status(400).json({
          success: false,
          error: "No file uploaded. Please upload a file with field 'file'.",
        });
        return;
      }

      const ext = path.extname(file.originalname).toLowerCase();
      const mimetype = (file.mimetype || '').toLowerCase();

      const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif'];
      const imageMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif'];

      const isImage = imageExtensions.includes(ext) || imageMimeTypes.includes(mimetype);
      const isVideo = ext === '.mp4' || mimetype === 'video/mp4';

      if (!isImage && !isVideo) {
        res.status(400).json({
          success: false,
          error: 'Unsupported file type. Only JPG, PNG, GIF images and MP4 videos are accepted.',
        });
        return;
      }

      const mediaType: 'image' | 'video' = isVideo ? 'video' : 'image';

      // LinkedIn size limits: max 10MB for images, max 200MB for video
      const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
      const MAX_VIDEO_SIZE = 200 * 1024 * 1024; // 200MB

      if (mediaType === 'image' && file.size > MAX_IMAGE_SIZE) {
        res.status(400).json({
          success: false,
          error: `Image size exceeds LinkedIn limit of 10MB (${(file.size / (1024 * 1024)).toFixed(1)}MB uploaded).`,
        });
        return;
      }

      if (mediaType === 'video' && file.size > MAX_VIDEO_SIZE) {
        res.status(400).json({
          success: false,
          error: `Video size exceeds LinkedIn limit of 200MB (${(file.size / (1024 * 1024)).toFixed(1)}MB uploaded).`,
        });
        return;
      }

      const uploadResult = await uploadContentMedia(file, mediaType);

      res.status(200).json({
        success: true,
        mediaUrl: uploadResult.mediaUrl,
        mediaType,
        fileName: uploadResult.fileName,
        size: uploadResult.size,
        data: {
          mediaUrl: uploadResult.mediaUrl,
          mediaType,
          fileName: uploadResult.fileName,
          size: uploadResult.size,
        },
      });
    } catch (error: any) {
      console.error('[ContentController] uploadMedia error:', error);
      res.status(500).json({
        success: false,
        error: error?.message || 'Failed to upload media file',
      });
    }
  };

  public listPosts = async (req: Request, res: Response): Promise<void> => {
    try {
      const { platform, status, search, page, limit, workspace } = req.query;
      const data = await this.service.listPosts({
        workspace: workspace ? String(workspace) : undefined,
        platform: platform as string,
        status: status as string,
        search: search as string,
        page: page ? parseInt(page as string, 10) : 1,
        limit: limit ? parseInt(limit as string, 10) : 50,
      });
      res.status(200).json({ success: true, ...data });
    } catch (error: any) {
      console.error('[ContentController] listPosts error:', error);
      res.status(500).json({ success: false, error: error?.message || 'Failed to list posts' });
    }
  };

  public getPost = async (req: Request, res: Response): Promise<void> => {
    try {
      const id = String(req.params.id);
      const post = await this.service.getPostById(id);
      res.status(200).json({ success: true, data: post });
    } catch (error: any) {
      console.error('[ContentController] getPost error:', error);
      res.status(error?.statusCode || 404).json({ success: false, error: error?.message || 'Post not found' });
    }
  };

  public createPost = async (req: Request, res: Response): Promise<void> => {
    try {
      const { title, hook, body, platform, scheduledFor, mediaUrl, mediaType, tags, author, requireApproval, workspace } = req.body;
      if (!title || !title.trim()) {
        res.status(400).json({ success: false, error: 'Post title is required' });
        return;
      }

      const post = await this.service.createPost(
        {
          workspace: workspace || (req.query.workspace as string) || 'leaders_performance',
          title: title.trim(),
          hook,
          body,
          platform,
          scheduledFor,
          mediaUrl,
          mediaType,
          tags,
          author,
          requireApproval: requireApproval !== false, // Defaults to true (human-in-the-loop review)
        },
        req.ip
      );

      res.status(201).json({ success: true, data: post });
    } catch (error: any) {
      console.error('[ContentController] createPost error:', error);
      const isClientError =
        error?.statusCode === 400 ||
        error?.message?.includes('Invalid mediaType') ||
        error?.message?.includes('required');
      res.status(isClientError ? 400 : 500).json({ success: false, error: error?.message || 'Failed to create post' });
    }
  };

  public updatePost = async (req: Request, res: Response): Promise<void> => {
    try {
      const id = String(req.params.id);
      const post = await this.service.updatePost(id, req.body, req.ip);
      res.status(200).json({ success: true, data: post });
    } catch (error: any) {
      console.error('[ContentController] updatePost error:', error);
      res.status(error?.statusCode || 400).json({ success: false, error: error?.message || 'Failed to update post' });
    }
  };

  public deletePost = async (req: Request, res: Response): Promise<void> => {
    try {
      const id = String(req.params.id);
      const result = await this.service.deletePost(id, req.ip);
      res.status(200).json(result);
    } catch (error: any) {
      console.error('[ContentController] deletePost error:', error);
      res.status(error?.statusCode || 400).json({ success: false, error: error?.message || 'Failed to delete post' });
    }
  };

  public requestApproval = async (req: Request, res: Response): Promise<void> => {
    try {
      const id = String(req.params.id);
      const post = await this.service.requestApproval(id, req.ip);
      res.status(200).json({ success: true, message: 'Submitted for Mr. Lionel sign-off', data: post });
    } catch (error: any) {
      console.error('[ContentController] requestApproval error:', error);
      res.status(error?.statusCode || 400).json({ success: false, error: error?.message || 'Failed to submit for approval' });
    }
  };

  public approvePost = async (req: Request, res: Response): Promise<void> => {
    try {
      const id = String(req.params.id);
      const user = (req as any).crmUser || (req as any).user;
      if (user && user.role === 'editor') {
        res.status(403).json({ success: false, error: 'Editors cannot approve posts. Admin or Approver role required.' });
        return;
      }
      const approverEmail = user?.email || (req.body?.approvedBy ? String(req.body.approvedBy) : 'approver@leadersperformance.ae');
      const signature = req.body?.signature || `SIG_${Date.now()}`;
      const post = await this.service.approvePost(id, { signature, approvedBy: approverEmail }, req.ip, user?.name || user?.email);
      res.status(200).json({
        success: true,
        message: 'Post approved and queued for dispatch',
        data: post,
      });
    } catch (error: any) {
      console.error('[ContentController] approvePost error:', error);
      res.status(error?.statusCode || 400).json({ success: false, error: error?.message || 'Failed to approve post' });
    }
  };

  public rejectPost = async (req: Request, res: Response): Promise<void> => {
    try {
      const id = String(req.params.id);
      const user = (req as any).crmUser || (req as any).user;
      if (user && user.role === 'editor') {
        res.status(403).json({ success: false, error: 'Editors cannot reject posts. Admin or Approver role required.' });
        return;
      }
      const { reason } = req.body;
      if (!reason || !reason.trim()) {
        res.status(400).json({ success: false, error: 'Rejection reason / revision notes are required' });
        return;
      }
      const actor = user?.name || user?.email || 'Approver';
      const post = await this.service.rejectPost(id, reason.trim(), req.ip, actor);
      res.status(200).json({ success: true, message: 'Revisions requested', data: post });
    } catch (error: any) {
      console.error('[ContentController] rejectPost error:', error);
      res.status(error?.statusCode || 400).json({ success: false, error: error?.message || 'Failed to reject post' });
    }
  };

  public publishNow = async (req: Request, res: Response): Promise<void> => {
    try {
      const user = (req as any).crmUser || (req as any).user;
      if (user && user.role === 'editor') {
        res.status(403).json({ success: false, error: 'Editors cannot publish posts. Admin or Approver role required.' });
        return;
      }
      if (!isLinkedInPublishingEnabled()) {
        res.status(403).json({
          success: false,
          error: 'LinkedIn publishing is currently disabled (LINKEDIN_PUBLISHING_ENABLED=false).',
        });
        return;
      }

      const id = String(req.params.id);
      const actor = user?.name || user?.email;
      const post = await this.service.publishPostNow(id, req.ip, actor);
      res.status(200).json({ success: true, message: 'Live dispatch completed successfully', data: post });
    } catch (error: any) {
      console.error('[ContentController] publishNow error:', error);
      const status = error?.statusCode || 502;
      res.status(status).json({ success: false, error: error?.message || 'Failed to broadcast post to social channel' });
    }
  };

  public getApprovalDesk = async (req: Request, res: Response): Promise<void> => {
    try {
      const workspace = req.query.workspace ? String(req.query.workspace) : undefined;
      const posts = await this.service.getApprovalDeskPosts(workspace);
      res.status(200).json({ success: true, data: posts, count: posts.length });
    } catch (error: any) {
      console.error('[ContentController] getApprovalDesk error:', error);
      res.status(500).json({ success: false, error: error?.message || 'Failed to retrieve approval queue' });
    }
  };

  public getApprovalStats = async (req: Request, res: Response): Promise<void> => {
    try {
      const workspace = req.query.workspace ? String(req.query.workspace) : undefined;
      const stats = await this.service.getApprovalStats(workspace);
      res.status(200).json({ success: true, data: stats });
    } catch (error: any) {
      console.error('[ContentController] getApprovalStats error:', error);
      res.status(500).json({ success: false, error: error?.message || 'Failed to retrieve approval stats' });
    }
  };

  public getAuditLogs = async (req: Request, res: Response): Promise<void> => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
      const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
      const cursor = req.query.cursor ? String(req.query.cursor) : undefined;
      const result = await this.service.getAuditLogs(limit, page, cursor);
      res.status(200).json({
        success: true,
        data: result.items,
        pagination: {
          page: result.page,
          limit: result.limit,
          total: result.total,
          hasMore: result.hasMore,
        },
      });
    } catch (error: any) {
      console.error('[ContentController] getAuditLogs error:', error);
      res.status(500).json({ success: false, error: error?.message || 'Failed to retrieve audit logs' });
    }
  };
}
