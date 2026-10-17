import fs from 'fs';
import path from 'path';
import Stripe from 'stripe';
import { PrismaClient } from '@prisma/client';
import { getStripeClient, recordEventProcessed } from './stripeWebhookService';
import { upsertContact, sendEmail } from './ghl';

const prisma = new PrismaClient();

export interface BookInvoiceEmailData {
  customerEmail: string;
  customerName?: string | null;
  amountPaidCents?: number | null;
  currency?: string | null;
  paidAt?: Date | string | null;
  stripeSessionId: string;
  stripePaymentIntentId?: string | null;
  invoiceNumber?: string | null;
  hostedInvoiceUrl?: string | null;
  invoicePdf?: string | null;
  version: 'en' | 'nl';
}

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function loadTemplate(filename: string): string {
  const possiblePaths = [
    path.join(__dirname, '../../templates', filename),
    path.join(__dirname, '../../../templates', filename),
    path.join(process.cwd(), 'templates', filename),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, 'utf8');
    }
  }
  return '';
}

function formatDubaiDate(date?: Date | string | null, version: 'en' | 'nl' = 'en'): string {
  try {
    const d = date ? new Date(date) : new Date();
    if (version === 'nl') {
      return (
        d.toLocaleString('nl-NL', {
          timeZone: 'Asia/Dubai',
          day: 'numeric',
          month: 'long',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }) + ' GST (Dubai)'
      );
    }
    return (
      d.toLocaleString('en-US', {
        timeZone: 'Asia/Dubai',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }) + ' GST (Dubai)'
    );
  } catch {
    return new Date().toUTCString();
  }
}

/**
 * Resolves the Frontend URL dynamically from environment variables.
 * Checks FRONTEND_URL or falls back to 'https://leadersperformance.ae'.
 */
export function getFrontendUrl(): string {
  const url = process.env.FRONTEND_URL || 'https://leadersperformance.ae';
  return url.replace(/\/$/, '');
}

/**
 * Resolves the Backend API URL dynamically from environment variables.
 * Checks BACKEND_URL, API_URL, or falls back to getFrontendUrl().
 */
export function getBackendUrl(): string {
  const url = process.env.BACKEND_URL || process.env.API_URL || process.env.API_BASE_URL || getFrontendUrl();
  return url.replace(/\/$/, '');
}

/**
 * Resolves direct PDF invoice download URL from Stripe invoice data.
 */
function resolveInvoiceDownloadUrl(
  invoicePdf?: string | null,
  hostedInvoiceUrl?: string | null,
  sessionId?: string,
  version: 'en' | 'nl' = 'en'
): string {
  if (invoicePdf && invoicePdf.startsWith('http')) {
    return invoicePdf;
  }
  if (hostedInvoiceUrl && hostedInvoiceUrl.startsWith('http')) {
    if (hostedInvoiceUrl.includes('/pdf')) {
      return hostedInvoiceUrl;
    }
    if (hostedInvoiceUrl.includes('invoice.stripe.com')) {
      return `${hostedInvoiceUrl.replace(/\/$/, '')}/pdf`;
    }
    return hostedInvoiceUrl;
  }
  const frontendUrl = getFrontendUrl();
  return `${frontendUrl}/payment-success?session_id=${encodeURIComponent(
    sessionId || ''
  )}&version=${version}&book=reset-by-discipline`;
}

/**
 * Resolves customer download URL, redirecting the customer to the frontend
 * payment-success page where the verified download button and access are presented.
 */
export function resolveCustomerDownloadUrl(sessionId: string, version: 'en' | 'nl'): string {
  const frontendUrl = getFrontendUrl();
  return `${frontendUrl}/payment-success?session_id=${encodeURIComponent(
    sessionId
  )}&version=${version}&book=reset-by-discipline`;
}

/**
 * Resolves direct PDF book download URL from backend API for staff.
 */
export function resolveStaffBookDownloadUrl(sessionId: string): string {
  const backendUrl = getBackendUrl();
  return `${backendUrl}/api/download?session_id=${encodeURIComponent(sessionId)}`;
}

