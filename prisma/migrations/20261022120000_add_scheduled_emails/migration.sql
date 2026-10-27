-- CreateTable
CREATE TABLE "scheduled_emails" (
    "id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "contact_email" TEXT NOT NULL,
    "email_type" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "html_body" TEXT NOT NULL,
    "send_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "scan_type" TEXT NOT NULL DEFAULT 'founder_pressure_scan',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),
    "error_message" TEXT,
    "appointment_id" TEXT,
    "reference_number" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "max_retries" INTEGER NOT NULL DEFAULT 3,
    "idempotency_key" TEXT,

    CONSTRAINT "scheduled_emails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_emails_idempotency_key_key" ON "scheduled_emails"("idempotency_key");

-- CreateIndex
CREATE INDEX "scheduled_emails_status_send_at_idx" ON "scheduled_emails"("status", "send_at");

-- CreateIndex
CREATE INDEX "scheduled_emails_contact_email_idx" ON "scheduled_emails"("contact_email");

-- CreateIndex
CREATE INDEX "scheduled_emails_reference_number_idx" ON "scheduled_emails"("reference_number");

-- CreateIndex
CREATE INDEX "scheduled_emails_appointment_id_idx" ON "scheduled_emails"("appointment_id");
