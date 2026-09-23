"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.articlesRepository = exports.ArticlesRepository = void 0;
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
class ArticlesRepository {
    /**
     * Retrieves all published articles ordered by created_at descending.
     */
    async findPublishedArticles() {
        const rows = await prisma.$queryRawUnsafe(`
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
        created_at, 
        updated_at
      FROM public.articles
      WHERE published = true
      ORDER BY created_at DESC;
    `);
        return rows.map((r) => ({
            id: r.id,
            slug: r.slug,
            title: r.title,
            excerpt: r.excerpt,
            pillar: r.pillar,
            pillar_color: r.pillar_color,
            keywords: Array.isArray(r.keywords) ? r.keywords : [],
            meta_title: r.meta_title,
            meta_description: r.meta_description,
            publish_date: r.publish_date,
            reading_time: r.reading_time,
            author: r.author,
            published: r.published,
            created_at: r.created_at,
        }));
    }
    /**
     * Retrieves a single article by slug.
     * If onlyPublished is true, unpublished articles will not be returned.
     */
    async findArticleBySlug(slug, onlyPublished = true) {
        const condition = onlyPublished ? 'AND published = true' : '';
        const rows = await prisma.$queryRawUnsafe(`
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
        created_at, 
        updated_at
      FROM public.articles
      WHERE LOWER(slug) = LOWER($1) ${condition}
      LIMIT 1;
    `, slug);
        if (!rows || rows.length === 0) {
            return null;
        }
        const r = rows[0];
        return {
            id: r.id,
            slug: r.slug,
            title: r.title,
            excerpt: r.excerpt,
            pillar: r.pillar,
            pillar_color: r.pillar_color,
            keywords: Array.isArray(r.keywords) ? r.keywords : [],
            meta_title: r.meta_title,
            meta_description: r.meta_description,
            publish_date: r.publish_date,
            reading_time: r.reading_time,
            author: r.author,
            content: r.content,
            published: r.published,
            created_at: r.created_at,
            updated_at: r.updated_at,
        };
    }
    /**
     * Upserts an article by slug.
     */
    async upsertArticle(input) {
        const rows = await prisma.$queryRawUnsafe(`
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
    `, input.slug, input.title, input.excerpt, input.pillar, input.pillar_color || 'hsl(122,31%,42%)', input.keywords || [], input.meta_title, input.meta_description, input.publish_date, input.reading_time, input.author || 'Lionel Eersteling', input.content, input.published !== undefined ? input.published : true);
        return {
            id: rows[0].id,
            slug: rows[0].slug,
            title: rows[0].title,
        };
    }
    /**
     * Deletes an article by slug.
     */
    async deleteArticle(slug) {
        const result = await prisma.$executeRawUnsafe(`DELETE FROM public.articles WHERE LOWER(slug) = LOWER($1);`, slug);
        return result > 0;
    }
}
exports.ArticlesRepository = ArticlesRepository;
exports.articlesRepository = new ArticlesRepository();