/**
 * Builds customer email HTML for English or Dutch text version.
 */
export function buildBookInvoiceEmailHtml(data: BookInvoiceEmailData): string {
  const isDutch = data.version === 'nl';
  const templateName = isDutch
    ? 'book-invoice-confirmation-nl.html'
    : 'book-invoice-confirmation-en.html';
  const rawTemplate = loadTemplate(templateName);

  const frontendUrl = getFrontendUrl();
  const bookUrl = `${frontendUrl}/knowledge?book-name=reset-by-discipline&version=${data.version}#reset-by-discipline`;
  const downloadUrl = resolveCustomerDownloadUrl(data.stripeSessionId, data.version);
  const invoiceDownloadUrl = resolveInvoiceDownloadUrl(
    data.invoicePdf,
    data.hostedInvoiceUrl,
    data.stripeSessionId,
    data.version
  );

  const invoiceNumber = data.invoiceNumber || `INV-BK-${data.stripeSessionId.slice(-8).toUpperCase()}`;
  const defaultName = isDutch ? 'Lezer' : 'Reader';
  const fullName = escapeHtml(data.customerName || defaultName);
  const email = escapeHtml(data.customerEmail);
  const paidAtFormatted = formatDubaiDate(data.paidAt, data.version);
  const amountPaidCents = data.amountPaidCents ?? 1999;
  const amountPaidFormatted = (amountPaidCents / 100).toFixed(2);

  let invoiceLinksHtml = '';
  if (isDutch) {
    invoiceLinksHtml += `<td style="padding: 0 10px;"><a href="${escapeHtml(
      invoiceDownloadUrl
    )}" target="_blank" style="color: #9f6511; font-family: 'Inter', Arial, sans-serif; font-size: 13.5px; font-weight: 700; text-decoration: underline;">Download Btw-factuur (PDF) &darr;</a></td>`;
    if (data.hostedInvoiceUrl && data.hostedInvoiceUrl !== invoiceDownloadUrl) {
      invoiceLinksHtml += `<td style="padding: 0 10px;"><a href="${escapeHtml(
        data.hostedInvoiceUrl
      )}" target="_blank" style="color: #9f6511; font-family: 'Inter', Arial, sans-serif; font-size: 13.5px; font-weight: 600; text-decoration: underline;">Bekijk Online Factuur &rarr;</a></td>`;
    }
  } else {
    invoiceLinksHtml += `<td style="padding: 0 10px;"><a href="${escapeHtml(
      invoiceDownloadUrl
    )}" target="_blank" style="color: #9f6511; font-family: 'Inter', Arial, sans-serif; font-size: 13.5px; font-weight: 700; text-decoration: underline;">Download Tax Invoice (PDF) &darr;</a></td>`;
    if (data.hostedInvoiceUrl && data.hostedInvoiceUrl !== invoiceDownloadUrl) {
      invoiceLinksHtml += `<td style="padding: 0 10px;"><a href="${escapeHtml(
        data.hostedInvoiceUrl
      )}" target="_blank" style="color: #9f6511; font-family: 'Inter', Arial, sans-serif; font-size: 13.5px; font-weight: 600; text-decoration: underline;">View Online Invoice &rarr;</a></td>`;
    }
  }

  if (rawTemplate) {
    return rawTemplate
      .replace(/{{invoice_number}}/g, escapeHtml(invoiceNumber))
      .replace(/{{full_name}}/g, fullName)
      .replace(/{{email}}/g, email)
      .replace(/{{paid_at}}/g, escapeHtml(paidAtFormatted))
      .replace(/{{amount_paid_formatted}}/g, amountPaidFormatted)
      .replace(/{{download_url}}/g, escapeHtml(downloadUrl))
      .replace(/{{book_url}}/g, escapeHtml(bookUrl))
      .replace(/{{invoice_download_url}}/g, escapeHtml(invoiceDownloadUrl))
      .replace(/{{invoice_links_html}}/g, invoiceLinksHtml);
  }

  // Minimal fallback if template file fails to load
  return isDutch
    ? `<!DOCTYPE html><html><body><h1>Reset door Discipline — Factuur</h1><p>Factuurnummer: ${escapeHtml(
        invoiceNumber
      )}</p><p>Bedrag: US $${amountPaidFormatted}</p><p><a href="${escapeHtml(
        downloadUrl
      )}">Download Boek (PDF)</a></p><p><a href="${escapeHtml(
        invoiceDownloadUrl
      )}">Download Btw-factuur (PDF)</a></p></body></html>`
    : `<!DOCTYPE html><html><body><h1>Reset by Discipline — Invoice</h1><p>Invoice: ${escapeHtml(
        invoiceNumber
      )}</p><p>Amount: US $${amountPaidFormatted}</p><p><a href="${escapeHtml(
        downloadUrl
      )}">Download Book (PDF)</a></p><p><a href="${escapeHtml(
        invoiceDownloadUrl
      )}">Download Tax Invoice (PDF)</a></p></body></html>`;
}

