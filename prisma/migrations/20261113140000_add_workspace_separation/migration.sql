-- AlterTable
ALTER TABLE "social_posts" ADD COLUMN IF NOT EXISTS "workspace" TEXT NOT NULL DEFAULT 'leaders_performance';

-- AlterTable
ALTER TABLE "crm_content_items" ADD COLUMN IF NOT EXISTS "workspace" TEXT NOT NULL DEFAULT 'leaders_performance';

-- AlterTable
ALTER TABLE "crm_posts" ADD COLUMN IF NOT EXISTS "workspace" TEXT NOT NULL DEFAULT 'leaders_performance';

-- CreateIndex
CREATE INDEX IF NOT EXISTS "social_posts_workspace_idx" ON "social_posts"("workspace");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "crm_content_items_workspace_idx" ON "crm_content_items"("workspace");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "crm_posts_workspace_idx" ON "crm_posts"("workspace");

