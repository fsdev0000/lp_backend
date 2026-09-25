import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import path from 'path';
import fs from 'fs';

export const checkoutRouter = Router();

// Helper to get initialized Stripe instance
function getStripeInstance(): Stripe {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY environment variable is not configured');
  }
  return new Stripe(secretKey);
}

/**
 * POST /api/create-checkout
 * Creates a one-off Stripe Checkout session for Reset by Discipline.
 * Uses only server-configured Stripe Price ID.
 */
checkoutRouter.post('/create-checkout', async (req: Request, res: Response): Promise<void> => {
  try {
    const priceId = process.env.STRIPE_BOOK_PRICE_ID;
    if (!priceId) {
      res.status(500).json({ error: 'STRIPE_BOOK_PRICE_ID environment variable is not configured' });
      return;
    }

    const stripe = getStripeInstance();
    const reqOrigin = req.headers.origin ? String(req.headers.origin).replace(/\/$/, '') : null;
    const frontendUrl = reqOrigin || (process.env.FRONTEND_URL || 'http://localhost:8080').replace(/\/$/, '');

    // Allow caller to pass full returnPath (e.g. '/knowledge?book-name=reset-by-discipline&version=nl#reset-by-discipline')
    const rawReturnPath = req.body?.returnPath || req.body?.source;
    let returnPath = '/knowledge?book-name=reset-by-discipline#reset-by-discipline';
    if (typeof rawReturnPath === 'string' && rawReturnPath.startsWith('/')) {
      returnPath = rawReturnPath;
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: `${frontendUrl}/payment-success?session_id={CHECKOUT_SESSION_ID}&from=${encodeURIComponent(returnPath)}`,
      cancel_url: `${frontendUrl}${returnPath}`,
      metadata: {
        product: 'Reset by Discipline',
        author: 'Lionel Eersteling',
        returnPath,
      },
    });

    if (!session.url) {
      res.status(500).json({ error: 'Failed to generate Stripe checkout URL' });
      return;
    }

    res.status(200).json({ url: session.url });
  } catch (error: any) {
    console.error('[Stripe] Error creating checkout session:', error?.message || error);
    res.status(500).json({ error: error?.message || 'Failed to create checkout session' });
  }
});

/**
 * GET /api/payment-status?session_id=...
 * Verifies payment directly against Stripe API without any application database.
 */
checkoutRouter.get('/payment-status', async (req: Request, res: Response): Promise<void> => {
  try {
    const sessionId = req.query.session_id as string | undefined;

    if (!sessionId || typeof sessionId !== 'string') {
      res.status(400).json({ error: 'Missing or invalid session_id parameter' });
      return;
    }

    const expectedPriceId = process.env.STRIPE_BOOK_PRICE_ID;
    const stripe = getStripeInstance();

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['line_items'],
    });

    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const isPaid = session.payment_status === 'paid';

    // Verify product price if line items are available and expectedPriceId is set
    if (expectedPriceId && session.line_items?.data) {
      const containsExpectedProduct = session.line_items.data.some(
        (item) => item.price?.id === expectedPriceId
      );
      if (!containsExpectedProduct && isPaid) {
        console.warn(`[Stripe] Session ${sessionId} does not contain expected price ID ${expectedPriceId}`);
        res.status(400).json({ status: 'unverified' });
        return;
      }
    }

    res.status(200).json({
      status: isPaid ? 'paid' : session.payment_status || 'pending',
      returnPath: session.metadata?.returnPath || null,
    });
  } catch (error: any) {
    console.error('[Stripe] Error checking payment status:', error?.message || error);
    res.status(500).json({ error: 'Unable to verify payment status' });
  }
});

/**
 * GET /api/download?session_id=...
 * Serves the private PDF book only after verifying payment directly with Stripe.
 */
