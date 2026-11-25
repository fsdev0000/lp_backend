import { Request, Response } from 'express';
import { lionelWebsiteService } from '../services/lionelWebsite.service';
import { AnalyticsService } from '../../analytics/services/analytics.service';

export class LionelWebsiteController {
  public submitContact = async (req: Request, res: Response): Promise<void> => {
    try {
      const result = await lionelWebsiteService.submitContactInquiry(req.body || {}, req);
      AnalyticsService.clearOverviewCache();
      res.status(200).json({
        success: true,
        inquiryId: result.inquiryId,
        contactId: result.contactId,
        data: result.inquiry,
      });
    } catch (error: any) {
      const status = error?.statusCode || 500;
      console.error('[LionelWebsiteController] submitContact failed:', error?.message);
      res.status(status).json({
        success: false,
        error: error?.message || 'Failed to process Lionel Eersteling website inquiry',
      });
    }
  };

  public listInquiries = async (req: Request, res: Response): Promise<void> => {
    try {
      const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 50;
      const inquiries = await lionelWebsiteService.getInquiries({ limit });
      res.status(200).json({
        success: true,
        domain: 'lioneleersteling.com',
        count: inquiries.length,
        inquiries,
        data: { inquiries, count: inquiries.length },
      });
    } catch (error: any) {
      console.error('[LionelWebsiteController] listInquiries failed:', error?.message);
      res.status(500).json({
        success: false,
        error: error?.message || 'Failed to retrieve Lionel Eersteling website inquiries',
      });
    }
  };

  public syncInquiries = async (_req: Request, res: Response): Promise<void> => {
    try {
      const result = await lionelWebsiteService.syncExternalInquiries(true);
      AnalyticsService.clearOverviewCache();
      res.status(200).json({
        success: true,
        domain: 'lioneleersteling.com',
        synced: result.synced,
      });
    } catch (error: any) {
      console.error('[LionelWebsiteController] syncInquiries failed:', error?.message);
      res.status(500).json({
        success: false,
        error: error?.message || 'Failed to sync external inquiries',
      });
    }
  };
}
