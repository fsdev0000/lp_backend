import fs from 'fs';
import path from 'path';
import { getSecret } from './secrets';
import { upsertContact, sendEmail } from './ghl';
import { escapeHtml, formatOperationalSubmissionDate } from './email';

export interface UnmaskedPrivatePayload {
  step1: {
    fullName: string;
    email: string;
    phone?: string;
    companyName?: string;
    roleTitle?: string;
  };
  step2?: {
    contextAnswers?: Record<string, any>;
  };
  step3: {
    investmentReadiness:
    | 'UP_TO_5K'
    | 'FROM_5K_TO_10K'
    | 'FROM_10K_TO_15K'
    | 'FROM_15K_TO_20K'
    | 'OVER_20K'
    | 'VALUE_DEPENDENT';
  };
  consent: {
    privacyConsent: boolean;
    privacyPolicyVersion?: string;
  };
  tracking?: {
    utm_source?: string;
    utm_medium?: string;
    utm_campaign?: string;
    utm_term?: string;
    utm_content?: string;
    referrer?: string;
  };
}

export interface RoutingResult {
  outcome: 'PENDING_PERSONAL_REVIEW' | 'BELOW_INVESTMENT_THRESHOLD';
  redirectUrl: string;
  isQualified: boolean;
}

export const INVESTMENT_LABELS: Record<string, string> = {
  UP_TO_5K: 'Up to AED 5,000',
  FROM_5K_TO_10K: 'AED 5,001 – 9,999',
  FROM_10K_TO_15K: 'AED 10,000 – 14,999',
  FROM_15K_TO_20K: 'AED 15,000 – 19,999',
  OVER_20K: 'AED 20,000 or more',
  VALUE_DEPENDENT: 'Value-Dependent (Scope & outcome based)',
};

// Generates unique reference number in format UNM-YYYY-XXXX
export function generateUnmaskedReferenceNumber(): string {
  const year = new Date().getFullYear();
  const seq = String(Math.floor(1000 + Math.random() * 9000));
  return `UNM-${year}-${seq}`;
}

// Evaluates investment readiness threshold
export function evaluateInvestmentRouting(investmentReadiness: string): RoutingResult {
  const belowThresholdBrackets = ['UP_TO_5K', 'FROM_5K_TO_10K'];
  const isQualified = !belowThresholdBrackets.includes(investmentReadiness);

  if (isQualified) {
    return {
      outcome: 'PENDING_PERSONAL_REVIEW',
      redirectUrl: '/unmasked-private/thank-you',
      isQualified: true,
    };
  }

  return {
    outcome: 'BELOW_INVESTMENT_THRESHOLD',
    redirectUrl: '/unmasked-private/not-ready-yet',
    isQualified: false,
  };
}

// In-memory duplicate lock cache (24 hours TTL per email)
interface DuplicateRecord {
  timestamp: number;
  referenceNumber: string;
  outcome: string;
}

const recentApplications = new Map<string, DuplicateRecord>();
const inFlightSubmissions = new Set<string>();
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

// Periodic sweep to prevent unbounded memory growth (every 30 mins)
setInterval(() => {
  const now = Date.now();
  for (const [email, record] of recentApplications.entries()) {
    if (now - record.timestamp > DUPLICATE_WINDOW_MS) {
      recentApplications.delete(email);
    }
  }
}, 30 * 60 * 1000).unref();

// In-flight concurrency lock (protects against rapid double-clicks)
export function acquireInFlightLock(email: string): boolean {
  const normalized = email.toLowerCase().trim();
  if (inFlightSubmissions.has(normalized)) return false;
  inFlightSubmissions.add(normalized);
  return true;
}

export function releaseInFlightLock(email: string): void {
  const normalized = email.toLowerCase().trim();
  inFlightSubmissions.delete(normalized);
}

// In-memory duplicate check (instant, <1ms)
export function checkRecentDuplicate(email: string): boolean {
  const normalized = email.toLowerCase().trim();
  const existing = recentApplications.get(normalized);
  if (!existing) return false;

  const now = Date.now();
  if (now - existing.timestamp > DUPLICATE_WINDOW_MS) {
    recentApplications.delete(normalized);
    return false;
  }
  return true;
}

