import { articlesRepository } from '../src/api/repositories/articles.repository';
import { translationService, calculateSourceHash } from '../src/services/translation/translationService';
import { spawn, ChildProcess } from 'child_process';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function ensureTranslationEngine(): Promise<ChildProcess | null> {
  const targetUrl = process.env.TRANSLATION_API_URL || 'http://127.0.0.1:5005';
  try {
    const res = await fetch(`${targetUrl.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      console.log(`[TranslationEngine] Connected to running engine at ${targetUrl}`);
      return null;
    }
  } catch {
    // Engine not active yet
  }

  console.log(`[TranslationEngine] Spawning local Argos Translate engine (scripts/argos_server.py)...`);
  const pythonScript = path.resolve(__dirname, 'argos_server.py');
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
  const serverProc = spawn(pythonCmd, [pythonScript, '5005'], { stdio: 'pipe' });

  serverProc.stderr?.on('data', (d) => {
    const msg = d.toString();
    if (!msg.includes('WARNING')) console.error(`[ArgosEngine]`, msg.trim());
  });

  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch('http://127.0.0.1:5005/health', { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        console.log(`[TranslationEngine] Local Argos Translate engine is ready and healthy.`);
        return serverProc;
      }
    } catch {
      // Keep waiting
    }
  }

  console.warn(`[TranslationEngine] Timed out waiting for local engine health check. Proceeding anyway...`);
  return serverProc;
}

async function runBackfill() {
  console.log('====================================================');
  console.log('   Articles Dutch (NL) Translation Backfill Worker  ');
  console.log('====================================================');

  const engineProcess = await ensureTranslationEngine();

  try {
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
        slug: article.slug,
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
        // Mark background processing in DB
        await articlesRepository.updateArticleTranslation(slug, 'nl', {
          background_status: 'processing',
          source_hash: currentHash,
        });

        // Execute translation
        const result = await translationService.translateArticle(translatableFields);

        // Save translation as pending_review (requires review/approval before going live)
        await articlesRepository.updateArticleTranslation(slug, 'nl', {
          status: 'pending_review',
          approved: false,
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

        console.log(`${progress} ✓ Successfully translated "${slug}" -> "${result.title}"`);
        translatedCount++;
      } catch (err: any) {
        console.error(`${progress} ✗ Failed to translate "${slug}":`, err.message);
        // Do not wipe existing translation on failure
        await articlesRepository.updateArticleTranslation(slug, 'nl', {
          background_status: 'failed',
          error: err.message,
        });
        failedCount++;
      }

      // Brief throttle
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    console.log('\n================ BACKFILL REPORT ================');
    console.log(`Total Published Articles: ${articles.length}`);
    console.log(`Already Up to Date:       ${alreadyUpToDate}`);
    console.log(`Newly Translated:         ${translatedCount}`);
    console.log(`Failed / Pending Retry:   ${failedCount}`);
    console.log('=================================================\n');
  } finally {
    if (engineProcess) {
      console.log('[TranslationEngine] Stopping local Argos engine...');
      engineProcess.kill();
    }
  }
}

runBackfill()
  .catch((err) => {
    console.error('Fatal backfill error:', err);
    process.exit(1);
  })
  .finally(() => {
    process.exit(0);
  });
