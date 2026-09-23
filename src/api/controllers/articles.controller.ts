import { Request, Response } from 'express';
import { articlesService, ArticlesService } from '../services/articles.service';

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
   * GET /api/articles
   * Returns list of published articles.
   */
  listArticles = async (req: Request, res: Response) => {
    try {
      console.log(`[articles] GET /articles from IP=${req.ip}`);
      const articles = await this.service.listPublishedArticles();
      return res.status(200).json({ articles });
    } catch (error) {
      console.error('[articles] GET list error:', error instanceof Error ? error.message : String(error));
      return res.status(500).json({ error: 'An internal error occurred.' });
    }
  };

  /**
   * GET /api/articles/:slug
   * Returns single published article by slug.
   */
  getArticleBySlug = async (req: Request, res: Response) => {
    try {
      const rawSlug = req.params.slug;
      const slug = Array.isArray(rawSlug) ? rawSlug[0] : rawSlug;
      if (!slug) {
        return res.status(400).json({ error: 'Missing slug parameter' });
      }

      console.log(`[articles] GET /articles/${slug}`);
      const article = await this.service.getPublishedArticleBySlug(slug);

      if (!article) {
        return res.status(404).json({ error: 'Article not found' });
      }

      return res.status(200).json({ article });
    } catch (error) {
      console.error(`[articles] GET /articles/${req.params?.slug} error:`, error instanceof Error ? error.message : String(error));
      return res.status(500).json({ error: 'An internal error occurred.' });
    }
  };

  /**
   * POST /api/articles
   * Create or update an article using slug as unique identifier.
   */
  upsertArticle = async (req: Request, res: Response) => {
    try {
      console.log(`[articles] POST /articles Content-Type=${req.headers['content-type']}`);
      // req.body could be parsed JSON, or string if raw text, or empty with query/headers
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
        return res.status(400).json({ error: 'Missing slug' });
      }

      console.log(`[articles] DELETE /articles/${slug}`);
      const deleted = await this.service.deleteArticle(slug);

      return res.status(200).json({
        message: `Deleted ${slug}`,
        deleted,
      });
    } catch (error) {
      console.error(`[articles] DELETE error for ${req.params?.slug}:`, error instanceof Error ? error.message : String(error));
      return res.status(500).json({ error: 'An internal error occurred.' });
    }
  };
}

export const articlesController = new ArticlesController();
