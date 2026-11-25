import { Request, Response } from 'express';
import { TikTokService } from '../services/tiktok.service';
import { isTikTokPublishingEnabled } from '../adapters/tiktok.adapter';
import { isAllowedReturnToUrl } from '../config/linkedin.config';

export class TikTokController {
  private service = new TikTokService();

  public getAuthUrl = async (req: Request, res: Response): Promise<void> => {
    try {
      const redirectUri = req.query.redirect_uri as string | undefined;
      const state = req.query.state as string | undefined;
      const returnTo = req.query.return_to as string | undefined;
      const rawScopes = req.query.scopes || req.query.scope;

      let parsedScopes: string[] | undefined = undefined;
      if (typeof rawScopes === 'string' && rawScopes.trim()) {
        parsedScopes = rawScopes.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
      }

      const clientKey = (req.query.client_key || req.query.clientKey) as string | undefined;

      const result = await this.service.getAuthUrl(redirectUri, state, parsedScopes, returnTo, clientKey);
      if (req.query.redirect === 'true' || req.query.auto === 'true' || req.accepts('html')) {
        res.redirect(302, result.url);
        return;
      }
      res.status(200).json({ success: true, ...result });
    } catch (error: any) {
      res
        .status(error?.statusCode || 500)
        .json({ success: false, error: error?.message || 'Failed to generate TikTok auth URL' });
    }
  };

  public handleCallback = async (req: Request, res: Response): Promise<void> => {
    try {
      const code = req.query.code as string;
      const state = req.query.state as string | undefined;
      const error = req.query.error as string;
      const errorDescription = req.query.error_description as string;
      const redirectUri = req.query.redirect_uri as string | undefined;
      const returnTo = req.query.return_to as string | undefined;

      if (error) {
        res.status(400).json({
          success: false,
          error: `TikTok authorization failed: ${error} - ${errorDescription || ''}`,
        });
        return;
      }

      if (!code || !state) {
        res.status(400).json({ success: false, error: 'Missing code or state in TikTok callback' });
        return;
      }

      const connection = await this.service.handleCallback(code, state, redirectUri, returnTo);

      if (connection.returnTo && isAllowedReturnToUrl(connection.returnTo)) {
        const sep = connection.returnTo.includes('?') ? '&' : '?';
        res.redirect(
          `${connection.returnTo}${sep}tiktok_connected=true&account=${encodeURIComponent(
            connection.username || ''
          )}`
        );
        return;
      }

      res.status(200).json({
        success: true,
        message: 'Successfully connected TikTok account',
        data: connection,
      });
    } catch (error: any) {
      res
        .status(error?.statusCode || 500)
        .json({ success: false, error: error?.message || 'Failed to process TikTok callback' });
    }
  };

  public getStatus = async (_req: Request, res: Response): Promise<void> => {
    try {
      const status = await this.service.getStatus();
      res.status(200).json({ success: true, ...status });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error?.message || 'Failed to get TikTok status' });
    }
  };

  public getAnalytics = async (_req: Request, res: Response): Promise<void> => {
    try {
      const data = await this.service.getAnalytics();
      res.status(200).json({ success: true, data });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error?.message || 'Failed to get TikTok analytics' });
    }
  };

  public publishDirect = async (req: Request, res: Response): Promise<void> => {
    try {
      if (!isTikTokPublishingEnabled()) {
        res.status(403).json({
          success: false,
          error: 'TikTok publishing is currently disabled (TIKTOK_PUBLISHING_ENABLED=false).',
        });
        return;
      }

      const { title, videoUrl, privacyLevel } = req.body || {};
      if (!videoUrl) {
        res.status(400).json({ success: false, error: 'videoUrl is required to publish to TikTok' });
        return;
      }

      const result = await this.service.publishDirect({
        title: title || '',
        videoUrl,
        privacyLevel,
      });
      res.status(200).json({ success: true, data: result });
    } catch (error: any) {
      res
        .status(error?.statusCode || 500)
        .json({ success: false, error: error?.message || 'Failed to publish to TikTok' });
    }
  };

  public disconnect = async (_req: Request, res: Response): Promise<void> => {
    try {
      const result = await this.service.disconnect();
      res.status(200).json(result);
    } catch (error: any) {
      res.status(500).json({ success: false, error: error?.message || 'Failed to disconnect TikTok' });
    }
  };

  /**
   * Handles TikTok Developer Portal Webhook events & Test URL pings
   * GET / POST /api/v1/social/tiktok/webhook
   */
  public handleWebhook = async (req: Request, res: Response): Promise<void> => {
    res.status(200).json({
      success: true,
      received: true,
      event: req.body?.event || 'ping',
    });
  };
}

