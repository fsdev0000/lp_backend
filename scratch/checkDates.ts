import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT slug, publish_date, created_at, updated_at FROM public.articles ORDER BY created_at ASC;`
  );
  for (const r of rows) {
    console.log(`${r.slug}: pub=${r.publish_date?.toISOString?.() || r.publish_date}, created=${r.created_at?.toISOString?.()}, updated=${r.updated_at?.toISOString?.()}`);
  }
}

main().finally(() => prisma.$disconnect());
