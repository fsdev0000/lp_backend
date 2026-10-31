import { Request, Response } from 'express';
import { ContentService } from '../services/content.service';

export class ContentController {
  private service = new ContentService();

  public listPosts = async (req: Request, res: Response): Promise<void> => {
    try {
      const { platform, status, search, page, limit } = req.query;
      const data = await this.service.listPosts({
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
      res.status(404).json({ success: false, error: error?.message || 'Post not found' });
    }
  };

  public createPost = async (req: Request, res: Response): Promise<void> => {
    try {
      const { title, hook, body, platform, scheduledFor, mediaUrl, mediaType, tags, author, requireApproval } = req.body;
      if (!title || !title.trim()) {
        res.status(400).json({ success: false, error: 'Post title is required' });
        return;
      }

      const post = await this.service.createPost(
        {
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
      res.status(500).json({ success: false, error: error?.message || 'Failed to create post' });
    }
  };

  public updatePost = async (req: Request, res: Response): Promise<void> => {
    try {
      const id = String(req.params.id);
      const post = await this.service.updatePost(id, req.body, req.ip);
      res.status(200).json({ success: true, data: post });
    } catch (error: any) {
      console.error('[ContentController] updatePost error:', error);
      res.status(400).json({ success: false, error: error?.message || 'Failed to update post' });
    }
  };

  public deletePost = async (req: Request, res: Response): Promise<void> => {
    try {
      const id = String(req.params.id);
      const result = await this.service.deletePost(id, req.ip);
      res.status(200).json(result);
    } catch (error: any) {
      console.error('[ContentController] deletePost error:', error);
      res.status(400).json({ success: false, error: error?.message || 'Failed to delete post' });
    }
  };

  public requestApproval = async (req: Request, res: Response): Promise<void> => {
    try {
      const id = String(req.params.id);
      const post = await this.service.requestApproval(id, req.ip);
      res.status(200).json({ success: true, message: 'Submitted for Mr. Lionel sign-off', data: post });
    } catch (error: any) {
      console.error('[ContentController] requestApproval error:', error);
      res.status(400).json({ success: false, error: error?.message || 'Failed to submit for approval' });
    }
  };

  public approvePost = async (req: Request, res: Response): Promise<void> => {
    try {
      const id = String(req.params.id);
      const { signature, approvedBy } = req.body || {};
      const post = await this.service.approvePost(id, { signature, approvedBy }, req.ip);
      res.status(200).json({
        success: true,
        message: 'Post approved and queued for dispatch',
        data: post,
      });
    } catch (error: any) {
      console.error('[ContentController] approvePost error:', error);
      res.status(400).json({ success: false, error: error?.message || 'Failed to approve post' });
    }
  };

  public rejectPost = async (req: Request, res: Response): Promise<void> => {
    try {
      const id = String(req.params.id);
      const { reason } = req.body;
      if (!reason || !reason.trim()) {
        res.status(400).json({ success: false, error: 'Rejection reason / revision notes are required' });
        return;
      }
      const post = await this.service.rejectPost(id, reason.trim(), req.ip);
      res.status(200).json({ success: true, message: 'Revisions requested', data: post });
    } catch (error: any) {
      console.error('[ContentController] rejectPost error:', error);
      res.status(400).json({ success: false, error: error?.message || 'Failed to reject post' });
    }
  };

  public publishNow = async (req: Request, res: Response): Promise<void> => {
    try {
      const id = String(req.params.id);
      const post = await this.service.publishPostNow(id, req.ip);
      res.status(200).json({ success: true, message: 'Live dispatch completed successfully', data: post });
    } catch (error: any) {
      console.error('[ContentController] publishNow error:', error);
      res.status(502).json({ success: false, error: error?.message || 'Failed to broadcast post to social channel' });
    }
  };

  public getApprovalDesk = async (_req: Request, res: Response): Promise<void> => {
    try {
      const posts = await this.service.getApprovalDeskPosts();
      res.status(200).json({ success: true, data: posts, count: posts.length });
    } catch (error: any) {
      console.error('[ContentController] getApprovalDesk error:', error);
      res.status(500).json({ success: false, error: error?.message || 'Failed to retrieve approval queue' });
    }
  };

  public getApprovalStats = async (_req: Request, res: Response): Promise<void> => {
    try {
      const stats = await this.service.getApprovalStats();
      res.status(200).json({ success: true, data: stats });
    } catch (error: any) {
      console.error('[ContentController] getApprovalStats error:', error);
      res.status(500).json({ success: false, error: error?.message || 'Failed to retrieve approval stats' });
    }
  };

  public getAuditLogs = async (req: Request, res: Response): Promise<void> => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
      const logs = await this.service.getAuditLogs(limit);
      res.status(200).json({ success: true, data: logs });
    } catch (error: any) {
      console.error('[ContentController] getAuditLogs error:', error);
      res.status(500).json({ success: false, error: error?.message || 'Failed to retrieve audit logs' });
    }
  };
}
