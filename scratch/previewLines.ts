import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const row = await prisma.article.findUnique({ where: { slug: 'founder-bottleneck-what-it-is-causes-fixes' } });
  if (!row?.content) return;
  const lines = row.content.split('\n');
  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    console.log(`${i}: ${lines[i]}`);
  }
}

main().finally(() => prisma.$disconnect());
