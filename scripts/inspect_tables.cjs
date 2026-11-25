const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const tables = await prisma.$queryRawUnsafe(`SELECT table_name FROM information_schema.tables WHERE table_schema='public';`);
  console.log("TABLES:", tables);
  const subscriberColumns = await prisma.$queryRawUnsafe(`
    SELECT column_name, data_type, is_nullable, column_default 
    FROM information_schema.columns 
    WHERE table_name='newsletter_subscribers';
  `);
  console.log("COLUMNS FOR newsletter_subscribers:", subscriberColumns);
  const countRes = await prisma.$queryRawUnsafe('SELECT count(*) FROM "newsletter_subscribers";');
  console.log("SUBSCRIBER COUNT RES:", countRes);
  const sample = await prisma.$queryRawUnsafe('SELECT * FROM "newsletter_subscribers" LIMIT 5;');
  console.log("SAMPLE SUBSCRIBERS:", sample);
}

main().catch(console.error).finally(() => prisma.$disconnect());
