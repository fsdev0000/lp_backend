import { articlesRepository, ArticlesRepository } from '../repositories/articles.repository';
import { parseAndValidateArticleInput, Article, ArticleSummary } from '../validation/articles.validation';
import { getSecret } from '../../services/secrets';
import { normalizeArticleContent } from '../utils/articleContentNormalizer';

export class ArticlesService {
  private cachedArticlesList: { data: ArticleSummary[]; timestamp: number } | null = null;
  private cachedArticlesBySlug: Map<string, { data: Article; timestamp: number }> = new Map();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(private repo: ArticlesRepository = articlesRepository) {}

  /**
   * Clears in-memory cache when articles are updated or deleted.
   */
  public clearCache(slug?: string): void {
    this.cachedArticlesList = null;
    if (slug) {
      this.cachedArticlesBySlug.delete(slug);
    } else {
      this.cachedArticlesBySlug.clear();
    }
  }

  /**
   * Verifies if the provided x-api-key matches ARTICLES_API_KEY from environment or Vault.
   */
  async verifyApiKey(providedKey?: string): Promise<boolean> {
    if (!providedKey) return false;
    // 1. Read directly from .env (e.g. VPS environment), fallback to Supabase Vault
    const expectedKey = process.env.ARTICLES_API_KEY || (await getSecret('ARTICLES_API_KEY'));
    if (!expectedKey) {
      console.warn('[articles.service] No ARTICLES_API_KEY configured in .env or Vault');
      return false;
    }
    return providedKey.trim() === expectedKey.trim();
  }

  /**
   * Lists all published articles for the website.
   * Cached in memory for high-speed delivery.
   */
  async listPublishedArticles(): Promise<ArticleSummary[]> {
    const now = Date.now();
    if (this.cachedArticlesList && now - this.cachedArticlesList.timestamp < this.CACHE_TTL_MS) {
      return this.cachedArticlesList.data;
    }

    const articles = await this.repo.findPublishedArticles();
    const normalized = articles.map((article: any) => {
      if (article.content) {
        return {
          ...article,
          content: normalizeArticleContent(article.content),
        };
      }
      return article;
    });

    this.cachedArticlesList = {
      data: normalized,
      timestamp: now,
    };

    return normalized;
  }

  /**
   * Returns a single published article by slug.
   * Cached in memory for high-speed delivery.
   */
  async getPublishedArticleBySlug(slug: string): Promise<Article | null> {
    const now = Date.now();
    const cached = this.cachedArticlesBySlug.get(slug);
    if (cached && now - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.data;
    }

    const article = await this.repo.findArticleBySlug(slug, true);
    if (!article) return null;

    const normalized = {
      ...article,
      content: normalizeArticleContent(article.content),
    };

    this.cachedArticlesBySlug.set(slug, {
      data: normalized,
      timestamp: now,
    });

    return normalized;
  }

  /**
   * Validates and upserts an article by slug.
   */
  async upsertArticle(
    rawBody: any,
    headers: Record<string, any>,
    query: Record<string, any>
  ): Promise<{ success: boolean; error?: string; received?: any; article?: any }> {
    const validation = parseAndValidateArticleInput(rawBody, headers, query);
    if (!validation.valid || !validation.data) {
      return {
        success: false,
        error: validation.error,
        received: validation.received,
      };
    }

    const saved = await this.repo.upsertArticle(validation.data);
    this.clearCache(validation.data.slug);
    return {
      success: true,
      article: saved,
    };
  }

  /**
   * Deletes an article by slug.
   */
  async deleteArticle(slug: string): Promise<boolean> {
    const deleted = await this.repo.deleteArticle(slug);
    if (deleted) {
      this.clearCache(slug);
    }
    return deleted;
  }
}

export const articlesService = new ArticlesService();

