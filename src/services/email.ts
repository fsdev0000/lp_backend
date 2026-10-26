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

export async function resolveScanPdfAttachmentUrl(
  referenceNumber: string,
  audience: 'internal' | 'participant' = 'internal'
): Promise<string | null> {
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

      const pdfBuffer = generatePressureScanPdf(
        {
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
          submittedAt: (submission as any).submittedAt || submission.createdAt,
          reviewStatus: submission.reviewStatus,
          reviewerNotes: submission.reviewerNotes,
          reviewerDecision: submission.reviewerDecision,
          reviewedAt: submission.reviewedAt,
          reviewedBy: submission.reviewedBy,
          zoomMeetingUrl: submission.zoomMeetingUrl,
          scheduledReviewAt: submission.scheduledReviewAt,
        },
        audience
      );

      try {
        const supabase = await getSupabaseClient();
        const suffix = audience === 'participant' ? 'Results' : 'Executive_Dossier';
        const objectPath = `pressure-scans/Founder_Pressure_Scan_${submission.referenceNumber}_${suffix}.pdf`;
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
    return `${backendUrl}/api/v1/scan/review/${encodeURIComponent(cleanRef)}/pdf?audience=${audience}`;
  } catch (err: any) {
    console.warn('[PDF Attachment] Notice resolving scan PDF attachment:', err?.message || err);
    return null;
  }
}

