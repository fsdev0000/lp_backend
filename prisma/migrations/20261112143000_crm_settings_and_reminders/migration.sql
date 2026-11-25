-- Migration: Add crm_settings and crm_notification_reminders tables

CREATE TABLE IF NOT EXISTS "crm_settings" (
  "key" TEXT NOT NULL PRIMARY KEY,
  "value" JSONB NOT NULL,
  "description" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "crm_notification_reminders" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "notification_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "related_item_id" TEXT,
  "sent_at" TIMESTAMP(3),
  "reminder_count" INTEGER NOT NULL DEFAULT 0,
  "next_reminder_at" TIMESTAMP(3),
  "resolved_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "crm_notification_reminders_notification_id_idx" ON "crm_notification_reminders"("notification_id");
CREATE INDEX IF NOT EXISTS "crm_notification_reminders_related_item_id_idx" ON "crm_notification_reminders"("related_item_id");
CREATE INDEX IF NOT EXISTS "crm_notification_reminders_resolved_next_idx" ON "crm_notification_reminders"("resolved_at", "next_reminder_at");

-- Seed default notification settings
INSERT INTO "crm_settings" ("key", "value", "description")
VALUES (
  'notification_settings',
  jsonb_build_object(
    'approverEmails', jsonb_build_array('lionel@leadersperformance.ae'),
    'reportCcEmails', jsonb_build_array('danielle@eersteling.nl'),
    'editorEmails', jsonb_build_array('sharathkiranpr@gmail.com', 'mirza@leadersperformance.ae'),
    'adminEmails', jsonb_build_array('asif@leadersperformance.ae', 'mirza@leadersperformance.ae'),
    'infoEmails', jsonb_build_array('info@leadersperformance.ae'),
    'reminderIntervalHours', jsonb_build_array(24, 48),
    'maxReminders', 2,
    'dryRunTestingMode', true,
    'testSafetyEmail', 'asif@leadersperformance.ae'
  ),
  'Configurable recipient emails, report CC lists, and follow-up reminder timings for Social CRM'
)
ON CONFLICT ("key") DO NOTHING;