// Persistent duplicate check querying GoHighLevel CRM (persists across server restarts)
export async function checkGhlDuplicate(email: string): Promise<boolean> {
  if (process.env.NODE_ENV === 'test') return false;

  try {
    const ghlBase =
      process.env.GHL_BASE ||
      (await getSecret('GHL_BASE').catch(() => null)) ||
      'https://services.leadconnectorhq.com';
    const ghlApiKey = process.env.GHL_API_KEY || (await getSecret('GHL_API_KEY').catch(() => null));
    const ghlLocationId = process.env.GHL_LOCATION_ID || (await getSecret('GHL_LOCATION_ID').catch(() => null));

    if (!ghlApiKey || !ghlLocationId) return false;

    const normalized = email.toLowerCase().trim();
    const res = await fetch(
      `${ghlBase}/contacts/?locationId=${encodeURIComponent(ghlLocationId)}&query=${encodeURIComponent(normalized)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${ghlApiKey}`,
          'Content-Type': 'application/json',
          Version: '2021-07-28',
        },
      }
    );

    if (!res.ok) return false;
    const data: any = await res.json();
    const contacts = data.contacts || [];
    const matched = contacts.find(
      (c: any) => c.email && c.email.toLowerCase().trim() === normalized
    );

    if (matched && Array.isArray(matched.tags) && matched.tags.includes('unmasked-private')) {
      // Seed into memory cache so subsequent lookups are instant
      recordRecentSubmission(normalized, 'UNM-EXISTING', 'ALREADY_SUBMITTED');
      return true;
    }
    return false;
  } catch (err) {
    console.warn('[Unmasked Private] GHL duplicate lookup non-fatal error:', err);
    return false;
  }
}

export function recordRecentSubmission(email: string, referenceNumber: string, outcome: string): void {
  const normalized = email.toLowerCase().trim();
  recentApplications.set(normalized, {
    timestamp: Date.now(),
    referenceNumber,
    outcome,
  });
}

// Exposed for test cleanup
export function clearRecentSubmissions(): void {
  recentApplications.clear();
  inFlightSubmissions.clear();
}

// Builds the HTML briefing email for Lionel
export function buildUnmaskedBriefingEmail(data: {
  participantName: string;
  email: string;
  phone?: string;
  companyName?: string;
  roleTitle?: string;
  investmentReadiness: string;
  referenceNumber: string;
  submittedAt: string;
  reviewUrl: string;
  contextAnswers?: Record<string, any>;
}): { subject: string; html: string } {
  const templatePath = path.join(__dirname, '../../templates/unmasked-private-briefing.html');
  let rawTemplate = '';

  try {
    rawTemplate = fs.readFileSync(templatePath, 'utf8');
  } catch (err) {
    console.warn('[Unmasked Private] Custom template not found, falling back to basic rendering', err);
    rawTemplate = `
      <h2>New UNMASKED PRIVATE Application</h2>
      <p>Applicant: {{participant_name}}</p>
      <p>Email: {{email}}</p>
      <p>Investment Bracket: {{investment_readiness}}</p>
      <p>Ref: {{reference_number}}</p>
    `;
  }

  // Format context section if answers are present
  let contextSection = '';
  if (data.contextAnswers && Object.keys(data.contextAnswers).length > 0) {
    let rows = '';
    for (const [key, value] of Object.entries(data.contextAnswers)) {
      if (value !== undefined && value !== null && String(value).trim()) {
        const readableKey = key
          .replace(/([A-Z])/g, ' $1')
          .replace(/[_-]/g, ' ')
          .trim()
          .toUpperCase();
        rows += `
          <tr style="border-bottom:1px solid #ebe4db;">
            <td style="padding:10px 0;width:170px;font-size:11px;font-weight:700;color:#8a5c18;">${escapeHtml(readableKey)}</td>
            <td style="padding:10px 0;font-size:13.5px;color:#1b2637;">${escapeHtml(String(value))}</td>
          </tr>
        `;
      }
    }

    if (rows) {
      contextSection = `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;border-top:2px solid #8a5c18;border-collapse:collapse;">
          <tr>
            <td colspan="2" style="padding:12px 0 8px 0;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#8a5c18;">
              Context & Diagnostic Answers
            </td>
          </tr>
          ${rows}
        </table>
      `;
    }
  }

  const atCompany = data.companyName ? `at ${escapeHtml(data.companyName)}` : '';
  const readableInvestment = INVESTMENT_LABELS[data.investmentReadiness] || data.investmentReadiness;

  const variables: Record<string, string> = {
    participant_name: escapeHtml(data.participantName),
    email: escapeHtml(data.email),
    phone: escapeHtml(data.phone || 'Not provided'),
    company_name: escapeHtml(data.companyName || 'Not specified'),
    role_title: escapeHtml(data.roleTitle || 'Executive'),
    at_company: atCompany,
    investment_readiness: escapeHtml(readableInvestment),
    reference_number: escapeHtml(data.referenceNumber),
    submitted_at: escapeHtml(data.submittedAt),
    review_url: escapeHtml(data.reviewUrl),
    context_section: contextSection,
  };

  let rendered = rawTemplate;
  for (const [k, v] of Object.entries(variables)) {
    rendered = rendered.replace(new RegExp(`{{${k}}}`, 'g'), v);
  }

  const subject = `[UNMASKED PRIVATE] New Application — ${data.participantName} (${data.companyName || 'Confidential'}) — ${data.referenceNumber}`;

  return { subject, html: rendered };
}

