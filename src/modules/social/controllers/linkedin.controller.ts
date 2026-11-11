import { Request, Response } from 'express';
import { LinkedInService } from '../services/linkedin.service';
import { LinkedInOAuthTarget } from '../adapters/linkedin.adapter';
import {
  isAllowedReturnToUrl,
  isLinkedInPublishingEnabled,
  LINKEDIN_MEMBER_SCOPES,
  LINKEDIN_PAGE_SCOPES,
  getLinkedInPageScopes,
} from '../config/linkedin.config';

export class LinkedInController {
  private service = new LinkedInService();

  /**
   * Generates LinkedIn OAuth 2.0 authorization URL
   * GET /api/v1/social/linkedin/auth-url
   * GET /api/v1/social/linkedin/page/auth-url
   */
  public getAuthUrl = async (req: Request, res: Response): Promise<void> => {
    try {
      const redirectUri = req.query.redirect_uri as string | undefined;
      const state = req.query.state as string | undefined;
      const returnTo = req.query.return_to as string | undefined;
      const rawTarget = ((req.query.target as string) || '').toLowerCase().trim();
      const isPageRoute = req.path.includes('/page/');
      const target: LinkedInOAuthTarget =
        isPageRoute || rawTarget !== 'member' ? 'page' : 'member';

      const rawScopes = req.query.scopes || req.query.scope;
      let parsedScopes: string[] | undefined = undefined;
      if (typeof rawScopes === 'string' && rawScopes.trim()) {
        parsedScopes = rawScopes.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
      } else if (Array.isArray(rawScopes)) {
        parsedScopes = rawScopes.map((s) => String(s).trim()).filter(Boolean);
      } else {
        parsedScopes = target === 'member' ? LINKEDIN_MEMBER_SCOPES : getLinkedInPageScopes();
      }

      const result = this.service.getAuthUrl(redirectUri, state, parsedScopes, target, returnTo);
      res.status(200).json({ success: true, ...result });
    } catch (error: any) {
      console.error('[LinkedInController] getAuthUrl error:', error);
      res
        .status(error?.statusCode || 500)
        .json({ success: false, error: error?.message || 'Failed to generate auth URL' });
    }
  };

  /**
   * Handles OAuth 2.0 callback from LinkedIn
   * GET /api/v1/social/linkedin/callback
   */
  public handleCallback = async (req: Request, res: Response): Promise<void> => {
    try {
      const code = req.query.code as string;
      const state = req.query.state as string | undefined;
      const error = req.query.error as string;
      const errorDescription = req.query.error_description as string;
      const redirectUri = req.query.redirect_uri as string | undefined;
      const returnTo = req.query.return_to as string | undefined;

      if (error) {
        const stateEntry = state ? LinkedInService.getState(state) : undefined;
        console.error(`[LinkedInCallback] OAuth failed: ${error} - ${errorDescription}`, {
          state,
          stateEntry,
          pageClientId: process.env.LINKEDIN_PAGE_CLIENT_ID || '78ocx3kz1moo0s',
        });
        res.status(400).json({
          success: false,
          error: `LinkedIn authorization failed: ${error} - ${errorDescription || 'No description provided'}`,
          diagnostics: {
            requestedScopes: stateEntry?.scopes || getLinkedInPageScopes(),
            target: stateEntry?.target || 'page',
            clientId:
              stateEntry?.target === 'member'
                ? process.env.LINKEDIN_CLIENT_ID || '86mkbep31a3f0n'
                : process.env.LINKEDIN_PAGE_CLIENT_ID || '78ocx3kz1moo0s',
            actionRequired:
              'Check your LinkedIn Developer Portal (https://www.linkedin.com/developers/apps). Under Products, ensure "Community Management API" is approved, and under the Auth tab verify what scopes are listed under "OAuth 2.0 scopes".',
          },
        });
        return;
      }

      if (!code) {
        res.status(400).json({ success: false, error: 'Missing code parameter in LinkedIn callback' });
        return;
      }

      if (!state) {
        res.status(400).json({ success: false, error: 'Missing state parameter in LinkedIn callback' });
        return;
      }

      if (returnTo && !isAllowedReturnToUrl(returnTo)) {
        res.status(400).json({
          success: false,
          error: 'Invalid return_to URL. Only approved Leaders Performance CRM URLs are allowed.',
        });
        return;
      }

      // Auto-detect redirect URI from incoming request if not explicitly provided
      const autoRedirectUri = redirectUri || `${req.protocol}://${req.get('host')}${req.baseUrl}${req.path}`;
      const connection = await this.service.handleCallback(code, state, autoRedirectUri, returnTo);

      // Redirect back to Social CRM UI only if returnTo passes strict allowlist check
      const verifiedReturnTo = connection.returnTo;
      if (verifiedReturnTo && isAllowedReturnToUrl(verifiedReturnTo)) {
        const sep = verifiedReturnTo.includes('?') ? '&' : '?';
        res.redirect(
          `${verifiedReturnTo}${sep}linkedin_connected=true&target=${encodeURIComponent(
            connection.target
          )}&account=${encodeURIComponent(connection.accountName || '')}`
        );
        return;
      }

      res.status(200).json({
        success: true,
        message: 'Successfully connected LinkedIn account',
        data: connection,
      });
    } catch (error: any) {
      console.error('[LinkedInController] handleCallback error:', error);
      res
        .status(error?.statusCode || 500)
        .json({ success: false, error: error?.message || 'Failed to process LinkedIn callback' });
    }
  };

