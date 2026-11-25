import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('[migrateLegacyMediaTypes] Finding pre-0d3d43e image posts with web page mediaUrls...');
  const cutoff = new Date('2026-11-04T00:00:00.000Z');

  const legacyPosts = await prisma.socialPost.findMany({
    where: {
      mediaType: 'image',
      mediaUrl: { not: null },
      createdAt: { lt: cutoff },
    },
  });

  console.log(`[migrateLegacyMediaTypes] Found ${legacyPosts.length} candidate post(s).`);

  let updatedCount = 0;
  for (const p of legacyPosts) {
    if (p.mediaUrl) {
      const cleanUrl = p.mediaUrl.trim().toLowerCase().split('?')[0];
      const isDirectMedia = /\.(jpg|jpeg|png|gif|webp|svg|mp4|mov|webm|jfif)$/i.test(cleanUrl);
      if (!isDirectMedia && (p.mediaUrl.startsWith('http://') || p.mediaUrl.startsWith('https://'))) {
        await prisma.socialPost.update({
          where: { id: p.id },
          data: { mediaType: 'article' },
        });
        console.log(`[migrateLegacyMediaTypes] Migrated post ${p.id} ("${p.title}") to "article".`);
        updatedCount++;
      }
    }
  }

  console.log(`[migrateLegacyMediaTypes] Done. Migrated ${updatedCount} post(s).`);
}

main()
  .catch((e) => {
    console.error('[migrateLegacyMediaTypes] Error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

