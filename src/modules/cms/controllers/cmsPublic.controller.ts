import { Request, Response } from 'express';
import { cmsService } from '../services/cms.service';

export class CmsPublicController {
  /**
   * GET /api/v1/cms/pages/:slug
   */
  public async getPage(req: Request, res: Response): Promise<void> {
    try {
      const slug = String(req.params.slug);
      const preview = req.query.preview === 'true';
      const page = await cmsService.getPageBySlug(slug, preview);

      if (!page) {
        res.status(404).json({
          success: false,
          error: `Page '${slug}' was not found`,
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: page,
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: err.message || 'Internal server error while fetching page',
      });
    }
  }

  /**
   * GET /api/v1/cms/sections/:slug/:sectionKey
   */
  public async getSection(req: Request, res: Response): Promise<void> {
    try {
      const slug = String(req.params.slug);
      const sectionKey = String(req.params.sectionKey);
      const section = await cmsService.getSectionByKey(slug, sectionKey);

      if (!section) {
        res.status(404).json({
          success: false,
          error: `Section '${sectionKey}' in page '${slug}' not found`,
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: section,
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: err.message || 'Internal server error while fetching section',
      });
    }
  }

  /**
   * GET /api/v1/cms/navigation/:location
   */
  public async getNavigation(req: Request, res: Response): Promise<void> {
    try {
      const location = String(req.params.location);
      const menu = await cmsService.getNavigationMenu(location);

      if (!menu) {
        res.status(404).json({
          success: false,
          error: `Navigation menu for '${location}' not found`,
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: menu,
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: err.message || 'Internal server error while fetching navigation',
      });
    }
  }

  /**
   * GET /api/v1/cms/navigation
   */
  public async getAllNavigation(_req: Request, res: Response): Promise<void> {
    try {
      const menus = await cmsService.getAllNavigation();
      res.status(200).json({
        success: true,
        data: menus,
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: err.message || 'Internal server error while fetching navigation menus',
      });
    }
  }

  /**
   * GET /api/v1/cms/testimonials
   */
  public async getTestimonials(req: Request, res: Response): Promise<void> {
    try {
      const category = req.query.category as string | undefined;
      const testimonials = await cmsService.getTestimonials(category);
      res.status(200).json({
        success: true,
        data: testimonials,
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: err.message || 'Internal server error while fetching testimonials',
      });
    }
  }

  /**
   * GET /api/v1/cms/faqs
   */
  public async getFaqs(req: Request, res: Response): Promise<void> {
    try {
      const category = req.query.category as string | undefined;
      const faqs = await cmsService.getFaqs(category);
      res.status(200).json({
        success: true,
        data: faqs,
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: err.message || 'Internal server error while fetching FAQs',
      });
    }
  }

  /**
   * GET /api/v1/cms/settings
   */
  public async getSettings(_req: Request, res: Response): Promise<void> {
    try {
      const settings = await cmsService.getSiteSettings();
      res.status(200).json({
        success: true,
        data: settings,
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: err.message || 'Internal server error while fetching settings',
      });
    }
  }

  /**
   * GET /api/v1/cms/bootstrap
   * High-speed single round-trip boot endpoint
   */
  public async getBootstrap(_req: Request, res: Response): Promise<void> {
    try {
      const config = await cmsService.getBootstrapConfig();
      res.status(200).json({
        success: true,
        data: config,
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: err.message || 'Internal server error while bootstrapping CMS data',
      });
    }
  }
}

export const cmsPublicController = new CmsPublicController();
