const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

const prisma = new PrismaClient();

function cleanCaptionBoilerplate(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let text = raw.trim();

  const prefixPatterns = [
    /^(here\s+(is|are)\s+(a\s+|the\s+)?(draft\s+|suggested\s+)?(caption|post|text|copy)[:\s\-]*)/i,
    /^(here'?s\s+(a\s+|the\s+)?(draft\s+|suggested\s+)?(caption|post|text|copy)[:\s\-]*)/i,
    /^(option\s+\d+[:\s\-]*)/i,
    /^(draft\s+\d+[:\s\-]*)/i,
    /^(caption\s*[:\-]\s*)/i,
    /^(post\s*[:\-]\s*)/i,
    /^(title\s*[:\-]\s*)/i,
    /^(hook\s*[:\-]\s*)/i,
    /^(main title\s*[:\-]\s*)/i,
    /^(full description\s*[:\-]\s*)/i,
    /^(sure[!,.]?\s*(here\s+is.*)?[:\s\-]*)/i,
    /^(certainly[!,.]?\s*(here\s+is.*)?[:\s\-]*)/i,
  ];

  let cleaned = true;
  while (cleaned) {
    cleaned = false;
    for (const pat of prefixPatterns) {
      if (pat.test(text)) {
        text = text.replace(pat, '').trim();
        cleaned = true;
      }
    }
  }

  const lines = text.split('\n');
  while (lines.length > 0) {
    const firstLine = lines[0].trim();
    if (firstLine.length > 0 && /^(\s*#\w+)+$/.test(firstLine)) {
      lines.shift();
    } else {
      break;
    }
  }
  text = lines.join('\n').trim();

  if (
    (text.startsWith('"') && text.endsWith('"') && text.length > 2) ||
    (text.startsWith('“') && text.endsWith('”') && text.length > 2)
  ) {
    text = text.slice(1, -1).trim();
  }

  text = text.replace(/\n{3,}/g, '\n\n');
  return text;
}

function cleanTitleBoilerplate(rawTitle) {
  if (!rawTitle || typeof rawTitle !== 'string') return null;
  let t = rawTitle.trim();
  t = t.replace(/^(title|main title|hook|topic)\s*[:\-]\s*/i, '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('“') && t.endsWith('”'))) {
    t = t.slice(1, -1).trim();
  }
  return t || null;
}

async function main() {
  console.log('[CaptionCleanup] Scanning existing posts in database for AI artifacts...');
  const posts = await prisma.post.findMany();
  console.log(`[CaptionCleanup] Found ${posts.length} posts to inspect.`);

  let updatedCount = 0;
  for (const p of posts) {
    const cleanedCaption = cleanCaptionBoilerplate(p.caption);
    const cleanedTitle = cleanTitleBoilerplate(p.title);

    const captionChanged = cleanedCaption !== (p.caption || '');
    const titleChanged = cleanedTitle !== p.title;

    if (captionChanged || titleChanged) {
      await prisma.post.update({
        where: { id: p.id },
        data: {
          caption: cleanedCaption || p.caption,
          title: cleanedTitle,
        },
      });
      updatedCount++;
      console.log(`[CaptionCleanup] Cleaned post ${p.id} (${p.platform})`);
    }
  }

  console.log(`✅ [CaptionCleanup] Completed. Cleaned ${updatedCount} / ${posts.length} posts.`);
}

main()
  .catch((err) => {
    console.error('❌ Caption cleanup failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

