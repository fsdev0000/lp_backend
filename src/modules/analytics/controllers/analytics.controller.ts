import { Request, Response } from 'express';
import { AnalyticsService } from '../services/analytics.service';
import { SseStreamManager } from '../realtime/sseStreamManager';
import { analyticsReportGeneratorService } from '../services/analyticsReportGenerator.service';

export class AnalyticsController {
  private service = new AnalyticsService();

  public getOverview = async (req: Request, res: Response): Promise<void> => {
    try {
      const range = (req.query.range as string) || '30d';
      const domain = (req.query.domain as string) || 'leadersperformance.ae';
      const data = await this.service.getOverview(range, domain);
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
      const range = (req.query.range as string) || '30d';
      const domain = (req.query.domain as string) || 'leadersperformance.ae';
      const data = await this.service.getChannels(range, domain);
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
      const website = ((req.query.domain as string) || (req.query.website as string) || 'leaders_performance') as string;
      const data = await this.service.getTelemetry(website);
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
      const domain = (req.query.domain as string) || 'leadersperformance.ae';
      const range = req.query.range as string | undefined;
      const startDate = typeof req.query.startDate === 'string' ? req.query.startDate : undefined;
      const endDate = typeof req.query.endDate === 'string' ? req.query.endDate : undefined;
      const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 10;

      const data = await this.service.getReportsSnapshot(startDate, endDate, limit, domain, range);
      res.status(200).json({ success: true, data, domain });
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
      const website = ((req.query.domain as string) || (req.query.website as string) || 'leaders_performance') as string;
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
      const website = ((req.query.domain as string) || (req.query.website as string) || 'leaders_performance') as string;
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
      const website = (req.body?.domain || req.body?.website || req.query.domain || req.query.website || 'leaders_performance') as string;
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
      const website = ((req.query.domain as string) || (req.query.website as string) || 'leaders_performance') as string;
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
      const website = ((req.query.domain as string) || (req.query.website as string) || undefined) as string | undefined;
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
      const website = (req.body?.domain || req.body?.website || req.query.domain || req.query.website || 'leaders_performance') as string;
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
      const range = ((req.query.range as string) || '7d').toLowerCase();
      const data = await this.service.getYouTubeAnalytics(range, refresh);
      res.status(200).json({ success: true, data });
    } catch (error: any) {
      console.error('[AnalyticsController] getYouTubeAnalytics failed:', error);
      res.status(502).json({
        success: false,
        error: error?.message || 'Failed to retrieve YouTube analytics',
      });
    }
  };

  public getYouTubeVideos = async (req: Request, res: Response): Promise<void> => {
    try {
      const type = ((req.query.type as string) || 'videos').toLowerCase();
      if (type !== 'videos' && type !== 'shorts') {
        res.status(400).json({
          success: false,
          error: "Invalid type parameter. Expected 'videos' or 'shorts'.",
        });
        return;
      }
      const refresh = req.query.refresh === 'true';
      const videos = await this.service.getYouTubeVideos(type as 'videos' | 'shorts', refresh);
      res.status(200).json({ success: true, videos, data: { videos } });
    } catch (error: any) {
      console.error('[AnalyticsController] getYouTubeVideos failed:', error);
      res.status(502).json({
        success: false,
        error: error?.message || 'Failed to retrieve YouTube videos',
      });
    }
  };

  public getYouTubePlaylists = async (req: Request, res: Response): Promise<void> => {
    try {
      const refresh = req.query.refresh === 'true';
      const playlists = await this.service.getYouTubePlaylists(refresh);
      res.status(200).json({ success: true, playlists, data: { playlists } });
    } catch (error: any) {
      console.error('[AnalyticsController] getYouTubePlaylists failed:', error);
      res.status(502).json({
        success: false,
        error: error?.message || 'Failed to retrieve YouTube playlists',
      });
    }
  };

