import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('[migrateTikTokPostsWorkspace] Checking TikTok posts in database...');
  const result = await prisma.socialPost.updateMany({
    where: {
      platform: 'TIKTOK',
      workspace: 'leaders_performance',
    },
    data: {
      workspace: 'lionel_eersteling',
    },
  });
  console.log(`[migrateTikTokPostsWorkspace] Successfully updated ${result.count} TikTok post(s) to lionel_eersteling.`);
}

main()
  .catch((e) => {
    console.error('[migrateTikTokPostsWorkspace] Error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
