import Stripe from 'stripe';
import { PrismaClient } from '@prisma/client';
import {
  sendMasterclassPaymentInvoiceEmail,
  MasterclassPaymentInvoiceEmailData,
} from './masterclassService';
import { isValidEmail, sanitizeEmail } from './emailValidation';
import { upsertContact } from './ghl';

const prisma = new PrismaClient();

/**
 * Determine whether the current runtime environment is Production.
 */
export function isProductionEnvironment(): boolean {
  if (process.env.APP_ENV?.toLowerCase() === 'production') return true;
  if (process.env.NODE_ENV?.toLowerCase() === 'production' && !process.env.APP_ENV) {
    const key = process.env.STRIPE_SECRET_KEY || '';
    if (key.startsWith('sk_live_')) return true;
  }
  const key = process.env.STRIPE_SECRET_KEY || '';
  return key.startsWith('sk_live_');
}

/**
 * Resolve the environment-specific Stripe API Secret Key.
 * Never hardcodes credentials or exposes secrets.
 */
export function getStripeSecretKey(): string {
  const isProd = isProductionEnvironment();
  const key = isProd
    ? process.env.STRIPE_SECRET_KEY_PRODUCTION || process.env.STRIPE_SECRET_KEY
    : process.env.STRIPE_SECRET_KEY_STAGING || process.env.STRIPE_SECRET_KEY;

  if (!key) {
    throw new Error('STRIPE_SECRET_KEY is not configured for the active environment');
  }
  return key;
}

/**
 * Resolve the environment-specific Stripe Webhook Signing Secret.
 * Never shares secrets between staging and production.
 */
export function getStripeWebhookSecret(): string {
  const isProd = isProductionEnvironment();
  const secret = isProd
    ? process.env.STRIPE_WEBHOOK_SECRET_PRODUCTION || process.env.STRIPE_WEBHOOK_SECRET
    : process.env.STRIPE_WEBHOOK_SECRET_STAGING || process.env.STRIPE_WEBHOOK_SECRET;

  if (!secret) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not configured for the active environment');
  }
  return secret;
}

/**
 * Get initialized Stripe client for the active environment.
 */
export function getStripeClient(): Stripe {
  return new Stripe(getStripeSecretKey());
}

/**
 * Masks sensitive emails for audit logs (e.g. as***@leadersperformance.ae).
 */
export function maskEmail(email: string): string {
  if (!email || !email.includes('@')) return '***';
  const [local, domain] = email.split('@');
  if (local.length <= 2) return `${local[0]}***@${domain}`;
  return `${local.slice(0, 2)}***@${domain}`;
}

/**
 * Masks identifier strings for secure diagnostic logging (e.g. cs_test_...YWv4fF).
 */
export function maskIdentifier(id: string | null | undefined): string {
  if (!id) return '[none]';
  if (id.length <= 8) return '***';
  return `${id.slice(0, 8)}...${id.slice(-6)}`;
}

// In-memory set for active concurrent execution locking
const activeProcessingLocks = new Set<string>();

/**
 * Check whether an event has already been processed idempotently.
 */
export async function isEventProcessed(eventId: string): Promise<boolean> {
  const existing = await prisma.systemLog.findFirst({
    where: {
      action: 'STRIPE_WEBHOOK_PROCESSED',
      details: { contains: eventId },
    },
  });
  return Boolean(existing);
}

/**
 * Mark a webhook event as successfully processed in SystemLog.
 */
export async function recordEventProcessed(
  eventId: string,
  eventType: string,
  metadata?: Record<string, any>
): Promise<void> {
  try {
    await prisma.systemLog.create({
      data: {
        level: 'info',
        action: 'STRIPE_WEBHOOK_PROCESSED',
        details: JSON.stringify({
          eventId,
          eventType,
          processedAt: new Date().toISOString(),
          ...metadata,
        }),
      },
    });
  } catch (err: any) {
    console.warn('[Stripe Webhook] Warning recording processed event:', err.message);
  }
}

// Configurable email dispatcher function (defaults to real sendMasterclassPaymentInvoiceEmail)
let invoiceEmailDispatcher = sendMasterclassPaymentInvoiceEmail;

export function setInvoiceEmailDispatcherForTesting(
  fn: ((data: MasterclassPaymentInvoiceEmailData) => Promise<boolean>) | null
): void {
  invoiceEmailDispatcher = fn || sendMasterclassPaymentInvoiceEmail;
}

