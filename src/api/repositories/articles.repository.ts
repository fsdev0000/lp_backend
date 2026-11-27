import { PrismaClient } from '@prisma/client';
import { Article, ArticleSummary, ParsedArticleInput } from '../validation/articles.validation';

const prisma = new PrismaClient();

export class ArticlesRepository {
  /**
   * Retrieves all published articles ordered by created_at descending.
   * If locale is 'nl' and a completed Dutch translation exists, returns localized content.
   */
  async findPublishedArticles(locale: string = 'en'): Promise<ArticleSummary[]> {
    const isDutch = locale.toLowerCase().startsWith('nl');

    const rows = await prisma.$queryRawUnsafe<any[]>(`
      SELECT 
        id, 
        slug, 
        title, 
        excerpt, 
        pillar, 
        pillar_color, 
        keywords, 
        meta_title, 
        meta_description, 
        to_char(publish_date, 'YYYY-MM-DD') AS publish_date, 
        reading_time, 
        author, 
        published, 
        COALESCE(translations, '{}'::jsonb) AS translations,
        created_at, 
        updated_at
      FROM public.articles
      WHERE published = true
      ORDER BY created_at DESC;
    `);

    return rows.map((r) => {
      const translations = typeof r.translations === 'object' && r.translations !== null ? r.translations : {};
      const nl = translations.nl;
      const useDutch = isDutch && nl && (nl.status === 'completed' || nl.approved === true);

      return {
        id: r.id,
        slug: r.slug,
        title: useDutch && nl.title ? nl.title : r.title,
        excerpt: useDutch && nl.excerpt ? nl.excerpt : r.excerpt,
        pillar: r.pillar,
        pillar_color: r.pillar_color,
        keywords: useDutch && Array.isArray(nl.keywords) && nl.keywords.length > 0 ? nl.keywords : (Array.isArray(r.keywords) ? r.keywords : []),
        meta_title: useDutch && nl.meta_title ? nl.meta_title : r.meta_title,
        meta_description: useDutch && nl.meta_description ? nl.meta_description : r.meta_description,
        publish_date: r.publish_date,
        reading_time: r.reading_time,
        author: r.author,
        published: r.published,
        locale: useDutch ? 'nl' : 'en',
        created_at: r.created_at,
      };
    });
  }

