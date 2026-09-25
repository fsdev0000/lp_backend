import { articlesRepository, ArticlesRepository } from '../repositories/articles.repository';
import { parseAndValidateArticleInput, Article, ArticleSummary } from '../validation/articles.validation';
import { getSecret } from '../../services/secrets';
import { normalizeArticleContent } from '../utils/articleContentNormalizer';

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
   * If any article entry includes content, normalizes it.
   */
  async listPublishedArticles(): Promise<ArticleSummary[]> {
    const articles = await this.repo.findPublishedArticles();
    return articles.map((article: any) => {
      if (article.content) {
        return {
          ...article,
          content: normalizeArticleContent(article.content),
        };
      }
      return article;
    });
  }

  /**
   * Returns a single published article by slug.
   * Inspects and normalizes malformed Markdown in memory before returning.
   */
  async getPublishedArticleBySlug(slug: string): Promise<Article | null> {
    const article = await this.repo.findArticleBySlug(slug, true);
    if (!article) return null;
    return {
      ...article,
      content: normalizeArticleContent(article.content),
    };
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
