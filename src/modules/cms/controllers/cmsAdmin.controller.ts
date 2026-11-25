import { Request, Response } from 'express';
import { cmsService } from '../services/cms.service';
import { cmsCache } from '../cache/cmsCache.service';
import {
  CmsPageInputSchema,
  CmsSectionInputSchema,
  CmsTestimonialInputSchema,
  CmsFaqInputSchema,
  CmsNavigationMenuInputSchema,
  CmsSiteSettingInputSchema,
  CmsTextInputSchema,
  CmsTextDiscardSchema,
  CmsTextPublishSchema,
  isSupportedCmsLocale,
} from '../validation/cms.validation';

export class CmsAdminController {
  /**
   * GET /api/v1/cms/admin/pages
   */
  public async listPages(req: Request, res: Response): Promise<void> {
    try {
      const status = req.query.status as any;
      const pages = await cmsService.listPages(status);
      res.status(200).json({ success: true, data: pages });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  /**
   * POST /api/v1/cms/admin/pages
   * PUT /api/v1/cms/admin/pages/:slug
   */
  public async savePage(req: Request, res: Response): Promise<void> {
    try {
      // Fix 2f: If slug is present in URL params, use it over body
      const rawData = {
        ...req.body,
        ...(req.params.slug ? { slug: String(req.params.slug) } : {}),
      };

      const parseResult = CmsPageInputSchema.safeParse(rawData);
      if (!parseResult.success) {
        res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: parseResult.error.format(),
        });
        return;
      }

      const page = await cmsService.savePage(parseResult.data);
      res.status(200).json({ success: true, data: page });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  /**
   * PUT /api/v1/cms/admin/pages/:slug/sections/:sectionKey
   */
  public async saveSection(req: Request, res: Response): Promise<void> {
    try {
      const slug = String(req.params.slug);
      const parseResult = CmsSectionInputSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: parseResult.error.format(),
        });
        return;
      }

      const section = await cmsService.saveSection(slug, parseResult.data);
      res.status(200).json({ success: true, data: section });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  /**
   * POST /api/v1/cms/admin/pages/:slug/publish
   */
  public async publishPage(req: Request, res: Response): Promise<void> {
    try {
      const slug = String(req.params.slug);
      const published = await cmsService.publishPage(slug);
      res.status(200).json({ success: true, data: published });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  /**
   * DELETE /api/v1/cms/admin/pages/:slug
   */
  public async deletePage(req: Request, res: Response): Promise<void> {
    try {
      const slug = String(req.params.slug);
      await cmsService.deletePage(slug);
      res.status(200).json({ success: true, message: `Page '${slug}' deleted` });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  /**
   * POST /api/v1/cms/admin/testimonials
   * PUT /api/v1/cms/admin/testimonials/:id
   */
  public async saveTestimonial(req: Request, res: Response): Promise<void> {
    try {
      const id = req.params.id ? String(req.params.id) : null;
      const parseResult = CmsTestimonialInputSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: parseResult.error.format(),
        });
        return;
      }

      const testimonial = await cmsService.saveTestimonial(id, parseResult.data);
      res.status(200).json({ success: true, data: testimonial });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  /**
   * DELETE /api/v1/cms/admin/testimonials/:id
   */
  public async deleteTestimonial(req: Request, res: Response): Promise<void> {
    try {
      const id = String(req.params.id);
      await cmsService.deleteTestimonial(id);
      res.status(200).json({ success: true, message: 'Testimonial deleted' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  /**
   * POST /api/v1/cms/admin/faqs
   * PUT /api/v1/cms/admin/faqs/:id
   */
  public async saveFaq(req: Request, res: Response): Promise<void> {
    try {
      const id = req.params.id ? String(req.params.id) : null;
      const parseResult = CmsFaqInputSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: parseResult.error.format(),
        });
        return;
      }

      const faq = await cmsService.saveFaq(id, parseResult.data);
      res.status(200).json({ success: true, data: faq });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  /**
   * DELETE /api/v1/cms/admin/faqs/:id
   */
  public async deleteFaq(req: Request, res: Response): Promise<void> {
    try {
      const id = String(req.params.id);
      await cmsService.deleteFaq(id);
      res.status(200).json({ success: true, message: 'FAQ deleted' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  /**
   * PUT /api/v1/cms/admin/navigation
   */
  public async saveNavigation(req: Request, res: Response): Promise<void> {
    try {
      const parseResult = CmsNavigationMenuInputSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: parseResult.error.format(),
        });
        return;
      }

      const menu = await cmsService.saveNavigation(parseResult.data);
      res.status(200).json({ success: true, data: menu });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  /**
   * PUT /api/v1/cms/admin/settings
   */
  public async saveSiteSetting(req: Request, res: Response): Promise<void> {
    try {
      const parseResult = CmsSiteSettingInputSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: parseResult.error.format(),
        });
        return;
      }

      const setting = await cmsService.saveSiteSetting(parseResult.data);
      res.status(200).json({ success: true, data: setting });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  // ============================================================================
  // CMS TEXTS ADMIN ENDPOINTS (Section 4 — English 'en' & Dutch 'nl')
  // ============================================================================

  /**
   * GET /api/v1/cms/admin/texts?locale=en|nl
   */
  public async listTexts(req: Request, res: Response): Promise<void> {
    try {
      const locale = req.query.locale !== undefined ? String(req.query.locale) : 'en';
      if (!isSupportedCmsLocale(locale)) {
        res.status(400).json({
          success: false,
          code: 'INVALID_LOCALE',
          error: 'Unsupported locale. Supported locales are "en" and "nl".',
        });
        return;
      }
      const texts = await cmsService.getAllTexts(locale);
      res.status(200).json({ success: true, data: texts });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  /**
   * PUT /api/v1/cms/admin/texts
   * Saves a draft value for a text key in 'en' or 'nl'
   */
  public async saveText(req: Request, res: Response): Promise<void> {
    try {
      const rawLocale = req.body?.locale !== undefined ? req.body.locale : (req.query.locale as string) || 'en';
      if (!isSupportedCmsLocale(rawLocale)) {
        res.status(400).json({
          success: false,
          code: 'INVALID_LOCALE',
          error: 'Unsupported locale. Supported locales are "en" and "nl".',
        });
        return;
      }

      const parseResult = CmsTextInputSchema.safeParse({
        ...req.body,
        locale: rawLocale,
      });
      if (!parseResult.success) {
        res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: parseResult.error.format(),
        });
        return;
      }

      const { key, locale, value } = parseResult.data;
      const actorEmail = (req as any).user?.email || 'admin@leadersperformance.ae';
      const text = await cmsService.saveTextDraft(key, locale, value, actorEmail);
      res.status(200).json({ success: true, data: text });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  /**
   * POST /api/v1/cms/admin/texts/discard
   * Discards drafts for given keys in the selected locale ('en' or 'nl')
   */
  public async discardTexts(req: Request, res: Response): Promise<void> {
    try {
      const locale =
        req.query.locale !== undefined
          ? String(req.query.locale)
          : req.body?.locale !== undefined
          ? String(req.body.locale)
          : 'en';
      if (!isSupportedCmsLocale(locale)) {
        res.status(400).json({
          success: false,
          code: 'INVALID_LOCALE',
          error: 'Unsupported locale. Supported locales are "en" and "nl".',
        });
        return;
      }

      const parseResult = CmsTextDiscardSchema.safeParse({
        ...req.body,
        locale,
      });
      if (!parseResult.success) {
        res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: parseResult.error.format(),
        });
        return;
      }

      const actorEmail = (req as any).user?.email || 'admin@leadersperformance.ae';
      const result = await cmsService.discardTextDrafts(parseResult.data.keys, locale, actorEmail);
      res.status(200).json({ success: true, data: result });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  /**
   * POST /api/v1/cms/admin/texts/publish
   * Publishes drafts (all or specific keys) for the selected locale ('en' or 'nl')
   */
  public async publishTexts(req: Request, res: Response): Promise<void> {
    try {
      const locale =
        req.query.locale !== undefined
          ? String(req.query.locale)
          : req.body?.locale !== undefined
          ? String(req.body.locale)
          : 'en';
      if (!isSupportedCmsLocale(locale)) {
        res.status(400).json({
          success: false,
          code: 'INVALID_LOCALE',
          error: 'Unsupported locale. Supported locales are "en" and "nl".',
        });
        return;
      }

      const parseResult = CmsTextPublishSchema.safeParse({
        ...(req.body || {}),
        locale,
      });
      if (!parseResult.success) {
        res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: parseResult.error.format(),
        });
        return;
      }

      const actorEmail = (req as any).user?.email || 'admin@leadersperformance.ae';
      const result = await cmsService.publishTextDrafts(parseResult.data?.keys, locale, actorEmail);
      res.status(200).json({ success: true, data: result });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  /**
   * GET /api/v1/cms/admin/texts/history?key=...&locale=en|nl
   */
  public async getTextHistory(req: Request, res: Response): Promise<void> {
    try {
      const key = req.query.key as string;
      if (!key) {
        res.status(400).json({
          success: false,
          error: 'Query parameter "key" is required',
        });
        return;
      }

      const locale = req.query.locale !== undefined ? String(req.query.locale) : 'en';
      if (!isSupportedCmsLocale(locale)) {
        res.status(400).json({
          success: false,
          code: 'INVALID_LOCALE',
          error: 'Unsupported locale. Supported locales are "en" and "nl".',
        });
        return;
      }

      const history = await cmsService.getTextHistory(key, locale);
      res.status(200).json({ success: true, data: history });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  /**
   * POST /api/v1/cms/admin/cache/purge
   */
  public purgeCache(req: Request, res: Response): void {
    const { tag, key } = req.body || {};
    const target = tag || key || req.query.tag || req.query.key || 'all';
    const result = cmsService.purgeCache(target as string);
    res.status(200).json({ success: true, data: result });
  }

  /**
   * GET /api/v1/cms/admin/cache/stats
   */
  public getCacheStats(_req: Request, res: Response): void {
    const stats = cmsCache.getStats();
    res.status(200).json({ success: true, data: stats });
  }
}

export const cmsAdminController = new CmsAdminController();
