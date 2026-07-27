"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendAssessmentEmail = sendAssessmentEmail;
exports.sendAdminBriefing = sendAdminBriefing;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const ghl_1 = require("./ghl");
// Interpolates variables like {{name}} into the template
function renderTemplate(templateHtml, variables) {
    let rendered = templateHtml;
    for (const [key, value] of Object.entries(variables)) {
        const regex = new RegExp(`{{${key}}}`, 'g');
        rendered = rendered.replace(regex, value || '');
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
        const html = renderTemplate(rawTemplate, {
            name: emailData.firstName,
            SCORE: emailData.score.toString(),
            strategic_url: 'https://leadersperformance.ae', // Placeholder
            daisy_url: 'https://leadersperformance.ae', // Placeholder
            unsubscribe_url: '#',
        });
        await (0, ghl_1.sendEmail)(contactId, `Your Founder Pressure Profile is ready`, html);
        console.log(`[SUCCESS] Founder Email Sent: Delivered ${templateName} to contact ${contactId} (${emailData.firstName})`);
    }
    catch (error) {
        console.error(`[ERROR] Failed to load or send Founder email (${templateName}):`, error);
    }
}
async function sendAdminBriefing(founderData, adminContactIds) {
    const templatePath = path_1.default.join(__dirname, '../../templates/internal-consultant-briefing.html');
    try {
        const rawTemplate = fs_1.default.readFileSync(templatePath, 'utf8');
        const html = renderTemplate(rawTemplate, {
            name: founderData.name,
            email: founderData.email,
            score: founderData.score.toString(),
            tier: founderData.tier,
            company: founderData.company || 'Unknown',
            // phone: founderData.phone || 'Unknown',
        });
        for (const adminContactId of adminContactIds) {
            await (0, ghl_1.sendEmail)(adminContactId, `Internal Notification: Founder Assessment (${founderData.score})`, html);
            console.log(`[SUCCESS] Admin Email Sent: Delivered briefing to contact ${adminContactId}`);
        }
    }
    catch (error) {
        console.error(`[ERROR] Failed to send Admin briefing:`, error);
    }
}
