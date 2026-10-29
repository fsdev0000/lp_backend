import { Request, Response } from 'express';
import { AnalyticsService } from '../services/analytics.service';
import { SseStreamManager } from '../realtime/sseStreamManager';

export class AnalyticsController {
  private service = new AnalyticsService();

  public getOverview = async (req: Request, res: Response): Promise<void> => {
    try {
      const range = (req.query.range as string) || '30d';
      const data = await this.service.getOverview(range);
      res.status(200).json({ success: true, data });
    } catch (error: any) {
      console.error('[AnalyticsController] getOverview failed:', error);
      res.status(502).json({
        success: false,
        error: error?.message || 'Failed to retrieve analytics overview',
      });
    }
  };

  public getChannels = async (req: Request, res: Response): Promise<void> => {
    try {
      const data = await this.service.getChannels();
      res.status(200).json({ success: true, data });
    } catch (error: any) {
      console.error('[AnalyticsController] getChannels failed:', error);
      res.status(502).json({
        success: false,
        error: error?.message || 'Failed to retrieve channel performance',
      });
    }
  };

  public getKeywords = async (req: Request, res: Response): Promise<void> => {
    try {
      const limit = parseInt(req.query.limit as string, 10) || 100;
      const range = (req.query.range as string) || '30d';
      const domain = (req.query.domain as string) || 'leadersperformance.ae';
      const startDate = req.query.startDate as string | undefined;
      const endDate = req.query.endDate as string | undefined;

      const result = await this.service.getKeywords({
        limit,
        range,
        domain,
        startDate,
        endDate,
      });

      res.status(200).json({
        success: true,
        data: result,
        totals: result.totals,
        queries: result.queries,
      });
    } catch (error: any) {
      console.error('[AnalyticsController] getKeywords failed:', error);
      res.status(502).json({
        success: false,
        error: error?.message || 'Failed to retrieve search queries',
      });
    }
  };

  public getTelemetry = async (req: Request, res: Response): Promise<void> => {
    try {
      const data = await this.service.getTelemetry();
      res.status(200).json({ success: true, data });
    } catch (error: any) {
      console.error('[AnalyticsController] getTelemetry failed:', error);
      res.status(502).json({
        success: false,
        error: error?.message || 'Failed to retrieve telemetry signals',
      });
    }
  };

  public getIntegrationsStatus = async (req: Request, res: Response): Promise<void> => {
    try {
      const data = await this.service.getIntegrationsStatus();
      res.status(200).json({ success: true, data });
    } catch (error: any) {
      console.error('[AnalyticsController] getIntegrationsStatus failed:', error);
      res.status(502).json({
        success: false,
        error: error?.message || 'Failed to evaluate integration health',
      });
    }
  };

  public pingIntegration = async (req: Request, res: Response): Promise<void> => {
    try {
      const providerId = (Array.isArray(req.params.id) ? req.params.id[0] : req.params.id) || '';
      const data = await this.service.pingIntegration(providerId);
      res.status(200).json({ success: true, data });
    } catch (error: any) {
      console.error('[AnalyticsController] pingIntegration failed:', error);
      res.status(502).json({
        success: false,
        error: error?.message || 'Integration ping failed',
      });
    }
  };

  public streamRealtime = (req: Request, res: Response): void => {
    SseStreamManager.getInstance().registerClient(req, res);
  };

  public getReportsSnapshot = async (req: Request, res: Response): Promise<void> => {
    try {
      const startDate = typeof req.query.startDate === 'string' ? req.query.startDate : '30daysAgo';
      const endDate = typeof req.query.endDate === 'string' ? req.query.endDate : 'today';
      const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 10;

      const data = await this.service.getReportsSnapshot(startDate, endDate, limit);
      res.status(200).json({ success: true, data });
    } catch (error: any) {
      console.error('[AnalyticsController] getReportsSnapshot failed:', error);
      res.status(502).json({
        success: false,
        error: error?.message || 'Failed to generate GA4 reports snapshot',
      });
    }
  };

