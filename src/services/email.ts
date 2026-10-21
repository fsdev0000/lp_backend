import fs from 'fs';
import path from 'path';
import { sendEmail, upsertContact } from './ghl';
import { getSecret } from './secrets';
import { PrismaClient } from '@prisma/client';
import { generatePressureScanPdf } from './pressureScanPdfService';
import { getSupabaseClient } from './supabaseStorageService';

const prisma = new PrismaClient();

// Safely escapes dynamic user-provided strings for HTML injection
export function escapeHtml(str: string | undefined | null): string {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Formats submission date and time using operational timezone supplied by the system
export function formatOperationalSubmissionDate(dateInput?: Date | string | number): string {
  const date = dateInput ? new Date(dateInput) : new Date();
  const operationalTz = process.env.OPERATIONAL_TIMEZONE || 'Asia/Dubai';

  try {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: operationalTz,
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short',
    });

    const parts = formatter.formatToParts(date);
    const partMap: Record<string, string> = {};
    for (const p of parts) {
      partMap[p.type] = p.value;
    }

    const day = partMap.day || String(date.getDate());
    const month = partMap.month || date.toLocaleString('en-US', { month: 'long' });
    const year = partMap.year || String(date.getFullYear());
    const hour = partMap.hour || '12';
    const minute = partMap.minute || '00';
    const dayPeriod = (partMap.dayPeriod || '').toUpperCase();
    const timeZoneName = partMap.timeZoneName || 'GST';

    return `${day} ${month} ${year} · ${hour}:${minute} ${dayPeriod} ${timeZoneName}`.trim();
  } catch (err) {
    return date.toUTCString();
  }
}

// Generates a reference number if not provided (e.g. FPS-2026-6418)
export function generateReferenceNumber(): string {
  const year = new Date().getFullYear();
  const seq = String(Math.floor(1000 + Math.random() * 9000));
  return `FPS-${year}-${seq}`;
}

// Resolves the secure review URL pointing to authenticated internal CRM/portal
export async function getSecureReviewUrl(): Promise<string> {
  if (process.env.INTERNAL_REVIEW_URL) {
    return process.env.INTERNAL_REVIEW_URL;
  }

  try {
    const locationId = (await getSecret('GHL_LOCATION_ID').catch(() => null)) || process.env.GHL_LOCATION_ID;
    if (locationId) {
      return `https://app.gohighlevel.com/v2/location/${encodeURIComponent(locationId)}/opportunities`;
    }
  } catch {
    // ignore
  }

  return 'https://leadersperformance.ae/admin/review';
}

// Interpolates variables like {{name}} into the template
export function renderTemplate(templateHtml: string, variables: Record<string, string>): string {
  let rendered = templateHtml;
  for (const [key, value] of Object.entries(variables)) {
    const regex = new RegExp(`{{${key}}}`, 'g');
    rendered = rendered.replace(regex, value ?? '');
  }
  return rendered;
}

export async function sendAssessmentEmail(contactId: string, emailData: { tier: string, firstName: string, score: number, sessionId: string }) {
  let templateName = 'strong.html';
  const lowerTier = (emailData.tier || '').toLowerCase();
  if (lowerTier.includes('priority') || lowerTier === 'critical') {
    templateName = 'critical.html';
  } else if (lowerTier.includes('active') || lowerTier.includes('emerging') || lowerTier === 'moderate') {
    templateName = 'moderate.html';
  } else {
    templateName = 'strong.html';
  }

  const templatePath = path.join(__dirname, '../../templates', templateName);
  
  try {
    const rawTemplate = fs.readFileSync(templatePath, 'utf8');
    
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:8080';
    const redirectUrl = `${frontendUrl}?session_id=${emailData.sessionId}`;

    const html = renderTemplate(rawTemplate, {
      name: emailData.firstName,
      SCORE: emailData.score.toString(),
      strategic_url: redirectUrl,
      daisy_url: redirectUrl,
      unsubscribe_url: '#',
    });
    
    await sendEmail(contactId, `Your Founder Pressure Profile is ready`, html);
    console.log(`[SUCCESS] Founder Email Sent: Delivered ${templateName} to contact ${contactId} (${emailData.firstName})`);
  } catch (error) {
    console.error(`[ERROR] Failed to load or send Founder email (${templateName}):`, error);
  }
}

