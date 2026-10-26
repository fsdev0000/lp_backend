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
      const limit = parseInt(req.query.limit as string, 10) || 20;
      const data = await this.service.getKeywords(limit);
      res.status(200).json({ success: true, data });
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
}