  /**
   * Retrieves a single article by slug.
   * If onlyPublished is true, unpublished articles will not be returned.
   * If locale is 'nl' and a completed Dutch translation exists, returns localized content.
   */
  async findArticleBySlug(slug: string, onlyPublished = true, locale: string = 'en'): Promise<Article | null> {
    const condition = onlyPublished ? 'AND published = true' : '';
    const isDutch = locale.toLowerCase().startsWith('nl');

    const rows = await prisma.$queryRawUnsafe<any[]>(
      `
      SELECT 
        id, 
        slug, 
        title, 
        excerpt, 
        pillar, 
        pillar_color, 
        keywords, 
        meta_title, 
        meta_description, 
        to_char(publish_date, 'YYYY-MM-DD') AS publish_date, 
        reading_time, 
        author, 
        content, 
        published, 
        COALESCE(translations, '{}'::jsonb) AS translations,
        created_at, 
        updated_at
      FROM public.articles
      WHERE LOWER(slug) = LOWER($1) ${condition}
      LIMIT 1;
    `,
      slug
    );

    if (!rows || rows.length === 0) {
      return null;
    }

    const r = rows[0];
    const translations = typeof r.translations === 'object' && r.translations !== null ? r.translations : {};
    const nl = translations.nl;
    const useDutch = isDutch && nl && (nl.status === 'completed' || nl.approved === true);

    return {
      id: r.id,
      slug: r.slug,
      title: useDutch && nl.title ? nl.title : r.title,
      excerpt: useDutch && nl.excerpt ? nl.excerpt : r.excerpt,
      pillar: r.pillar,
      pillar_color: r.pillar_color,
      keywords: useDutch && Array.isArray(nl.keywords) && nl.keywords.length > 0 ? nl.keywords : (Array.isArray(r.keywords) ? r.keywords : []),
      meta_title: useDutch && nl.meta_title ? nl.meta_title : r.meta_title,
      meta_description: useDutch && nl.meta_description ? nl.meta_description : r.meta_description,
      publish_date: r.publish_date,
      reading_time: r.reading_time,
      author: r.author,
      content: useDutch && nl.content ? nl.content : r.content,
      published: r.published,
      locale: useDutch ? 'nl' : 'en',
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  }

  /**
   * Retrieves an article strictly in raw format with its translations JSON.
   */
  async getArticleRaw(slug: string): Promise<any | null> {
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT *, COALESCE(translations, '{}'::jsonb) AS translations FROM public.articles WHERE LOWER(slug) = LOWER($1) LIMIT 1;`,
      slug
    );
    return rows && rows.length > 0 ? rows[0] : null;
  }

  /**
   * Retrieves all published articles with their raw fields and translations (for backfill).
   */
  async findAllPublishedForTranslation(): Promise<any[]> {
    return prisma.$queryRawUnsafe<any[]>(
      `SELECT id, slug, title, excerpt, content, meta_title, meta_description, keywords, COALESCE(translations, '{}'::jsonb) AS translations FROM public.articles WHERE published = true ORDER BY created_at ASC;`
    );
  }

  /**
   * Updates an article's specific locale translation in the JSONB column.
   * Merges fields into existing translation so background status/error updates never wipe content.
   * Does NOT touch updated_at (preserves original article publishing and modification timestamp).
   */
  async updateArticleTranslation(
    slug: string,
    locale: string,
    translationData: Record<string, any>
  ): Promise<boolean> {
    const jsonStr = JSON.stringify(translationData);
    const result = await prisma.$executeRawUnsafe(
      `
      UPDATE public.articles
      SET translations = jsonb_set(
        COALESCE(translations, '{}'::jsonb),
        ARRAY[$1],
        COALESCE(translations->$1, '{}'::jsonb) || $2::jsonb,
        true
      )
      WHERE LOWER(slug) = LOWER($3);
      `,
      locale,
      jsonStr,
      slug
    );
    return result > 0;
  }

  /**
   * Upserts an article by slug.
   */
  async upsertArticle(input: ParsedArticleInput): Promise<{ id: string; slug: string; title: string }> {
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `
      INSERT INTO public.articles (
        slug, 
        title, 
        excerpt, 
        pillar, 
        pillar_color, 
        keywords, 
        meta_title, 
        meta_description, 
        publish_date, 
        reading_time, 
        author, 
        content, 
        published, 
        updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6::text[], $7, $8, $9::date, $10, $11, $12, $13, NOW()
      )
      ON CONFLICT (slug) DO UPDATE SET
        title = EXCLUDED.title,
        excerpt = EXCLUDED.excerpt,
        pillar = EXCLUDED.pillar,
        pillar_color = COALESCE(EXCLUDED.pillar_color, public.articles.pillar_color),
        keywords = COALESCE(EXCLUDED.keywords, public.articles.keywords),
        meta_title = EXCLUDED.meta_title,
        meta_description = EXCLUDED.meta_description,
        publish_date = COALESCE(EXCLUDED.publish_date, public.articles.publish_date),
        reading_time = COALESCE(EXCLUDED.reading_time, public.articles.reading_time),
        author = COALESCE(EXCLUDED.author, public.articles.author),
        content = EXCLUDED.content,
        published = COALESCE(EXCLUDED.published, public.articles.published),
        updated_at = NOW()
      RETURNING id, slug, title;
    `,
      input.slug,
      input.title,
      input.excerpt,
      input.pillar,
      input.pillar_color || 'hsl(122,31%,42%)',
      input.keywords || [],
      input.meta_title,
      input.meta_description,
      input.publish_date,
      input.reading_time,
      input.author || 'Lionel Eersteling',
      input.content,
      input.published !== undefined ? input.published : true
    );

    return {
      id: rows[0].id,
      slug: rows[0].slug,
      title: rows[0].title,
    };
  }

  /**
   * Deletes an article by slug.
   */
  async deleteArticle(slug: string): Promise<boolean> {
    const result = await prisma.$executeRawUnsafe(
      `DELETE FROM public.articles WHERE LOWER(slug) = LOWER($1);`,
      slug
    );
    return result > 0;
  }
}

export const articlesRepository = new ArticlesRepository();
