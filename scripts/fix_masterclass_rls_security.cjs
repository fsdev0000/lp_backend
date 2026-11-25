const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function runFix() {
  try {
    console.log('[Security Fix] Enabling RLS and revoking anon/authenticated access on sensitive tables...');

    // 1. Enable Row Level Security (RLS)
    console.log('[Security Fix] Enabling RLS on masterclass_enrollments, masterclass_workbook_submissions, attribution_visits, masterclass_bookings...');
    await prisma.$executeRawUnsafe(`ALTER TABLE public.masterclass_enrollments ENABLE ROW LEVEL SECURITY;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE public.masterclass_workbook_submissions ENABLE ROW LEVEL SECURITY;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE public.attribution_visits ENABLE ROW LEVEL SECURITY;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE public.masterclass_bookings ENABLE ROW LEVEL SECURITY;`);

    // 2. Revoke all privileges from anon and authenticated roles
    console.log('[Security Fix] Revoking permissions from anon and authenticated roles...');
    await prisma.$executeRawUnsafe(`REVOKE ALL ON TABLE public.masterclass_enrollments FROM anon, authenticated;`);
    await prisma.$executeRawUnsafe(`REVOKE ALL ON TABLE public.masterclass_workbook_submissions FROM anon, authenticated;`);
    await prisma.$executeRawUnsafe(`REVOKE ALL ON TABLE public.attribution_visits FROM anon, authenticated;`);
    await prisma.$executeRawUnsafe(`REVOKE ALL ON TABLE public.masterclass_bookings FROM anon, authenticated;`);

    // 3. Verify RLS status
    const rlsStatus = await prisma.$queryRawUnsafe(`
      SELECT tablename, rowsecurity 
      FROM pg_tables 
      WHERE schemaname = 'public' 
        AND tablename IN ('masterclass_enrollments', 'masterclass_workbook_submissions', 'attribution_visits', 'masterclass_bookings')
      ORDER BY tablename;
    `);
    console.log('[Security Fix] Updated RLS Status:');
    console.table(rlsStatus);

    // 4. Verify grants
    const remainingGrants = await prisma.$queryRawUnsafe(`
      SELECT grantee, table_name, privilege_type 
      FROM information_schema.role_table_grants 
      WHERE table_schema = 'public' 
        AND table_name IN ('masterclass_enrollments', 'masterclass_workbook_submissions', 'attribution_visits', 'masterclass_bookings')
        AND grantee IN ('anon', 'authenticated');
    `);
    console.log('[Security Fix] Remaining anon/authenticated grants (should be empty):', remainingGrants.length);

    console.log('[Security Fix] Completed successfully!');
  } catch (error) {
    console.error('[Security Fix] Error applying security fixes:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runFix();