/**
 * Builds staff notification email HTML for English or Dutch text version.
 */
export function buildBookStaffAlertHtml(data: BookInvoiceEmailData): string {
  const isDutch = data.version === 'nl';
  const templateName = isDutch ? 'book-staff-alert-nl.html' : 'book-staff-alert-en.html';
  const rawTemplate = loadTemplate(templateName);

  const invoiceNumber = data.invoiceNumber || `INV-BK-${data.stripeSessionId.slice(-8).toUpperCase()}`;
  const defaultName = isDutch ? 'Lezer' : 'Reader';
  const fullName = escapeHtml(data.customerName || defaultName);
  const email = escapeHtml(data.customerEmail);
  const paidAtFormatted = formatDubaiDate(data.paidAt, data.version);
  const amountPaidCents = data.amountPaidCents ?? 1999;
  const amountPaidFormatted = (amountPaidCents / 100).toFixed(2);
  const currency = escapeHtml((data.currency || 'usd').toUpperCase());
  const downloadUrl = resolveStaffBookDownloadUrl(data.stripeSessionId);
  const invoiceDownloadUrl = resolveInvoiceDownloadUrl(
    data.invoicePdf,
    data.hostedInvoiceUrl,
    data.stripeSessionId,
    data.version
  );

  let staffActionButtonsHtml = '';
  if (isDutch) {
    staffActionButtonsHtml += `
      <td style="padding-right: 12px; padding-bottom: 10px;">
        <a href="${escapeHtml(invoiceDownloadUrl)}" target="_blank" style="display: inline-block; background-color: #021329; border: 1px solid #d0a35a; color: #d0a35a; text-decoration: none; font-family: 'Inter', Arial, sans-serif; font-size: 14px; font-weight: 600; line-height: 20px; padding: 12px 22px; text-align: center; border-radius: 2px;">
          Download PDF Factuur&nbsp;&nbsp;&darr;
        </a>
      </td>
    `;
    if (data.hostedInvoiceUrl && data.hostedInvoiceUrl !== invoiceDownloadUrl) {
      staffActionButtonsHtml += `
        <td style="padding-right: 12px; padding-bottom: 10px;">
          <a href="${escapeHtml(data.hostedInvoiceUrl)}" target="_blank" style="display: inline-block; background-color: #d0a35a; border: 1px solid #d0a35a; color: #010d20; text-decoration: none; font-family: 'Inter', Arial, sans-serif; font-size: 14px; font-weight: 600; line-height: 20px; padding: 12px 22px; text-align: center; border-radius: 2px;">
            Bekijk Stripe Btw-factuur&nbsp;&nbsp;&rarr;
          </a>
        </td>
      `;
    }
    staffActionButtonsHtml += `
      <td style="padding-right: 12px; padding-bottom: 10px;">
        <a href="${escapeHtml(downloadUrl)}" target="_blank" style="display: inline-block; background-color: transparent; border: 1px solid #021329; color: #010d20; text-decoration: none; font-family: 'Inter', Arial, sans-serif; font-size: 14px; font-weight: 600; line-height: 20px; padding: 12px 22px; text-align: center; border-radius: 2px;">
          Download Boek PDF&nbsp;&nbsp;&darr;
        </a>
      </td>
    `;
  } else {
    staffActionButtonsHtml += `
      <td style="padding-right: 12px; padding-bottom: 10px;">
        <a href="${escapeHtml(invoiceDownloadUrl)}" target="_blank" style="display: inline-block; background-color: #021329; border: 1px solid #d0a35a; color: #d0a35a; text-decoration: none; font-family: 'Inter', Arial, sans-serif; font-size: 14px; font-weight: 600; line-height: 20px; padding: 12px 22px; text-align: center; border-radius: 2px;">
          Download PDF Invoice&nbsp;&nbsp;&darr;
        </a>
      </td>
    `;
    if (data.hostedInvoiceUrl && data.hostedInvoiceUrl !== invoiceDownloadUrl) {
      staffActionButtonsHtml += `
        <td style="padding-right: 12px; padding-bottom: 10px;">
          <a href="${escapeHtml(data.hostedInvoiceUrl)}" target="_blank" style="display: inline-block; background-color: #d0a35a; border: 1px solid #d0a35a; color: #010d20; text-decoration: none; font-family: 'Inter', Arial, sans-serif; font-size: 14px; font-weight: 600; line-height: 20px; padding: 12px 22px; text-align: center; border-radius: 2px;">
            View Stripe Tax Invoice&nbsp;&nbsp;&rarr;
          </a>
        </td>
      `;
    }
    staffActionButtonsHtml += `
      <td style="padding-right: 12px; padding-bottom: 10px;">
        <a href="${escapeHtml(downloadUrl)}" target="_blank" style="display: inline-block; background-color: transparent; border: 1px solid #021329; color: #010d20; text-decoration: none; font-family: 'Inter', Arial, sans-serif; font-size: 14px; font-weight: 600; line-height: 20px; padding: 12px 22px; text-align: center; border-radius: 2px;">
          Download Book PDF&nbsp;&nbsp;&darr;
        </a>
      </td>
    `;
  }

  if (rawTemplate) {
    return rawTemplate
      .replace(/{{full_name}}/g, fullName)
      .replace(/{{email}}/g, email)
      .replace(/{{paid_at}}/g, escapeHtml(paidAtFormatted))
      .replace(/{{amount_paid_formatted}}/g, amountPaidFormatted)
      .replace(/{{currency}}/g, currency)
      .replace(/{{invoice_number}}/g, escapeHtml(invoiceNumber))
      .replace(/{{stripe_session_id}}/g, escapeHtml(data.stripeSessionId))
      .replace(/{{stripe_payment_intent_id}}/g, escapeHtml(data.stripePaymentIntentId || 'N/A'))
      .replace(/{{download_url}}/g, escapeHtml(downloadUrl))
      .replace(/{{invoice_download_url}}/g, escapeHtml(invoiceDownloadUrl))
      .replace(/{{staff_action_buttons_html}}/g, staffActionButtonsHtml);
  }

  return `<!DOCTYPE html><html><body><h1>[Staff Alert] New Book Purchase (${data.version.toUpperCase()})</h1><p>Customer: ${fullName} (${email})</p><p>Amount: US $${amountPaidFormatted} ${currency}</p><p>Invoice: ${escapeHtml(
    invoiceNumber
  )}</p><p><a href="${escapeHtml(invoiceDownloadUrl)}">Download PDF Invoice</a></p></body></html>`;
}