export interface AdminBriefingData {
  name?: string;
  participant_name?: string;
  email?: string;
  company?: string;
  company_name?: string;
  phone?: string;
  revenue?: string;
  stage?: string;
  signal_classification?: string;
  reference_number?: string;
  ref?: string;
  initial_reason?: string;
  reason?: string;
  review_status?: string;
  review_url?: string;
  submission_date?: Date | string | number;
  // Legacy fields accepted for backwards compatibility
  score?: number;
  tier?: string;
  primary_focus?: string;
  focus_area?: string;
  greatest_opportunity?: string;
  opening_question?: string;
}

export async function buildAdminBriefingEmail(founderData: AdminBriefingData): Promise<{ subject: string; html: string; referenceNumber: string; companyName: string }> {
  const templatePath = path.join(__dirname, '../../templates/internal-consultant-briefing.html');
  const rawTemplate = fs.readFileSync(templatePath, 'utf8');

  const participantName = (founderData.participant_name || founderData.name || 'Anonymous Founder').trim();
  const companyName = (founderData.company_name || founderData.company || 'Confidential').trim();
  const referenceNumber = (founderData.reference_number || founderData.ref || generateReferenceNumber()).trim();
  const submittedAt = formatOperationalSubmissionDate(founderData.submission_date);
  const reviewStatus = (founderData.review_status || 'Awaiting Human Review').trim();
  const frontendUrl = process.env.FRONTEND_URL || 'https://staging.leadersperformance.ae';
  const backendUrl = process.env.BACKEND_URL || frontendUrl;
  const reviewUrl = founderData.review_url || `${backendUrl}/api/v1/scan/review/${encodeURIComponent(referenceNumber)}/pdf`;

  const initialReason = (
    founderData.initial_reason ||
    founderData.reason ||
    'We are preparing for the next stage of growth and I want to understand where my involvement may be limiting leadership ownership and execution.'
  ).trim();

  // Subject requirement: [Founder Pressure Scan] New Submission: [Name] - [Company] (Ref: [Ref])
  const subject = `[Founder Pressure Scan] New Submission: ${participantName} — ${companyName} (Ref: ${referenceNumber})`;

  // HTML template variables map including full founder profile details
  const variables: Record<string, string> = {
    participant_name: escapeHtml(participantName),
    company_name: escapeHtml(companyName),
    email: escapeHtml(founderData.email || '—'),
    phone: escapeHtml(founderData.phone || '—'),
    revenue: escapeHtml(founderData.revenue || '—'),
    stage: escapeHtml(founderData.stage || '—'),
    signal_classification: escapeHtml(founderData.signal_classification || 'Pending Review'),
    primary_focus: escapeHtml(founderData.primary_focus || 'General Operating Cadence'),
    submitted_at: escapeHtml(submittedAt),
    review_status: escapeHtml(reviewStatus),
    reference_number: escapeHtml(referenceNumber),
    review_url: escapeHtml(reviewUrl),
    initial_reason: escapeHtml(initialReason),
    // Backward compatibility mappings
    name: escapeHtml(participantName),
    company: escapeHtml(companyName),
    submission_url: escapeHtml(reviewUrl),
  };

  const html = renderTemplate(rawTemplate, variables);

  return { subject, html, referenceNumber, companyName };
}