export async function sendAdminBriefing(founderData: AdminBriefingData, adminContactIds: string[]) {
  try {
    const { subject, html, referenceNumber, companyName } = await buildAdminBriefingEmail(founderData);
    const pdfAttachmentUrl = await resolveScanPdfAttachmentUrl(referenceNumber, 'internal');
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

export interface ParticipantScanResultsEmailData {
  participantName: string;
  email: string;
  companyName?: string;
  referenceNumber: string;
  primarySignalArea: string;
  signalClassification?: string;
  contactId?: string;
}

export async function sendParticipantScanResultsEmail(data: ParticipantScanResultsEmailData) {
  try {
    const frontendUrl = process.env.FRONTEND_URL || 'https://staging.leadersperformance.ae';
    const scheduleUrl = `${frontendUrl}/diagnostics?book=${encodeURIComponent(data.referenceNumber)}`;
    const subject = `[Founder Pressure Scan] Your Executive Results Report (Ref: ${data.referenceNumber})`;

    const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(subject)}</title>
  <!--[if mso]>
  <style type="text/css">
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
  </style>
  <![endif]-->
  <style type="text/css">
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Playfair+Display:wght@400;500&display=swap');
    body, table, td, p, a, li, blockquote {
      -webkit-text-size-adjust: 100%;
      -ms-text-size-adjust: 100%;
    }
    img { -ms-interpolation-mode: bicubic; border: 0; outline: none; text-decoration: none; }
    body { margin: 0 !important; padding: 0 !important; width: 100% !important; background-color: #f2ede3; }

    /* Mobile Responsive Rules */
    @media only screen and (max-width: 599px) {
      .email-container {
        width: 100% !important;
        max-width: 100% !important;
      }
      .header-padding {
        padding: 24px 20px !important;
      }
      .content-padding {
        padding: 28px 18px !important;
      }
      .headline-text {
        font-size: 24px !important;
        line-height: 30px !important;
      }
      /* Metadata rows stack vertically on mobile so labels and values never collide */
      .meta-cell-label {
        display: block !important;
        width: 100% !important;
        padding-top: 12px !important;
        padding-bottom: 4px !important;
        padding-right: 0 !important;
        font-size: 11px !important;
        letter-spacing: 1.2px !important;
      }
      .meta-cell-value {
        display: block !important;
        width: 100% !important;
        padding-top: 0 !important;
        padding-bottom: 12px !important;
        padding-left: 0 !important;
        font-size: 14.5px !important;
        line-height: 20px !important;
      }
      .cta-btn {
        display: block !important;
        width: 100% !important;
        box-sizing: border-box !important;
        -webkit-box-sizing: border-box !important;
        text-align: center !important;
        padding: 14px 16px !important;
      }
      .footer-padding {
        padding: 20px 18px !important;
      }
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#f2ede3;font-family:'Inter',Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f2ede3;width:100%;margin:0;padding:32px 0;">
    <tr>
      <td align="center" style="padding:0 12px;">
        <table role="presentation" class="email-container" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#fbf8f2;border:1px solid #ebe4db;border-collapse:separate;margin:0 auto;text-align:left;">
          <!-- Header Banner -->
          <tr>
            <td class="header-padding" style="background-color:#021329;border-bottom:1px solid #d0a35a;padding:34px 40px;">
              <a href="https://leadersperformance.ae" target="_blank" style="text-decoration:none;display:inline-block;">
                <img src="https://tpyudbsbzrhhngulxyxp.supabase.co/storage/v1/object/public/avatars/branding/logo-gold.png" alt="Leaders Performance" width="146" style="display:block;width:146px;height:auto;max-width:146px;border:0;outline:none;" />
              </a>
            </td>
          </tr>

          <!-- Content Body -->
          <tr>
            <td class="content-padding" style="padding:40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;padding-bottom:12px;">
                    FOUNDER PRESSURE SCAN RESULTS
                  </td>
                </tr>
                <tr>
                  <td class="headline-text" style="font-family:'Playfair Display',Georgia,'Times New Roman',serif;font-size:28px;font-weight:400;line-height:34px;color:#1b2637;padding-bottom:12px;">
                    Your Executive Results Report is ready
                  </td>
                </tr>
                <tr>
                  <td style="font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:400;line-height:24px;color:#4a5568;padding-bottom:28px;">
                    Dear ${escapeHtml(data.participantName)}, thank you for completing the Founder Pressure Scan. Your directional diagnostic evaluation has been compiled based on your 10 assessment answers.
                  </td>
                </tr>
              </table>

              <!-- Metadata Section -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #ebe4db;border-collapse:collapse;margin-bottom:28px;">
                <tr style="border-bottom:1px solid #ebe4db;">
                  <td class="meta-cell-label" style="padding:14px 20px 14px 0;width:190px;vertical-align:top;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;">
                    PARTICIPANT
                  </td>
                  <td class="meta-cell-value" style="padding:14px 0;vertical-align:top;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:500;line-height:22px;color:#1b2637;">
                    ${escapeHtml(data.participantName)}
                  </td>
                </tr>
                <tr style="border-bottom:1px solid #ebe4db;">
                  <td class="meta-cell-label" style="padding:14px 20px 14px 0;width:190px;vertical-align:top;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;">
                    ORGANISATION
                  </td>
                  <td class="meta-cell-value" style="padding:14px 0;vertical-align:top;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:500;line-height:22px;color:#1b2637;">
                    ${escapeHtml(data.companyName || 'Confidential')}
                  </td>
                </tr>
                <tr style="border-bottom:1px solid #ebe4db;">
                  <td class="meta-cell-label" style="padding:14px 20px 14px 0;width:190px;vertical-align:top;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;">
                    SCAN REFERENCE
                  </td>
                  <td class="meta-cell-value" style="padding:14px 0;vertical-align:top;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:500;line-height:22px;color:#1b2637;word-break:break-word;">
                    ${escapeHtml(data.referenceNumber)}
                  </td>
                </tr>
                <tr style="border-bottom:1px solid #ebe4db;">
                  <td class="meta-cell-label" style="padding:14px 20px 14px 0;width:190px;vertical-align:top;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;">
                    PRIMARY SIGNAL AREA
                  </td>
                  <td class="meta-cell-value" style="padding:14px 0;vertical-align:top;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:600;line-height:22px;color:#9f6511;">
                    ${escapeHtml(data.primarySignalArea || 'Operational Resilience')}
                  </td>
                </tr>
                ${data.signalClassification ? `
                <tr style="border-bottom:1px solid #ebe4db;">
                  <td class="meta-cell-label" style="padding:14px 20px 14px 0;width:190px;vertical-align:top;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;">
                    SIGNAL LEVEL
                  </td>
                  <td class="meta-cell-value" style="padding:14px 0;vertical-align:top;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:500;line-height:22px;color:#1b2637;">
                    ${escapeHtml(data.signalClassification)}
                  </td>
                </tr>
                ` : ''}
              </table>

              <!-- Callout Box: Executive Results Report Attached -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#faf7f2;border:1px solid #d0a35a;border-radius:2px;margin-bottom:28px;">
                <tr>
                  <td style="padding:16px 20px;">
                    <div style="font-family:'Inter',Arial,sans-serif;font-size:11px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:#9f6511;margin-bottom:4px;">
                      EXECUTIVE RESULTS REPORT ATTACHED
                    </div>
                    <div style="font-family:'Inter',Arial,sans-serif;font-size:13.5px;color:#1b2637;line-height:20px;">
                      Your complete Founder Pressure Scan Results Report PDF is attached directly to this email. It outlines your 5-domain intensity matrix, scaling contextual guidance, and a record of your answers.
                    </div>
                  </td>
                </tr>
              </table>

              <!-- Next Step Invitation -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
                <tr>
                  <td style="font-family:'Inter',Arial,sans-serif;font-size:14px;line-height:22px;color:#4a5568;padding-bottom:18px;">
                    To translate these observations into practical executive decoupling actions, you are invited to schedule a complimentary <strong>30-minute private consultation with Lionel Eersteling</strong>.
                  </td>
                </tr>
                <tr>
                  <td align="center">
                    <a href="${escapeHtml(scheduleUrl)}" target="_blank" class="cta-btn" style="display:inline-block;background-color:#d0a35a;border:1px solid #d0a35a;color:#010d20;text-decoration:none;font-family:'Inter',Arial,sans-serif;font-size:15px;font-weight:600;line-height:22px;padding:14px 32px;text-align:center;border-radius:2px;">
                      Schedule Your Private Review Session &rarr;
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td class="footer-padding" style="background-color:#010d20;border-top:1px solid #d0a35a;padding:22px 40px;color:#fbf8f2;font-family:'Inter',Arial,sans-serif;font-size:12px;line-height:18px;text-align:left;">
              Leaders Performance &middot; Executive Advisory &middot; Dubai, UAE
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    let contactId = data.contactId;
    if (!contactId) {
      contactId = await upsertContact({
        email: data.email,
        firstName: data.participantName.split(' ')[0],
        lastName: data.participantName.split(' ').slice(1).join(' ') || undefined,
        companyName: data.companyName,
        tags: ['founder-pressure-scan', 'results-delivered'],
      });
    }

    if (contactId) {
      const pdfAttachmentUrl = await resolveScanPdfAttachmentUrl(data.referenceNumber, 'participant');
      const attachments = pdfAttachmentUrl ? [pdfAttachmentUrl] : undefined;
      await sendEmail(contactId, subject, html, undefined, attachments);
      console.log(`[SUCCESS] Participant Results Email Sent with PDF to: ${data.email} (Ref: ${data.referenceNumber})`);
    }
  } catch (err: any) {
    console.error('[ERROR] Failed to send Participant Results email:', err.message || err);
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
    const founderHtml = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${founderSubject}</title>
</head>
<body style="margin:0;padding:0;background-color:#f2ede3;font-family:'Inter',Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f2ede3;width:100%;margin:0;padding:32px 0;">
    <tr>
      <td align="center" style="padding:0 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#fbf8f2;border:1px solid #ebe4db;border-collapse:separate;margin:0 auto;text-align:left;">
          <!-- Header Banner -->
          <tr>
            <td style="background-color:#021329;border-bottom:1px solid #d0a35a;padding:34px 40px;">
              <a href="https://leadersperformance.ae" target="_blank" style="text-decoration:none;display:inline-block;">
                <img src="https://tpyudbsbzrhhngulxyxp.supabase.co/storage/v1/object/public/avatars/branding/logo-gold.png" alt="Leaders Performance" width="146" style="display:block;width:146px;height:auto;max-width:146px;border:0;outline:none;" />
              </a>
            </td>
          </tr>

          <!-- Content Body -->
          <tr>
            <td style="padding:40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;padding-bottom:12px;">
                    CONFIRMED 1-ON-1 STRATEGIC REVIEW
                  </td>
                </tr>
                <tr>
                  <td style="font-family:'Playfair Display',Georgia,'Times New Roman',serif;font-size:28px;font-weight:400;line-height:34px;color:#1b2637;padding-bottom:12px;">
                    Your consultation with Lionel Eersteling is confirmed.
                  </td>
                </tr>
                <tr>
                  <td style="font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:400;line-height:24px;color:#4a5568;padding-bottom:28px;">
                    Dear ${escapeHtml(data.participantName)}, your private 30-minute strategic review conversation with <strong>Lionel Eersteling</strong> has been scheduled.
                  </td>
                </tr>
              </table>

              <!-- Metadata Section -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #ebe4db;border-collapse:collapse;margin-bottom:28px;">
                <tr style="border-bottom:1px solid #ebe4db;">
                  <td style="padding:15px 0;width:170px;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;">
                    CONFIRMED DATE &amp; TIME
                  </td>
                  <td style="padding:15px 0;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:600;line-height:22px;color:#9f6511;">
                    ${escapeHtml(formattedDate)}
                  </td>
                </tr>
                <tr style="border-bottom:1px solid #ebe4db;">
                  <td style="padding:15px 0;width:170px;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;">
                    EXECUTIVE ADVISOR
                  </td>
                  <td style="padding:15px 0;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:500;line-height:22px;color:#1b2637;">
                    Lionel Eersteling
                  </td>
                </tr>
                <tr style="border-bottom:1px solid #ebe4db;">
                  <td style="padding:15px 0;width:170px;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;">
                    SCAN REFERENCE
                  </td>
                  <td style="padding:15px 0;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:500;line-height:22px;color:#1b2637;">
                    ${escapeHtml(data.referenceNumber)}
                  </td>
                </tr>
                <tr style="border-bottom:1px solid #ebe4db;">
                  <td style="padding:15px 0;width:170px;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;">
                    MEETING ROOM (ZOOM)
                  </td>
                  <td style="padding:15px 0;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:14px;font-weight:500;line-height:20px;color:#1b2637;">
                    <a href="${escapeHtml(zoomUrl)}" target="_blank" style="color:#9f6511;text-decoration:underline;word-break:break-all;">${escapeHtml(zoomUrl)}</a>
                  </td>
                </tr>
              </table>

              <!-- CTA Button -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
                <tr>
                  <td align="center">
                    <a href="${escapeHtml(zoomUrl)}" target="_blank" style="display:inline-block;background-color:#d0a35a;border:1px solid #d0a35a;color:#010d20;text-decoration:none;font-family:'Inter',Arial,sans-serif;font-size:15px;font-weight:600;line-height:22px;padding:14px 32px;text-align:center;border-radius:2px;">
                      Launch Zoom Meeting Room &rarr;
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Callout Box: Executive Results Report Attached -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#faf7f2;border:1px solid #d0a35a;border-radius:2px;margin-bottom:28px;">
                <tr>
                  <td style="padding:16px 20px;">
                    <div style="font-family:'Inter',Arial,sans-serif;font-size:11px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:#9f6511;margin-bottom:4px;">
                      EXECUTIVE RESULTS REPORT ATTACHED
                    </div>
                    <div style="font-family:'Inter',Arial,sans-serif;font-size:13.5px;color:#1b2637;line-height:20px;">
                      Your complete Founder Pressure Scan Results Report PDF (updated with your confirmed consultation date and Zoom access coordinates) is attached directly to this email.
                    </div>
                  </td>
                </tr>
              </table>

              <!-- Preparation Note -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#faf7f2;border-left:3px solid #9f6511;border-top:1px solid #ebe4db;border-right:1px solid #ebe4db;border-bottom:1px solid #ebe4db;padding:16px 20px;">
                <tr>
                  <td style="font-family:'Inter',Arial,sans-serif;font-size:13px;line-height:20px;color:#4a5568;">
                    <strong style="color:#1b2637;">Preparation Note:</strong> Please ensure your camera and microphone are ready 2 minutes before the session starts. Lionel will review your scan answers beforehand to focus directly on strategic priorities.
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#010d20;border-top:1px solid #d0a35a;padding:22px 40px;color:#fbf8f2;font-family:'Inter',Arial,sans-serif;font-size:12px;line-height:18px;text-align:left;">
              Leaders Performance &middot; Executive Advisory &middot; Dubai, UAE
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
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
      const founderPdfAttachmentUrl = await resolveScanPdfAttachmentUrl(data.referenceNumber, 'participant');
      const founderAttachments = founderPdfAttachmentUrl ? [founderPdfAttachmentUrl] : undefined;
      await sendEmail(founderContactId, founderSubject, founderHtml, undefined, founderAttachments);
      console.log(`[SUCCESS] Calendar Booking Email Sent to Founder with PDF attachment: ${data.email} (Ref: ${data.referenceNumber})`);
    }
  } catch (err: any) {
    console.error('[ERROR] Failed to send Calendar booking email to founder:', err.message);
  }

  // 2. LIONEL'S SIDE CALENDAR ALERT (Sent to lionel@leadersperformance.ae & info@leadersperformance.ae)
  try {
    const staffSubject = `[Calendar Booked] 1-on-1 Session Confirmed: ${data.participantName} — ${data.companyName || 'Enterprise'} (Ref: ${data.referenceNumber})`;
    const staffHtml = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${staffSubject}</title>
</head>
<body style="margin:0;padding:0;background-color:#f2ede3;font-family:'Inter',Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f2ede3;width:100%;margin:0;padding:32px 0;">
    <tr>
      <td align="center" style="padding:0 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#fbf8f2;border:1px solid #ebe4db;border-collapse:separate;margin:0 auto;text-align:left;">
          <!-- Header Banner -->
          <tr>
            <td style="background-color:#021329;border-bottom:1px solid #d0a35a;padding:34px 40px;">
              <a href="https://leadersperformance.ae" target="_blank" style="text-decoration:none;display:inline-block;">
                <img src="https://tpyudbsbzrhhngulxyxp.supabase.co/storage/v1/object/public/avatars/branding/logo-gold.png" alt="Leaders Performance" width="146" style="display:block;width:146px;height:auto;max-width:146px;border:0;outline:none;" />
              </a>
            </td>
          </tr>

          <!-- Content Body -->
          <tr>
            <td style="padding:40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;padding-bottom:12px;">
                    1-ON-1 CALENDAR RESERVATION CONFIRMED
                  </td>
                </tr>
                <tr>
                  <td style="font-family:'Playfair Display',Georgia,'Times New Roman',serif;font-size:28px;font-weight:400;line-height:34px;color:#1b2637;padding-bottom:12px;">
                    New consultation booked on your calendar
                  </td>
                </tr>
                <tr>
                  <td style="font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:400;line-height:24px;color:#4a5568;padding-bottom:28px;">
                    A founder has scheduled their 30-minute private executive review session.
                  </td>
                </tr>
              </table>

              <!-- Metadata Section -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #ebe4db;border-collapse:collapse;margin-bottom:28px;">
                <tr style="border-bottom:1px solid #ebe4db;">
                  <td style="padding:15px 0;width:170px;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;">
                    FOUNDER / PARTICIPANT
                  </td>
                  <td style="padding:15px 0;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:500;line-height:22px;color:#1b2637;">
                    ${escapeHtml(data.participantName)}
                  </td>
                </tr>
                <tr style="border-bottom:1px solid #ebe4db;">
                  <td style="padding:15px 0;width:170px;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;">
                    ORGANISATION
                  </td>
                  <td style="padding:15px 0;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:500;line-height:22px;color:#1b2637;">
                    ${escapeHtml(data.companyName || 'Confidential')}
                  </td>
                </tr>
                <tr style="border-bottom:1px solid #ebe4db;">
                  <td style="padding:15px 0;width:170px;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;">
                    DIRECT EMAIL &amp; PHONE
                  </td>
                  <td style="padding:15px 0;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:500;line-height:22px;color:#1b2637;">
                    ${escapeHtml(data.email)} &middot; ${escapeHtml(data.phone || '—')}
                  </td>
                </tr>
                <tr style="border-bottom:1px solid #ebe4db;">
                  <td style="padding:15px 0;width:170px;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;">
                    BOOKED SESSION TIME
                  </td>
                  <td style="padding:15px 0;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:600;line-height:22px;color:#9f6511;">
                    ${escapeHtml(formattedDate)}
                  </td>
                </tr>
                <tr style="border-bottom:1px solid #ebe4db;">
                  <td style="padding:15px 0;width:170px;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;">
                    SCAN REFERENCE
                  </td>
                  <td style="padding:15px 0;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:500;line-height:22px;color:#1b2637;">
                    ${escapeHtml(data.referenceNumber)}
                  </td>
                </tr>
                <tr style="border-bottom:1px solid #ebe4db;">
                  <td style="padding:15px 0;width:170px;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;">
                    ZOOM MEETING LINK
                  </td>
                  <td style="padding:15px 0;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:14px;font-weight:500;line-height:20px;color:#1b2637;">
                    <a href="${escapeHtml(zoomUrl)}" target="_blank" style="color:#9f6511;text-decoration:underline;word-break:break-all;">${escapeHtml(zoomUrl)}</a>
                  </td>
                </tr>
              </table>

              <!-- Callout Box: Executive Dossier Attached -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#faf7f2;border:1px solid #d0a35a;border-radius:2px;margin-bottom:28px;">
                <tr>
                  <td style="padding:16px 20px;">
                    <div style="font-family:'Inter',Arial,sans-serif;font-size:11px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:#9f6511;margin-bottom:4px;">
                      EXECUTIVE DOSSIER ATTACHED
                    </div>
                    <div style="font-family:'Inter',Arial,sans-serif;font-size:13.5px;color:#1b2637;line-height:20px;">
                      The complete Founder Pressure Scan Executive Review PDF (dossier with full 10-question breakdown, domain scores, and founder profile) is attached directly to this email.
                    </div>
                  </td>
                </tr>
              </table>

              <!-- CTA Button -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center">
                    <a href="${escapeHtml(zoomUrl)}" target="_blank" style="display:inline-block;background-color:#d0a35a;border:1px solid #d0a35a;color:#010d20;text-decoration:none;font-family:'Inter',Arial,sans-serif;font-size:15px;font-weight:600;line-height:22px;padding:14px 32px;text-align:center;border-radius:2px;">
                      Launch Zoom Meeting Room &rarr;
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#010d20;border-top:1px solid #d0a35a;padding:22px 40px;color:#fbf8f2;font-family:'Inter',Arial,sans-serif;font-size:12px;line-height:18px;text-align:left;">
              Leaders Performance &middot; Internal Calendar Notification &middot; Executive Advisory
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
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

export interface BookingReminderEmailData {
  participantName: string;
  email: string;
  phone?: string;
  companyName?: string;
  dateTimeStr: string;
  referenceNumber: string;
  zoomMeetingUrl?: string;
}

/**
 * 24-Hour (1 Day Prior) Appointment Reminder Email with Participant Results PDF
 */
export async function sendBookingReminder24hEmail(data: BookingReminderEmailData) {
  try {
    const zoomUrl = data.zoomMeetingUrl || process.env.REVIEW_MEETING_URL || 'https://zoom.us/j/7114427991?pwd=leadersperformance';
    let formattedDate = data.dateTimeStr;
    try {
      const d = new Date(data.dateTimeStr);
      formattedDate = d.toLocaleString('en-GB', {
        dateStyle: 'full',
        timeStyle: 'short',
        timeZone: 'Asia/Dubai',
      }) + ' (Dubai GST)';
    } catch (_) {}

    const subject = `[Reminder] Your 1-on-1 Strategic Review with Lionel Eersteling Tomorrow (Ref: ${data.referenceNumber})`;
    const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f2ede3;font-family:'Inter',Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f2ede3;width:100%;margin:0;padding:32px 0;">
    <tr>
      <td align="center" style="padding:0 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#fbf8f2;border:1px solid #ebe4db;border-collapse:separate;margin:0 auto;text-align:left;">
          <!-- Header Banner -->
          <tr>
            <td style="background-color:#021329;border-bottom:1px solid #d0a35a;padding:34px 40px;">
              <a href="https://leadersperformance.ae" target="_blank" style="text-decoration:none;display:inline-block;">
                <img src="https://tpyudbsbzrhhngulxyxp.supabase.co/storage/v1/object/public/avatars/branding/logo-gold.png" alt="Leaders Performance" width="146" style="display:block;width:146px;height:auto;max-width:146px;border:0;outline:none;" />
              </a>
            </td>
          </tr>

          <!-- Content Body -->
          <tr>
            <td style="padding:40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;padding-bottom:12px;">
                    APPOINTMENT REMINDER &middot; 24 HOURS PRIOR
                  </td>
                </tr>
                <tr>
                  <td style="font-family:'Playfair Display',Georgia,'Times New Roman',serif;font-size:28px;font-weight:400;line-height:34px;color:#1b2637;padding-bottom:12px;">
                    Your consultation with Lionel Eersteling is tomorrow
                  </td>
                </tr>
                <tr>
                  <td style="font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:400;line-height:24px;color:#4a5568;padding-bottom:28px;">
                    Dear ${escapeHtml(data.participantName)}, this is a brief reminder that your private 30-minute strategic review conversation with <strong>Lionel Eersteling</strong> is scheduled for tomorrow.
                  </td>
                </tr>
              </table>

              <!-- Metadata Section -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #ebe4db;border-collapse:collapse;margin-bottom:28px;">
                <tr style="border-bottom:1px solid #ebe4db;">
                  <td style="padding:15px 0;width:170px;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;">
                    CONFIRMED DATE &amp; TIME
                  </td>
                  <td style="padding:15px 0;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:600;line-height:22px;color:#9f6511;">
                    ${escapeHtml(formattedDate)}
                  </td>
                </tr>
                <tr style="border-bottom:1px solid #ebe4db;">
                  <td style="padding:15px 0;width:170px;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;">
                    EXECUTIVE ADVISOR
                  </td>
                  <td style="padding:15px 0;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:500;line-height:22px;color:#1b2637;">
                    Lionel Eersteling
                  </td>
                </tr>
                <tr style="border-bottom:1px solid #ebe4db;">
                  <td style="padding:15px 0;width:170px;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;">
                    SCAN REFERENCE
                  </td>
                  <td style="padding:15px 0;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:500;line-height:22px;color:#1b2637;">
                    ${escapeHtml(data.referenceNumber)}
                  </td>
                </tr>
                <tr style="border-bottom:1px solid #ebe4db;">
                  <td style="padding:15px 0;width:170px;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;">
                    MEETING ROOM (ZOOM)
                  </td>
                  <td style="padding:15px 0;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:14px;font-weight:500;line-height:20px;color:#1b2637;">
                    <a href="${escapeHtml(zoomUrl)}" target="_blank" style="color:#9f6511;text-decoration:underline;word-break:break-all;">${escapeHtml(zoomUrl)}</a>
                  </td>
                </tr>
              </table>

              <!-- CTA Button -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
                <tr>
                  <td align="center">
                    <a href="${escapeHtml(zoomUrl)}" target="_blank" style="display:inline-block;background-color:#d0a35a;border:1px solid #d0a35a;color:#010d20;text-decoration:none;font-family:'Inter',Arial,sans-serif;font-size:15px;font-weight:600;line-height:22px;padding:14px 32px;text-align:center;border-radius:2px;">
                      Launch Zoom Meeting Room &rarr;
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Callout Box: Executive Results Report Attached -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#faf7f2;border:1px solid #d0a35a;border-radius:2px;margin-bottom:28px;">
                <tr>
                  <td style="padding:16px 20px;">
                    <div style="font-family:'Inter',Arial,sans-serif;font-size:11px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:#9f6511;margin-bottom:4px;">
                      EXECUTIVE RESULTS REPORT ATTACHED
                    </div>
                    <div style="font-family:'Inter',Arial,sans-serif;font-size:13.5px;color:#1b2637;line-height:20px;">
                      Your complete Founder Pressure Scan Results Report PDF is attached directly to this email so you can review your 5-domain evaluation prior to tomorrow's conversation.
                    </div>
                  </td>
                </tr>
              </table>

              <!-- Preparation Note -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#faf7f2;border-left:3px solid #9f6511;border-top:1px solid #ebe4db;border-right:1px solid #ebe4db;border-bottom:1px solid #ebe4db;padding:16px 20px;">
                <tr>
                  <td style="font-family:'Inter',Arial,sans-serif;font-size:13px;line-height:20px;color:#4a5568;">
                    <strong style="color:#1b2637;">Preparation Note:</strong> Please ensure your camera and audio are set up 2 minutes prior. Lionel will review your scan answers beforehand to focus directly on strategic priorities.
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#010d20;border-top:1px solid #d0a35a;padding:22px 40px;color:#fbf8f2;font-family:'Inter',Arial,sans-serif;font-size:12px;line-height:18px;text-align:left;">
              Leaders Performance &middot; Executive Advisory &middot; Dubai, UAE
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    const contactId = await upsertContact({
      email: data.email,
      firstName: data.participantName.split(' ')[0],
      lastName: data.participantName.split(' ').slice(1).join(' ') || undefined,
      phone: data.phone,
      companyName: data.companyName,
      tags: ['founder-pressure-scan', 'reminder-24h'],
    });

    if (contactId) {
      const pdfAttachmentUrl = await resolveScanPdfAttachmentUrl(data.referenceNumber, 'participant');
      const attachments = pdfAttachmentUrl ? [pdfAttachmentUrl] : undefined;
      await sendEmail(contactId, subject, html, undefined, attachments);
      console.log(`[SUCCESS] 24-Hour Reminder Email Sent with PDF to: ${data.email} (Ref: ${data.referenceNumber})`);
      return true;
    }
    return false;
  } catch (err: any) {
    console.error('[ERROR] Failed to send 24-hour reminder email:', err.message || err);
    throw err;
  }
}

/**
 * 2-Hour Appointment Reminder Email with Participant Results PDF
 */
export async function sendBookingReminder2hEmail(data: BookingReminderEmailData) {
  try {
    const zoomUrl = data.zoomMeetingUrl || process.env.REVIEW_MEETING_URL || 'https://zoom.us/j/7114427991?pwd=leadersperformance';
    let formattedDate = data.dateTimeStr;
    try {
      const d = new Date(data.dateTimeStr);
      formattedDate = d.toLocaleString('en-GB', {
        dateStyle: 'full',
        timeStyle: 'short',
        timeZone: 'Asia/Dubai',
      }) + ' (Dubai GST)';
    } catch (_) {}

    const subject = `[Starting in 2 Hours] Your 1-on-1 Strategic Review with Lionel Eersteling (Ref: ${data.referenceNumber})`;
    const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f2ede3;font-family:'Inter',Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f2ede3;width:100%;margin:0;padding:32px 0;">
    <tr>
      <td align="center" style="padding:0 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#fbf8f2;border:1px solid #ebe4db;border-collapse:separate;margin:0 auto;text-align:left;">
          <!-- Header Banner -->
          <tr>
            <td style="background-color:#021329;border-bottom:1px solid #d0a35a;padding:34px 40px;">
              <a href="https://leadersperformance.ae" target="_blank" style="text-decoration:none;display:inline-block;">
                <img src="https://tpyudbsbzrhhngulxyxp.supabase.co/storage/v1/object/public/avatars/branding/logo-gold.png" alt="Leaders Performance" width="146" style="display:block;width:146px;height:auto;max-width:146px;border:0;outline:none;" />
              </a>
            </td>
          </tr>

          <!-- Content Body -->
          <tr>
            <td style="padding:40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;padding-bottom:12px;">
                    URGENT REMINDER &middot; STARTING IN 2 HOURS
                  </td>
                </tr>
                <tr>
                  <td style="font-family:'Playfair Display',Georgia,'Times New Roman',serif;font-size:28px;font-weight:400;line-height:34px;color:#1b2637;padding-bottom:12px;">
                    Your consultation begins in 2 hours
                  </td>
                </tr>
                <tr>
                  <td style="font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:400;line-height:24px;color:#4a5568;padding-bottom:28px;">
                    Dear ${escapeHtml(data.participantName)}, your private 30-minute strategic review conversation with <strong>Lionel Eersteling</strong> begins shortly.
                  </td>
                </tr>
              </table>

              <!-- Prominent Join Button -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
                <tr>
                  <td align="center">
                    <a href="${escapeHtml(zoomUrl)}" target="_blank" style="display:inline-block;background-color:#d0a35a;border:1px solid #d0a35a;color:#010d20;text-decoration:none;font-family:'Inter',Arial,sans-serif;font-size:16px;font-weight:600;line-height:24px;padding:16px 36px;text-align:center;border-radius:2px;box-shadow:0 2px 8px rgba(208,163,90,0.3);">
                      Join Zoom Meeting Room Now &rarr;
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Metadata Section -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #ebe4db;border-collapse:collapse;margin-bottom:28px;">
                <tr style="border-bottom:1px solid #ebe4db;">
                  <td style="padding:15px 0;width:170px;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;">
                    SESSION START TIME
                  </td>
                  <td style="padding:15px 0;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:600;line-height:22px;color:#9f6511;">
                    ${escapeHtml(formattedDate)}
                  </td>
                </tr>
                <tr style="border-bottom:1px solid #ebe4db;">
                  <td style="padding:15px 0;width:170px;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;">
                    EXECUTIVE ADVISOR
                  </td>
                  <td style="padding:15px 0;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:500;line-height:22px;color:#1b2637;">
                    Lionel Eersteling
                  </td>
                </tr>
                <tr style="border-bottom:1px solid #ebe4db;">
                  <td style="padding:15px 0;width:170px;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;">
                    DIRECT ZOOM LINK
                  </td>
                  <td style="padding:15px 0;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:14px;font-weight:500;line-height:20px;color:#1b2637;">
                    <a href="${escapeHtml(zoomUrl)}" target="_blank" style="color:#9f6511;text-decoration:underline;word-break:break-all;">${escapeHtml(zoomUrl)}</a>
                  </td>
                </tr>
              </table>

              <!-- Callout Box: Executive Results Report Attached -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#faf7f2;border:1px solid #d0a35a;border-radius:2px;margin-bottom:28px;">
                <tr>
                  <td style="padding:16px 20px;">
                    <div style="font-family:'Inter',Arial,sans-serif;font-size:11px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:#9f6511;margin-bottom:4px;">
                      EXECUTIVE RESULTS REPORT ATTACHED
                    </div>
                    <div style="font-family:'Inter',Arial,sans-serif;font-size:13.5px;color:#1b2637;line-height:20px;">
                      Your personalized Founder Pressure Scan Results Report PDF is attached for immediate reference during your consultation.
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#010d20;border-top:1px solid #d0a35a;padding:22px 40px;color:#fbf8f2;font-family:'Inter',Arial,sans-serif;font-size:12px;line-height:18px;text-align:left;">
              Leaders Performance &middot; Executive Advisory &middot; Dubai, UAE
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    const contactId = await upsertContact({
      email: data.email,
      firstName: data.participantName.split(' ')[0],
      lastName: data.participantName.split(' ').slice(1).join(' ') || undefined,
      phone: data.phone,
      companyName: data.companyName,
      tags: ['founder-pressure-scan', 'reminder-2h'],
    });

    if (contactId) {
      const pdfAttachmentUrl = await resolveScanPdfAttachmentUrl(data.referenceNumber, 'participant');
      const attachments = pdfAttachmentUrl ? [pdfAttachmentUrl] : undefined;
      await sendEmail(contactId, subject, html, undefined, attachments);
      console.log(`[SUCCESS] 2-Hour Reminder Email Sent with PDF to: ${data.email} (Ref: ${data.referenceNumber})`);
      return true;
    }
    return false;
  } catch (err: any) {
    console.error('[ERROR] Failed to send 2-hour reminder email:', err.message || err);
    return false;
  }
}

/**
 * 1-Hour Appointment Reminder Email with Participant Results PDF
 */
export async function sendBookingReminder1hEmail(data: BookingReminderEmailData): Promise<boolean> {
  try {
    const zoomUrl = data.zoomMeetingUrl || process.env.REVIEW_MEETING_URL || 'https://zoom.us/j/7114427991?pwd=leadersperformance';
    let formattedDate = data.dateTimeStr;
    try {
      const d = new Date(data.dateTimeStr);
      formattedDate = d.toLocaleString('en-GB', {
        dateStyle: 'full',
        timeStyle: 'short',
        timeZone: 'Asia/Dubai',
      }) + ' (Dubai GST)';
    } catch (_) {}

    const subject = `[Starting in 1 Hour] Your 1-on-1 Strategic Review with Lionel Eersteling (Ref: ${data.referenceNumber})`;
    const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f2ede3;font-family:'Inter',Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f2ede3;width:100%;margin:0;padding:32px 0;">
    <tr>
      <td align="center" style="padding:0 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#fbf8f2;border:1px solid #ebe4db;border-collapse:separate;margin:0 auto;text-align:left;">
          <!-- Header Banner -->
          <tr>
            <td style="background-color:#021329;border-bottom:1px solid #d0a35a;padding:34px 40px;">
              <a href="https://leadersperformance.ae" target="_blank" style="text-decoration:none;display:inline-block;">
                <img src="https://tpyudbsbzrhhngulxyxp.supabase.co/storage/v1/object/public/avatars/branding/logo-gold.png" alt="Leaders Performance" width="146" style="display:block;width:146px;height:auto;max-width:146px;border:0;outline:none;" />
              </a>
            </td>
          </tr>

          <!-- Content Body -->
          <tr>
            <td style="padding:40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;padding-bottom:12px;">
                    URGENT REMINDER &middot; STARTING IN 1 HOUR
                  </td>
                </tr>
                <tr>
                  <td style="font-family:'Playfair Display',Georgia,'Times New Roman',serif;font-size:28px;font-weight:400;line-height:34px;color:#1b2637;padding-bottom:12px;">
                    Your consultation begins in 1 hour
                  </td>
                </tr>
                <tr>
                  <td style="font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:400;line-height:24px;color:#4a5568;padding-bottom:28px;">
                    Dear ${escapeHtml(data.participantName)}, your private 30-minute strategic review conversation with <strong>Lionel Eersteling</strong> begins in 1 hour.
                  </td>
                </tr>
              </table>

              <!-- Prominent Join Button -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
                <tr>
                  <td align="center">
                    <a href="${escapeHtml(zoomUrl)}" target="_blank" style="display:inline-block;background-color:#d0a35a;border:1px solid #d0a35a;color:#010d20;text-decoration:none;font-family:'Inter',Arial,sans-serif;font-size:16px;font-weight:600;line-height:24px;padding:16px 36px;text-align:center;border-radius:2px;box-shadow:0 2px 8px rgba(208,163,90,0.3);">
                      Join Zoom Meeting Room Now &rarr;
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Metadata Section -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #ebe4db;border-collapse:collapse;margin-bottom:28px;">
                <tr style="border-bottom:1px solid #ebe4db;">
                  <td style="padding:15px 0;width:170px;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;">
                    SESSION START TIME
                  </td>
                  <td style="padding:15px 0;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:600;line-height:22px;color:#9f6511;">
                    ${escapeHtml(formattedDate)}
                  </td>
                </tr>
                <tr style="border-bottom:1px solid #ebe4db;">
                  <td style="padding:15px 0;width:170px;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;">
                    EXECUTIVE ADVISOR
                  </td>
                  <td style="padding:15px 0;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:500;line-height:22px;color:#1b2637;">
                    Lionel Eersteling
                  </td>
                </tr>
                <tr style="border-bottom:1px solid #ebe4db;">
                  <td style="padding:15px 0;width:170px;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;">
                    DIRECT ZOOM LINK
                  </td>
                  <td style="padding:15px 0;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:14px;font-weight:500;line-height:20px;color:#1b2637;">
                    <a href="${escapeHtml(zoomUrl)}" target="_blank" style="color:#9f6511;text-decoration:underline;word-break:break-all;">${escapeHtml(zoomUrl)}</a>
                  </td>
                </tr>
              </table>

              <!-- Callout Box: Executive Results Report Attached -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#faf7f2;border:1px solid #d0a35a;border-radius:2px;margin-bottom:28px;">
                <tr>
                  <td style="padding:16px 20px;">
                    <div style="font-family:'Inter',Arial,sans-serif;font-size:11px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:#9f6511;margin-bottom:4px;">
                      EXECUTIVE RESULTS REPORT ATTACHED
                    </div>
                    <div style="font-family:'Inter',Arial,sans-serif;font-size:13.5px;color:#1b2637;line-height:20px;">
                      Your personalized Founder Pressure Scan Results Report PDF is attached for immediate reference during your consultation.
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#010d20;border-top:1px solid #d0a35a;padding:22px 40px;color:#fbf8f2;font-family:'Inter',Arial,sans-serif;font-size:12px;line-height:18px;text-align:left;">
              Leaders Performance &middot; Executive Advisory &middot; Dubai, UAE
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    let contactId = undefined;
    try {
      contactId = await upsertContact({
        email: data.email,
        firstName: data.participantName.split(' ')[0],
        lastName: data.participantName.split(' ').slice(1).join(' ') || undefined,
        phone: data.phone,
        companyName: data.companyName,
        tags: ['founder-pressure-scan', 'reminder-1h'],
      });
    } catch (_) {}

    if (contactId) {
      const pdfAttachmentUrl = await resolveScanPdfAttachmentUrl(data.referenceNumber, 'participant');
      const attachments = pdfAttachmentUrl ? [pdfAttachmentUrl] : undefined;
      await sendEmail(contactId, subject, html, undefined, attachments);
      console.log(`[SUCCESS] 1-Hour Reminder Email Sent with PDF to: ${data.email} (Ref: ${data.referenceNumber})`);
      return true;
    }
    return false;
  } catch (err: any) {
    console.error('[ERROR] Failed to send 1-hour reminder email:', err.message || err);
    throw err;
  }
}

export interface FollowupEmailData {
  participantName: string;
  email: string;
  companyName?: string;
  referenceNumber: string;
  primarySignalArea?: string;
  contactId?: string;
}

/**
 * First Follow-up Email: 2 days (48 hours) after scan submission if no call booked
 */
export function buildScanFollowup1Email(data: FollowupEmailData): { subject: string; html: string } {
  const frontendUrl = process.env.FRONTEND_URL || 'https://staging.leadersperformance.ae';
  const scheduleUrl = `${frontendUrl}/diagnostics?book=${encodeURIComponent(data.referenceNumber)}`;
  const primarySignal = data.primarySignalArea || 'Operational Resilience';
  const subject = `[Founder Pressure Scan] Reviewing your scan results & next steps (Ref: ${data.referenceNumber})`;

  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f2ede3;font-family:'Inter',Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f2ede3;width:100%;margin:0;padding:32px 0;">
    <tr>
      <td align="center" style="padding:0 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#fbf8f2;border:1px solid #ebe4db;border-collapse:separate;margin:0 auto;text-align:left;">
          <!-- Header Banner -->
          <tr>
            <td style="background-color:#021329;border-bottom:1px solid #d0a35a;padding:34px 40px;">
              <a href="https://leadersperformance.ae" target="_blank" style="text-decoration:none;display:inline-block;">
                <img src="https://tpyudbsbzrhhngulxyxp.supabase.co/storage/v1/object/public/avatars/branding/logo-gold.png" alt="Leaders Performance" width="146" style="display:block;width:146px;height:auto;max-width:146px;border:0;outline:none;" />
              </a>
            </td>
          </tr>

          <!-- Content Body -->
          <tr>
            <td style="padding:40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;padding-bottom:12px;">
                    FOUNDER PRESSURE SCAN &middot; 48-HOUR STRATEGIC FOLLOW-UP
                  </td>
                </tr>
                <tr>
                  <td style="font-family:'Playfair Display',Georgia,'Times New Roman',serif;font-size:28px;font-weight:400;line-height:34px;color:#1b2637;padding-bottom:12px;">
                    Translating your diagnostic signals into operational velocity
                  </td>
                </tr>
                <tr>
                  <td style="font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:400;line-height:24px;color:#4a5568;padding-bottom:24px;">
                    Dear ${escapeHtml(data.participantName)}, two days ago you completed the Founder Pressure Scan. Your directional diagnostic evaluation identified <strong>${escapeHtml(primarySignal)}</strong> as your primary structural signal area.
                  </td>
                </tr>
                <tr>
                  <td style="font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:400;line-height:24px;color:#4a5568;padding-bottom:28px;">
                    Translating diagnostic clarity into sustainable founder decoupling requires examining where organizational dependencies continue to flow through your desk. We invite you to schedule your private 30-minute review consultation with <strong>Lionel Eersteling</strong> to unpack these findings.
                  </td>
                </tr>
              </table>

              <!-- Metadata Section -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #ebe4db;border-collapse:collapse;margin-bottom:28px;">
                <tr style="border-bottom:1px solid #ebe4db;">
                  <td style="padding:15px 0;width:170px;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;">
                    PARTICIPANT
                  </td>
                  <td style="padding:15px 0;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:500;line-height:22px;color:#1b2637;">
                    ${escapeHtml(data.participantName)}
                  </td>
                </tr>
                <tr style="border-bottom:1px solid #ebe4db;">
                  <td style="padding:15px 0;width:170px;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;">
                    ORGANISATION
                  </td>
                  <td style="padding:15px 0;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:500;line-height:22px;color:#1b2637;">
                    ${escapeHtml(data.companyName || 'Confidential')}
                  </td>
                </tr>
                <tr style="border-bottom:1px solid #ebe4db;">
                  <td style="padding:15px 0;width:170px;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;">
                    SCAN REFERENCE
                  </td>
                  <td style="padding:15px 0;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:500;line-height:22px;color:#1b2637;">
                    ${escapeHtml(data.referenceNumber)}
                  </td>
                </tr>
                <tr style="border-bottom:1px solid #ebe4db;">
                  <td style="padding:15px 0;width:170px;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;">
                    PRIMARY SIGNAL
                  </td>
                  <td style="padding:15px 0;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:600;line-height:22px;color:#9f6511;">
                    ${escapeHtml(primarySignal)}
                  </td>
                </tr>
              </table>

              <!-- CTA Button -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
                <tr>
                  <td align="center">
                    <a href="${escapeHtml(scheduleUrl)}" target="_blank" style="display:inline-block;background-color:#d0a35a;border:1px solid #d0a35a;color:#010d20;text-decoration:none;font-family:'Inter',Arial,sans-serif;font-size:15px;font-weight:600;line-height:22px;padding:14px 32px;text-align:center;border-radius:2px;">
                      Schedule Your Private Review Session &rarr;
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Advisory Note -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#faf7f2;border-left:3px solid #9f6511;border-top:1px solid #ebe4db;border-right:1px solid #ebe4db;border-bottom:1px solid #ebe4db;padding:16px 20px;">
                <tr>
                  <td style="font-family:'Inter',Arial,sans-serif;font-size:13px;line-height:20px;color:#4a5568;">
                    <strong style="color:#1b2637;">Note:</strong> The consultation is conducted privately via Zoom and is limited to qualified executive founders. Lionel reviews your full diagnostic dossier beforehand.
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#010d20;border-top:1px solid #d0a35a;padding:22px 40px;color:#fbf8f2;font-family:'Inter',Arial,sans-serif;font-size:12px;line-height:18px;text-align:left;">
              Leaders Performance &middot; Executive Advisory &middot; Dubai, UAE
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, html };
}

export async function sendScanFollowup1Email(data: FollowupEmailData): Promise<boolean> {
  try {
    const { subject, html } = buildScanFollowup1Email(data);
    let contactId = data.contactId;
    if (!contactId) {
      contactId = await upsertContact({
        email: data.email,
        firstName: data.participantName.split(' ')[0],
        lastName: data.participantName.split(' ').slice(1).join(' ') || undefined,
        companyName: data.companyName,
        tags: ['founder-pressure-scan', 'followup-day-2'],
      });
    }

    if (contactId) {
      const pdfAttachmentUrl = await resolveScanPdfAttachmentUrl(data.referenceNumber, 'participant');
      const attachments = pdfAttachmentUrl ? [pdfAttachmentUrl] : undefined;
      await sendEmail(contactId, subject, html, undefined, attachments);
      console.log(`[SUCCESS] Follow-up 1 (Day 2) Email Sent to: ${data.email} (Ref: ${data.referenceNumber})`);
      return true;
    }
    return false;
  } catch (err: any) {
    console.error('[ERROR] Failed to send Follow-up 1 email:', err.message || err);
    throw err;
  }
}

/**
 * Final Follow-up Email: 5 days (120 hours) after scan submission if no call booked
 */
export function buildScanFollowup2Email(data: FollowupEmailData): { subject: string; html: string } {
  const frontendUrl = process.env.FRONTEND_URL || 'https://staging.leadersperformance.ae';
  const scheduleUrl = `${frontendUrl}/diagnostics?book=${encodeURIComponent(data.referenceNumber)}`;
  const primarySignal = data.primarySignalArea || 'Operational Resilience';
  const subject = `[Founder Pressure Scan] Final note regarding your strategic review (Ref: ${data.referenceNumber})`;

  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f2ede3;font-family:'Inter',Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f2ede3;width:100%;margin:0;padding:32px 0;">
    <tr>
      <td align="center" style="padding:0 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#fbf8f2;border:1px solid #ebe4db;border-collapse:separate;margin:0 auto;text-align:left;">
          <!-- Header Banner -->
          <tr>
            <td style="background-color:#021329;border-bottom:1px solid #d0a35a;padding:34px 40px;">
              <a href="https://leadersperformance.ae" target="_blank" style="text-decoration:none;display:inline-block;">
                <img src="https://tpyudbsbzrhhngulxyxp.supabase.co/storage/v1/object/public/avatars/branding/logo-gold.png" alt="Leaders Performance" width="146" style="display:block;width:146px;height:auto;max-width:146px;border:0;outline:none;" />
              </a>
            </td>
          </tr>

          <!-- Content Body -->
          <tr>
            <td style="padding:40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;padding-bottom:12px;">
                    FOUNDER PRESSURE SCAN &middot; FINAL FOLLOW-UP
                  </td>
                </tr>
                <tr>
                  <td style="font-family:'Playfair Display',Georgia,'Times New Roman',serif;font-size:28px;font-weight:400;line-height:34px;color:#1b2637;padding-bottom:12px;">
                    Final note regarding your executive review consultation
                  </td>
                </tr>
                <tr>
                  <td style="font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:400;line-height:24px;color:#4a5568;padding-bottom:24px;">
                    Dear ${escapeHtml(data.participantName)}, this is a final follow-up regarding your Founder Pressure Scan (Ref: ${escapeHtml(data.referenceNumber)}).
                  </td>
                </tr>
                <tr>
                  <td style="font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:400;line-height:24px;color:#4a5568;padding-bottom:28px;">
                    Your directional signal assessment in <strong>${escapeHtml(primarySignal)}</strong> remains on file. If you would like to explore practical steps to systematically remove bottlenecks and increase executive autonomy with Lionel Eersteling, please reserve your preferred consultation slot before your initial review window closes.
                  </td>
                </tr>
              </table>

              <!-- Metadata Section -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #ebe4db;border-collapse:collapse;margin-bottom:28px;">
                <tr style="border-bottom:1px solid #ebe4db;">
                  <td style="padding:15px 0;width:170px;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;">
                    PARTICIPANT
                  </td>
                  <td style="padding:15px 0;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:500;line-height:22px;color:#1b2637;">
                    ${escapeHtml(data.participantName)}
                  </td>
                </tr>
                <tr style="border-bottom:1px solid #ebe4db;">
                  <td style="padding:15px 0;width:170px;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;">
                    ORGANISATION
                  </td>
                  <td style="padding:15px 0;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:500;line-height:22px;color:#1b2637;">
                    ${escapeHtml(data.companyName || 'Confidential')}
                  </td>
                </tr>
                <tr style="border-bottom:1px solid #ebe4db;">
                  <td style="padding:15px 0;width:170px;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;">
                    SCAN REFERENCE
                  </td>
                  <td style="padding:15px 0;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:500;line-height:22px;color:#1b2637;">
                    ${escapeHtml(data.referenceNumber)}
                  </td>
                </tr>
                <tr style="border-bottom:1px solid #ebe4db;">
                  <td style="padding:15px 0;width:170px;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;line-height:17px;letter-spacing:1.44px;text-transform:uppercase;color:#9f6511;">
                    PRIMARY SIGNAL
                  </td>
                  <td style="padding:15px 0;vertical-align:middle;font-family:'Inter',Arial,Helvetica,sans-serif;font-size:15px;font-weight:600;line-height:22px;color:#9f6511;">
                    ${escapeHtml(primarySignal)}
                  </td>
                </tr>
              </table>

              <!-- CTA Button -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
                <tr>
                  <td align="center">
                    <a href="${escapeHtml(scheduleUrl)}" target="_blank" style="display:inline-block;background-color:#d0a35a;border:1px solid #d0a35a;color:#010d20;text-decoration:none;font-family:'Inter',Arial,sans-serif;font-size:15px;font-weight:600;line-height:22px;padding:14px 32px;text-align:center;border-radius:2px;">
                      Schedule Your Private Review Session &rarr;
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#010d20;border-top:1px solid #d0a35a;padding:22px 40px;color:#fbf8f2;font-family:'Inter',Arial,sans-serif;font-size:12px;line-height:18px;text-align:left;">
              Leaders Performance &middot; Executive Advisory &middot; Dubai, UAE
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, html };
}

export async function sendScanFollowup2Email(data: FollowupEmailData): Promise<boolean> {
  try {
    const { subject, html } = buildScanFollowup2Email(data);
    let contactId = data.contactId;
    if (!contactId) {
      contactId = await upsertContact({
        email: data.email,
        firstName: data.participantName.split(' ')[0],
        lastName: data.participantName.split(' ').slice(1).join(' ') || undefined,
        companyName: data.companyName,
        tags: ['founder-pressure-scan', 'followup-day-5'],
      });
    }

    if (contactId) {
      const pdfAttachmentUrl = await resolveScanPdfAttachmentUrl(data.referenceNumber, 'participant');
      const attachments = pdfAttachmentUrl ? [pdfAttachmentUrl] : undefined;
      await sendEmail(contactId, subject, html, undefined, attachments);
      console.log(`[SUCCESS] Follow-up 2 (Day 5) Email Sent to: ${data.email} (Ref: ${data.referenceNumber})`);
      return true;
    }
    return false;
  } catch (err: any) {
    console.error('[ERROR] Failed to send Follow-up 2 email:', err.message || err);
    throw err;
  }
}


