import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import path from 'path';
import fs from 'fs';
import { handleStripeWebhook } from '../controllers/stripeWebhookController';
import { sendTextBookPurchaseEmailsIfPending } from '../../services/bookInvoiceEmailService';

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
 * Helpers for multi-language book support (English and Dutch)
 */
function getBookPriceId(version: 'nl' | 'en'): { priceId: string; envVarName: string } | null {
  if (version === 'nl') {
    const priceId = process.env.STRIPE_BOOK_PRICE_ID_NL || process.env.STRIPE_BOOK_PRICE_ID;
    return priceId ? { priceId, envVarName: 'STRIPE_BOOK_PRICE_ID_NL' } : null;
  }
  const priceId = process.env.STRIPE_BOOK_PRICE_ID_EN || process.env.STRIPE_BOOK_PRICE_ID;
  return priceId ? { priceId, envVarName: 'STRIPE_BOOK_PRICE_ID_EN' } : null;
}

function getAllBookPriceIds(): string[] {
  return [
    process.env.STRIPE_BOOK_PRICE_ID_EN,
    process.env.STRIPE_BOOK_PRICE_ID_NL,
    process.env.STRIPE_BOOK_PRICE_ID,
  ].filter(Boolean) as string[];
}

function getSessionVersion(session: Stripe.Checkout.Session): 'nl' | 'en' {
  // 1. Check metadata
  const metaVersion = (session.metadata?.version || '').toLowerCase().trim();
  if (metaVersion === 'nl' || metaVersion === 'dutch') {
    return 'nl';
  }
  if (metaVersion === 'en' || metaVersion === 'english') {
    return 'en';
  }

  // 2. Check line items for specific Dutch or English Price ID
  const nlPriceId = process.env.STRIPE_BOOK_PRICE_ID_NL;
  const enPriceId = process.env.STRIPE_BOOK_PRICE_ID_EN;
  if (session.line_items?.data) {
    if (nlPriceId && session.line_items.data.some((item) => item.price?.id === nlPriceId)) {
      return 'nl';
    }
    if (enPriceId && session.line_items.data.some((item) => item.price?.id === enPriceId)) {
      return 'en';
    }
  }

  // 3. Check metadata returnPath for version param
  const returnPath = session.metadata?.returnPath || '';
  if (returnPath.includes('version=nl') || returnPath.includes('lang=nl')) {
    return 'nl';
  }

  return 'en';
}

/**
 * Resolves the book file path strictly from environment variables (.env).
 * Security Rules:
 * 1. The book file path MUST be explicitly configured in .env (BOOK_FILE_PATH_EN / BOOK_FILE_PATH_NL / BOOK_FILE_PATH).
 * 2. NO fallback to hardcoded original books or scanning unconfigured private directories.
 * 3. Path traversal attacks are blocked: file must be a verified .pdf and resolve to a valid file.
 * 4. The download filename is derived directly from the configured file name in .env.
 */
