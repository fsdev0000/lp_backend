import { Request, Response } from 'express';
import { articlesService, ArticlesService } from '../services/articles.service';

/**
 * Resolves requested locale strictly with priority:
 * 1. Query parameter (?locale=nl or ?locale=en)
 * 2. Header (x-locale: nl or x-locale: en)
 * 3. Default 'en'
 * (Never guesses from Referer or Accept-Language)
 */
function resolveLocale(req: Request): string {
  if (req.query.locale && typeof req.query.locale === 'string') {
    const loc = req.query.locale.trim().toLowerCase();
    if (loc === 'nl' || loc === 'en') return loc;
  }
  const xLocale = req.headers['x-locale'];
  if (typeof xLocale === 'string') {
    const loc = xLocale.trim().toLowerCase();
    if (loc === 'nl' || loc === 'en') return loc;
  }
  return 'en';
}

export class ArticlesController {
  constructor(private service: ArticlesService = articlesService) {}

  /**
   * Middleware to authenticate management operations via x-api-key.
   */
  authenticate = async (req: Request, res: Response, next: Function) => {
    const apiKey = (req.headers['x-api-key'] || req.headers['authorization']) as string | undefined;
    const cleanKey = apiKey?.replace(/^Bearer\s+/i, '');

    const isValid = await this.service.verifyApiKey(cleanKey);
    if (!isValid) {
      console.warn(`[articles] Unauthorized management request: IP=${req.ip}, Path=${req.originalUrl}`);
      return res.status(401).json({ error: 'Unauthorized' });
    }

    next();
  };

  /**
   * GET /api/articles or /api/v1/articles
   * Returns list of published articles. Supports ?locale=nl.
   */
  listArticles = async (req: Request, res: Response) => {
    try {
      const locale = resolveLocale(req);
      console.log(`[articles] GET /articles locale=${locale} IP=${req.ip}`);
      const articles = await this.service.listPublishedArticles(locale);
      res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
      res.setHeader('Vary', 'Origin');
      return res.status(200).json({ articles, locale });
    } catch (error) {
      console.error('[articles] GET list error:', error instanceof Error ? error.message : String(error));
      return res.status(500).json({ error: 'An internal error occurred.' });
    }
  };

  /**
   * GET /api/articles/:slug or /api/v1/articles/:slug
   * Returns single published article by slug. Supports ?locale=nl.
   */
  getArticleBySlug = async (req: Request, res: Response) => {
    try {
      const rawSlug = req.params.slug;
      const slug = Array.isArray(rawSlug) ? rawSlug[0] : rawSlug;
      if (!slug) {
        return res.status(400).json({ error: 'Missing slug parameter' });
      }

      const locale = resolveLocale(req);
      console.log(`[articles] GET /articles/${slug} locale=${locale}`);
      const article = await this.service.getPublishedArticleBySlug(slug, locale);

      if (!article) {
        return res.status(404).json({ error: 'Article not found' });
      }

      res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
      res.setHeader('Vary', 'Origin');
      return res.status(200).json({ article, locale: article.locale || locale });
    } catch (error) {
      console.error(`[articles] GET /articles/${req.params?.slug} error:`, error instanceof Error ? error.message : String(error));
      return res.status(500).json({ error: 'An internal error occurred.' });
    }
  };

  /**
   * GET /api/articles/:slug/translation
   * Management endpoint to inspect translation status and payload for an article.
   */
  getTranslationStatus = async (req: Request, res: Response) => {
    try {
      const rawSlug = req.params.slug;
      const slug = Array.isArray(rawSlug) ? rawSlug[0] : String(rawSlug || '');
      if (!slug) {
        return res.status(400).json({ error: 'Missing slug parameter' });
      }
      const status = await this.service.getArticleTranslationStatus(slug);
      if (!status) {
        return res.status(404).json({ error: 'Article not found' });
      }
      return res.status(200).json(status);
    } catch (error) {
      console.error('[articles] GET translation status error:', error instanceof Error ? error.message : String(error));
      return res.status(500).json({ error: 'An internal error occurred.' });
    }
  };

