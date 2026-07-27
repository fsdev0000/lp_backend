import fs from 'fs';
import path from 'path';
import { sendEmail } from './ghl';

// Interpolates variables like {{name}} into the template
function renderTemplate(templateHtml: string, variables: Record<string, string>): string {
  let rendered = templateHtml;
  for (const [key, value] of Object.entries(variables)) {
    const regex = new RegExp(`{{${key}}}`, 'g');
    rendered = rendered.replace(regex, value || '');
  }
  return rendered;
}

export async function sendAssessmentEmail(contactId: string, emailData: { tier: string, firstName: string, score: number }) {
  let templateName = 'strong.html';
  if (emailData.tier.toLowerCase() === 'critical') templateName = 'critical.html';
  else if (emailData.tier.toLowerCase() === 'moderate') templateName = 'moderate.html';

  const templatePath = path.join(__dirname, '../../templates', templateName);
  
  try {
    const rawTemplate = fs.readFileSync(templatePath, 'utf8');
    
    const html = renderTemplate(rawTemplate, {
      name: emailData.firstName,
      SCORE: emailData.score.toString(),
      strategic_url: 'https://leadersperformance.ae', // Placeholder
      daisy_url: 'https://leadersperformance.ae', // Placeholder
      unsubscribe_url: '#',
    });
    
    await sendEmail(contactId, `Your Founder Pressure Profile is ready`, html);
    console.log(`[SUCCESS] Founder Email Sent: Delivered ${templateName} to contact ${contactId} (${emailData.firstName})`);
  } catch (error) {
    console.error(`[ERROR] Failed to load or send Founder email (${templateName}):`, error);
  }
}

export async function sendAdminBriefing(founderData: { name: string, email: string, score: number, tier: string, company: string, phone: string }, adminContactIds: string[]) {
  const templatePath = path.join(__dirname, '../../templates/internal-consultant-briefing.html');
  
  try {
    const rawTemplate = fs.readFileSync(templatePath, 'utf8');
    const html = renderTemplate(rawTemplate, {
      name: founderData.name,
      email: founderData.email,
      score: founderData.score.toString(),
      tier: founderData.tier,
      company: founderData.company || 'Unknown',
      // phone: founderData.phone || 'Unknown',
    });
    
    for (const adminContactId of adminContactIds) {
       await sendEmail(adminContactId, `Internal Notification: Founder Assessment (${founderData.score})`, html);
       console.log(`[SUCCESS] Admin Email Sent: Delivered briefing to contact ${adminContactId}`);
    }
  } catch (error) {
    console.error(`[ERROR] Failed to send Admin briefing:`, error);
  }
}
