"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_UNMASKED_QUESTIONNAIRE = exports.INVESTMENT_LABELS = void 0;
exports.normalizeInvestmentReadiness = normalizeInvestmentReadiness;
exports.getUnmaskedQuestionnaire = getUnmaskedQuestionnaire;
exports.updateUnmaskedQuestionnaire = updateUnmaskedQuestionnaire;
exports.clearQuestionnaireCache = clearQuestionnaireCache;
exports.generateUnmaskedReferenceNumber = generateUnmaskedReferenceNumber;
exports.evaluateInvestmentRouting = evaluateInvestmentRouting;
exports.acquireInFlightLock = acquireInFlightLock;
exports.releaseInFlightLock = releaseInFlightLock;
exports.checkRecentDuplicate = checkRecentDuplicate;
exports.checkGhlDuplicate = checkGhlDuplicate;
exports.recordRecentSubmission = recordRecentSubmission;
exports.clearRecentSubmissions = clearRecentSubmissions;
exports.buildUnmaskedBriefingEmail = buildUnmaskedBriefingEmail;
exports.withRetry = withRetry;
exports.sendUnmaskedPrivateNotification = sendUnmaskedPrivateNotification;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const client_1 = require("@prisma/client");
const secrets_1 = require("./secrets");
const ghl_1 = require("./ghl");
const email_1 = require("./email");
const prisma = new client_1.PrismaClient();
exports.INVESTMENT_LABELS = {
    UP_TO_5K: 'Up to AED 5,000',
    FROM_5K_TO_10K: 'AED 5,001–9,999',
    FROM_10K_TO_15K: 'AED 10,000–14,999',
    FROM_15K_TO_20K: 'AED 15,000–19,999',
    OVER_20K: 'AED 20,000 or more',
};
// Maps human strings or enum keys to canonical investment key
function normalizeInvestmentReadiness(val) {
    if (!val)
        return '';
    const s = String(val).trim();
    if (['UP_TO_5K', 'FROM_5K_TO_10K', 'FROM_10K_TO_15K', 'FROM_15K_TO_20K', 'OVER_20K', 'VALUE_DEPENDENT'].includes(s)) {
        return s;
    }
    if (s.includes('Up to AED 5,000') || s.toLowerCase().includes('up to 5'))
        return 'UP_TO_5K';
    if (s.includes('5,001–9,999') || s.includes('5,001') || s.includes('9,999'))
        return 'FROM_5K_TO_10K';
    if (s.includes('10,000–14,999') || s.includes('10,000') || s.includes('14,999'))
        return 'FROM_10K_TO_15K';
    if (s.includes('15,000–19,999') || s.includes('15,000') || s.includes('19,999'))
        return 'FROM_15K_TO_20K';
    if (s.includes('20,000 or more') || s.toLowerCase().includes('20,000'))
        return 'OVER_20K';
    if (s.toLowerCase().includes('appropriate investment') ||
        s.toLowerCase().includes('depends on the value') ||
        s.toLowerCase().includes('proposed scope') ||
        s.toLowerCase().includes('value')) {
        return 'VALUE_DEPENDENT';
    }
    return s;
}
// Concise questionnaire definition stored in DB (SystemConfig key: unmasked_questionnaire)
// Note: Step 1 (About You) is rendered directly by the frontend UI
exports.DEFAULT_UNMASKED_QUESTIONNAIRE = {
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
let cachedQuestionnaire = null;
let questionnaireCacheTime = 0;
const QUESTIONNAIRE_CACHE_TTL = 5 * 60 * 1000; // 5 mins
async function getUnmaskedQuestionnaire() {
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
    }
    catch (err) {
        console.warn('[Unmasked Private] Failed to read questionnaire from DB:', err?.message || err);
    }
    // Auto-seed to DB if missing or in old format
    try {
        await prisma.systemConfig.upsert({
            where: { key: 'unmasked_questionnaire' },
            update: { value: JSON.stringify(exports.DEFAULT_UNMASKED_QUESTIONNAIRE) },
            create: { key: 'unmasked_questionnaire', value: JSON.stringify(exports.DEFAULT_UNMASKED_QUESTIONNAIRE) },
        });
    }
    catch (seedErr) {
        console.warn('[Unmasked Private] Non-fatal: could not auto-seed questionnaire to DB:', seedErr?.message || seedErr);
    }
    cachedQuestionnaire = exports.DEFAULT_UNMASKED_QUESTIONNAIRE;
    questionnaireCacheTime = now;
    return cachedQuestionnaire;
}
async function updateUnmaskedQuestionnaire(newConfig) {
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
function clearQuestionnaireCache() {
    cachedQuestionnaire = null;
    questionnaireCacheTime = 0;
}
// Generates unique reference number in format UNM-YYYY-XXXX
function generateUnmaskedReferenceNumber() {
    const year = new Date().getFullYear();
    const seq = String(Math.floor(1000 + Math.random() * 9000));
    return `UNM-${year}-${seq}`;
}
// Evaluates investment readiness threshold
function evaluateInvestmentRouting(investmentReadiness) {
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
const recentApplications = new Map();
const inFlightSubmissions = new Set();
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
function acquireInFlightLock(email) {
    const normalized = email.toLowerCase().trim();
    if (inFlightSubmissions.has(normalized))
        return false;
    inFlightSubmissions.add(normalized);
    return true;
}
function releaseInFlightLock(email) {
    const normalized = email.toLowerCase().trim();
    inFlightSubmissions.delete(normalized);
}
// In-memory duplicate check (instant, <1ms)
function checkRecentDuplicate(email) {
    const normalized = email.toLowerCase().trim();
    const existing = recentApplications.get(normalized);
    if (!existing)
        return false;
    const now = Date.now();
    if (now - existing.timestamp > DUPLICATE_WINDOW_MS) {
        recentApplications.delete(normalized);
        return false;
    }
    return true;
}
// Persistent duplicate check querying GoHighLevel CRM (persists across server restarts)
async function checkGhlDuplicate(email) {
    if (process.env.NODE_ENV === 'test')
        return false;
    try {
        const ghlBase = process.env.GHL_BASE ||
            (await (0, secrets_1.getSecret)('GHL_BASE').catch(() => null)) ||
            'https://services.leadconnectorhq.com';
        const ghlApiKey = process.env.GHL_API_KEY || (await (0, secrets_1.getSecret)('GHL_API_KEY').catch(() => null));
        const ghlLocationId = process.env.GHL_LOCATION_ID || (await (0, secrets_1.getSecret)('GHL_LOCATION_ID').catch(() => null));
        if (!ghlApiKey || !ghlLocationId)
            return false;
        const normalized = email.toLowerCase().trim();
        const res = await fetch(`${ghlBase}/contacts/?locationId=${encodeURIComponent(ghlLocationId)}&query=${encodeURIComponent(normalized)}`, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${ghlApiKey}`,
                'Content-Type': 'application/json',
                Version: '2021-07-28',
            },
        });
        if (!res.ok)
            return false;
        const data = await res.json();
        const contacts = data.contacts || [];
        const matched = contacts.find((c) => c.email && c.email.toLowerCase().trim() === normalized);
        if (matched && Array.isArray(matched.tags) && matched.tags.includes('unmasked-private')) {
            // Seed into memory cache so subsequent lookups are instant
            recordRecentSubmission(normalized, 'UNM-EXISTING', 'ALREADY_SUBMITTED');
            return true;
        }
        return false;
    }
    catch (err) {
        console.warn('[Unmasked Private] GHL duplicate lookup non-fatal error:', err);
        return false;
    }
}
function recordRecentSubmission(email, referenceNumber, outcome) {
    const normalized = email.toLowerCase().trim();
    recentApplications.set(normalized, {
        timestamp: Date.now(),
        referenceNumber,
        outcome,
    });
}
// Exposed for test cleanup
function clearRecentSubmissions() {
    recentApplications.clear();
    inFlightSubmissions.clear();
}
// Builds the HTML briefing email for Lionel and executive advisors
function buildUnmaskedBriefingEmail(data) {
    const templatePath = path_1.default.join(__dirname, '../../templates/unmasked-private-briefing.html');
    let rawTemplate = '';
    try {
        rawTemplate = fs_1.default.readFileSync(templatePath, 'utf8');
    }
    catch (err) {
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
            <td style="padding:10px 0;width:170px;font-size:11px;font-weight:700;color:#8a5c18;">${(0, email_1.escapeHtml)(readableKey)}</td>
            <td style="padding:10px 0;font-size:13.5px;color:#1b2637;">${(0, email_1.escapeHtml)(String(value))}</td>
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
    const atCompany = data.companyName ? `at ${(0, email_1.escapeHtml)(data.companyName)}` : '';
    const normalizedInv = normalizeInvestmentReadiness(data.investmentReadiness);
    const readableInvestment = exports.INVESTMENT_LABELS[normalizedInv] || data.investmentReadiness;
    const companyWebsiteHtml = data.companyWebsite
        ? `<a href="${(0, email_1.escapeHtml)(data.companyWebsite)}" target="_blank" style="color:#8a5c18;text-decoration:underline;">${(0, email_1.escapeHtml)(data.companyWebsite)}</a>`
        : 'Not provided';
    const isQualified = data.isQualified !== false;
    const statusHeading = isQualified
        ? 'New Application Awaiting Personal Review'
        : 'New Application (Below Investment Threshold)';
    const statusSubtext = isQualified
        ? 'A qualified applicant has submitted an application for UNMASKED PRIVATE. The profile meets the investment threshold and is pending your executive review.'
        : 'An applicant has submitted an application for UNMASKED PRIVATE with an investment tier below AED 10,000 (Below Threshold).';
    const variables = {
        status_heading: (0, email_1.escapeHtml)(statusHeading),
        status_subtext: (0, email_1.escapeHtml)(statusSubtext),
        participant_name: (0, email_1.escapeHtml)(data.participantName),
        email: (0, email_1.escapeHtml)(data.email),
        phone: (0, email_1.escapeHtml)(data.phone || 'Not provided'),
        company_name: (0, email_1.escapeHtml)(data.companyName || 'Not specified'),
        company_website: companyWebsiteHtml,
        role_title: (0, email_1.escapeHtml)(data.roleTitle || 'Executive'),
        city_and_country: (0, email_1.escapeHtml)(data.cityAndCountry || 'Not specified'),
        at_company: atCompany,
        investment_readiness: (0, email_1.escapeHtml)(readableInvestment),
        reference_number: (0, email_1.escapeHtml)(data.referenceNumber),
        submitted_at: (0, email_1.escapeHtml)(data.submittedAt),
        review_url: (0, email_1.escapeHtml)(data.reviewUrl),
        business_result: (0, email_1.escapeHtml)(data.businessResult || 'Not specified'),
        attention_now: (0, email_1.escapeHtml)(data.attentionNow || 'Not specified'),
        outcome_90_days: (0, email_1.escapeHtml)(data.outcome90Days || 'Not specified'),
        attempted_already: data.attemptedAlready ? (0, email_1.escapeHtml)(data.attemptedAlready) : 'None reported',
        decision_influence: (0, email_1.escapeHtml)(data.decisionInfluence || 'Not specified'),
        challenge_view: (0, email_1.escapeHtml)(data.challengeView || 'Not specified'),
        authority_to_act: (0, email_1.escapeHtml)(data.authorityToAct || 'Not specified'),
        available_for_call: (0, email_1.escapeHtml)(data.availableForCall || 'Not specified'),
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
async function withRetry(operation, options = {}) {
    const retries = options.retries ?? 3;
    let delay = options.delayMs ?? 500;
    const factor = options.backoffFactor ?? 2;
    const context = options.context ?? 'Operation';
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await operation();
        }
        catch (err) {
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
async function sendUnmaskedPrivateNotification(payload, referenceNumber, contactId, isQualified = true) {
    if (process.env.NODE_ENV === 'test' || process.env.SKIP_EMAIL === 'true' || process.env.CI === 'true') {
        return;
    }
    const ghlApiKey = process.env.GHL_API_KEY || (await (0, secrets_1.getSecret)('GHL_API_KEY').catch(() => null));
    const ghlLocationId = process.env.GHL_LOCATION_ID || (await (0, secrets_1.getSecret)('GHL_LOCATION_ID').catch(() => null));
    if (!ghlApiKey || !ghlLocationId) {
        console.warn('[Unmasked Private] GHL API credentials not configured; skipping notification email');
        return;
    }
    const reviewUrl = contactId
        ? `https://app.gohighlevel.com/v2/location/${encodeURIComponent(ghlLocationId)}/contacts/detail/${encodeURIComponent(contactId)}`
        : `https://app.gohighlevel.com/v2/location/${encodeURIComponent(ghlLocationId)}/opportunities`;
    // Extract step 2 answers (supporting direct fields or contextAnswers)
    const businessResult = payload.step2?.businessResult ||
        payload.step2?.contextAnswers?.businessResult ||
        payload.step2?.contextAnswers?.currentChallenge ||
        payload.step2?.contextAnswers?.primaryChallenge;
    const attentionNow = payload.step2?.attentionNow ||
        payload.step2?.contextAnswers?.attentionNow ||
        payload.step2?.contextAnswers?.whyNow;
    const outcome90Days = payload.step2?.outcome90Days ||
        payload.step2?.contextAnswers?.outcome90Days ||
        payload.step2?.contextAnswers?.successfulOutcome;
    const attemptedAlready = payload.step2?.attemptedAlready || payload.step2?.contextAnswers?.attemptedAlready;
    // Extract step 3 answers
    const decisionInfluence = payload.step3.decisionInfluence ||
        payload.step3.contextAnswers?.decisionInfluence ||
        payload.step3.contextAnswers?.ownDecisions;
    const challengeView = payload.step3.challengeView ||
        payload.step3.contextAnswers?.challengeView ||
        payload.step3.contextAnswers?.recentSituation;
    const authorityToAct = payload.step3.authorityToAct ||
        payload.step3.contextAnswers?.authorityToAct ||
        payload.step3.contextAnswers?.authority;
    const availableForCall = payload.step3.availableForCall ||
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
        submittedAt: (0, email_1.formatOperationalSubmissionDate)(),
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
            const staffContactId = await withRetry(() => (0, ghl_1.upsertContact)({
                email: recipient.email,
                firstName: recipient.firstName,
                lastName: recipient.lastName,
                tags: ['lp-staff', 'internal-notification'],
            }), { retries: 3, delayMs: 500, context: `Upsert Staff Contact (${recipient.email})` });
            if (staffContactId) {
                await withRetry(() => (0, ghl_1.sendEmail)(staffContactId, subject, html), { retries: 3, delayMs: 800, context: `Send Briefing Email (${recipient.email})` });
                console.log(`[Unmasked Private] Notification sent to ${recipient.email} (Ref: ${referenceNumber})`);
            }
        }
        catch (err) {
            console.error(`[Unmasked Private] Failed to send notification to ${recipient.email}:`, err);
        }
    }
}
