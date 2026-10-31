import { Request, Response } from 'express';
import { LinkedInService } from '../services/linkedin.service';

export class LinkedInController {
  private service = new LinkedInService();

  /**
   * Generates LinkedIn OAuth 2.0 authorization URL
   * GET /api/v1/social/linkedin/auth-url
   */
  public getAuthUrl = async (req: Request, res: Response): Promise<void> => {
    try {
      const redirectUri = req.query.redirect_uri as string | undefined;
      const state = req.query.state as string | undefined;
      const result = this.service.getAuthUrl(redirectUri, state);
      res.status(200).json({ success: true, ...result });
    } catch (error: any) {
      console.error('[LinkedInController] getAuthUrl error:', error);
      res.status(500).json({ success: false, error: error?.message || 'Failed to generate auth URL' });
    }
  };

  /**
   * Handles OAuth 2.0 callback from LinkedIn
   * GET /api/v1/social/linkedin/callback
   */
  public handleCallback = async (req: Request, res: Response): Promise<void> => {
    try {
      const code = req.query.code as string;
      const error = req.query.error as string;
      const errorDescription = req.query.error_description as string;
      const redirectUri = req.query.redirect_uri as string | undefined;

      if (error) {
        res.status(400).json({
          success: false,
          error: `LinkedIn authorization failed: ${error} - ${errorDescription || 'No description provided'}`,
        });
        return;
      }

      if (!code) {
        res.status(400).json({ success: false, error: 'Missing code parameter in LinkedIn callback' });
        return;
      }

      const connection = await this.service.handleCallback(code, redirectUri);

      // If requested via browser GET navigation, redirect back to Social CRM UI if configured
      const returnTo = req.query.return_to as string;
      if (returnTo && returnTo.startsWith('http')) {
        res.redirect(`${returnTo}?linkedin_connected=true&account=${encodeURIComponent(connection.accountName || '')}`);
        return;
      }

      res.status(200).json({
        success: true,
        message: 'Successfully connected LinkedIn account',
        data: connection,
      });
    } catch (error: any) {
      console.error('[LinkedInController] handleCallback error:', error);
      res.status(500).json({ success: false, error: error?.message || 'Failed to process LinkedIn callback' });
    }
  };

  /**
   * Retrieves active LinkedIn connection status
   * GET /api/v1/social/linkedin/status
   */
  public getStatus = async (req: Request, res: Response): Promise<void> => {
    try {
      const status = await this.service.getStatus();
      res.status(200).json({ success: true, ...status });
    } catch (error: any) {
      console.error('[LinkedInController] getStatus error:', error);
      res.status(500).json({ success: false, error: error?.message || 'Failed to get LinkedIn status' });
    }
  };

  /**
   * Disconnects active LinkedIn connection
   * POST /api/v1/social/linkedin/disconnect
   */
  public disconnect = async (req: Request, res: Response): Promise<void> => {
    try {
      const result = await this.service.disconnect();
      res.status(200).json(result);
    } catch (error: any) {
      console.error('[LinkedInController] disconnect error:', error);
      res.status(500).json({ success: false, error: error?.message || 'Failed to disconnect LinkedIn' });
    }
  };

  /**
   * Directly posts to LinkedIn
   * POST /api/v1/social/linkedin/share
   */
  public publishDirect = async (req: Request, res: Response): Promise<void> => {
    try {
      const { text, title, mediaUrl } = req.body;
      if (!text || !text.trim()) {
        res.status(400).json({ success: false, error: 'Text content is required to publish to LinkedIn' });
        return;
      }

      const result = await this.service.publishDirect({ text, title, mediaUrl });
      res.status(200).json({ success: true, data: result });
    } catch (error: any) {
      console.error('[LinkedInController] publishDirect error:', error);
      res.status(500).json({ success: false, error: error?.message || 'Failed to publish post to LinkedIn' });
    }
  };

  /**
   * Pings LinkedIn API credentials and health status
   * GET /api/v1/social/linkedin/ping
   */
  public ping = async (req: Request, res: Response): Promise<void> => {
    try {
      const result = await this.service.ping();
      res.status(200).json({ success: true, ...result });
    } catch (error: any) {
      console.error('[LinkedInController] ping error:', error);
      res.status(500).json({ success: false, error: error?.message || 'Failed to ping LinkedIn' });
    }
  };
}
