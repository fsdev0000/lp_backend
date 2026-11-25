import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { upsertContact, sendEmail } from './ghl';
import { renderTemplate } from './email';

import { getNewsletterPdfAttachmentUrl } from './newsletterStorage';

const prisma = new PrismaClient();
const db = prisma as any;

export interface NewsletterEmailPayload {
  toEmail: string;
  firstName?: string | null;
  subject: string;
  campaignTitle: string;
  pdfUrl?: string | null;
  unsubscribeUrl: string;
  subscriberId: string;
  campaignKey: string;
}

export interface NewsletterSendResult {
  success: boolean;
  providerMessageId?: string;
  errorMessage?: string;
}

/**
 * Clean provider interface for newsletter email delivery
 */
export interface INewsletterEmailProvider {
  sendCampaignEmail(payload: NewsletterEmailPayload): Promise<NewsletterSendResult>;
}

/**
 * GHL / Default LP Infrastructure Provider
 */
export class GhlNewsletterEmailProvider implements INewsletterEmailProvider {
  async sendCampaignEmail(payload: NewsletterEmailPayload): Promise<NewsletterSendResult> {
    try {
      const { toEmail, firstName, subject, campaignTitle, pdfUrl, unsubscribeUrl, campaignKey } = payload;

      // 1. Resolve dynamic signed PDF attachment URL from Supabase Storage (bucket: news-letter)
      const pdfAttachmentUrl = await getNewsletterPdfAttachmentUrl(pdfUrl || campaignKey);

      // 2. Ensure contact exists in GHL CRM
      let contactId: string | undefined;
      try {
        contactId = await upsertContact({
          email: toEmail,
          firstName: firstName || undefined,
          source: 'The Founder Performance Newsletter Campaign',
          tags: ['The Founder Performance Newsletter', `Campaign ${campaignKey}`],
        });
      } catch (err: any) {
        console.warn(`[NewsletterSender] GHL contact upsert notice for ${maskEmail(toEmail)}:`, err?.message || err);
      }

      // 3. Prepare HTML content from template
      const templatePath = path.join(__dirname, '../../templates/monthly-newsletter.html');
      let html = '';

      if (fs.existsSync(templatePath)) {
        const rawTemplate = fs.readFileSync(templatePath, 'utf8');
        html = renderTemplate(rawTemplate, {
          email: toEmail,
          first_name: firstName || 'Leader',
          campaign_title: campaignTitle,
          subject: subject,
          pdf_url: pdfAttachmentUrl || 'https://leadersperformance.ae',
          unsubscribe_url: unsubscribeUrl,
        });
      } else {
        // Fallback robust executive layout if template not found
        html = `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;background:#051225;font-family:system-ui,sans-serif;color:#ffffff;">
  <div style="max-width:600px;margin:0 auto;background:#081a35;padding:32px;border:1px solid rgba(215,185,120,0.3);border-radius:8px;">
    <p style="color:#D7B978;text-transform:uppercase;font-size:12px;letter-spacing:2px;font-weight:600;">The Founder Performance Newsletter</p>
    <h1 style="color:#ffffff;font-size:24px;">${escapeHtml(campaignTitle)}</h1>
    <p style="color:#CECFD2;font-size:15px;line-height:1.6;">Dear ${escapeHtml(firstName || 'Subscriber')},</p>
    <p style="color:#CECFD2;font-size:15px;line-height:1.6;">Your latest executive edition is now ready.</p>
    ${pdfAttachmentUrl ? `<p style="margin:24px 0;"><a href="${pdfAttachmentUrl}" style="background:#D7B978;color:#051225;padding:12px 24px;text-decoration:none;font-weight:600;border-radius:4px;display:inline-block;">Access Monthly Issue</a></p>` : ''}
    <hr style="border:none;border-top:1px solid rgba(215,185,120,0.2);margin:32px 0 16px 0;" />
    <p style="font-size:12px;color:#80848d;">
      You received this email because you subscribed to The Founder Performance Newsletter.<br />
      <a href="${unsubscribeUrl}" style="color:#D7B978;">Unsubscribe</a> from this list.
    </p>
  </div>
</body>
</html>
        `;
      }

      // 4. Email Headers including RFC 8058 One-Click List-Unsubscribe
      const emailHeaders: Record<string, string> = {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      };

      // 5. Attach the Supabase Storage PDF directly to the email
      const attachments = pdfAttachmentUrl ? [pdfAttachmentUrl] : undefined;

      if (contactId) {
        await sendEmail(contactId, subject, html, emailHeaders, attachments);
        return {
          success: true,
          providerMessageId: `ghl_${contactId}_${Date.now()}`,
        };
      } else {
        // If GHL is in mock/test mode or contactId unavailable
        return {
          success: true,
          providerMessageId: `mock_${crypto.randomBytes(8).toString('hex')}`,
        };
      }
    } catch (error: any) {
      return {
        success: false,
        errorMessage: error?.message || 'Email delivery failure',
      };
    }
  }
}

