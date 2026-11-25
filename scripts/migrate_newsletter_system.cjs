const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const prisma = new PrismaClient();

async function runMigration() {
  try {
    console.log('[Migration] Starting Supabase PostgreSQL newsletter migration via Prisma...');

    // 1. Alter newsletter_subscribers table
    console.log('[Migration] Updating newsletter_subscribers table...');
    await prisma.$executeRawUnsafe(`
      ALTER TABLE newsletter_subscribers
        ADD COLUMN IF NOT EXISTS first_name TEXT,
        ADD COLUMN IF NOT EXISTS consent_given BOOLEAN NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS consent_date TIMESTAMPTZ NOT NULL DEFAULT now(),
        ADD COLUMN IF NOT EXISTS consent_source TEXT NOT NULL DEFAULT 'website',
        ADD COLUMN IF NOT EXISTS privacy_policy_version TEXT NOT NULL DEFAULT 'v2026.3',
        ADD COLUMN IF NOT EXISTS subscribed BOOLEAN NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS unsubscribe_token TEXT,
        ADD COLUMN IF NOT EXISTS unsubscribed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
    `);

    // Ensure unique index on unsubscribe_token
    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_newsletter_subscribers_unsubscribe_token
        ON newsletter_subscribers (unsubscribe_token)
        WHERE unsubscribe_token IS NOT NULL;
    `);

    // Index on subscribed and consent_given
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_newsletter_subscribers_subscribed_consent
        ON newsletter_subscribers (subscribed, consent_given);
    `);

    // Backfill existing subscribers
    const existingRows = await prisma.$queryRawUnsafe(`
      SELECT id, status, "subscribedAt", "updatedAt", unsubscribe_token FROM newsletter_subscribers;
    `);

    console.log(`[Migration] Found ${existingRows.length} existing records to check/backfill.`);

    for (const row of existingRows) {
      const isSubscribed = row.status !== 'unsubscribed';
      const token = row.unsubscribe_token || crypto.randomBytes(32).toString('hex');
      const unsubAt = !isSubscribed ? (row.updatedAt || new Date()) : null;

      await prisma.$executeRawUnsafe(`
        UPDATE newsletter_subscribers
        SET subscribed = $1,
            unsubscribed_at = $2,
            unsubscribe_token = $3,
            consent_given = true,
            consent_date = COALESCE("subscribedAt", now()),
            created_at = COALESCE("subscribedAt", now())
        WHERE id = $4;
      `, isSubscribed, unsubAt, token, row.id);
    }

    // 2. Create newsletter_campaigns table
    console.log('[Migration] Creating newsletter_campaigns table...');
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS newsletter_campaigns (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        campaign_key TEXT UNIQUE NOT NULL,
        campaign_month TEXT NOT NULL,
        title TEXT NOT NULL,
        subject TEXT NOT NULL,
        pdf_path TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        approval_status TEXT NOT NULL DEFAULT 'pending',
        scheduled_at TIMESTAMPTZ,
        approved_at TIMESTAMPTZ,
        send_started_at TIMESTAMPTZ,
        send_completed_at TIMESTAMPTZ,
        total_recipients INT NOT NULL DEFAULT 0,
        total_sent INT NOT NULL DEFAULT 0,
        total_failed INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_newsletter_campaigns_status
        ON newsletter_campaigns (status, approval_status);
    `);

    // 3. Create newsletter_campaign_recipients table
    console.log('[Migration] Creating newsletter_campaign_recipients table...');
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS newsletter_campaign_recipients (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        campaign_id UUID NOT NULL REFERENCES newsletter_campaigns(id) ON DELETE CASCADE,
        subscriber_id TEXT NOT NULL REFERENCES newsletter_subscribers(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        sent_at TIMESTAMPTZ,
        failed_at TIMESTAMPTZ,
        provider_message_id TEXT,
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uq_campaign_subscriber UNIQUE (campaign_id, subscriber_id)
      );
    `);

    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign
        ON newsletter_campaign_recipients (campaign_id);
    `);

    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_campaign_recipients_subscriber
        ON newsletter_campaign_recipients (subscriber_id);
    `);

    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_campaign_recipients_status
        ON newsletter_campaign_recipients (status);
    `);

    // 4. Enable Row Level Security (RLS) on all 3 tables
    console.log('[Migration] Enabling RLS on all newsletter tables...');
    await prisma.$executeRawUnsafe(`ALTER TABLE newsletter_subscribers ENABLE ROW LEVEL SECURITY;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE newsletter_campaigns ENABLE ROW LEVEL SECURITY;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE newsletter_campaign_recipients ENABLE ROW LEVEL SECURITY;`);

    console.log('[Migration] Newsletter system migration completed successfully!');
  } catch (err) {
    console.error('[Migration] Failed:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runMigration();
