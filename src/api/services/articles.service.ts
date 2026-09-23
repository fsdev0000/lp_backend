import { articlesRepository, ArticlesRepository } from '../repositories/articles.repository';
import { parseAndValidateArticleInput, Article, ArticleSummary } from '../validation/articles.validation';
import { getSecret } from '../../services/secrets';

export class ArticlesService {
  constructor(private repo: ArticlesRepository = articlesRepository) {}

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
   */
  async listPublishedArticles(): Promise<ArticleSummary[]> {
    return this.repo.findPublishedArticles();
  }

  /**
   * Returns a single published article by slug.
   */
  async getPublishedArticleBySlug(slug: string): Promise<Article | null> {
    return this.repo.findArticleBySlug(slug, true);
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
    return {
      success: true,
      article: saved,
    };
  }

  /**
   * Deletes an article by slug.
   */
  async deleteArticle(slug: string): Promise<boolean> {
    return this.repo.deleteArticle(slug);
  }
}

export const articlesService = new ArticlesService();
