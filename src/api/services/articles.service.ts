import { articlesRepository, ArticlesRepository } from '../repositories/articles.repository';
import { parseAndValidateArticleInput, Article, ArticleSummary, ParsedArticleInput } from '../validation/articles.validation';
import { getSecret } from '../../services/secrets';
import { normalizeArticleContent } from '../utils/articleContentNormalizer';
import { translationService, calculateSourceHash } from '../../services/translation/translationService';

export class ArticlesService {
  private cachedArticlesList: Map<string, { data: ArticleSummary[]; timestamp: number }> = new Map();
  private cachedArticlesBySlug: Map<string, { data: Article; timestamp: number }> = new Map();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(private repo: ArticlesRepository = articlesRepository) {}

  /**
   * Clears in-memory cache when articles are updated or deleted.
   */
  public clearCache(slug?: string): void {
    this.cachedArticlesList.clear();
    if (slug) {
      this.cachedArticlesBySlug.delete(`en:${slug.toLowerCase()}`);
      this.cachedArticlesBySlug.delete(`nl:${slug.toLowerCase()}`);
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
   * If locale is 'nl', returns Dutch translations where available.
   * Cached in memory for high-speed delivery.
   */
  async listPublishedArticles(locale: string = 'en'): Promise<ArticleSummary[]> {
    const locKey = locale.toLowerCase().startsWith('nl') ? 'nl' : 'en';
    const now = Date.now();
    const cached = this.cachedArticlesList.get(locKey);

    if (cached && now - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.data;
    }

    const articles = await this.repo.findPublishedArticles(locKey);
    const normalized = articles.map((article: any) => {
      if (article.content) {
        return {
          ...article,
          content: normalizeArticleContent(article.content),
        };
      }
      return article;
    });

    this.cachedArticlesList.set(locKey, {
      data: normalized,
      timestamp: now,
    });

    return normalized;
  }

  /**
   * Returns a single published article by slug.
   * If locale is 'nl', returns Dutch translations where available.
   * Cached in memory for high-speed delivery.
   */
  async getPublishedArticleBySlug(slug: string, locale: string = 'en'): Promise<Article | null> {
    const locKey = locale.toLowerCase().startsWith('nl') ? 'nl' : 'en';
    const cacheKey = `${locKey}:${slug.toLowerCase()}`;
    const now = Date.now();
    const cached = this.cachedArticlesBySlug.get(cacheKey);

    if (cached && now - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.data;
    }

    const article = await this.repo.findArticleBySlug(slug, true, locKey);
    if (!article) return null;

    const normalized = {
      ...article,
      content: normalizeArticleContent(article.content),
    };

    this.cachedArticlesBySlug.set(cacheKey, {
      data: normalized,
      timestamp: now,
    });

    return normalized;
  }

  /**
   * Triggers background translation for an article (English -> Dutch).
   * Non-blocking, idempotent, avoids redundant re-translation if hash matches.
   */
  public async triggerAutoTranslation(input: ParsedArticleInput): Promise<void> {
    const slug = input.slug;

    try {
      // 1. Check existing translation to avoid redundant API calls
      const existing = await this.repo.getArticleRaw(slug);
      const existingNl = existing?.translations?.nl;
      const currentHash = calculateSourceHash({
        title: input.title,
        excerpt: input.excerpt,
        content: input.content,
        meta_title: input.meta_title,
        meta_description: input.meta_description,
        keywords: input.keywords,
      });

      if (existingNl && existingNl.status === 'completed' && existingNl.source_hash === currentHash) {
        console.log(`[Translation] Skipping translation for "${slug}": source hash unchanged.`);
        return;
      }

      console.log(`[Translation] Starting automatic background translation for "${slug}"...`);

      // 2. Mark translation as processing
      await this.repo.updateArticleTranslation(slug, 'nl', {
        status: 'processing',
        source_hash: currentHash,
        updated_at: new Date().toISOString(),
      });

      // 3. Execute translation
      const result = await translationService.translateArticle({
        title: input.title,
        excerpt: input.excerpt,
        content: input.content,
        meta_title: input.meta_title,
        meta_description: input.meta_description,
        keywords: input.keywords,
      });

      // 4. Save completed Dutch translation
      await this.repo.updateArticleTranslation(slug, 'nl', {
        status: 'completed',
        title: result.title,
        excerpt: result.excerpt,
        content: result.content,
        meta_title: result.meta_title,
        meta_description: result.meta_description,
        keywords: result.keywords,
        source_hash: result.source_hash,
        translated_at: result.translated_at,
        provider: result.provider,
        error: null,
      });

      this.clearCache(slug);
      console.log(`[Translation] Successfully completed Dutch translation for "${slug}".`);
    } catch (err: any) {
      console.error(`[Translation] Failed to translate article "${slug}":`, err.message);
      try {
        await this.repo.updateArticleTranslation(slug, 'nl', {
          status: 'failed',
          error: err.message,
          updated_at: new Date().toISOString(),
        });
      } catch (dbErr: any) {
        console.error(`[Translation] Failed to record error state in DB for "${slug}":`, dbErr.message);
      }
    }
  }

  /**
   * Validates and upserts an article by slug.
   * Saves English immediately, and kicks off async background Dutch translation.
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

    // Automatically trigger Dutch translation asynchronously in background (zero block on n8n)
    setImmediate(() => {
      this.triggerAutoTranslation(validation.data!).catch((err) => {
        console.error('[Translation] Async translation trigger uncaught error:', err);
      });
    });

    return {
      success: true,
      article: saved,
    };
  }

  /**
   * Retrieves translation status and raw payloads for an article.
   */
  async getArticleTranslationStatus(slug: string): Promise<any> {
    const raw = await this.repo.getArticleRaw(slug);
    if (!raw) return null;

    return {
      id: raw.id,
      slug: raw.slug,
      title: raw.title,
      translations: raw.translations || {},
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