// Resilient exponential backoff retry utility
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    retries?: number;
    delayMs?: number;
    backoffFactor?: number;
    context?: string;
  } = {}
): Promise<T> {
  const retries = options.retries ?? 3;
  let delay = options.delayMs ?? 500;
  const factor = options.backoffFactor ?? 2;
  const context = options.context ?? 'Operation';

  let lastError: any;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await operation();
    } catch (err: any) {
      lastError = err;
      if (attempt === retries) {
        console.error(`[Retry] ${context} failed after ${retries} attempts:`, err?.message || err);
        break;
      }
      console.warn(`[Retry] ${context} attempt ${attempt} failed, retrying in ${delay}ms...`, err?.message || err);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= factor;
    }
  }
  throw lastError;
}

// Dispatches notification alerts to Lionel and Leaders Performance staff
export async function sendUnmaskedPrivateNotification(
  payload: UnmaskedPrivatePayload,
  referenceNumber: string,
  contactId?: string
): Promise<void> {
  const ghlBase =
    process.env.GHL_BASE ||
    (await getSecret('GHL_BASE').catch(() => null)) ||
    'https://services.leadconnectorhq.com';
  // Suppress all notification emails during tests or when explicitly disabled
  if (
    process.env.NODE_ENV === 'test' ||
    process.env.SKIP_EMAIL === 'true' ||
    process.env.CI === 'true'
  ) {
    return;
  }

  const ghlApiKey = process.env.GHL_API_KEY || (await getSecret('GHL_API_KEY').catch(() => null));
  const ghlLocationId = process.env.GHL_LOCATION_ID || (await getSecret('GHL_LOCATION_ID').catch(() => null));

  if (!ghlApiKey || !ghlLocationId) {
    console.warn('[Unmasked Private] GHL API credentials not configured; skipping notification email');
    return;
  }

  const reviewUrl = contactId
    ? `https://app.gohighlevel.com/v2/location/${encodeURIComponent(ghlLocationId)}/contacts/detail/${encodeURIComponent(contactId)}`
    : `https://app.gohighlevel.com/v2/location/${encodeURIComponent(ghlLocationId)}/opportunities`;

  const { subject, html } = buildUnmaskedBriefingEmail({
    participantName: payload.step1.fullName,
    email: payload.step1.email,
    phone: payload.step1.phone,
    companyName: payload.step1.companyName,
    roleTitle: payload.step1.roleTitle,
    investmentReadiness: payload.step3.investmentReadiness,
    referenceNumber,
    submittedAt: formatOperationalSubmissionDate(),
    reviewUrl,
    contextAnswers: payload.step2?.contextAnswers,
  });

  const staffRecipients = [
    /*{ email: 'lionel@leadersperformance.ae', firstName: 'Lionel', lastName: 'Eersteling' },
   
  */
    { email: 'info@leadersperformance.ae', firstName: 'Leaders', lastName: 'Performance' },
  ];

  for (const recipient of staffRecipients) {
    try {
      const staffContactId = await withRetry(
        () =>
          upsertContact({
            email: recipient.email,
            firstName: recipient.firstName,
            lastName: recipient.lastName,
            tags: ['lp-staff', 'internal-notification'],
          }),
        { retries: 3, delayMs: 500, context: `Upsert Staff Contact (${recipient.email})` }
      );

      if (staffContactId) {
        await withRetry(
          () => sendEmail(staffContactId, subject, html),
          { retries: 3, delayMs: 800, context: `Send Briefing Email (${recipient.email})` }
        );
        console.log(`[Unmasked Private] Notification sent to ${recipient.email} (Ref: ${referenceNumber})`);
      }
    } catch (err) {
      console.error(`[Unmasked Private] Failed to send notification to ${recipient.email}:`, err);
    }
  }
}
