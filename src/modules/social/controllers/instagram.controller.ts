import { Request, Response } from 'express';
import { InstagramService } from '../services/instagram.service';

const instagramService = new InstagramService();

export class InstagramController {
  /**
   * GET /api/v1/social/instagram/auth-url
   */
  public getAuthUrl = async (req: Request, res: Response): Promise<void> => {
    try {
      const redirectUri = (req.query.redirect_uri as string) || undefined;
      const data = instagramService.getAuthUrl(redirectUri);
      res.status(200).json({ success: true, ...data });
    } catch (error: any) {
      console.error('[InstagramController] getAuthUrl error:', error);
      res.status(500).json({ success: false, error: error?.message || 'Failed to generate OAuth URL' });
    }
  };

  /**
   * GET /api/v1/social/instagram/callback
   */
  public handleCallback = async (req: Request, res: Response): Promise<void> => {
    try {
      const code = (req.query.code as string) || '';
      const state = (req.query.state as string) || undefined;
      const redirectUri = (req.query.redirect_uri as string) || undefined;

      if (!code) {
        const errorDesc = (req.query.error_description as string) || (req.query.error as string) || 'Authorization denied';
        res.status(400).json({ success: false, error: errorDesc });
        return;
      }

      const result = await instagramService.handleCallback(code, state, redirectUri);
      res.status(200).json({ success: true, data: result });
    } catch (error: any) {
      console.error('[InstagramController] callback error:', error);
      res.status(500).json({ success: false, error: error?.message || 'OAuth callback failed' });
    }
  };

  /**
   * GET /api/v1/social/instagram/status
   */
  public getStatus = async (req: Request, res: Response): Promise<void> => {
    try {
      const status = await instagramService.getStatus();
      res.status(200).json({ success: true, ...status });
    } catch (error: any) {
      console.error('[InstagramController] getStatus error:', error);
      res.status(500).json({ success: false, error: error?.message || 'Failed to check status' });
    }
  };

  /**
   * GET /api/v1/social/instagram/ping
   */
  public ping = async (req: Request, res: Response): Promise<void> => {
    try {
      const pingResult = await instagramService.ping();
      res.status(200).json({ success: true, ...pingResult });
    } catch (error: any) {
      console.error('[InstagramController] ping error:', error);
      res.status(500).json({ success: false, error: error?.message || 'Failed to ping Meta Graph API' });
    }
  };

  /**
   * POST /api/v1/social/instagram/disconnect
   */
  public disconnect = async (req: Request, res: Response): Promise<void> => {
    try {
      const actor = req.body?.actor || 'Lionel Eersteling (Owner)';
      const result = await instagramService.disconnect(actor);
      res.status(200).json(result);
    } catch (error: any) {
      console.error('[InstagramController] disconnect error:', error);
      res.status(500).json({ success: false, error: error?.message || 'Failed to disconnect account' });
    }
  };
}
