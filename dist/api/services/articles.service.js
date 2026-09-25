"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.articlesService = exports.ArticlesService = void 0;
const articles_repository_1 = require("../repositories/articles.repository");
const articles_validation_1 = require("../validation/articles.validation");
const secrets_1 = require("../../services/secrets");
const articleContentNormalizer_1 = require("../utils/articleContentNormalizer");
class ArticlesService {
    repo;
    constructor(repo = articles_repository_1.articlesRepository) {
        this.repo = repo;
    }
    /**
     * Verifies if the provided x-api-key matches ARTICLES_API_KEY from environment or Vault.
     */
    async verifyApiKey(providedKey) {
        if (!providedKey)
            return false;
        // 1. Read directly from .env (e.g. VPS environment), fallback to Supabase Vault
        const expectedKey = process.env.ARTICLES_API_KEY || (await (0, secrets_1.getSecret)('ARTICLES_API_KEY'));
        if (!expectedKey) {
            console.warn('[articles.service] No ARTICLES_API_KEY configured in .env or Vault');
            return false;
        }
        return providedKey.trim() === expectedKey.trim();
    }
    /**
     * Lists all published articles for the website.
     * If any article entry includes content, normalizes it.
     */
    async listPublishedArticles() {
        const articles = await this.repo.findPublishedArticles();
        return articles.map((article) => {
            if (article.content) {
                return {
                    ...article,
                    content: (0, articleContentNormalizer_1.normalizeArticleContent)(article.content),
                };
            }
            return article;
        });
    }
    /**
     * Returns a single published article by slug.
     * Inspects and normalizes malformed Markdown in memory before returning.
     */
    async getPublishedArticleBySlug(slug) {
        const article = await this.repo.findArticleBySlug(slug, true);
        if (!article)
            return null;
        return {
            ...article,
            content: (0, articleContentNormalizer_1.normalizeArticleContent)(article.content),
        };
    }
    /**
     * Validates and upserts an article by slug.
     */
    async upsertArticle(rawBody, headers, query) {
        const validation = (0, articles_validation_1.parseAndValidateArticleInput)(rawBody, headers, query);
        if (!validation.valid || !validation.data) {
            return {
                success: false,
                error: validation.error,
                received: validation.received,
            };
        }
        const saved = await this.repo.upsertArticle(validation.data);
        return {
            success: true,
            article: saved,
        };
    }
    /**
     * Deletes an article by slug.
     */
    async deleteArticle(slug) {
        return this.repo.deleteArticle(slug);
    }
}
exports.ArticlesService = ArticlesService;
exports.articlesService = new ArticlesService();
