import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { getSecret } from './secrets';
import { upsertContact, sendEmail } from './ghl';
import { escapeHtml, formatOperationalSubmissionDate } from './email';

const prisma = new PrismaClient();

export interface UnmaskedPrivatePayload {
  step1: {
    fullName: string;
    email: string;
    phone: string;
    companyName: string;
    companyWebsite?: string;
    role?: string;
    roleTitle?: string;
    cityAndCountry?: string;
    location?: string;
  };
  step2?: {
    businessResult?: string;
    attentionNow?: string;
    outcome90Days?: string;
    attemptedAlready?: string;
    contextAnswers?: Record<string, any>;
  };
  step3: {
    decisionInfluence?: string;
    challengeView?: string;
    authorityToAct?: 'Yes' | 'Partly' | 'No' | string;
    investmentReadiness:
      | 'UP_TO_5K'
      | 'FROM_5K_TO_10K'
      | 'FROM_10K_TO_15K'
      | 'FROM_15K_TO_20K'
      | 'OVER_20K'
      | 'VALUE_DEPENDENT'
      | string;
    availableForCall?: 'Yes' | 'No' | string;
    contextAnswers?: Record<string, any>;
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
  FROM_5K_TO_10K: 'AED 5,001–9,999',
  FROM_10K_TO_15K: 'AED 10,000–14,999',
  FROM_15K_TO_20K: 'AED 15,000–19,999',
  OVER_20K: 'AED 20,000 or more',
  VALUE_DEPENDENT: 'The appropriate investment depends on the value of the result and proposed scope',
};

// Maps human strings or enum keys to canonical investment key
export function normalizeInvestmentReadiness(val: string): string {
  if (!val) return '';
  const s = String(val).trim();
  if (['UP_TO_5K', 'FROM_5K_TO_10K', 'FROM_10K_TO_15K', 'FROM_15K_TO_20K', 'OVER_20K', 'VALUE_DEPENDENT'].includes(s)) {
    return s;
  }
  if (s.includes('Up to AED 5,000') || s.toLowerCase().includes('up to 5')) return 'UP_TO_5K';
  if (s.includes('5,001–9,999') || s.includes('5,001') || s.includes('9,999')) return 'FROM_5K_TO_10K';
  if (s.includes('10,000–14,999') || s.includes('10,000') || s.includes('14,999')) return 'FROM_10K_TO_15K';
  if (s.includes('15,000–19,999') || s.includes('15,000') || s.includes('19,999')) return 'FROM_15K_TO_20K';
  if (s.includes('20,000 or more') || s.toLowerCase().includes('20,000')) return 'OVER_20K';
  if (
    s.toLowerCase().includes('appropriate investment') ||
    s.toLowerCase().includes('depends on the value') ||
    s.toLowerCase().includes('proposed scope') ||
    s.toLowerCase().includes('value')
  ) {
    return 'VALUE_DEPENDENT';
  }
  return s;
}

// Concise questionnaire definition stored in DB (SystemConfig key: unmasked_questionnaire)
// Note: Step 1 (About You) is rendered directly by the frontend UI
export const DEFAULT_UNMASKED_QUESTIONNAIRE = {
  step2: {
    step: 2,
    title: 'Your Result',
    questions: [
      {
        id: 'businessResult',
        text: 'What is the one business result, consequential decision or strategic challenge you want to address?',
        required: true,
      },
      {
        id: 'attentionNow',
        text: 'Why does this require attention now?',
        required: true,
      },
      {
        id: 'outcome90Days',
        text: 'What would a successful outcome make possible during the next 90 days?',
        required: true,
      },
      {
        id: 'attemptedAlready',
        text: 'What have you already attempted, and what happened?(optional)',
        required: false,
      },
    ],
  },
  step3: {
    step: 3,
    title: 'Your Readiness',
    notice: 'UNMASKED PRIVATE engagements start at AED 10,000 excluding VAT.',
    questions: [
      {
        id: 'decisionInfluence',
        text: 'Where may your own decisions, standards or behaviour be influencing the current result?',
        required: true,
      },
      {
        id: 'challengeView',
        text: 'Describe a recent situation in which someone challenged your view and you changed your decision or approach.\nWhat did you initially believe, what changed your view and what did you do differently?',
        required: true,
      },
      {
        id: 'authorityToAct',
        text: 'Do you have the authority and practical ability to act on the decisions that may emerge?',
        options: ['Yes', 'Partly', 'No'],
        required: true,
      },
      {
        id: 'investmentReadiness',
        text: 'If there is a genuine fit, what level of investment are you currently prepared to make in accelerating this result?',
        options: [
          { label: 'Up to AED 5,000', value: 'UP_TO_5K' },
          { label: 'AED 5,001–9,999', value: 'FROM_5K_TO_10K' },
          { label: 'AED 10,000–14,999', value: 'FROM_10K_TO_15K' },
          { label: 'AED 15,000–19,999', value: 'FROM_15K_TO_20K' },
          { label: 'AED 20,000 or more', value: 'OVER_20K' },
          {
            label: 'The appropriate investment depends on the value of the result and proposed scope',
            value: 'VALUE_DEPENDENT',
          },
        ],
        required: true,
      },
      {
        id: 'availableForCall',
        text: 'Are you available for a confidential 30-minute conversation if Lionel determines there is a genuine fit?',
        options: ['Yes', 'No'],
        required: true,
      },
    ],
  },
};

// In-memory cache for dynamic questionnaire config
let cachedQuestionnaire: any = null;
let questionnaireCacheTime = 0;
const QUESTIONNAIRE_CACHE_TTL = 5 * 60 * 1000; // 5 mins

export async function getUnmaskedQuestionnaire(): Promise<any> {
  const now = Date.now();
  if (cachedQuestionnaire && now - questionnaireCacheTime < QUESTIONNAIRE_CACHE_TTL) {
    return cachedQuestionnaire;
  }

  try {
    const record = await prisma.systemConfig.findUnique({
      where: { key: 'unmasked_questionnaire' },
    });

    if (record && record.value) {
      const parsed = JSON.parse(record.value);
      if (parsed && parsed.step2 && parsed.step3) {
        cachedQuestionnaire = parsed;
        questionnaireCacheTime = now;
        return cachedQuestionnaire;
      }
    }
  } catch (err: any) {
    console.warn('[Unmasked Private] Failed to read questionnaire from DB:', err?.message || err);
  }

  // Auto-seed to DB if missing or in old format
  try {
    await prisma.systemConfig.upsert({
      where: { key: 'unmasked_questionnaire' },
      update: { value: JSON.stringify(DEFAULT_UNMASKED_QUESTIONNAIRE) },
      create: { key: 'unmasked_questionnaire', value: JSON.stringify(DEFAULT_UNMASKED_QUESTIONNAIRE) },
    });
  } catch (seedErr: any) {
    console.warn('[Unmasked Private] Non-fatal: could not auto-seed questionnaire to DB:', seedErr?.message || seedErr);
  }

  cachedQuestionnaire = DEFAULT_UNMASKED_QUESTIONNAIRE;
  questionnaireCacheTime = now;
  return cachedQuestionnaire;
}

export async function updateUnmaskedQuestionnaire(newConfig: any): Promise<any> {
  const serialized = JSON.stringify(newConfig);
  const updated = await prisma.systemConfig.upsert({
    where: { key: 'unmasked_questionnaire' },
    update: { value: serialized },
    create: { key: 'unmasked_questionnaire', value: serialized },
  });

  cachedQuestionnaire = JSON.parse(updated.value);
  questionnaireCacheTime = Date.now();
  return cachedQuestionnaire;
}

export function clearQuestionnaireCache(): void {
  cachedQuestionnaire = null;
  questionnaireCacheTime = 0;
}

// Generates unique reference number in format UNM-YYYY-XXXX
export function generateUnmaskedReferenceNumber(): string {
  const year = new Date().getFullYear();
  const seq = String(Math.floor(1000 + Math.random() * 9000));
  return `UNM-${year}-${seq}`;
}

// Evaluates investment readiness threshold
export function evaluateInvestmentRouting(investmentReadiness: string): RoutingResult {
  const normalized = normalizeInvestmentReadiness(investmentReadiness);
  const belowThresholdBrackets = ['UP_TO_5K', 'FROM_5K_TO_10K'];
  const isQualified = !belowThresholdBrackets.includes(normalized);

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
    const matched = contacts.find((c: any) => c.email && c.email.toLowerCase().trim() === normalized);

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

// Builds the HTML briefing email for Lionel and executive advisors
export function buildUnmaskedBriefingEmail(data: {
  participantName: string;
  email: string;
  phone?: string;
  companyName?: string;
  companyWebsite?: string;
  roleTitle?: string;
  cityAndCountry?: string;
  investmentReadiness: string;
  referenceNumber: string;
  submittedAt: string;
  reviewUrl: string;
  isQualified?: boolean;
  businessResult?: string;
  attentionNow?: string;
  outcome90Days?: string;
  attemptedAlready?: string;
  decisionInfluence?: string;
  challengeView?: string;
  authorityToAct?: string;
  availableForCall?: string;
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
      <p>Phone: {{phone}}</p>
      <p>Company: {{company_name}}</p>
      <p>Role: {{role_title}}</p>
      <p>City & Country: {{city_and_country}}</p>
      <p>Investment Bracket: {{investment_readiness}}</p>
      <p>Ref: {{reference_number}}</p>
      <h3>Step 02: Strategic Result</h3>
      <p><strong>Challenge:</strong> {{business_result}}</p>
      <p><strong>Why Now:</strong> {{attention_now}}</p>
      <p><strong>90-Day Outcome:</strong> {{outcome_90_days}}</p>
      <p><strong>Attempted Already:</strong> {{attempted_already}}</p>
      <h3>Step 03: Readiness</h3>
      <p><strong>Influence of Own Decisions:</strong> {{decision_influence}}</p>
      <p><strong>Challenged View:</strong> {{challenge_view}}</p>
      <p><strong>Authority to Act:</strong> {{authority_to_act}}</p>
      <p><strong>Available for 30-min Call:</strong> {{available_for_call}}</p>
    `;
  }

  // Format additional context answers if present and not already displayed
  const knownKeys = new Set([
    'businessResult',
    'attentionNow',
    'outcome90Days',
    'attemptedAlready',
    'decisionInfluence',
    'challengeView',
    'authorityToAct',
    'investmentReadiness',
    'availableForCall',
    'currentChallenge',
    'primaryChallenge',
  ]);

  let contextSection = '';
  if (data.contextAnswers && Object.keys(data.contextAnswers).length > 0) {
    let rows = '';
    for (const [key, value] of Object.entries(data.contextAnswers)) {
      if (!knownKeys.has(key) && value !== undefined && value !== null && String(value).trim()) {
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
              Additional Diagnostic Context
            </td>
          </tr>
          ${rows}
        </table>
      `;
    }
  }

  const atCompany = data.companyName ? `at ${escapeHtml(data.companyName)}` : '';
  const normalizedInv = normalizeInvestmentReadiness(data.investmentReadiness);
  const readableInvestment = INVESTMENT_LABELS[normalizedInv] || data.investmentReadiness;
  const companyWebsiteHtml = data.companyWebsite
    ? `<a href="${escapeHtml(data.companyWebsite)}" target="_blank" style="color:#8a5c18;text-decoration:underline;">${escapeHtml(data.companyWebsite)}</a>`
    : 'Not provided';

  const isQualified = data.isQualified !== false;
  const statusHeading = isQualified
    ? 'New Application Awaiting Personal Review'
    : 'New Application (Below Investment Threshold)';

  const statusSubtext = isQualified
    ? 'A qualified applicant has submitted an application for UNMASKED PRIVATE. The profile meets the investment threshold and is pending your executive review.'
    : 'An applicant has submitted an application for UNMASKED PRIVATE with an investment tier below AED 10,000 (Below Threshold).';

  const variables: Record<string, string> = {
    status_heading: escapeHtml(statusHeading),
    status_subtext: escapeHtml(statusSubtext),
    participant_name: escapeHtml(data.participantName),
    email: escapeHtml(data.email),
    phone: escapeHtml(data.phone || 'Not provided'),
    company_name: escapeHtml(data.companyName || 'Not specified'),
    company_website: companyWebsiteHtml,
    role_title: escapeHtml(data.roleTitle || 'Executive'),
    city_and_country: escapeHtml(data.cityAndCountry || 'Not specified'),
    at_company: atCompany,
    investment_readiness: escapeHtml(readableInvestment),
    reference_number: escapeHtml(data.referenceNumber),
    submitted_at: escapeHtml(data.submittedAt),
    review_url: escapeHtml(data.reviewUrl),
    business_result: escapeHtml(data.businessResult || 'Not specified'),
    attention_now: escapeHtml(data.attentionNow || 'Not specified'),
    outcome_90_days: escapeHtml(data.outcome90Days || 'Not specified'),
    attempted_already: data.attemptedAlready ? escapeHtml(data.attemptedAlready) : 'None reported',
    decision_influence: escapeHtml(data.decisionInfluence || 'Not specified'),
    challenge_view: escapeHtml(data.challengeView || 'Not specified'),
    authority_to_act: escapeHtml(data.authorityToAct || 'Not specified'),
    available_for_call: escapeHtml(data.availableForCall || 'Not specified'),
    context_section: contextSection,
  };

  let rendered = rawTemplate;
  for (const [k, v] of Object.entries(variables)) {
    rendered = rendered.replace(new RegExp(`{{${k}}}`, 'g'), v);
  }

  const statusPrefix = isQualified ? '[UNMASKED PRIVATE]' : '[UNMASKED PRIVATE — BELOW THRESHOLD]';
  const subject = `${statusPrefix} New Application — ${data.participantName} (${data.companyName || 'Confidential'}) — ${data.referenceNumber}`;

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
  contactId?: string,
  isQualified: boolean = true
): Promise<void> {
  if (process.env.NODE_ENV === 'test' || process.env.SKIP_EMAIL === 'true' || process.env.CI === 'true') {
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

  // Extract step 2 answers (supporting direct fields or contextAnswers)
  const businessResult =
    payload.step2?.businessResult ||
    payload.step2?.contextAnswers?.businessResult ||
    payload.step2?.contextAnswers?.currentChallenge ||
    payload.step2?.contextAnswers?.primaryChallenge;
  const attentionNow =
    payload.step2?.attentionNow ||
    payload.step2?.contextAnswers?.attentionNow ||
    payload.step2?.contextAnswers?.whyNow;
  const outcome90Days =
    payload.step2?.outcome90Days ||
    payload.step2?.contextAnswers?.outcome90Days ||
    payload.step2?.contextAnswers?.successfulOutcome;
  const attemptedAlready =
    payload.step2?.attemptedAlready || payload.step2?.contextAnswers?.attemptedAlready;

  // Extract step 3 answers
  const decisionInfluence =
    payload.step3.decisionInfluence ||
    payload.step3.contextAnswers?.decisionInfluence ||
    payload.step3.contextAnswers?.ownDecisions;
  const challengeView =
    payload.step3.challengeView ||
    payload.step3.contextAnswers?.challengeView ||
    payload.step3.contextAnswers?.recentSituation;
  const authorityToAct =
    payload.step3.authorityToAct ||
    payload.step3.contextAnswers?.authorityToAct ||
    payload.step3.contextAnswers?.authority;
  const availableForCall =
    payload.step3.availableForCall ||
    payload.step3.contextAnswers?.availableForCall ||
    payload.step3.contextAnswers?.available;

  const roleTitle = payload.step1.role || payload.step1.roleTitle;
  const cityAndCountry = payload.step1.cityAndCountry || payload.step1.location;

  const { subject, html } = buildUnmaskedBriefingEmail({
    participantName: payload.step1.fullName,
    email: payload.step1.email,
    phone: payload.step1.phone,
    companyName: payload.step1.companyName,
    companyWebsite: payload.step1.companyWebsite,
    roleTitle,
    cityAndCountry,
    investmentReadiness: payload.step3.investmentReadiness,
    referenceNumber,
    submittedAt: formatOperationalSubmissionDate(),
    reviewUrl,
    isQualified,
    businessResult,
    attentionNow,
    outcome90Days,
    attemptedAlready,
    decisionInfluence,
    challengeView,
    authorityToAct,
    availableForCall,
    contextAnswers: {
      ...(payload.step2?.contextAnswers || {}),
      ...(payload.step3.contextAnswers || {}),
    },
  });

  const staffRecipients = [
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