/**
 * Safely dispatches the invoice email with exponential backoff retries.
 */
export async function dispatchInvoiceEmailWithRetries(
  emailData: MasterclassPaymentInvoiceEmailData,
  maxRetries = 3
): Promise<boolean> {
  let attempt = 0;
  while (attempt < maxRetries) {
    attempt++;
    try {
      const delivered = await invoiceEmailDispatcher(emailData);
      if (delivered) {
        return true;
      }
      console.warn(`[Stripe Invoice] Delivery attempt ${attempt}/${maxRetries} returned false. Retrying...`);
    } catch (err: any) {
      console.warn(`[Stripe Invoice] Delivery attempt ${attempt}/${maxRetries} error: ${err.message}`);
    }

    if (attempt < maxRetries) {
      const delayMs = attempt * 1000;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}

/**
 * Core processor for Stripe webhook events.
 */
export async function processStripeWebhookEvent(
  event: Stripe.Event
): Promise<{ success: boolean; message: string; duplicate?: boolean }> {
  const stripe = getStripeClient();
  const eventId = event.id;
  const eventType = event.type;

  console.log(`[Stripe Webhook] Ingesting event ${eventId} (${eventType}) | livemode: ${event.livemode}`);

  // 1. Event-level idempotency deduplication
  if (await isEventProcessed(eventId)) {
    console.log(`[Stripe Webhook] Idempotency: Event ${eventId} was already processed. Skipping replay.`);
    return { success: true, message: 'Event already processed', duplicate: true };
  }

  // 2. Event type dispatching
  switch (eventType) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object as Stripe.Checkout.Session;
      return await handleCheckoutSessionSuccess(stripe, session, eventId);
    }

    case 'payment_intent.succeeded': {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;
      return await handlePaymentIntentSuccess(stripe, paymentIntent, eventId);
    }

    case 'invoice.payment_succeeded':
    case 'invoice.paid': {
      const invoice = event.data.object as Stripe.Invoice;
      return await handleInvoicePaymentSuccess(stripe, invoice, eventId);
    }

    case 'payment_intent.payment_failed': {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;
      const declineReason = paymentIntent.last_payment_error?.message || 'Payment declined';
      console.warn(
        `[Stripe Webhook] Payment failed for PaymentIntent ${maskIdentifier(paymentIntent.id)}: ${declineReason}`
      );
      await prisma.systemLog.create({
        data: {
          level: 'warn',
          action: 'STRIPE_PAYMENT_FAILED',
          details: JSON.stringify({
            eventId,
            paymentIntentId: paymentIntent.id,
            declineReason,
            customerEmail: paymentIntent.receipt_email ? maskEmail(paymentIntent.receipt_email) : undefined,
            failedAt: new Date().toISOString(),
          }),
        },
      });
      await recordEventProcessed(eventId, eventType, { status: 'failed', paymentIntentId: paymentIntent.id });
      return { success: true, message: 'Payment failure recorded' };
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      console.warn(`[Stripe Webhook] Invoice payment failed for Invoice ${maskIdentifier(invoice.id)}`);
      await prisma.systemLog.create({
        data: {
          level: 'warn',
          action: 'STRIPE_INVOICE_FAILED',
          details: JSON.stringify({
            eventId,
            invoiceId: invoice.id,
            invoiceNumber: invoice.number,
            failedAt: new Date().toISOString(),
          }),
        },
      });
      await recordEventProcessed(eventId, eventType, { status: 'failed', invoiceId: invoice.id });
      return { success: true, message: 'Invoice failure recorded' };
    }

    default:
      console.log(`[Stripe Webhook] Acknowledged unhandled event type: ${eventType}`);
      await recordEventProcessed(eventId, eventType, { unhandled: true });
      return { success: true, message: 'Event acknowledged' };
  }
}

/**
 * Handle successful Checkout Session (Masterclass enrollment, book purchase, etc.)
 */