export async function resolveScanPdfAttachmentUrl(referenceNumber: string): Promise<string | null> {
  try {
    const cleanRef = (referenceNumber || '').trim();
    if (!cleanRef) return null;

    const submission = await prisma.pressureScanSubmission.findFirst({
      where: {
        OR: [{ referenceNumber: cleanRef }, { id: cleanRef }],
      },
    });

    if (submission) {
      const answersList = Array.isArray(submission.answers) ? (submission.answers as any[]) : [];
      const domainScoresList = Array.isArray(submission.domainScores) ? (submission.domainScores as any[]) : [];

      const pdfBuffer = generatePressureScanPdf({
        referenceNumber: submission.referenceNumber,
        fullName: submission.fullName,
        email: submission.email,
        companyName: submission.companyName,
        phone: submission.phone,
        submittedContext: (submission.submittedContext as any) || null,
        answers: answersList,
        overallRawMean: submission.overallRawMean,
        overallNormalised: submission.overallNormalised,
        domainScores: domainScoresList,
        primarySignalAreas: submission.primarySignalAreas,
        signalClassification: submission.signalClassification,
        submittedAt: submission.createdAt,
        reviewStatus: submission.reviewStatus,
        reviewerNotes: submission.reviewerNotes,
        reviewerDecision: submission.reviewerDecision,
        reviewedAt: submission.reviewedAt,
        reviewedBy: submission.reviewedBy,
        zoomMeetingUrl: submission.zoomMeetingUrl,
        scheduledReviewAt: submission.scheduledReviewAt,
      });

      try {
        const supabase = await getSupabaseClient();
        const objectPath = `pressure-scans/Founder_Pressure_Scan_${submission.referenceNumber}.pdf`;
        const { error: uploadError } = await supabase.storage.from('avatars').upload(objectPath, pdfBuffer, {
          contentType: 'application/pdf',
          upsert: true,
        });

        if (!uploadError) {
          const { data: pubData } = supabase.storage.from('avatars').getPublicUrl(objectPath);
          if (pubData?.publicUrl) {
            return pubData.publicUrl;
          }
        }
      } catch (uploadErr) {
        console.warn('[PDF Attachment] Supabase storage upload notice:', uploadErr);
      }
    }

    const backendUrl = process.env.BACKEND_URL || process.env.FRONTEND_URL || 'https://staging.leadersperformance.ae';
    return `${backendUrl}/api/v1/scan/review/${encodeURIComponent(cleanRef)}/pdf`;
  } catch (err: any) {
    console.warn('[PDF Attachment] Notice resolving scan PDF attachment:', err?.message || err);
    return null;
  }
}

export async function sendAdminBriefing(founderData: AdminBriefingData, adminContactIds: string[]) {
  try {
    const { subject, html, referenceNumber, companyName } = await buildAdminBriefingEmail(founderData);
    const pdfAttachmentUrl = await resolveScanPdfAttachmentUrl(referenceNumber);
    const attachments = pdfAttachmentUrl ? [pdfAttachmentUrl] : undefined;
    
    for (const adminContactId of adminContactIds) {
      if (adminContactId) {
        await sendEmail(adminContactId, subject, html, undefined, attachments);
        console.log(`[SUCCESS] Admin Email Sent with PDF attachment: Delivered briefing to contact ${adminContactId} (Company: ${companyName}, Ref: ${referenceNumber})`);
      }
    }
  } catch (error) {
    console.error(`[ERROR] Failed to send Admin briefing:`, error);
  }
}

export interface CalendarBookingEmailData {
  participantName: string;
  email: string;
  phone?: string;
  companyName?: string;
  dateTimeStr: string;
  referenceNumber: string;
  zoomMeetingUrl?: string;
}