/**
 * Dispatches confirmation & invoice email to customer and notification email to staff.
 * Idempotently tracked via SystemLog to prevent any duplicate dispatch.
 */
export async function sendBookPurchaseEmails(
  data: BookInvoiceEmailData
): Promise<{ customerDelivered: boolean; staffDelivered: boolean }> {
  const isDutch = data.version === 'nl';
  const invoiceNumber = data.invoiceNumber || `INV-BK-${data.stripeSessionId.slice(-8).toUpperCase()}`;
  const amountPaidCents = data.amountPaidCents ?? 1999;
  const amountPaidFormatted = (amountPaidCents / 100).toFixed(2);
  let customerDelivered = false;
  let staffDelivered = false;

  // 1. Dispatch invoice email to customer in their purchased language
  try {
    const contactId = await upsertContact({
      email: data.customerEmail,
      firstName: data.customerName?.split(' ')[0] || (isDutch ? 'Lezer' : 'Reader'),
      lastName: data.customerName?.split(' ').slice(1).join(' ') || undefined,
      tags: [
        'Book Customer',
        'Reset by Discipline',
        isDutch ? 'Reset by Discipline Dutch' : 'Reset by Discipline English',
        'Invoice Sent',
      ],
    });

    if (contactId) {
      const customerSubject = isDutch
        ? `Reset door Discipline — Betalingsbewijs & Btw-factuur (${invoiceNumber})`
        : `Reset by Discipline — Payment Receipt & Tax Invoice (${invoiceNumber})`;
      const customerHtml = buildBookInvoiceEmailHtml(data);
      await sendEmail(contactId, customerSubject, customerHtml);
      console.log(
        `[Book Invoice] Successfully delivered invoice email to customer ${data.customerEmail} (${data.version.toUpperCase()}, Invoice: ${invoiceNumber})`
      );
      customerDelivered = true;
    }
  } catch (err: any) {
    console.warn('[Book Invoice] Notice dispatching invoice email to customer:', err.message);
  }

  // 2. Dispatch staff alert email to info@leadersperformance.ae in the appropriate language
  try {
    const staffContactId = await upsertContact({
      email: 'info@leadersperformance.ae',
      firstName: 'Leaders',
      lastName: 'Performance',
      tags: [
        'lp-staff',
        'internal-notification',
        isDutch ? 'book-sale-dutch' : 'book-sale-english',
      ],
    });

    if (staffContactId) {
      const editionLabel = isDutch ? 'Nederlandse Editie' : 'English Edition';
      const staffSubject = isDutch
        ? `[Boek Aangeschaft] ${data.customerName || 'Klant'} (${data.customerEmail}) — US $${amountPaidFormatted} — Factuur ${invoiceNumber} (${editionLabel})`
        : `[Book Purchased] ${data.customerName || 'Customer'} (${data.customerEmail}) — US $${amountPaidFormatted} — Invoice ${invoiceNumber} (${editionLabel})`;
      const staffHtml = buildBookStaffAlertHtml(data);
      await sendEmail(staffContactId, staffSubject, staffHtml);
      console.log(`[Book Invoice] Staff sale alert delivered to: info@leadersperformance.ae (${data.version.toUpperCase()})`);
      staffDelivered = true;
    }
  } catch (err: any) {
    console.warn('[Book Invoice] Notice dispatching staff alert email to info@leadersperformance.ae:', err.message);
  }

  // Record delivery in SystemLog to guarantee strict idempotency
  if (customerDelivered || staffDelivered) {
    try {
      await prisma.systemLog.create({
        data: {
          level: 'info',
          action: 'BOOK_INVOICE_EMAIL_SENT',
          details: JSON.stringify({
            sessionId: data.stripeSessionId,
            version: data.version,
            customerEmail: data.customerEmail,
            invoiceNumber,
            customerDelivered,
            staffDelivered,
            sentAt: new Date().toISOString(),
          }),
        },
      });
    } catch (logErr: any) {
      console.warn('[Book Invoice] Notice recording email delivery log:', logErr.message);
    }
  }

  return { customerDelivered, staffDelivered };
}

