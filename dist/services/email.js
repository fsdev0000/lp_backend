"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.escapeHtml = escapeHtml;
exports.formatOperationalSubmissionDate = formatOperationalSubmissionDate;
exports.generateReferenceNumber = generateReferenceNumber;
exports.getSecureReviewUrl = getSecureReviewUrl;
exports.renderTemplate = renderTemplate;
exports.sendAssessmentEmail = sendAssessmentEmail;
exports.buildAdminBriefingEmail = buildAdminBriefingEmail;
exports.sendAdminBriefing = sendAdminBriefing;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const ghl_1 = require("./ghl");
const secrets_1 = require("./secrets");
// Safely escapes dynamic user-provided strings for HTML injection
function escapeHtml(str) {
    if (str === null || str === undefined)
        return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
// Formats submission date and time using operational timezone supplied by the system
function formatOperationalSubmissionDate(dateInput) {
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
        const partMap = {};
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
    }
    catch (err) {
        return date.toUTCString();
    }
}
// Generates a reference number if not provided (e.g. FPS-2026-6418)
function generateReferenceNumber() {
    const year = new Date().getFullYear();
    const seq = String(Math.floor(1000 + Math.random() * 9000));
    return `FPS-${year}-${seq}`;
}
// Resolves the secure review URL pointing to authenticated internal CRM/portal
async function getSecureReviewUrl() {
    if (process.env.INTERNAL_REVIEW_URL) {
        return process.env.INTERNAL_REVIEW_URL;
    }
    try {
        const locationId = (await (0, secrets_1.getSecret)('GHL_LOCATION_ID').catch(() => null)) || process.env.GHL_LOCATION_ID;
        if (locationId) {
            return `https://app.gohighlevel.com/v2/location/${encodeURIComponent(locationId)}/opportunities`;
        }
    }
    catch {
        // ignore
    }
    return 'https://leadersperformance.ae/admin/review';
}
// Interpolates variables like {{name}} into the template
function renderTemplate(templateHtml, variables) {
    let rendered = templateHtml;
    for (const [key, value] of Object.entries(variables)) {
        const regex = new RegExp(`{{${key}}}`, 'g');
        rendered = rendered.replace(regex, value ?? '');
    }
    return rendered;
}
async function sendAssessmentEmail(contactId, emailData) {
    let templateName = 'strong.html';
    if (emailData.tier.toLowerCase() === 'critical')
        templateName = 'critical.html';
    else if (emailData.tier.toLowerCase() === 'moderate')
        templateName = 'moderate.html';
    const templatePath = path_1.default.join(__dirname, '../../templates', templateName);
    try {
        const rawTemplate = fs_1.default.readFileSync(templatePath, 'utf8');
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:8080';
        const redirectUrl = `${frontendUrl}?session_id=${emailData.sessionId}`;
        const html = renderTemplate(rawTemplate, {
            name: emailData.firstName,
            SCORE: emailData.score.toString(),
            strategic_url: redirectUrl,
            daisy_url: redirectUrl,
            unsubscribe_url: '#',
        });
        await (0, ghl_1.sendEmail)(contactId, `Your Founder Pressure Profile is ready`, html);
        console.log(`[SUCCESS] Founder Email Sent: Delivered ${templateName} to contact ${contactId} (${emailData.firstName})`);
    }
    catch (error) {
        console.error(`[ERROR] Failed to load or send Founder email (${templateName}):`, error);
    }
}
async function buildAdminBriefingEmail(founderData) {
    const templatePath = path_1.default.join(__dirname, '../../templates/internal-consultant-briefing.html');
    const rawTemplate = fs_1.default.readFileSync(templatePath, 'utf8');
    const participantName = (founderData.participant_name || founderData.name || 'Anonymous Founder').trim();
    const companyName = (founderData.company_name || founderData.company || 'Confidential').trim();
    const referenceNumber = (founderData.reference_number || founderData.ref || generateReferenceNumber()).trim();
    const submittedAt = formatOperationalSubmissionDate(founderData.submission_date);
    const reviewStatus = (founderData.review_status || 'Awaiting Human Review').trim();
    const reviewUrl = '#';
    const initialReason = (founderData.initial_reason ||
        founderData.reason ||
        'We are preparing for the next stage of growth and I want to understand where my involvement may be limiting leadership ownership and execution.').trim();
    // Subject requirement: New Founder Pressure Scan Submission — [Company Name] — [Reference Number]
    const subject = `New Founder Pressure Scan Submission — ${companyName} — ${referenceNumber}`;
    // Safe HTML template variables map (strictly excluding raw scores, tiers, answers, or consultant diagnostics)
    const variables = {
        participant_name: escapeHtml(participantName),
        company_name: escapeHtml(companyName),
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
async function sendAdminBriefing(founderData, adminContactIds) {
    try {
        const { subject, html, referenceNumber, companyName } = await buildAdminBriefingEmail(founderData);
        for (const adminContactId of adminContactIds) {
            if (adminContactId) {
                await (0, ghl_1.sendEmail)(adminContactId, subject, html);
                console.log(`[SUCCESS] Admin Email Sent: Delivered briefing to contact ${adminContactId} (Company: ${companyName}, Ref: ${referenceNumber})`);
            }
        }
    }
    catch (error) {
        console.error(`[ERROR] Failed to send Admin briefing:`, error);
    }
}