  public getLinkedInAnalytics = async (req: Request, res: Response): Promise<void> => {
    try {
      const refresh = req.query.refresh === 'true';
      const range = ((req.query.range as string) || '7d').toLowerCase();
      const accountType = (req.query.accountType as string) || (req.query.type as string) || 'all';
      const data = await this.service.getLinkedInAnalytics(range, refresh, accountType as any);
      res.status(200).json({ success: true, data });
    } catch (error: any) {
      console.error('[AnalyticsController] getLinkedInAnalytics failed:', error);
      res.status(502).json({
        success: false,
        error: error?.message || 'Failed to retrieve LinkedIn analytics',
      });
    }
  };

  public getLinkedInPosts = async (req: Request, res: Response): Promise<void> => {
    try {
      const refresh = req.query.refresh === 'true';
      const posts = await this.service.getLinkedInPosts(refresh);
      res.status(200).json({ success: true, posts, data: { posts } });
    } catch (error: any) {
      console.error('[AnalyticsController] getLinkedInPosts failed:', error);
      res.status(502).json({
        success: false,
        error: error?.message || 'Failed to retrieve LinkedIn posts',
      });
    }
  };

  public getInstagramAnalytics = async (req: Request, res: Response): Promise<void> => {
    try {
      const refresh = req.query.refresh === 'true';
      const range = ((req.query.range as string) || '7d').toLowerCase();
      const data = await this.service.getInstagramAnalytics(range, refresh);
      res.status(200).json({ success: true, data });
    } catch (error: any) {
      console.error('[AnalyticsController] getInstagramAnalytics failed:', error);
      res.status(502).json({
        success: false,
        error: error?.message || 'Failed to retrieve Instagram analytics',
      });
    }
  };

  public getInstagramPosts = async (req: Request, res: Response): Promise<void> => {
    try {
      const refresh = req.query.refresh === 'true';
      const posts = await this.service.getInstagramPosts(refresh);
      res.status(200).json({ success: true, posts, data: { posts } });
    } catch (error: any) {
      console.error('[AnalyticsController] getInstagramPosts failed:', error);
      res.status(502).json({
        success: false,
        error: error?.message || 'Failed to retrieve Instagram posts',
      });
    }
  };

  public exportReport = async (req: Request, res: Response): Promise<void> => {
    try {
      const format = ((req.query.format as string) || 'pdf').toLowerCase();
      const domain = (req.query.domain as string) || 'leadersperformance.ae';
      const range = (req.query.range as string) || '30d';
      const startDate = req.query.startDate as string | undefined;
      const endDate = req.query.endDate as string | undefined;
      const frequency = (range === '7d' ? 'WEEKLY' : range === '30d' ? 'MONTHLY' : 'ON_DEMAND') as any;

      const data = await analyticsReportGeneratorService.collectReportData({
        range,
        domain,
        startDate,
        endDate,
        frequency,
      });

      const dateStr = new Date().toISOString().slice(0, 10);

      if (format === 'csv') {
        const csv = analyticsReportGeneratorService.generateCsvReport(data);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="analytics-report-${domain}-${dateStr}.csv"`);
        res.status(200).send(csv);
        return;
      }

      if (format === 'json') {
        res.status(200).json({ success: true, data });
        return;
      }

      // Default: PDF
      const pdf = analyticsReportGeneratorService.generatePdfReport(data);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="analytics-report-${domain}-${dateStr}.pdf"`);
      res.status(200).send(pdf);
    } catch (error: any) {
      console.error('[AnalyticsController] exportReport failed:', error);
      res.status(502).json({
        success: false,
        error: error?.message || 'Failed to export analytics report',
      });
    }
  };

  public dispatchReport = async (req: Request, res: Response): Promise<void> => {
    try {
      const frequency = ((req.body?.frequency || req.query.frequency || 'WEEKLY') as string).toUpperCase() as any;
      const domain = (req.body?.domain || req.query.domain || 'leadersperformance.ae') as string;

      const result = await analyticsReportGeneratorService.dispatchExecutiveAnalyticsReport({
        frequency,
        domain,
      });

      res.status(200).json({
        success: true,
        message: `Analytics report successfully dispatched (${frequency})`,
        data: result,
      });
    } catch (error: any) {
      console.error('[AnalyticsController] dispatchReport failed:', error);
      res.status(502).json({
        success: false,
        error: error?.message || 'Failed to dispatch analytics report',
      });
    }
  };
}