/**
 * Check whether emails have already been dispatched for this session.
 */
export async function isBookInvoiceEmailSent(sessionId: string): Promise<boolean> {
  try {
    const existing = await prisma.systemLog.findFirst({
      where: {
        action: 'BOOK_INVOICE_EMAIL_SENT',
        details: { contains: sessionId },
      },
    });
    return Boolean(existing);
  } catch {
    return false;
  }
}

/**
 * Identifies if a Stripe Checkout session represents a text version book purchase.
 */
export function isTextBookSession(session: Stripe.Checkout.Session): boolean {
  // Not an audiobook session
  if (
    session.metadata?.productType === 'audiobook' ||
    session.metadata?.bookId === 'reset-by-discipline'
  ) {
    return false;
  }

  // Not a masterclass session
  if (session.metadata?.enrollmentId) {
    return false;
  }

  // Matches text version indicators
  const productMeta = (session.metadata?.product || '').toLowerCase();
  const versionMeta = (session.metadata?.version || '').toLowerCase();
  const returnPath = (session.metadata?.returnPath || '').toLowerCase();

  if (
    productMeta.includes('reset by discipline') ||
    productMeta.includes('reset door discipline') ||
    productMeta.includes('edition')
  ) {
    return true;
  }

  if (versionMeta === 'nl' || versionMeta === 'en' || versionMeta === 'dutch' || versionMeta === 'english') {
    return true;
  }

  if (returnPath.includes('reset-by-discipline') || returnPath.includes('book-name=')) {
    return true;
  }

  // Check line items if available
  const bookPriceIds = [
    process.env.STRIPE_BOOK_PRICE_ID_EN,
    process.env.STRIPE_BOOK_PRICE_ID_NL,
    process.env.STRIPE_BOOK_PRICE_ID,
  ].filter(Boolean) as string[];

  if (session.line_items?.data && bookPriceIds.length > 0) {
    return session.line_items.data.some((item) => item.price?.id && bookPriceIds.includes(item.price.id));
  }

  return false;
}