checkoutRouter.get('/download', async (req: Request, res: Response): Promise<void> => {
  try {
    const sessionId = req.query.session_id as string | undefined;

    if (!sessionId || typeof sessionId !== 'string') {
      res.status(400).json({ error: 'Missing or invalid session_id' });
      return;
    }

    const expectedPriceId = process.env.STRIPE_BOOK_PRICE_ID;
    const stripe = getStripeInstance();

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['line_items'],
    });

    if (!session || session.payment_status !== 'paid') {
      res.status(403).json({ error: 'Payment not completed or session unauthorized' });
      return;
    }

    // Verify price if configured
    if (expectedPriceId && session.line_items?.data) {
      const containsExpectedProduct = session.line_items.data.some(
        (item) => item.price?.id === expectedPriceId
      );
      if (!containsExpectedProduct) {
        res.status(403).json({ error: 'Unauthorized product in session' });
        return;
      }
    }

    // Resolve private file path
    const configuredPath = process.env.BOOK_FILE_PATH;
    const candidatePaths = [
      configuredPath,
      path.resolve(__dirname, '../../../private/reset-by-discipline.pdf'),
      path.resolve(process.cwd(), 'private/reset-by-discipline.pdf'),
    ].filter(Boolean) as string[];

    let resolvedPath = candidatePaths.find((p) => fs.existsSync(p));

    if (!resolvedPath) {
      console.error('[Stripe] Private book file not found at any configured path');
      res.status(404).json({ error: 'Book file not found on server' });
      return;
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="reset-by-discipline.pdf"');
    res.sendFile(path.resolve(resolvedPath));
  } catch (error: any) {
    console.error('[Stripe] Error serving download:', error?.message || error);
    res.status(403).json({ error: 'Payment verification failed' });
  }
});

/**
 * POST /api/stripe/webhook
 * Stateless webhook handler verifying Stripe signature.
 * Does NOT persist any database records.
 */
checkoutRouter.post('/stripe/webhook', async (req: Request, res: Response): Promise<void> => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret || !sig) {
    res.status(400).json({ error: 'Missing webhook secret or stripe-signature header' });
    return;
  }

  let event: Stripe.Event;

  try {
    const rawBody = (req as any).rawBody || req.body;
    const stripe = getStripeInstance();
    event = stripe.webhooks.constructEvent(rawBody, sig as string, webhookSecret);
  } catch (err: any) {
    console.error(`[Stripe Webhook] Verification failed:`, err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  // Handle specific event types statelessly
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    console.log(`[Stripe Webhook] Checkout completed for session ${session.id}. Payment status: ${session.payment_status}`);
  }

  res.status(200).json({ received: true });
});

/**
 * TODO: TEMPORARY ENDPOINT - MUST BE REMOVED AFTER RETRIEVING THE PRICE IDS.
 * GET /api/stripe/products
 * Read-only endpoint to retrieve all active Stripe products and their associated active Price IDs.
 * Handles Stripe pagination and only returns active products and their active prices.
 */
checkoutRouter.get('/stripe/products', async (_req: Request, res: Response): Promise<void> => {
  try {
    const stripe = getStripeInstance();

    // Retrieve all active products handling pagination
    const products: Stripe.Product[] = [];
    for await (const product of stripe.products.list({ active: true, limit: 100 })) {
      products.push(product);
    }

    // Retrieve all active prices handling pagination
    const prices: Stripe.Price[] = [];
    for await (const price of stripe.prices.list({ active: true, limit: 100 })) {
      prices.push(price);
    }

    // Group active prices by productId
    const pricesByProductId = new Map<string, Array<{
      priceId: string;
      currency: string;
      amount: number | null;
      type: string;
      active: boolean;
      recurring?: {
        interval: string;
        intervalCount: number;
      };
    }>>();

    for (const price of prices) {
      const productId = typeof price.product === 'string' ? price.product : price.product?.id;
      if (!productId) continue;

      const priceData: {
        priceId: string;
        currency: string;
        amount: number | null;
        type: string;
        active: boolean;
        recurring?: {
          interval: string;
          intervalCount: number;
        };
      } = {
        priceId: price.id,
        currency: price.currency,
        amount: price.unit_amount,
        type: price.type,
        active: price.active,
      };

      if (price.type === 'recurring' && price.recurring) {
        priceData.recurring = {
          interval: price.recurring.interval,
          intervalCount: price.recurring.interval_count,
        };
      }

      if (!pricesByProductId.has(productId)) {
        pricesByProductId.set(productId, []);
      }
      pricesByProductId.get(productId)!.push(priceData);
    }

    const formattedProducts = products.map((product) => ({
      productId: product.id,
      name: product.name,
      description: product.description,
      prices: pricesByProductId.get(product.id) || [],
    }));

    res.status(200).json({ products: formattedProducts });
  } catch (error: any) {
    console.error('[Stripe] Error fetching products:', error?.message || error);
    res.status(500).json({ error: error?.message || 'Failed to fetch Stripe products' });
  }
});
