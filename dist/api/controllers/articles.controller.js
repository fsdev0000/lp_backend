"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.articlesController = exports.ArticlesController = void 0;
const articles_service_1 = require("../services/articles.service");
class ArticlesController {
    service;
    constructor(service = articles_service_1.articlesService) {
        this.service = service;
    }
    /**
     * Middleware to authenticate management operations via x-api-key.
     */
    authenticate = async (req, res, next) => {
        const apiKey = (req.headers['x-api-key'] || req.headers['authorization']);
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
    listArticles = async (req, res) => {
        try {
            console.log(`[articles] GET /articles from IP=${req.ip}`);
            const articles = await this.service.listPublishedArticles();
            return res.status(200).json({ articles });
        }
        catch (error) {
            console.error('[articles] GET list error:', error instanceof Error ? error.message : String(error));
            return res.status(500).json({ error: 'An internal error occurred.' });
        }
    };
    /**
     * GET /api/articles/:slug
     * Returns single published article by slug.
     */
    getArticleBySlug = async (req, res) => {
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
        }
        catch (error) {
            console.error(`[articles] GET /articles/${req.params?.slug} error:`, error instanceof Error ? error.message : String(error));
            return res.status(500).json({ error: 'An internal error occurred.' });
        }
    };
    /**
     * POST /api/articles
     * Create or update an article using slug as unique identifier.
     */
    upsertArticle = async (req, res) => {
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
        }
        catch (error) {
            console.error('[articles] POST upsert error:', error instanceof Error ? error.message : String(error));
            return res.status(500).json({ error: 'An internal error occurred.' });
        }
    };
    /**
     * DELETE /api/articles/:slug (or DELETE /api/articles with { slug } in body)
     */
    deleteArticle = async (req, res) => {
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
        }
        catch (error) {
            console.error(`[articles] DELETE error for ${req.params?.slug}:`, error instanceof Error ? error.message : String(error));
            return res.status(500).json({ error: 'An internal error occurred.' });
        }
    };
}
exports.ArticlesController = ArticlesController;
exports.articlesController = new ArticlesController();