  /**
   * POST /api/articles/:slug/translation/retry
   * Management endpoint to force re-translate an article to Dutch.
   */
  retryTranslation = async (req: Request, res: Response) => {
    try {
      const rawSlug = req.params.slug;
      const slug = Array.isArray(rawSlug) ? rawSlug[0] : String(rawSlug || '');
      if (!slug) {
        return res.status(400).json({ error: 'Missing slug parameter' });
      }
      const article = await this.service.getPublishedArticleBySlug(slug, 'en');
      if (!article) {
        return res.status(404).json({ error: 'Article not found' });
      }

      // Kicks off async translation
      this.service.triggerAutoTranslation({
        slug: article.slug,
        title: article.title,
        excerpt: article.excerpt,
        content: article.content,
        pillar: article.pillar,
        meta_title: article.meta_title,
        meta_description: article.meta_description,
        keywords: article.keywords,
        author: article.author || undefined,
        publish_date: article.publish_date || undefined,
        reading_time: article.reading_time || undefined,
      }).catch((err) => {
        console.error('[articles] Retry translation error:', err);
      });

      return res.status(202).json({ message: 'Translation triggered in background', slug });
    } catch (error) {
      console.error('[articles] POST translation retry error:', error instanceof Error ? error.message : String(error));
      return res.status(500).json({ error: 'An internal error occurred.' });
    }
  };

  /**
   * POST /api/articles/:slug/translation/approve
   * Management endpoint to approve a pending_review translation, marking it completed and live.
   */
  approveTranslation = async (req: Request, res: Response) => {
    try {
      const rawSlug = req.params.slug;
      const slug = Array.isArray(rawSlug) ? rawSlug[0] : String(rawSlug || '');
      if (!slug) {
        return res.status(400).json({ error: 'Missing slug parameter' });
      }

      const success = await this.service.approveTranslation(slug, 'nl');
      if (!success) {
        return res.status(404).json({ error: 'Article or Dutch translation not found' });
      }

      return res.status(200).json({ success: true, message: 'Translation approved and marked live', slug });
    } catch (error) {
      console.error('[articles] POST translation approve error:', error instanceof Error ? error.message : String(error));
      return res.status(500).json({ error: 'An internal error occurred.' });
    }
  };

  /**
   * POST /api/articles or /api/v1/articles
   * Create or update an article using slug as unique identifier.
   */
  upsertArticle = async (req: Request, res: Response) => {
    try {
      console.log(`[articles] POST /articles Content-Type=${req.headers['content-type']}`);
      const rawBody = req.body;
      const result = await this.service.upsertArticle(rawBody, req.headers, req.query);

      if (!result.success) {
        return res.status(400).json({
          error: result.error,
          received: result.received,
        });
      }

      return res.status(200).json({
        article: result.article,
        message: 'Upserted successfully',
      });
    } catch (error) {
      console.error('[articles] POST upsert error:', error instanceof Error ? error.message : String(error));
      return res.status(500).json({ error: 'An internal error occurred.' });
    }
  };

  /**
   * DELETE /api/articles/:slug (or DELETE /api/articles with { slug } in body)
   */
  deleteArticle = async (req: Request, res: Response) => {
    try {
      const rawSlug = req.params.slug || req.body?.slug;
      const slug = Array.isArray(rawSlug) ? rawSlug[0] : rawSlug;

      if (!slug) {
        return res.status(400).json({ error: 'Missing slug parameter' });
      }

      console.log(`[articles] DELETE /articles/${slug}`);
      const deleted = await this.service.deleteArticle(slug);

      if (!deleted) {
        return res.status(404).json({ error: 'Article not found' });
      }

      return res.status(200).json({ message: `Deleted ${slug}`, slug });
    } catch (error) {
      console.error('[articles] DELETE error:', error instanceof Error ? error.message : String(error));
      return res.status(500).json({ error: 'An internal error occurred.' });
    }
  };
}

export const articlesController = new ArticlesController();