export async function sendCalendarBookingEmails(data: CalendarBookingEmailData) {
  const frontendUrl = process.env.FRONTEND_URL || 'https://staging.leadersperformance.ae';
  const backendUrl = process.env.BACKEND_URL || frontendUrl;
  const secureReviewUrl = `${backendUrl}/api/v1/scan/review/${encodeURIComponent(data.referenceNumber)}/pdf`;
  const zoomUrl = data.zoomMeetingUrl || process.env.REVIEW_MEETING_URL || 'https://zoom.us/j/7114427991?pwd=leadersperformance';

  // Format date nicely (Dubai GST)
  let formattedDate = data.dateTimeStr;
  try {
    const d = new Date(data.dateTimeStr);
    formattedDate = d.toLocaleString('en-GB', {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone: 'Asia/Dubai',
    }) + ' (Dubai GST)';
  } catch (_) {}

  // 1. FOUNDER CONFIRMATION EMAIL (Sent ONLY to Founder)
  try {
    const founderSubject = `[Confirmed] 1-on-1 Strategic Review with Lionel Eersteling (Ref: ${data.referenceNumber})`;
    const founderHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${founderSubject}</title>
  <style>
    body { font-family: 'Inter', Arial, sans-serif; background: #f2ede3; margin: 0; padding: 24px 0; }
    .card { max-width: 600px; margin: 0 auto; background: #fbf8f2; border: 1px solid #ebe4db; }
    .header { background: #021329; border-bottom: 1px solid #d0a35a; padding: 28px 36px; }
    .content { padding: 36px; color: #1b2637; }
    .btn { display: inline-block; background: #d0a35a; color: #010d20; padding: 14px 28px; text-decoration: none; font-weight: 600; border-radius: 2px; }
    .row { border-bottom: 1px solid #ebe4db; padding: 12px 0; }
    .label { font-size: 11px; font-weight: 600; color: #9f6511; text-transform: uppercase; letter-spacing: 1px; }
    .val { font-size: 14px; font-weight: 500; color: #1b2637; margin-top: 4px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <img src="https://tpyudbsbzrhhngulxyxp.supabase.co/storage/v1/object/public/avatars/branding/logo-gold.png" alt="Leaders Performance" width="140" style="display:block;" />
    </div>
    <div class="content">
      <div style="font-size: 11px; font-weight: 600; color: #9f6511; letter-spacing: 1.5px; text-transform: uppercase; margin-bottom: 8px;">
        CONFIRMED 1-ON-1 STRATEGIC REVIEW
      </div>
      <h2 style="font-family: Georgia, serif; font-size: 26px; color: #021329; margin: 0 0 16px;">
        Your consultation with Lionel Eersteling is confirmed.
      </h2>
      <p style="font-size: 14px; line-height: 22px; color: #4a5568; margin-bottom: 24px;">
        Dear ${escapeHtml(data.participantName)}, your private 1-on-1 strategic review conversation with <strong>Lionel Eersteling</strong> has been scheduled.
      </p>

      <div style="background: #ffffff; border: 1px solid #ebe4db; padding: 20px 24px; margin-bottom: 28px;">
        <div class="row">
          <div class="label">CONFIRMED DATE & TIME</div>
          <div class="val">${escapeHtml(formattedDate)}</div>
        </div>
        <div class="row">
          <div class="label">EXECUTIVE ADVISOR</div>
          <div class="val">Lionel Eersteling</div>
        </div>
        <div class="row">
          <div class="label">SCAN REFERENCE</div>
          <div class="val">${escapeHtml(data.referenceNumber)}</div>
        </div>
        <div class="row" style="border-bottom: none;">
          <div class="label">MEETING ROOM (ZOOM)</div>
          <div class="val"><a href="${escapeHtml(zoomUrl)}" target="_blank" style="color: #9f6511; text-decoration: underline;">${escapeHtml(zoomUrl)}</a></div>
        </div>
      </div>

      <div style="text-align: center; margin-bottom: 30px;">
        <a href="${escapeHtml(zoomUrl)}" target="_blank" class="btn">
          Launch Zoom Meeting&nbsp;&nbsp;&rarr;
        </a>
      </div>

      <div style="background: #ebe4db; border-left: 3px solid #9f6511; padding: 18px 20px; font-size: 13px; line-height: 20px; color: #4a5568;">
        <strong>Preparation Note:</strong> Please ensure your camera and microphone are ready 2 minutes before the session starts. Lionel will review your scan answers beforehand to focus directly on strategic priorities.
      </div>
    </div>
    <div style="background: #010d20; color: #fbf8f2; padding: 18px 36px; font-size: 11px; text-align: left;">
      Leaders Performance · Executive Advisory · Dubai, UAE
    </div>
  </div>
</body>
</html>`;

    const founderContactId = await upsertContact({
      email: data.email,
      firstName: data.participantName.split(' ')[0],
      lastName: data.participantName.split(' ').slice(1).join(' ') || undefined,
      phone: data.phone,
      companyName: data.companyName,
      tags: ['founder-pressure-scan', 'booking-confirmed'],
    });

    if (founderContactId) {
      await sendEmail(founderContactId, founderSubject, founderHtml);
      console.log(`[SUCCESS] Calendar Booking Email Sent to Founder: ${data.email} (Ref: ${data.referenceNumber})`);
    }
  } catch (err: any) {
    console.error('[ERROR] Failed to send Calendar booking email to founder:', err.message);
  }

  // 2. LIONEL'S SIDE CALENDAR ALERT (Sent to lionel@leadersperformance.ae & info@leadersperformance.ae)
  try {
    const staffSubject = `[Calendar Booked] 1-on-1 Session Confirmed: ${data.participantName} — ${data.companyName || 'Enterprise'} (Ref: ${data.referenceNumber})`;
    const staffHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${staffSubject}</title>
  <style>
    body { font-family: 'Inter', Arial, sans-serif; background: #f2ede3; margin: 0; padding: 24px 0; }
    .card { max-width: 600px; margin: 0 auto; background: #fbf8f2; border: 1px solid #ebe4db; }
    .header { background: #021329; border-bottom: 1px solid #d0a35a; padding: 28px 36px; }
    .content { padding: 36px; color: #1b2637; }
    .btn { display: inline-block; background: #d0a35a; color: #010d20; padding: 14px 28px; text-decoration: none; font-weight: 600; border-radius: 2px; }
    .row { border-bottom: 1px solid #ebe4db; padding: 12px 0; }
    .label { font-size: 11px; font-weight: 600; color: #9f6511; text-transform: uppercase; letter-spacing: 1px; }
    .val { font-size: 14px; font-weight: 500; color: #1b2637; margin-top: 4px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <img src="https://tpyudbsbzrhhngulxyxp.supabase.co/storage/v1/object/public/avatars/branding/logo-gold.png" alt="Leaders Performance" width="140" style="display:block;" />
    </div>
    <div class="content">
      <div style="font-size: 11px; font-weight: 600; color: #9f6511; letter-spacing: 1.5px; text-transform: uppercase; margin-bottom: 8px;">
        1-ON-1 CALENDAR RESERVATION CONFIRMED
      </div>
      <h2 style="font-family: Georgia, serif; font-size: 24px; color: #021329; margin: 0 0 16px;">
        New consultation booked on your calendar
      </h2>

      <div style="background: #ffffff; border: 1px solid #ebe4db; padding: 20px 24px; margin-bottom: 28px;">
        <div class="row">
          <div class="label">FOUNDER / PARTICIPANT</div>
          <div class="val">${escapeHtml(data.participantName)}</div>
        </div>
        <div class="row">
          <div class="label">ORGANISATION</div>
          <div class="val">${escapeHtml(data.companyName || 'Confidential')}</div>
        </div>
        <div class="row">
          <div class="label">DIRECT EMAIL & PHONE</div>
          <div class="val">${escapeHtml(data.email)} · ${escapeHtml(data.phone || 'N/A')}</div>
        </div>
        <div class="row">
          <div class="label">BOOKED SESSION TIME</div>
          <div class="val" style="color: #9f6511; font-weight: 600;">${escapeHtml(formattedDate)}</div>
        </div>
        <div class="row">
          <div class="label">SCAN REFERENCE</div>
          <div class="val">${escapeHtml(data.referenceNumber)}</div>
        </div>
        <div class="row" style="border-bottom: none;">
          <div class="label">ZOOM MEETING LINK</div>
          <div class="val"><a href="${escapeHtml(zoomUrl)}" target="_blank" style="color: #9f6511; text-decoration: underline;">${escapeHtml(zoomUrl)}</a></div>
        </div>
      </div>

      <div style="margin-bottom: 24px; padding: 14px 18px; background: #faf7f2; border: 1px solid #d0a35a; border-radius: 2px; text-align: left;">
        <div style="font-size: 11px; font-weight: 600; letter-spacing: 1.5px; text-transform: uppercase; color: #9f6511; margin-bottom: 4px;">
          EXECUTIVE DOSSIER ATTACHED
        </div>
        <div style="font-size: 13.5px; color: #1b2637; line-height: 20px;">
          The complete Founder Pressure Scan Executive Review PDF is attached directly to this email.
        </div>
      </div>
    </div>
    <div style="background: #010d20; color: #fbf8f2; padding: 18px 36px; font-size: 11px; text-align: left;">
      Leaders Performance · Internal Calendar Notification · Staging
    </div>
  </div>
</body>
</html>`;

    const staffEmails = ['lionel@leadersperformance.ae', 'info@leadersperformance.ae'];
    const staffPdfAttachmentUrl = await resolveScanPdfAttachmentUrl(data.referenceNumber);
    const staffAttachments = staffPdfAttachmentUrl ? [staffPdfAttachmentUrl] : undefined;

    for (const email of staffEmails) {
      const staffContactId = await upsertContact({
        email,
        firstName: email.startsWith('lionel') ? 'Lionel' : 'Leaders',
        lastName: email.startsWith('lionel') ? 'Eersteling' : 'Performance',
        tags: ['lp-staff', 'calendar-alert'],
      });
      if (staffContactId) {
        await sendEmail(staffContactId, staffSubject, staffHtml, undefined, staffAttachments);
        console.log(`[SUCCESS] Calendar Alert Sent to Staff with PDF attachment: ${email} (Founder: ${data.participantName}, Ref: ${data.referenceNumber})`);
      }
    }
  } catch (err: any) {
    console.error('[ERROR] Failed to send Calendar alert to Lionel staff:', err.message);
  }
}

