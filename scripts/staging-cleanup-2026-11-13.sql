-- Staging data cleanup after the 13 Nov 2026 CRM review (items 15, 29, 32 and "no live posts").
-- The approver email (item 34) stays asif@leadersperformance.ae for now: this script doesn't touch it.
--
-- HOW TO RUN (staging first; production only after checking the counts there):
--   1. Run PART 1 alone. It only reads and shows what PART 2 would change.
--   2. If the counts look right, run PART 2. It runs in one transaction: check the counts it prints, then COMMIT,
--      or ROLLBACK to undo everything.
--
-- Nothing here posts to any social channel.

-- ============================================================================================
-- PART 1: read only
-- ============================================================================================

-- Item 15: the 29 Oct 2026 test scans ("Lionel Eersteling / Leaders Performance LLC", ~08:18 UTC).
SELECT count(*) AS test_scans_29_oct, min(created_at), max(created_at)
FROM pressure_scan_submissions
WHERE full_name = 'Lionel Eersteling'
  AND company_name = 'Leaders Performance LLC'
  AND created_at >= '2026-10-29 07:00:00+00' AND created_at < '2026-10-29 10:00:00+00';

-- Item 15: scans from the automated tests' addresses.
SELECT email, count(*) FROM pressure_scan_submissions
WHERE email IN ('pdf@company.ae', 'dossier@company.ae', 'sanitize@company.ae', 'tieddomains@company.ae', 'domainmean@company.ae')
GROUP BY email;

-- Item 15: other days with bursts of scans (20–22 Oct had 109 / 92 / 47 inquiries in the trend).
-- Review these by hand: only delete days you know were tests.
SELECT date_trunc('day', created_at AT TIME ZONE 'Asia/Dubai') AS dubai_day, full_name, company_name, email, count(*)
FROM pressure_scan_submissions
GROUP BY 1, 2, 3, 4
HAVING count(*) >= 5
ORDER BY 1, 5 DESC;

-- Item 15: attribution visits the test scans wrote (lead_form founder_pressure_scan). Review by hand: "New inquiries"
-- counts each address once, so these add at most one person per address.
SELECT email, lead_form, count(*), min(created_at), max(created_at)
FROM attribution_visits
WHERE email IS NOT NULL AND created_at >= '2026-10-29 07:00:00+00' AND created_at < '2026-10-29 10:00:00+00'
GROUP BY email, lead_form;

-- Item 15: masterclass enrollments that look like tests (review by hand; PART 2 doesn't touch them).
SELECT id, full_name, email, amount, payment_status, created_at
FROM masterclass_enrollments
WHERE email ILIKE '%test%' OR email ILIKE '%@company.ae' OR full_name ILIKE '%test%'
ORDER BY created_at;

-- Item 29: Instagram sync rows that fill the Activity log (the job no longer writes them).
SELECT count(*) AS instagram_sync_log_rows FROM social_audit_logs WHERE action = 'INSTAGRAM_ANALYTICS_SYNC_COMPLETED';

-- Item 32: calendar posts for Lionel's personal channels that are still in the Leaders Performance workspace.
SELECT platform, workspace, count(*) FROM crm_posts GROUP BY platform, workspace ORDER BY platform;

-- Two test posts written to staging by mistake during local testing on 13 Nov 2026 (~11:49–11:51 UTC), with their
-- activity rows and 77 error logs. Nothing was posted to LinkedIn (11ac5003 was FAILED: "fetch failed").
-- ALREADY REMOVED from staging on 13 Nov 2026 (2 posts, 3 activity rows, 77 error logs): these checks should show 0 rows.
SELECT id, title, status, created_at FROM social_posts
WHERE id IN ('11ac5003-1b9d-4517-a1eb-497b9293c191', '41d84781-31d4-4a18-95e1-d44bde93bdd9');
SELECT actor, action, entity, timestamp FROM social_audit_logs
WHERE entity IN ('ContentPost #11ac5003-1b9d-4517-a1eb-497b9293c191', 'ContentPost #41d84781-31d4-4a18-95e1-d44bde93bdd9');
-- The same local run wrote 77 error rows (GA4, Search Console, Clarity, YouTube) while its network was blocked:
-- they carry a local file path or "fetch failed". Expect 77.
SELECT action, count(*) FROM "SystemLog"
WHERE "createdAt" BETWEEN '2026-11-13 11:43:00+00' AND '2026-11-13 11:52:00+00'
  AND (details LIKE '%/Users/asadullah/%' OR details LIKE '%"message":"fetch failed"%')
GROUP BY action;

-- "No live posts": current settings.
SELECT key, value FROM crm_settings WHERE key IN ('notification_settings', 'publishing_flags');

-- ============================================================================================
-- PART 2: changes (one transaction)
-- ============================================================================================

BEGIN;

-- Item 15: the 29 Oct test scans and the test addresses' scans.
DELETE FROM pressure_scan_submissions
WHERE (full_name = 'Lionel Eersteling'
       AND company_name = 'Leaders Performance LLC'
       AND created_at >= '2026-10-29 07:00:00+00' AND created_at < '2026-10-29 10:00:00+00')
   OR email IN ('pdf@company.ae', 'dossier@company.ae', 'sanitize@company.ae', 'tieddomains@company.ae', 'domainmean@company.ae');

-- Item 29: Instagram sync noise in the Activity log.
DELETE FROM social_audit_logs WHERE action = 'INSTAGRAM_ANALYTICS_SYNC_COMPLETED';

-- Item 32: Instagram, TikTok and YouTube calendar posts belong to the Lionel Eersteling workspace
-- (new imports set this by themselves, see src/modules/automation/workspace.ts).
UPDATE crm_posts SET workspace = 'lionel_eersteling'
WHERE platform IN ('INSTAGRAM', 'TIKTOK', 'YOUTUBE') AND workspace <> 'lionel_eersteling';

-- No live posts for now: every platform off and the global dry run on.
UPDATE crm_settings
SET value = value::jsonb || '{"youtube": false, "instagram": false, "tiktok": false, "linkedin": false, "dryRunGlobal": true}'::jsonb,
    updated_at = now()
WHERE key = 'publishing_flags';

-- Check the result before committing.
SELECT count(*) AS scans_left_29_oct FROM pressure_scan_submissions
WHERE full_name = 'Lionel Eersteling' AND company_name = 'Leaders Performance LLC'
  AND created_at >= '2026-10-29 07:00:00+00' AND created_at < '2026-10-29 10:00:00+00';
SELECT platform, workspace, count(*) FROM crm_posts GROUP BY platform, workspace ORDER BY platform;
SELECT key, value FROM crm_settings WHERE key IN ('notification_settings', 'publishing_flags');

-- COMMIT;   -- when the numbers above are right
-- ROLLBACK; -- otherwise
