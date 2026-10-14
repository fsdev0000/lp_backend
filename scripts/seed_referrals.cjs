const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log("Checking masterclass_referral_codes in DB...");

  // Verify table exists
  const check = await prisma.$queryRawUnsafe(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name = 'masterclass_referral_codes'
    );
  `);
  console.log("Table exists check:", check);

  // Upsert Danielle
  await prisma.$executeRawUnsafe(`
    INSERT INTO "masterclass_referral_codes" 
      ("id", "code", "referrer_name", "referrer_email", "discount_percent", "start_date", "end_date", "is_active", "used_count", "notes", "created_at", "updated_at")
    VALUES 
      (gen_random_uuid(), '0XQZ6IN', 'Danielle', 'danielle@leadersperformance.ae', 33.33, '2026-10-01 00:00:00+00', '2027-12-31 23:59:59+00', true, 0, 'Official executive referral code for Danielle (33.33% privilege)', NOW(), NOW())
    ON CONFLICT ("code") DO UPDATE SET
      "referrer_name" = 'Danielle',
      "discount_percent" = 33.33,
      "is_active" = true,
      "updated_at" = NOW();
  `);

  // Upsert Divalos
  await prisma.$executeRawUnsafe(`
    INSERT INTO "masterclass_referral_codes" 
      ("id", "code", "referrer_name", "referrer_email", "discount_percent", "start_date", "end_date", "is_active", "used_count", "notes", "created_at", "updated_at")
    VALUES 
      (gen_random_uuid(), 'DIVALOS', 'Divalos', 'divalos@leadersperformance.ae', 33.33, '2026-10-01 00:00:00+00', '2027-12-31 23:59:59+00', true, 0, 'Official executive referral code for Divalos (33.33% privilege)', NOW(), NOW())
    ON CONFLICT ("code") DO UPDATE SET
      "referrer_name" = 'Divalos',
      "discount_percent" = 33.33,
      "is_active" = true,
      "updated_at" = NOW();
  `);

  // Query and print all rows
  const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "masterclass_referral_codes" ORDER BY "created_at" ASC;`);
  console.log("\n--- CURRENT ROWS IN masterclass_referral_codes ---");
  console.table(rows);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
