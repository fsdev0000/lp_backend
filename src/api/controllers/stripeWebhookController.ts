import { Request, Response } from 'express';
import {
  getStripeClient,
  getStripeWebhookSecret,
  isProductionEnvironment,
  processStripeWebhookEvent,
} from '../../services/stripeWebhookService';

/**
 * Universal Stripe Webhook Controller.
 * Handles:
 * - Production: https://api.leadersperformance.ae/api/v1/stripe/webhook
 * - Staging: https://staging.leadersperformance.ae/api/v1/stripe/webhook
 * - Signature verification using raw request buffer
 * - Strict livemode validation preventing test/live crossover
 * - Idempotency & deduplication
 */
export async function handleStripeWebhook(req: Request, res: Response): Promise<void> {
  const sig = req.headers['stripe-signature'];

  if (!sig || typeof sig !== 'string') {
    console.warn('[Stripe Webhook] Rejected request: Missing stripe-signature header.');
    res.status(400).json({ error: 'Missing stripe-signature header' });
    return;
  }

  let webhookSecret: string;
  try {
    webhookSecret = getStripeWebhookSecret();
  } catch (err: any) {
    console.error('[Stripe Webhook] Configuration error:', err.message);
    res.status(500).json({ error: 'Webhook secret not configured' });
    return;
  }

  // Raw body verification
  const rawBody = (req as any).rawBody || req.body;
  if (!rawBody) {
    console.warn('[Stripe Webhook] Rejected request: Missing raw request body buffer.');
    res.status(400).json({ error: 'Missing raw request body buffer' });
    return;
  }

  const stripe = getStripeClient();
  let event: any;

  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err: any) {
    console.error('[Stripe Webhook] Signature verification failed:', err.message);
    res.status(400).send(`Webhook Signature Verification Error: ${err.message}`);
    return;
  }

  // Environment Livemode Protection (Requirement 6)
  const isProd = isProductionEnvironment();
  if (event.livemode !== isProd) {
    const errorMsg = `[Stripe Webhook] Livemode mismatch: Received ${
      event.livemode ? 'live-mode' : 'test-mode'
    } event (${event.type}) in ${isProd ? 'production' : 'staging'} environment.`;
    console.warn(errorMsg);
    res.status(400).json({
      error: 'Environment livemode mismatch',
      receivedLivemode: event.livemode,
      expectedLivemode: isProd,
    });
    return;
  }

  // Process the verified event
  try {
    const result = await processStripeWebhookEvent(event);
    res.status(200).json({ received: true, ...result });
  } catch (processErr: any) {
    console.error('[Stripe Webhook] Processing error:', processErr.message);
    // Return 500 to trigger Stripe's automatic webhook retry if email or database failed
    res.status(500).json({ error: 'Webhook processing failed', message: processErr.message });
  }
}
