-- Add translations JSONB column to articles table if not exists
ALTER TABLE "public"."articles" ADD COLUMN IF NOT EXISTS "translations" JSONB DEFAULT '{}'::jsonb;