/**
 * Resolves the book version ('en' | 'nl') from a checkout session.
 */
export function detectBookVersion(session: Stripe.Checkout.Session): 'nl' | 'en' {
  const metaVersion = (session.metadata?.version || '').toLowerCase().trim();
  if (metaVersion === 'nl' || metaVersion === 'dutch') return 'nl';
  if (metaVersion === 'en' || metaVersion === 'english') return 'en';

  const productMeta = (session.metadata?.product || '').toLowerCase();
  if (productMeta.includes('dutch') || productMeta.includes('door discipline')) return 'nl';

  const nlPriceId = process.env.STRIPE_BOOK_PRICE_ID_NL;
  if (nlPriceId && session.line_items?.data) {
    if (session.line_items.data.some((item) => item.price?.id === nlPriceId)) {
      return 'nl';
    }
  }

  const returnPath = (session.metadata?.returnPath || '').toLowerCase();
  if (returnPath.includes('version=nl') || returnPath.includes('lang=nl')) {
    return 'nl';
  }

  return 'en';
}

/**
 * Webhook fulfiller for Stripe events matching Reset by Discipline Text purchases.
 */
export async function handleTextBookWebhookSession(
  session: Stripe.Checkout.Session,
  eventId: string,
  eventType: string
): Promise<boolean> {
  if (!isTextBookSession(session)) {
    return false;
  }

  const sessionId = session.id;
  const isPaid = session.payment_status === 'paid';
  const version = detectBookVersion(session);

  console.log(`[Book Webhook] Processing event ${eventId} (${eventType}) for session ${sessionId} [Version: ${version.toUpperCase()}]`);

  if (eventType === 'checkout.session.completed' || eventType === 'checkout.session.async_payment_succeeded') {
    const customerEmail = session.customer_details?.email || session.customer_email || null;
    const customerName = session.customer_details?.name || null;
    const amount = session.amount_total;
    const paymentIntentId =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id || null;

    if (isPaid && customerEmail) {
      // Idempotency check: prevent sending duplicate emails for the same payment session
      const alreadySent = await isBookInvoiceEmailSent(sessionId);
      if (alreadySent) {
        console.log(`[Book Webhook] Idempotency: Invoice emails already sent for session ${sessionId}. Skipping duplicate.`);
      } else {
        let invoiceNumber: string | null = null;
        let hostedInvoiceUrl: string | null = null;
        let invoicePdf: string | null = null;

        try {
          const stripe = getStripeClient();
          if (session.invoice) {
            const invObj =
              typeof session.invoice === 'string'
                ? await stripe.invoices.retrieve(session.invoice)
                : session.invoice;
            if (invObj) {
              invoiceNumber = invObj.number || invObj.id || null;
              hostedInvoiceUrl = invObj.hosted_invoice_url ?? null;
              invoicePdf = invObj.invoice_pdf ?? null;
            }
          }
          if (!hostedInvoiceUrl && paymentIntentId) {
            const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
              expand: ['latest_charge'],
            });
            const charge = pi.latest_charge as Stripe.Charge | undefined;
            if (charge?.receipt_url) {
              hostedInvoiceUrl = charge.receipt_url;
            }
          }
        } catch (invErr: any) {
          console.warn('[Book Webhook] Notice retrieving invoice details:', invErr.message);
        }

        await sendBookPurchaseEmails({
          customerEmail,
          customerName,
          amountPaidCents: amount ?? 1999,
          currency: session.currency || 'usd',
          paidAt: new Date(),
          stripeSessionId: sessionId,
          stripePaymentIntentId: paymentIntentId,
          invoiceNumber: invoiceNumber || `INV-BK-${sessionId.slice(-8).toUpperCase()}`,
          hostedInvoiceUrl,
          invoicePdf,
          version,
        });
      }
    }

    await recordEventProcessed(eventId, eventType, {
      productType: 'text-book',
      version,
      sessionId,
      paid: isPaid,
    });
    return true;
  }

  if (eventType === 'checkout.session.async_payment_failed' || eventType === 'checkout.session.expired') {
    await recordEventProcessed(eventId, eventType, {
      productType: 'text-book',
      version,
      sessionId,
      status: eventType.includes('failed') ? 'failed' : 'expired',
    });
    return true;
  }

  return false;
}