  /**
   * Retrieves active LinkedIn connection status (including publishingEnabled)
   * GET /api/v1/social/linkedin/status
   */
  public getStatus = async (req: Request, res: Response): Promise<void> => {
    try {
      const isPageRoute = req.path.includes('/page/');
      const rawTarget = ((req.query.target as string) || '').toLowerCase().trim();
      const target: LinkedInOAuthTarget | undefined = isPageRoute
        ? 'page'
        : rawTarget === 'page' || rawTarget === 'member'
        ? (rawTarget as LinkedInOAuthTarget)
        : undefined;
      const syncLive = req.query.sync === 'true' || req.query.refresh === 'true';

      const status = await this.service.getStatus(target, syncLive);
      res.status(200).json({ success: true, ...status });
    } catch (error: any) {
      console.error('[LinkedInController] getStatus error:', error);
      res.status(500).json({ success: false, error: error?.message || 'Failed to get LinkedIn status' });
    }
  };

  /**
   * Internally verifies/refreshes LinkedIn OAuth credentials, syncs profile into DB, and returns structured profile
   * GET /api/v1/social/linkedin/profile
   * GET /api/v1/social/linkedin/page/profile
   */
  public getProfile = async (req: Request, res: Response): Promise<void> => {
    try {
      const isPageRoute = req.path.includes('/page/');
      const rawTarget = ((req.query.target as string) || '').toLowerCase().trim();
      const target: LinkedInOAuthTarget = isPageRoute || rawTarget === 'page' ? 'page' : 'member';

      const profile = await this.service.getProfile(target);
      res.status(200).json({ success: true, data: profile });
    } catch (error: any) {
      console.error('[LinkedInController] getProfile error:', error);
      res
        .status(error?.statusCode || 500)
        .json({ success: false, error: error?.message || 'Failed to fetch LinkedIn profile' });
    }
  };

  /**
   * Disconnects active LinkedIn connection
   * POST /api/v1/social/linkedin/disconnect
   */
  public disconnect = async (req: Request, res: Response): Promise<void> => {
    try {
      const isPageRoute = req.path.includes('/page/');
      const rawTarget = ((req.query.target as string) || (req.body?.target as string) || '').toLowerCase().trim();
      const target: LinkedInOAuthTarget | 'all' = isPageRoute
        ? 'page'
        : rawTarget === 'page' || rawTarget === 'member'
        ? (rawTarget as LinkedInOAuthTarget)
        : 'all';

      const result = await this.service.disconnect(target);
      res.status(200).json(result);
    } catch (error: any) {
      console.error('[LinkedInController] disconnect error:', error);
      res.status(500).json({ success: false, error: error?.message || 'Failed to disconnect LinkedIn' });
    }
  };

  /**
   * Directly posts to LinkedIn using internal DB credentials, persists post in DB, and returns structured result
   * POST /api/v1/social/linkedin/share
   */
  public publishDirect = async (req: Request, res: Response): Promise<void> => {
    try {
      if (!isLinkedInPublishingEnabled()) {
        res.status(403).json({
          success: false,
          error: 'LinkedIn publishing is currently disabled (LINKEDIN_PUBLISHING_ENABLED=false).',
        });
        return;
      }

      const { text, title, hook, body, mediaUrl, mediaType, tags } = req.body || {};
      const resolvedText = (text || body || '').trim();
      if (!resolvedText) {
        res.status(400).json({ success: false, error: 'Text content is required to publish to LinkedIn' });
        return;
      }

      const result = await this.service.publishDirect({
        text: resolvedText,
        title,
        hook,
        body,
        mediaUrl,
        mediaType,
        tags,
      });
      res.status(200).json({ success: true, data: result });
    } catch (error: any) {
      console.error('[LinkedInController] publishDirect error:', error);
      res
        .status(error?.statusCode || 500)
        .json({ success: false, error: error?.message || 'Failed to publish post to LinkedIn' });
    }
  };

  /**
   * Retrieves LinkedIn posts stored in DB and optionally syncs live engagement metrics from LinkedIn API
   * GET /api/v1/social/linkedin/posts
   */
  public getPosts = async (req: Request, res: Response): Promise<void> => {
    try {
      const sync = req.query.sync !== 'false';
      const limit = Number(req.query.limit) || 25;
      const result = await this.service.getPosts({ sync, limit });
      res.status(200).json({ success: true, ...result });
    } catch (error: any) {
      console.error('[LinkedInController] getPosts error:', error);
      res
        .status(error?.statusCode || 500)
        .json({ success: false, error: error?.message || 'Failed to fetch LinkedIn posts' });
    }
  };

  /**
   * Full internal synchronization of LinkedIn profile, posts, and company analytics into DB
   * POST /api/v1/social/linkedin/sync
   */
  public syncAll = async (req: Request, res: Response): Promise<void> => {
    try {
      const range = (req.body?.range as string) || (req.query.range as string) || '30d';
      const result = await this.service.syncAll(range);
      res.status(200).json({ success: true, data: result });
    } catch (error: any) {
      console.error('[LinkedInController] syncAll error:', error);
      res
        .status(error?.statusCode || 500)
        .json({ success: false, error: error?.message || 'Failed to synchronize LinkedIn data' });
    }
  };

  /**
   * Pings LinkedIn API credentials and health status
   * GET /api/v1/social/linkedin/ping
   */
  public ping = async (_req: Request, res: Response): Promise<void> => {
    try {
      const result = await this.service.ping();
      res.status(200).json({ success: true, ...result });
    } catch (error: any) {
      console.error('[LinkedInController] ping error:', error);
      res.status(500).json({ success: false, error: error?.message || 'Failed to ping LinkedIn' });
    }
  };
}