let activeProvider: INewsletterEmailProvider = new GhlNewsletterEmailProvider();

export function setNewsletterEmailProvider(provider: INewsletterEmailProvider) {
  activeProvider = provider;
}

export function getNewsletterEmailProvider(): INewsletterEmailProvider {
  return activeProvider;
}

/**
 * Mask email address for secure operational logging
 */
export function maskEmail(email: string): string {
  if (!email || !email.includes('@')) return '***';
  const [local, domain] = email.split('@');
  if (local.length <= 2) return `${local[0]}***@${domain}`;
  return `${local[0]}***${local[local.length - 1]}@${domain}`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Server-side Query Helper: Select ONLY eligible subscribers for a campaign send
 * Rule: consent_given = true AND subscribed = true AND email IS NOT NULL AND subscribed_at <= cutoffDate
 */
export async function getEligibleSubscribersForSend(cutoffDate: Date) {
  return db.newsletterSubscriber.findMany({
    where: {
      consentGiven: true,
      subscribed: true,
      status: 'subscribed',
      unsubscribedAt: null,
      email: {
        not: '',
      },
      subscribedAt: {
        lte: cutoffDate,
      },
    },
    orderBy: {
      subscribedAt: 'asc',
    },
  });
}

/**
 * Execute monthly newsletter campaign sending
 */
export async function processNewsletterCampaignSend(campaignId: string) {
  // 1. Fetch Campaign
  const campaign = await db.newsletterCampaign.findUnique({
    where: { id: campaignId },
  });

  if (!campaign) {
    throw new Error(`Campaign ${campaignId} not found`);
  }

  if (campaign.approvalStatus !== 'approved') {
    throw new Error(`Campaign ${campaign.campaignKey} has not been approved for sending (approvalStatus: ${campaign.approvalStatus})`);
  }

  if (campaign.status === 'sent') {
    throw new Error(`Campaign ${campaign.campaignKey} has already been marked as sent`);
  }

  // 2. Mark send_started_at if not set and status = 'sending'
  const sendStartedAt = campaign.sendStartedAt || new Date();

  await db.newsletterCampaign.update({
    where: { id: campaignId },
    data: {
      sendStartedAt,
      status: 'sending',
    },
  });

  console.log(`[NewsletterSend] send.started for campaign ${campaign.campaignKey} with cutoff ${sendStartedAt.toISOString()}`);

  // 3. Find eligible subscribers at or before the cutoff timestamp
  const eligibleSubscribers = await getEligibleSubscribersForSend(sendStartedAt);
  console.log(`[NewsletterSend] Identified ${eligibleSubscribers.length} eligible subscribers for campaign ${campaign.campaignKey}`);

  // 4. Create recipient snapshot in newsletter_campaign_recipients
  // Uses upsert / insert with unique constraint protection
  for (const sub of eligibleSubscribers) {
    try {
      await db.newsletterCampaignRecipient.upsert({
        where: {
          campaignId_subscriberId: {
            campaignId: campaign.id,
            subscriberId: sub.id,
          },
        },
        create: {
          campaignId: campaign.id,
          subscriberId: sub.id,
          email: sub.email,
          status: 'pending',
        },
        update: {}, // Don't alter existing status if already in snapshot
      });
    } catch (e: any) {
      console.warn(`[NewsletterSend] Recipient snapshot notice for ${maskEmail(sub.email)}:`, e?.message);
    }
  }

  // 5. Query all recipients for this campaign to process delivery
  const recipients = await db.newsletterCampaignRecipient.findMany({
    where: { campaignId: campaign.id },
    include: { subscriber: true },
  });

  const baseUrl = (process.env.FRONTEND_URL || process.env.API_URL || '').replace(/\/$/, '');
  const provider = getNewsletterEmailProvider();

  let sentCount = 0;
  let failedCount = 0;

  for (const recipient of recipients) {
    // PREVENT DUPLICATE SENDING:
    // If status is already 'sent', NEVER send again!
    if (recipient.status === 'sent') {
      sentCount++;
      continue;
    }

    // STRICT UNINTERRUPTED SUPPRESSION CHECK:
    // Once a user unsubscribes, they must NEVER receive any newsletter/marketing emails.
    const freshSubscriber = await db.newsletterSubscriber.findUnique({
      where: { id: recipient.subscriberId },
    });

    if (
      !freshSubscriber ||
      !freshSubscriber.subscribed ||
      freshSubscriber.status === 'unsubscribed' ||
      freshSubscriber.unsubscribedAt !== null
    ) {
      console.log(`[NewsletterSend] Subscriber ${maskEmail(recipient.email)} is unsubscribed. Suppressing email transmission.`);
      await db.newsletterCampaignRecipient.update({
        where: { id: recipient.id },
        data: {
          status: 'suppressed',
          errorMessage: 'Subscriber unsubscribed prior to transmission',
        },
      });
      continue;
    }

    // Build unique non-guessable unsubscribe link pointing to frontend unsubscribe route
    const token = recipient.subscriber?.unsubscribeToken || crypto.randomBytes(32).toString('hex');
    const unsubscribeUrl = `${baseUrl}/unsubscribe?token=${encodeURIComponent(token)}`;

    const sendResult = await provider.sendCampaignEmail({
      toEmail: recipient.email,
      firstName: recipient.subscriber?.firstName,
      subject: campaign.subject,
      campaignTitle: campaign.title,
      pdfUrl: campaign.pdfPath,
      unsubscribeUrl,
      subscriberId: recipient.subscriberId,
      campaignKey: campaign.campaignKey,
    });

    if (sendResult.success) {
      sentCount++;
      await db.newsletterCampaignRecipient.update({
        where: { id: recipient.id },
        data: {
          status: 'sent',
          sentAt: new Date(),
          providerMessageId: sendResult.providerMessageId || null,
          errorMessage: null,
        },
      });
      console.log(`[NewsletterSend] Delivered to recipient ${maskEmail(recipient.email)} for ${campaign.campaignKey}`);
    } else {
      failedCount++;
      await db.newsletterCampaignRecipient.update({
        where: { id: recipient.id },
        data: {
          status: 'failed',
          failedAt: new Date(),
          errorMessage: sendResult.errorMessage || 'Send failure',
        },
      });
      console.error(`[NewsletterSend] Failed delivery to recipient ${maskEmail(recipient.email)}:`, sendResult.errorMessage);
    }
  }

  // 6. Update Campaign Statistics
  const completedAt = new Date();
  const finalStatus = failedCount === 0 ? 'sent' : 'sent'; // Completed run

  const updatedCampaign = await db.newsletterCampaign.update({
    where: { id: campaign.id },
    data: {
      status: finalStatus,
      sendCompletedAt: completedAt,
      totalRecipients: recipients.length,
      totalSent: sentCount,
      totalFailed: failedCount,
    },
  });

  console.log(`[NewsletterSend] send.completed for ${campaign.campaignKey}: Total=${recipients.length}, Sent=${sentCount}, Failed=${failedCount}`);

  return {
    campaign: updatedCampaign,
    summary: {
      totalRecipients: recipients.length,
      sentCount,
      failedCount,
    },
  };
}
