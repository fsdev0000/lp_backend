-- CreateTable
CREATE TABLE IF NOT EXISTS "cms_texts" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
    "key" VARCHAR(200) NOT NULL,
    "locale" VARCHAR(10) NOT NULL DEFAULT 'en',
    "has_draft" BOOLEAN NOT NULL DEFAULT false,
    "draft_value" TEXT,
    "published_value" TEXT,
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_by" TEXT,
    "published_at" TIMESTAMP(3)
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "cms_text_revisions" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
    "key" VARCHAR(200) NOT NULL,
    "locale" VARCHAR(10) NOT NULL DEFAULT 'en',
    "value" TEXT,
    "action" VARCHAR(50) NOT NULL,
    "actor_email" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "cms_texts_key_locale_key" ON "cms_texts"("key", "locale");
CREATE INDEX IF NOT EXISTS "cms_texts_locale_idx" ON "cms_texts"("locale");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "cms_text_revisions_key_locale_idx" ON "cms_text_revisions"("key", "locale");
CREATE INDEX IF NOT EXISTS "cms_text_revisions_created_at_idx" ON "cms_text_revisions"("created_at");