/**
 * Idempotently triggers invoice and notification emails if payment is verified and not already sent.
 * Useful as a safety net when the client lands on payment-success or checks payment-status.
 */
export async function sendTextBookPurchaseEmailsIfPending(
  sessionId: string,
  session?: Stripe.Checkout.Session | null
): Promise<boolean> {
  const alreadySent = await isBookInvoiceEmailSent(sessionId);
  if (alreadySent) return false;

  const stripe = getStripeClient();
  const checkoutSession = session || (await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['line_items'],
  }));

  if (!checkoutSession || checkoutSession.payment_status !== 'paid') {
    return false;
  }

  if (!isTextBookSession(checkoutSession)) {
    return false;
  }

  const customerEmail = checkoutSession.customer_details?.email || checkoutSession.customer_email;
  if (!customerEmail) return false;

  const version = detectBookVersion(checkoutSession);
  const paymentIntentId =
    typeof checkoutSession.payment_intent === 'string'
      ? checkoutSession.payment_intent
      : checkoutSession.payment_intent?.id || null;

  let invoiceNumber: string | null = null;
  let hostedInvoiceUrl: string | null = null;
  let invoicePdf: string | null = null;

  try {
    if (checkoutSession.invoice) {
      const invObj =
        typeof checkoutSession.invoice === 'string'
          ? await stripe.invoices.retrieve(checkoutSession.invoice)
          : checkoutSession.invoice;
      if (invObj) {
        invoiceNumber = invObj.number || invObj.id || null;
        hostedInvoiceUrl = invObj.hosted_invoice_url ?? null;
        invoicePdf = invObj.invoice_pdf ?? null;
      }
    }
    if (!hostedInvoiceUrl && paymentIntentId) {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
        expand: ['latest_charge'],
      });
      const charge = pi.latest_charge as Stripe.Charge | undefined;
      if (charge?.receipt_url) {
        hostedInvoiceUrl = charge.receipt_url;
      }
    }
  } catch (err: any) {
    console.warn('[Book Invoice Safety Net] Notice retrieving invoice details:', err.message);
  }

  await sendBookPurchaseEmails({
    customerEmail,
    customerName: checkoutSession.customer_details?.name || null,
    amountPaidCents: checkoutSession.amount_total ?? 1999,
    currency: checkoutSession.currency || 'usd',
    paidAt: new Date(),
    stripeSessionId: sessionId,
    stripePaymentIntentId: paymentIntentId,
    invoiceNumber: invoiceNumber || `INV-BK-${sessionId.slice(-8).toUpperCase()}`,
    hostedInvoiceUrl,
    invoicePdf,
    version,
  });

  return true;
}