export function getBookFilePath(version: 'nl' | 'en'): { filePath: string; fileName: string } | null {
  const isDutch = version === 'nl';

  // 1. Strictly read from .env
  const rawEnvPath = isDutch
    ? process.env.BOOK_FILE_PATH_NL
    : (process.env.BOOK_FILE_PATH_EN || process.env.BOOK_FILE_PATH);

  if (!rawEnvPath || typeof rawEnvPath !== 'string' || !rawEnvPath.trim()) {
    console.warn(`[Stripe Security] Book download blocked: No path configured in .env for ${version.toUpperCase()} (BOOK_FILE_PATH_${version.toUpperCase()} is unset).`);
    return null;
  }

  const envPath = rawEnvPath.trim().replace(/^['"]|['"]$/g, '');
  const baseName = path.basename(envPath);

  // Security: must be a PDF file
  if (!baseName.toLowerCase().endsWith('.pdf')) {
    console.error(`[Stripe Security] Invalid file type configured in .env: "${envPath}" (must end with .pdf)`);
    return null;
  }

  // 2. Resolve path across allowed application and private directories
  const candidatePaths = [
    envPath,
    path.resolve(envPath),
    path.resolve(process.cwd(), envPath),
    path.resolve(process.cwd(), 'lp_backend', envPath),
    path.resolve(__dirname, '../../..', envPath),
    path.resolve(__dirname, '../../../private', baseName),
    path.resolve(__dirname, '../../private', baseName),
    path.resolve(process.cwd(), 'private', baseName),
    path.resolve(process.cwd(), 'lp_backend/private', baseName),
  ];

  const matchedPath = candidatePaths.find((p) => {
    try {
      return fs.existsSync(p) && fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });

  if (!matchedPath) {
    console.error(`[Stripe Security] Configured book file for ${version.toUpperCase()} not found on disk: "${envPath}"`);
    return null;
  }

  const resolved = path.resolve(matchedPath);

  // Download filename comes directly from .env configuration (or optional explicit BOOK_FILE_NAME override)
  const envCustomFileName = isDutch ? process.env.BOOK_FILE_NAME_NL : process.env.BOOK_FILE_NAME_EN;
  const fileName = envCustomFileName?.trim() || baseName;

  console.log(`[Stripe Checkout] Securely serving ${version.toUpperCase()} book from .env: ${resolved} (download filename: "${fileName}")`);

  return {
    filePath: resolved,
    fileName,
  };
}

/**
 * POST /api/create-checkout
 * Creates a one-off Stripe Checkout session for Reset by Discipline.
 * Dynamically supports English and Dutch versions via Price IDs:
 * STRIPE_BOOK_PRICE_ID_EN and STRIPE_BOOK_PRICE_ID_NL
 */
checkoutRouter.post('/create-checkout', async (req: Request, res: Response): Promise<void> => {
  try {
    const rawVersion = (req.body?.version || req.query?.version || 'en').toString().toLowerCase().trim();
    const version: 'nl' | 'en' = (rawVersion === 'nl' || rawVersion === 'dutch') ? 'nl' : 'en';

    const priceConfig = getBookPriceId(version);
    if (!priceConfig) {
      const missingVar = version === 'nl' ? 'STRIPE_BOOK_PRICE_ID_NL' : 'STRIPE_BOOK_PRICE_ID_EN';
      res.status(500).json({ error: `${missingVar} environment variable is not configured` });
      return;
    }

    const priceId = priceConfig.priceId;
    const stripe = getStripeInstance();
    const reqOrigin = req.headers.origin ? String(req.headers.origin).replace(/\/$/, '') : null;
    const frontendUrl = reqOrigin || (process.env.FRONTEND_URL || 'http://localhost:8080').replace(/\/$/, '');

    // Allow caller to pass returnPath, otherwise construct a clean query URL
    const rawReturnPath = req.body?.returnPath || req.body?.source;
    let returnPath = `/knowledge?book-name=reset-by-discipline&version=${version}`;
    if (typeof rawReturnPath === 'string' && rawReturnPath.startsWith('/')) {
      returnPath = rawReturnPath;
    }

    const productTitle = version === 'nl'
      ? 'Reset door Discipline (Dutch Edition)'
      : 'Reset by Discipline (English Edition)';

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: `${frontendUrl}/payment-success?session_id={CHECKOUT_SESSION_ID}&version=${version}&from=${encodeURIComponent(returnPath)}`,
      cancel_url: `${frontendUrl}${returnPath}`,
      metadata: {
        product: productTitle,
        author: 'Lionel Eersteling',
        version,
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
 * Returns payment status and purchased book version ('en' | 'nl').
 */
checkoutRouter.get('/payment-status', async (req: Request, res: Response): Promise<void> => {
  try {
    const sessionId = req.query.session_id as string | undefined;

    if (!sessionId || typeof sessionId !== 'string') {
      res.status(400).json({ error: 'Missing or invalid session_id parameter' });
      return;
    }

    const validPriceIds = getAllBookPriceIds();
    const stripe = getStripeInstance();

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['line_items'],
    });

    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const isPaid = session.payment_status === 'paid';

    // Verify product price if line items are available and price IDs are configured
    if (validPriceIds.length > 0 && session.line_items?.data) {
      const containsExpectedProduct = session.line_items.data.some(
        (item) => item.price?.id && validPriceIds.includes(item.price.id)
      );
      if (!containsExpectedProduct && isPaid) {
        console.warn(`[Stripe] Session ${sessionId} does not contain an expected price ID (${validPriceIds.join(', ')})`);
        res.status(400).json({ status: 'unverified' });
        return;
      }
    }

    const version = getSessionVersion(session);

    if (isPaid) {
      sendTextBookPurchaseEmailsIfPending(session.id, session).catch((err: any) =>
        console.warn('[Stripe Payment Status] Non-blocking invoice dispatch notice:', err?.message || err)
      );
    }

    res.status(200).json({
      status: isPaid ? 'paid' : session.payment_status || 'pending',
      version,
      returnPath: session.metadata?.returnPath || null,
    });
  } catch (error: any) {
    console.error('[Stripe] Error checking payment status:', error?.message || error);
    res.status(500).json({ error: 'Unable to verify payment status' });
  }
});

/**
 * GET /api/v1/payments/checkout/:sessionId
 * Returns verified payment status and entitlement for the checkout success page.
 * Supports both Audiobooks and PDF books.
 */
checkoutRouter.get('/payments/checkout/:sessionId', async (req: Request, res: Response): Promise<void> => {
  try {
    const { sessionId } = req.params;

    if (!sessionId || typeof sessionId !== 'string') {
      res.status(400).json({ error: 'Missing or invalid sessionId parameter' });
      return;
    }

    const stripe = getStripeInstance();
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['line_items'],
    });

    if (!session) {
      res.status(404).json({ error: 'Checkout session not found' });
      return;
    }

    const isPaid = session.payment_status === 'paid';
    const isAudiobook =
      session.metadata?.productType === 'audiobook' ||
      session.metadata?.bookId === 'reset-by-discipline';

    if (isAudiobook) {
      const {
        checkPurchaseAccess,
        sendAudiobookPurchaseEmailsIfPending,
      } = require('../../services/audiobookService');
      const accessInfo = await checkPurchaseAccess('reset-by-discipline', { sessionId });

      if (isPaid) {
        sendAudiobookPurchaseEmailsIfPending(session.id, session, accessInfo.accessToken).catch((err: any) =>
          console.warn('[Audiobook Checkout Status] Non-blocking invoice dispatch notice:', err?.message || err)
        );
      }

      res.status(200).json({
        status: isPaid ? 'paid' : session.payment_status || 'pending',
        paid: isPaid,
        sessionId: session.id,
        productType: 'audiobook',
        bookId: 'reset-by-discipline',
        hasAccess: accessInfo.hasAccess,
        accessToken: accessInfo.accessToken || null,
        customerEmail: session.customer_details?.email || session.customer_email || accessInfo.customerEmail || null,
        amount: session.amount_total,
        currency: session.currency,
        returnPath: session.metadata?.returnPath || null,
      });
      return;
    }

    // Default: Book or standard checkout
    const version = getSessionVersion(session);

    if (isPaid) {
      sendTextBookPurchaseEmailsIfPending(session.id, session).catch((err: any) =>
        console.warn('[Stripe Checkout Status] Non-blocking invoice dispatch notice:', err?.message || err)
      );
    }

    res.status(200).json({
      status: isPaid ? 'paid' : session.payment_status || 'pending',
      paid: isPaid,
      sessionId: session.id,
      version,
      customerEmail: session.customer_details?.email || session.customer_email || null,
      amount: session.amount_total,
      currency: session.currency,
      returnPath: session.metadata?.returnPath || null,
    });
  } catch (error: any) {
    console.error('[Stripe Payments] Error checking checkout status:', error?.message || error);
    res.status(500).json({ error: 'Unable to verify payment status' });
  }
});

/**
 * GET /api/download?session_id=...
 * Serves the private PDF book (English or Dutch) only after verifying payment directly with Stripe.
 */
checkoutRouter.get('/download', async (req: Request, res: Response): Promise<void> => {
  try {
    const sessionId = req.query.session_id as string | undefined;

    if (!sessionId || typeof sessionId !== 'string') {
      res.status(400).json({ error: 'Missing or invalid session_id' });
      return;
    }

    const validPriceIds = getAllBookPriceIds();
    const stripe = getStripeInstance();

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['line_items'],
    });

    if (!session || session.payment_status !== 'paid') {
      res.status(403).json({ error: 'Payment not completed or session unauthorized' });
      return;
    }

    // Verify price if configured
    if (validPriceIds.length > 0 && session.line_items?.data) {
      const containsExpectedProduct = session.line_items.data.some(
        (item) => item.price?.id && validPriceIds.includes(item.price.id)
      );
      if (!containsExpectedProduct) {
        res.status(403).json({ error: 'Unauthorized product in session' });
        return;
      }
    }

    // Determine version and resolve corresponding file path
    const version = getSessionVersion(session);
    const bookFile = getBookFilePath(version);

    if (!bookFile || !fs.existsSync(bookFile.filePath)) {
      console.error(`[Stripe] Private book file (${version}) not found on server`);
      res.status(404).json({ error: `Book file (${version.toUpperCase()}) not found on server` });
      return;
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${bookFile.fileName}"`);
    res.sendFile(bookFile.filePath);
  } catch (error: any) {
    console.error('[Stripe] Error serving download:', error?.message || error);
    res.status(403).json({ error: 'Payment verification failed' });
  }
});

/**
 * POST /api/stripe/webhook
 * Universal Stripe Webhook for Production & Staging:
 * - Production: https://api.leadersperformance.ae/api/v1/stripe/webhook
 * - Staging: https://staging.leadersperformance.ae/api/v1/stripe/webhook
 * Verifies signatures using rawBody, strictly validates environment livemode,
 * guarantees idempotency, records diagnostics, and dispatches invoice emails.
 */
checkoutRouter.post('/stripe/webhook', handleStripeWebhook);

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
