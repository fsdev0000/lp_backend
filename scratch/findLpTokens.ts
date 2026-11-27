import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT slug, translations FROM public.articles WHERE published = true;`
  );
  let totalMatches = 0;
  for (const r of rows) {
    const nl = r.translations?.nl;
    if (!nl) continue;
    const jsonStr = JSON.stringify(nl);
    const matches = jsonStr.match(/LP[\s_]*TOKEN[\s_]*\d+/gi);
    if (matches && matches.length > 0) {
      console.log(`Article "${r.slug}" has ${matches.length} matches:`, matches);
      totalMatches += matches.length;
    }
  }
  console.log(`Total LP TOKEN instances across DB: ${totalMatches}`);
}

main().finally(() => prisma.$disconnect());