  public getClaritySessions = async (req: Request, res: Response): Promise<void> => {
    try {
      const website = typeof req.query.website === 'string' ? req.query.website : 'leaders_performance';
      const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 20;
      const data = await this.service.getClaritySessions(limit, website);
      res.status(200).json({ success: true, data });
    } catch (error: any) {
      console.error('[AnalyticsController] getClaritySessions failed:', error);
      res.status(502).json({
        success: false,
        error: error?.message || 'Failed to retrieve Clarity sessions',
      });
    }
  };

  public getClarityAnalytics = async (req: Request, res: Response): Promise<void> => {
    try {
      const website = typeof req.query.website === 'string' ? req.query.website : 'leaders_performance';
      const days = typeof req.query.days === 'string' ? parseInt(req.query.days, 10) : 1;
      const data = await this.service.getClarityAnalytics(website, false, days);
      res.status(200).json({ success: true, data });
    } catch (error: any) {
      console.error('[AnalyticsController] getClarityAnalytics failed:', error);
      res.status(502).json({
        success: false,
        error: error?.message || 'Failed to retrieve Clarity analytics',
      });
    }
  };

  public refreshClarityAnalytics = async (req: Request, res: Response): Promise<void> => {
    try {
      const website = (req.body?.website || req.query.website || 'leaders_performance') as string;
      const data = await this.service.refreshClarityAnalytics(website);
      res.status(200).json({ success: true, message: 'Clarity cache refreshed', data });
    } catch (error: any) {
      console.error('[AnalyticsController] refreshClarityAnalytics failed:', error);
      res.status(502).json({
        success: false,
        error: error?.message || 'Failed to refresh Clarity analytics',
      });
    }
  };

  public getClarityRecordings = async (req: Request, res: Response): Promise<void> => {
    try {
      const website = typeof req.query.website === 'string' ? req.query.website : 'leaders_performance';
      const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 20;
      const data = await this.service.getClarityRecordings(website, limit);
      res.status(200).json({ success: true, data });
    } catch (error: any) {
      console.error('[AnalyticsController] getClarityRecordings failed:', error);
      res.status(502).json({
        success: false,
        error: error?.message || 'Failed to retrieve Clarity recordings',
      });
    }
  };

  public getClarityStatus = async (req: Request, res: Response): Promise<void> => {
    try {
      const website = typeof req.query.website === 'string' ? req.query.website : undefined;
      const data = await this.service.getClarityStatus(website);
      res.status(200).json({ success: true, data });
    } catch (error: any) {
      console.error('[AnalyticsController] getClarityStatus failed:', error);
      res.status(502).json({
        success: false,
        error: error?.message || 'Failed to evaluate Clarity status',
      });
    }
  };

  public ingestClarityWebhook = async (req: Request, res: Response): Promise<void> => {
    try {
      const website = (req.body?.website || req.query.website || 'leaders_performance') as string;
      const result = await this.service.ingestClarityWebhook(req.body, website);
      res.status(200).json({ success: true, data: result });
    } catch (error: any) {
      console.error('[AnalyticsController] ingestClarityWebhook failed:', error);
      res.status(500).json({
        success: false,
        error: error?.message || 'Failed to ingest Clarity webhook payload',
      });
    }
  };

  public getYouTubeAnalytics = async (req: Request, res: Response): Promise<void> => {
    try {
      const refresh = req.query.refresh === 'true';
      const data = await this.service.getYouTubeAnalytics(refresh);
      res.status(200).json({ success: true, data });
    } catch (error: any) {
      console.error('[AnalyticsController] getYouTubeAnalytics failed:', error);
      res.status(502).json({
        success: false,
        error: error?.message || 'Failed to retrieve YouTube analytics',
      });
    }
  };
}

