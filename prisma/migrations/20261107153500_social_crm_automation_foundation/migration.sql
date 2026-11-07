-- Social CRM Content Automation Foundation Migration (Plan Section 5)

DO $$ BEGIN
  CREATE TYPE "Platform" AS ENUM ('LINKEDIN', 'INSTAGRAM', 'YOUTUBE', 'TIKTOK', 'X', 'MEDIUM', 'LINKEDIN_NEWSLETTER', 'INSPO', 'WEBSITE');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "PublishMode" AS ENUM ('AUTO', 'MANUAL');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "PostStatus" AS ENUM (
    'BLOCKED',
    'PENDING_REVIEW',
    'CHANGES_REQUESTED',
    'APPROVED',
    'PUBLISHING',
    'PROCESSING',
    'PUBLISHED',
    'FAILED',
    'MISSED',
    'REJECTED',
    'SKIPPED',
    'CANCELLED',
    'MANUAL_DONE'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "MediaStatus" AS ENUM ('PENDING_UPLOAD', 'READY', 'INVALID');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "ReviewAction" AS ENUM ('SUBMITTED', 'APPROVED', 'CHANGES_REQUESTED', 'REJECTED', 'COMMENT', 'RESUBMITTED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "crm_folder_rules" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "drive_path" TEXT NOT NULL UNIQUE,
  "platform" "Platform" NOT NULL,
  "post_kind" TEXT NOT NULL,
  "content_type_aliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "mode" "PublishMode" NOT NULL DEFAULT 'AUTO',
  "expected_files" TEXT NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "crm_folder_rules_platform_idx" ON "crm_folder_rules"("platform");

CREATE TABLE IF NOT EXISTS "crm_social_accounts" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "platform" "Platform" NOT NULL,
  "label" TEXT NOT NULL,
  "external_id" TEXT NOT NULL,
  "token_encrypted" TEXT,
  "refresh_encrypted" TEXT,
  "token_expires_at" TIMESTAMP(3),
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "crm_social_accounts_platform_is_active_idx" ON "crm_social_accounts"("platform", "is_active");

CREATE TABLE IF NOT EXISTS "crm_channel_aliases" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "alias" TEXT NOT NULL UNIQUE,
  "platform" "Platform" NOT NULL,
  "account_id" TEXT,
  "mode" "PublishMode" NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "crm_content_items" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "sheet_id" TEXT NOT NULL,
  "sheet_tab" TEXT NOT NULL,
  "row_number" INTEGER NOT NULL,
  "row_key" TEXT NOT NULL UNIQUE,
  "row_hash" TEXT NOT NULL,
  "scheduled_at" TIMESTAMP(3) NOT NULL,
  "channel_raw" TEXT NOT NULL,
  "content_type" TEXT,
  "subject" TEXT,
  "file_location" TEXT,
  "raw_row" JSONB NOT NULL,
  "category" TEXT,
  "last_seen_at" TIMESTAMP(3) NOT NULL,
  "unseen_runs" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "crm_content_items_scheduled_at_idx" ON "crm_content_items"("scheduled_at");
CREATE INDEX IF NOT EXISTS "crm_content_items_last_seen_at_idx" ON "crm_content_items"("last_seen_at");

CREATE TABLE IF NOT EXISTS "crm_posts" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "content_item_id" TEXT NOT NULL REFERENCES "crm_content_items"("id") ON DELETE CASCADE,
  "account_id" TEXT REFERENCES "crm_social_accounts"("id") ON DELETE SET NULL,
  "platform" "Platform" NOT NULL,
  "mode" "PublishMode" NOT NULL,
  "status" "PostStatus" NOT NULL,
  "blocked_reason" TEXT,
  "scheduled_at" TIMESTAMP(3) NOT NULL,
  "title" TEXT,
  "caption" TEXT,
  "hashtags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "options" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "caption_source" TEXT,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "approved_by_id" TEXT,
  "approved_at" TIMESTAMP(3),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3),
  "locked_at" TIMESTAMP(3),
  "locked_by" TEXT,
  "platform_post_id" TEXT,
  "platform_url" TEXT,
  "processing_ref" TEXT,
  "published_at" TIMESTAMP(3),
  "last_error" TEXT,
  "idempotency_key" TEXT NOT NULL UNIQUE,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "crm_posts_status_scheduled_at_idx" ON "crm_posts"("status", "scheduled_at");
CREATE INDEX IF NOT EXISTS "crm_posts_platform_status_idx" ON "crm_posts"("platform", "status");
CREATE INDEX IF NOT EXISTS "crm_posts_content_item_id_idx" ON "crm_posts"("content_item_id");

CREATE TABLE IF NOT EXISTS "crm_media_assets" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "drive_file_id" TEXT NOT NULL,
  "checksum_md5" TEXT NOT NULL,
  "file_name" TEXT NOT NULL,
  "mime_type" TEXT NOT NULL,
  "size_bytes" BIGINT NOT NULL,
  "duration_sec" DOUBLE PRECISION,
  "width" INTEGER,
  "height" INTEGER,
  "storage_provider" TEXT NOT NULL DEFAULT 'supabase',
  "bucket" TEXT NOT NULL,
  "object_key" TEXT,
  "status" "MediaStatus" NOT NULL,
  "invalid_reason" TEXT,
  "delete_after" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "crm_media_assets_drive_file_id_checksum_md5_key" UNIQUE ("drive_file_id", "checksum_md5")
);

CREATE INDEX IF NOT EXISTS "crm_media_assets_checksum_md5_idx" ON "crm_media_assets"("checksum_md5");
CREATE INDEX IF NOT EXISTS "crm_media_assets_delete_after_idx" ON "crm_media_assets"("delete_after");