async function handleCheckoutSessionSuccess(
  stripe: Stripe,
  session: Stripe.Checkout.Session,
  eventId: string
): Promise<{ success: boolean; message: string; duplicate?: boolean }> {
  const sessionId = session.id;
  const isPaid = session.payment_status === 'paid';

  if (!isPaid) {
    console.log(`[Stripe Webhook] Session ${maskIdentifier(sessionId)} is not marked as paid. Status: ${session.payment_status}`);
    await recordEventProcessed(eventId, 'checkout.session.completed', { paymentStatus: session.payment_status });
    return { success: true, message: 'Session is not paid' };
  }

  // Concurrency lock
  if (activeProcessingLocks.has(sessionId)) {
    console.log(`[Stripe Webhook] Concurrency lock active for session ${sessionId}. Skipping parallel run.`);
    return { success: true, message: 'Concurrent run in progress', duplicate: true };
  }
  activeProcessingLocks.add(sessionId);

  try {
    // 1. Locate trusted enrollment record
    const enrollment = await prisma.masterclassEnrollment.findFirst({
      where: {
        OR: [
          { stripeSessionId: sessionId },
          { id: session.metadata?.enrollmentId },
          { email: session.customer_email || session.metadata?.email },
        ].filter(Boolean) as any,
      },
    });

    if (!enrollment) {
      console.log(`[Stripe Webhook] No masterclass enrollment matched session ${maskIdentifier(sessionId)}. Checking other products...`);
      await recordEventProcessed(eventId, 'checkout.session.completed', { sessionId, product: session.metadata?.product });
      return { success: true, message: 'Non-masterclass session processed' };
    }

    // 2. Validate trusted customer email
    const rawEmail = enrollment.email || session.customer_details?.email || session.customer_email || '';
    const trustedEmail = sanitizeEmail(rawEmail);
    if (!isValidEmail(trustedEmail)) {
      console.error(`[Stripe Webhook] Untrusted or invalid customer email detected: '${maskEmail(rawEmail)}'`);
      return { success: false, message: 'Invalid customer email' };
    }

    // 3. Check enrollment-level deduplication for invoice email
    let parsedMetadata: Record<string, any> = {};
    try {
      parsedMetadata = enrollment.metadata ? JSON.parse(enrollment.metadata) : {};
    } catch {
      parsedMetadata = {};
    }

    const alreadySent = Boolean(parsedMetadata.invoiceEmailSent);

    // 4. Update enrollment payment status in DB
    const paymentIntentId =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id;

    await prisma.masterclassEnrollment.update({
      where: { id: enrollment.id },
      data: {
        paymentStatus: 'paid',
        accessGranted: true,
        paidAt: enrollment.paidAt || new Date(),
        stripePaymentIntentId: paymentIntentId || enrollment.stripePaymentIntentId,
        stripeSessionId: sessionId,
      },
    });

    // 5. Retrieve Stripe Tax Invoice details
    let invoiceNumber: string | null = parsedMetadata.invoiceNumber || null;
    let hostedInvoiceUrl: string | null = parsedMetadata.hostedInvoiceUrl || null;
    let invoicePdf: string | null = parsedMetadata.invoicePdf || null;
    let invoiceId: string | null = parsedMetadata.invoiceId || null;

    if (session.invoice) {
      try {
        let invObj: Stripe.Invoice | null = null;
        if (typeof session.invoice === 'string') {
          invObj = await stripe.invoices.retrieve(session.invoice);
        } else {
          invObj = session.invoice as Stripe.Invoice;
        }

        if (invObj) {
          invoiceId = invObj.id;
          invoiceNumber = invObj.number || invObj.id || null;
          hostedInvoiceUrl = invObj.hosted_invoice_url ?? null;
          invoicePdf = invObj.invoice_pdf ?? null;
        }
      } catch (err: any) {
        console.warn('[Stripe Webhook] Error retrieving invoice details:', err.message);
      }
    }

    // 6. Deliver invoice email if not already delivered (Idempotency guarantee)
    let emailDelivered = alreadySent;
    if (!alreadySent) {
      console.log(
        `[Stripe Webhook] Triggering invoice email for customer ${maskEmail(trustedEmail)} (Invoice: ${invoiceNumber || 'Stripe Invoice'})`
      );

      emailDelivered = await dispatchInvoiceEmailWithRetries({
        enrollment: {
          ...enrollment,
          email: trustedEmail,
        },
        invoiceNumber,
        hostedInvoiceUrl,
        invoicePdf,
        amountPaid: enrollment.amount || 50000,
        currency: enrollment.currency || 'usd',
        paidAt: enrollment.paidAt || new Date(),
        stripeSessionId: sessionId,
      });

      if (emailDelivered) {
        parsedMetadata.invoiceEmailSent = true;
        parsedMetadata.invoiceEmailSentAt = new Date().toISOString();
        parsedMetadata.invoiceNumber = invoiceNumber;
        parsedMetadata.invoiceId = invoiceId;
        parsedMetadata.hostedInvoiceUrl = hostedInvoiceUrl;
        parsedMetadata.invoicePdf = invoicePdf;

        await prisma.masterclassEnrollment.update({
          where: { id: enrollment.id },
          data: { metadata: JSON.stringify(parsedMetadata) },
        });

        console.log(`[Stripe Webhook] Invoice email delivery confirmed and persisted for ${maskEmail(trustedEmail)}`);
      } else {
        console.error(`[Stripe Webhook] Invoice email delivery failed for ${maskEmail(trustedEmail)} after retries.`);
        throw new Error('Failed to deliver invoice email after retries');
      }
    } else {
      console.log(`[Stripe Webhook] Idempotency: Invoice email already sent for enrollment ${enrollment.id}. Skipping duplicate.`);
    }

    // Tag contact in GHL as paid customer
    try {
      await upsertContact({
        email: enrollment.email,
        firstName: enrollment.fullName ? enrollment.fullName.split(' ')[0] : undefined,
        lastName: enrollment.fullName ? enrollment.fullName.split(' ').slice(1).join(' ') || undefined : undefined,
        tags: ['Masterclass Paid', 'The Founders Next Move Customer'],
      });
    } catch (err: any) {
      console.warn('[GHL] Non-fatal tagging error upon payment:', err.message);
    }

    // 7. Record event as fully processed
    await recordEventProcessed(eventId, 'checkout.session.completed', {
      enrollmentId: enrollment.id,
      sessionId,
      invoiceNumber,
      emailDelivered,
    });

    return { success: true, message: 'Checkout session fulfilled and invoice sent' };
  } finally {
    activeProcessingLocks.delete(sessionId);
  }
}

