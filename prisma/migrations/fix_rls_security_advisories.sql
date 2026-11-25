-- Migration: Enable Row Level Security (RLS) and Revoke Public PostgREST Exposure
-- Resolves Supabase Security Advisor Critical Findings:
-- 1. RLS Disabled in Public: public.masterclass_workbook_submissions
-- 2. RLS Disabled in Public: public.masterclass_enrollments
-- 3. RLS Disabled in Public: public.attribution_visits
-- 4. Sensitive Columns Exposed: public.masterclass_enrollments

-- Step 1: Enable Row Level Security (RLS) on all flagged tables
ALTER TABLE public.masterclass_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.masterclass_workbook_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attribution_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.masterclass_bookings ENABLE ROW LEVEL SECURITY;

-- Step 2: Revoke default anon and authenticated access to prevent PostgREST public exposure
REVOKE ALL ON TABLE public.masterclass_enrollments FROM anon, authenticated;
REVOKE ALL ON TABLE public.masterclass_workbook_submissions FROM anon, authenticated;
REVOKE ALL ON TABLE public.attribution_visits FROM anon, authenticated;
REVOKE ALL ON TABLE public.masterclass_bookings FROM anon, authenticated;