CREATE TABLE IF NOT EXISTS "crm_post_media" (
  "post_id" TEXT NOT NULL REFERENCES "crm_posts"("id") ON DELETE CASCADE,
  "asset_id" TEXT NOT NULL REFERENCES "crm_media_assets"("id") ON DELETE CASCADE,
  "position" INTEGER NOT NULL DEFAULT 0,
  "role" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY ("post_id", "asset_id", "role", "revision")
);

CREATE INDEX IF NOT EXISTS "crm_post_media_post_id_revision_idx" ON "crm_post_media"("post_id", "revision");

CREATE TABLE IF NOT EXISTS "crm_post_revisions" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "post_id" TEXT NOT NULL REFERENCES "crm_posts"("id") ON DELETE CASCADE,
  "revision" INTEGER NOT NULL,
  "caption" TEXT,
  "title" TEXT,
  "media_snapshot" JSONB NOT NULL,
  "created_by_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "crm_post_revisions_post_id_revision_idx" ON "crm_post_revisions"("post_id", "revision");

CREATE TABLE IF NOT EXISTS "crm_review_events" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "post_id" TEXT NOT NULL REFERENCES "crm_posts"("id") ON DELETE CASCADE,
  "revision" INTEGER NOT NULL,
  "action" "ReviewAction" NOT NULL,
  "comment" TEXT,
  "actor_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "crm_review_events_post_id_created_at_idx" ON "crm_review_events"("post_id", "created_at");

CREATE TABLE IF NOT EXISTS "crm_publish_attempts" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "post_id" TEXT NOT NULL REFERENCES "crm_posts"("id") ON DELETE CASCADE,
  "attempt_no" INTEGER NOT NULL,
  "started_at" TIMESTAMP(3) NOT NULL,
  "finished_at" TIMESTAMP(3),
  "http_status" INTEGER,
  "error_code" TEXT,
  "response" JSONB
);

CREATE INDEX IF NOT EXISTS "crm_publish_attempts_post_id_attempt_no_idx" ON "crm_publish_attempts"("post_id", "attempt_no");

CREATE TABLE IF NOT EXISTS "crm_notifications" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "type" TEXT NOT NULL,
  "post_id" TEXT,
  "recipients" TEXT[] NOT NULL,
  "cc" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "subject" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "dedupe_key" TEXT NOT NULL UNIQUE,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "sent_at" TIMESTAMP(3),
  "error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "crm_notifications_status_created_at_idx" ON "crm_notifications"("status", "created_at");
CREATE INDEX IF NOT EXISTS "crm_notifications_post_id_idx" ON "crm_notifications"("post_id");

CREATE TABLE IF NOT EXISTS "crm_job_runs" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "workflow" TEXT NOT NULL,
  "started_at" TIMESTAMP(3) NOT NULL,
  "finished_at" TIMESTAMP(3),
  "stats" JSONB,
  "error" TEXT
);

CREATE INDEX IF NOT EXISTS "crm_job_runs_workflow_started_at_idx" ON "crm_job_runs"("workflow", "started_at");

CREATE TABLE IF NOT EXISTS "crm_post_metric_snapshots" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "post_id" TEXT NOT NULL REFERENCES "crm_posts"("id") ON DELETE CASCADE,
  "captured_at" TIMESTAMP(3) NOT NULL,
  "views" INTEGER,
  "reach" INTEGER,
  "impressions" INTEGER,
  "likes" INTEGER,
  "comments" INTEGER,
  "shares" INTEGER,
  "saves" INTEGER,
  "raw" JSONB
);

CREATE INDEX IF NOT EXISTS "crm_post_metric_snapshots_post_id_captured_at_idx" ON "crm_post_metric_snapshots"("post_id", "captured_at");

-- Seed default FolderRules from Plan Section 4
INSERT INTO "crm_folder_rules" ("drive_path", "platform", "post_kind", "content_type_aliases", "mode", "expected_files")
VALUES
  ('01_Linkedin/01_Quotes', 'LINKEDIN', 'Image', ARRAY['quote', 'quotes', '01_quotes'], 'AUTO', '1 image + caption'),
  ('01_Linkedin/02_Poster', 'LINKEDIN', 'Image', ARRAY['poster', 'posters', '02_poster'], 'AUTO', '1 image + caption'),
  ('01_Linkedin/03_Video', 'LINKEDIN', 'Video', ARRAY['video', 'videos', '03_video'], 'AUTO', '1 video + caption'),
  ('01_Linkedin/04_Newsletter_Article', 'LINKEDIN_NEWSLETTER', 'Article', ARRAY['newsletter', 'article', 'newsletter_article', '04_newsletter_article'], 'MANUAL', 'article .docx + cover image'),
  ('02_Instagram/01_Video', 'INSTAGRAM', 'Reel', ARRAY['reel', 'reels', 'video', '01_video'], 'AUTO', '1 video + caption'),
  ('02_Instagram/02_Photo', 'INSTAGRAM', 'Image', ARRAY['photo', 'image', 'carousel', 'carousels', 'poster', 'quote', '02_photo'], 'AUTO', '1 image, or 2-10 images sorted by file name'),
  ('03_Youtube', 'YOUTUBE', 'Video', ARRAY['video', 'youtube', 'short', 'shorts'], 'AUTO', '1 video + caption + optional Thumbnail.png/.jpg'),
  ('04_Tiktok', 'TIKTOK', 'Video', ARRAY['video', 'tiktok', 'reel', 'short'], 'AUTO', '1 video (.mov/.mp4) + caption')
ON CONFLICT ("drive_path") DO NOTHING;