/**
 * Handle payment_intent.succeeded
 */
async function handlePaymentIntentSuccess(
  stripe: Stripe,
  paymentIntent: Stripe.PaymentIntent,
  eventId: string
): Promise<{ success: boolean; message: string; duplicate?: boolean }> {
  const paymentIntentId = paymentIntent.id;

  // Find enrollment by paymentIntentId
  const enrollment = await prisma.masterclassEnrollment.findFirst({
    where: {
      OR: [
        { stripePaymentIntentId: paymentIntentId },
        { id: paymentIntent.metadata?.enrollmentId },
        { email: paymentIntent.receipt_email || paymentIntent.metadata?.email },
      ].filter(Boolean) as any,
    },
  });

  if (!enrollment) {
    console.log(`[Stripe Webhook] PaymentIntent ${maskIdentifier(paymentIntentId)} has no associated Masterclass enrollment.`);
    await recordEventProcessed(eventId, 'payment_intent.succeeded', { paymentIntentId });
    return { success: true, message: 'PaymentIntent processed' };
  }

  let parsedMetadata: Record<string, any> = {};
  try {
    parsedMetadata = enrollment.metadata ? JSON.parse(enrollment.metadata) : {};
  } catch {
    parsedMetadata = {};
  }

  // If invoice email already delivered by checkout.session.completed, skip duplicate
  if (parsedMetadata.invoiceEmailSent) {
    console.log(`[Stripe Webhook] Idempotency: Invoice email already dispatched for enrollment ${enrollment.id} via session. Skipping duplicate on PaymentIntent.`);
    await recordEventProcessed(eventId, 'payment_intent.succeeded', { enrollmentId: enrollment.id, duplicate: true });
    return { success: true, message: 'Already fulfilled' };
  }

  // Update enrollment
  await prisma.masterclassEnrollment.update({
    where: { id: enrollment.id },
    data: {
      paymentStatus: 'paid',
      accessGranted: true,
      paidAt: enrollment.paidAt || new Date(),
      stripePaymentIntentId: paymentIntentId,
    },
  });

  // Check if invoice exists
  let invoiceNumber: string | null = null;
  let hostedInvoiceUrl: string | null = null;
  let invoicePdf: string | null = null;

  const piInvoice = (paymentIntent as any).invoice;
  if (piInvoice) {
    try {
      const invId = typeof piInvoice === 'string' ? piInvoice : piInvoice.id;
      const invObj = await stripe.invoices.retrieve(invId);
      if (invObj) {
        invoiceNumber = invObj.number || invObj.id || null;
        hostedInvoiceUrl = invObj.hosted_invoice_url ?? null;
        invoicePdf = invObj.invoice_pdf ?? null;
      }
    } catch (err: any) {
      console.warn('[Stripe Webhook] Notice retrieving invoice on PaymentIntent:', err.message);
    }
  }

  const trustedEmail = sanitizeEmail(enrollment.email);
  const delivered = await dispatchInvoiceEmailWithRetries({
    enrollment: { ...enrollment, email: trustedEmail },
    invoiceNumber,
    hostedInvoiceUrl,
    invoicePdf,
    amountPaid: enrollment.amount || paymentIntent.amount || 50000,
    currency: enrollment.currency || paymentIntent.currency || 'usd',
    paidAt: enrollment.paidAt || new Date(),
    stripeSessionId: enrollment.stripeSessionId,
  });

  if (delivered) {
    parsedMetadata.invoiceEmailSent = true;
    parsedMetadata.invoiceEmailSentAt = new Date().toISOString();
    parsedMetadata.invoiceNumber = invoiceNumber;
    await prisma.masterclassEnrollment.update({
      where: { id: enrollment.id },
      data: { metadata: JSON.stringify(parsedMetadata) },
    });
  }

  await recordEventProcessed(eventId, 'payment_intent.succeeded', {
    enrollmentId: enrollment.id,
    paymentIntentId,
    emailDelivered: delivered,
  });

  return { success: true, message: 'PaymentIntent fulfilled' };
}

