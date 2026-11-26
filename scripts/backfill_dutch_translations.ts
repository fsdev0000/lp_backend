import { articlesRepository } from '../src/api/repositories/articles.repository';
import { translationService, calculateSourceHash } from '../src/services/translation/translationService';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function runBackfill() {
  console.log('====================================================');
  console.log('   Articles Dutch (NL) Translation Backfill Worker  ');
  console.log('====================================================');

  const articles = await articlesRepository.findAllPublishedForTranslation();
  console.log(`Discovered ${articles.length} published articles in database.\n`);

  let alreadyUpToDate = 0;
  let translatedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    const slug = article.slug;
    const progress = `[${i + 1}/${articles.length}]`;

    const translatableFields = {
      title: article.title,
      excerpt: article.excerpt,
      content: article.content,
      meta_title: article.meta_title,
      meta_description: article.meta_description,
      keywords: Array.isArray(article.keywords) ? article.keywords : [],
    };

    const currentHash = calculateSourceHash(translatableFields);
    const existingNl = article.translations?.nl;

    if (existingNl && existingNl.status === 'completed' && existingNl.source_hash === currentHash) {
      console.log(`${progress} ✓ "${slug}" is already translated and up to date. Skipping.`);
      alreadyUpToDate++;
      continue;
    }

    console.log(`${progress} Translating "${slug}" ("${article.title}")...`);

    try {
      // Mark processing in DB
      await articlesRepository.updateArticleTranslation(slug, 'nl', {
        status: 'processing',
        source_hash: currentHash,
        updated_at: new Date().toISOString(),
      });

      // Execute translation
      const result = await translationService.translateArticle(translatableFields);

      // Save completed translation
      await articlesRepository.updateArticleTranslation(slug, 'nl', {
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

      console.log(`${progress} ✓ Successfully translated "${slug}" -> "${result.title}"`);
      translatedCount++;
    } catch (err: any) {
      console.error(`${progress} ✗ Failed to translate "${slug}":`, err.message);
      await articlesRepository.updateArticleTranslation(slug, 'nl', {
        status: 'failed',
        error: err.message,
        updated_at: new Date().toISOString(),
      });
      failedCount++;
    }

    // Brief throttle to avoid connection saturation
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log('\n================ BACKFILL REPORT ================');
  console.log(`Total Published Articles: ${articles.length}`);
  console.log(`Already Up to Date:       ${alreadyUpToDate}`);
  console.log(`Newly Translated:         ${translatedCount}`);
  console.log(`Failed / Pending Retry:   ${failedCount}`);
  console.log('=================================================\n');
}

runBackfill()
  .catch((err) => {
    console.error('Fatal backfill error:', err);
    process.exit(1);
  })
  .finally(() => {
    process.exit(0);
  });
