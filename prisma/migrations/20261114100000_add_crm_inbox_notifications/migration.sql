-- CreateTable
CREATE TABLE IF NOT EXISTS "crm_inbox_notifications" (
    "id" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "link" TEXT,
    "workspace" TEXT,
    "entity_id" TEXT,
    "dedupe_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMP(3),

    CONSTRAINT "crm_inbox_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "crm_inbox_notifications_recipient_dedupe_key_key" ON "crm_inbox_notifications"("recipient", "dedupe_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "crm_inbox_notifications_recipient_read_at_created_at_idx" ON "crm_inbox_notifications"("recipient", "read_at", "created_at");