/**
 * Handle invoice.payment_succeeded & invoice.paid (Stripe Billing / Subscriptions / Checkout Invoices)
 */
async function handleInvoicePaymentSuccess(
  stripe: Stripe,
  invoice: Stripe.Invoice,
  eventId: string
): Promise<{ success: boolean; message: string; duplicate?: boolean }> {
  const invoiceId = invoice.id;
  const invoiceNumber = invoice.number || invoice.id;
  const rawEmail = invoice.customer_email || '';
  const trustedEmail = sanitizeEmail(rawEmail);

  console.log(`[Stripe Webhook] Processing invoice payment for Invoice ${invoiceNumber} (${maskEmail(trustedEmail)})`);

  // Check if enrollment exists for this customer/invoice
  const enrollment = await prisma.masterclassEnrollment.findFirst({
    where: {
      OR: [
        { email: trustedEmail },
        { id: invoice.metadata?.enrollmentId },
      ].filter(Boolean) as any,
    },
    orderBy: { createdAt: 'desc' },
  });

  if (enrollment) {
    let parsedMetadata: Record<string, any> = {};
    try {
      parsedMetadata = enrollment.metadata ? JSON.parse(enrollment.metadata) : {};
    } catch {
      parsedMetadata = {};
    }

    if (parsedMetadata.invoiceEmailSent) {
      console.log(`[Stripe Webhook] Idempotency: Invoice email already dispatched for enrollment ${enrollment.id}. Skipping duplicate on invoice.payment_succeeded.`);
      await recordEventProcessed(eventId, 'invoice.payment_succeeded', { invoiceId, duplicate: true });
      return { success: true, message: 'Invoice already dispatched' };
    }

    // Deliver email
    const delivered = await dispatchInvoiceEmailWithRetries({
      enrollment: { ...enrollment, email: trustedEmail || enrollment.email },
      invoiceNumber,
      hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
      invoicePdf: invoice.invoice_pdf ?? null,
      amountPaid: invoice.amount_paid || enrollment.amount || 50000,
      currency: invoice.currency || 'usd',
      paidAt: new Date(),
      stripeSessionId: enrollment.stripeSessionId,
    });

    if (delivered) {
      parsedMetadata.invoiceEmailSent = true;
      parsedMetadata.invoiceEmailSentAt = new Date().toISOString();
      parsedMetadata.invoiceNumber = invoiceNumber;
      parsedMetadata.invoiceId = invoiceId;
      await prisma.masterclassEnrollment.update({
        where: { id: enrollment.id },
        data: { metadata: JSON.stringify(parsedMetadata), paymentStatus: 'paid', accessGranted: true },
      });
    }
  }

  await recordEventProcessed(eventId, 'invoice.payment_succeeded', { invoiceId, invoiceNumber });
  return { success: true, message: 'Invoice payment handled' };
}
