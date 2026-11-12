-- Migration: Add account_type column to support both LinkedIn Personal Profile and Company Page stats

ALTER TABLE "social_account_connections" 
  ADD COLUMN IF NOT EXISTS "account_type" TEXT NOT NULL DEFAULT 'BUSINESS';

ALTER TABLE "crm_social_accounts" 
  ADD COLUMN IF NOT EXISTS "account_type" TEXT NOT NULL DEFAULT 'BUSINESS';

ALTER TABLE "crm_post_metric_snapshots" 
  ADD COLUMN IF NOT EXISTS "account_type" TEXT NOT NULL DEFAULT 'BUSINESS';

-- Create indexes for fast lookup by platform and account type
CREATE INDEX IF NOT EXISTS "social_account_connections_platform_account_type_idx" 
  ON "social_account_connections"("platform", "account_type");

CREATE INDEX IF NOT EXISTS "crm_social_accounts_platform_account_type_idx" 
  ON "crm_social_accounts"("platform", "account_type");

-- Ensure Lionel's personal profile connection (if exists) is classified as PERSONAL
UPDATE "social_account_connections"
SET "account_type" = 'PERSONAL'
WHERE "platform" = 'LINKEDIN' AND ("account_urn" LIKE 'urn:li:person:%' OR "account_name" ILIKE '%lionel%');

-- Ensure Company Page connection is classified as BUSINESS
UPDATE "social_account_connections"
SET "account_type" = 'BUSINESS'
WHERE "platform" IN ('LINKEDIN_PAGE', 'LINKEDIN') AND ("account_urn" LIKE 'urn:li:organization:%' OR "account_name" ILIKE '%leaders%');

