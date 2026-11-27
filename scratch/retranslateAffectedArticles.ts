import { PrismaClient } from '@prisma/client';
import { translationService } from '../src/services/translation/translationService';
import { articlesRepository } from '../src/api/repositories/articles.repository';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const prisma = new PrismaClient();

const TARGET_SLUGS = [
  'why-senior-hires-fail-founder-led-companies-structural-issues',
  'founder-burnout-not-lifestyle-problem-structural-warning-signal',
  'founder-bottleneck-what-it-is-causes-fixes',
  'what-is-founder-dependency-why-not-delegation-problem',
  'i-built-the-company-but-now-i-am-trapped-inside-it',
  'founder-mode-vs-manager-mode-paul-graham-right-wrong',
];

async function main() {
  console.log('--- Starting Re-translation of Affected Articles ---');

  for (const slug of TARGET_SLUGS) {
    console.log(`\nProcessing: ${slug}`);
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT slug, title, excerpt, content, meta_title, meta_description, keywords FROM public.articles WHERE LOWER(slug) = LOWER($1);`,
      slug
    );

    if (!rows.length) {
      console.warn(`Article not found: ${slug}`);
      continue;
    }

    const article = rows[0];
    const translatableFields = {
      title: article.title,
      excerpt: article.excerpt,
      content: article.content,
      meta_title: article.meta_title,
      meta_description: article.meta_description,
      keywords: Array.isArray(article.keywords) ? article.keywords : [],
    };

    console.log(`Calling translationService for "${article.title}"...`);
    const result = await translationService.translateArticle(translatableFields);

    // Verify no LP TOKEN remains
    const allText = `${result.title} ${result.excerpt} ${result.content}`;
    if (/LP[\s_]*TOKEN/i.test(allText)) {
      throw new Error(`CRITICAL: LP TOKEN detected in translated text for ${slug}`);
    }

    const enHeadings = (article.content.match(/^\s*#{1,6}\s+/gm) || []).length;
    const nlHeadings = (result.content.match(/^\s*#{1,6}\s+/gm) || []).length;
    console.log(`Headings verification -> EN: ${enHeadings}, NL: ${nlHeadings}`);

    if (enHeadings !== nlHeadings) {
      console.warn(`[WARNING] Heading count difference on ${slug}: EN=${enHeadings}, NL=${nlHeadings}`);
    }

    // Save into DB
    await articlesRepository.updateArticleTranslation(slug, 'nl', {
      status: 'completed',
      approved: true,
      background_status: 'completed',
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

    console.log(`✓ Successfully updated translation for "${slug}".`);
  }

  // Restore updated_at = created_at for all published articles (Issue #5)
  console.log('\n--- Restoring original updated_at dates (Issue #5) ---');
  const updateRes = await prisma.$executeRawUnsafe(`
    UPDATE public.articles
    SET updated_at = created_at
    WHERE published = true;
  `);
  console.log(`Restored updated_at = created_at for ${updateRes} articles.`);

  console.log('\n--- Re-translation and Date Restoration Completed! ---');
}

main()
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
