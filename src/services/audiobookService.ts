import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Request, Response } from 'express';
import Stripe from 'stripe';
import { PrismaClient } from '@prisma/client';
import { createClient } from '@supabase/supabase-js';
import { getStripeClient, isProductionEnvironment, recordEventProcessed, isEventProcessed } from './stripeWebhookService';
import { upsertContact, sendEmail } from './ghl';

const prisma = new PrismaClient();

export const DEFAULT_BOOK_ID = 'reset-by-discipline';

/**
 * Normalizes bookId input.
 * Supports 'reset-by-discipline', 'reset-by-discipline-en', 'reset-by-discipline-english'.
 */
export function normalizeBookId(bookId: string | undefined): string {
  if (!bookId) return '';
  const clean = bookId.toLowerCase().trim();
  if (
    clean === 'reset-by-discipline' ||
    clean === 'reset-by-discipline-en' ||
    clean === 'reset-by-discipline-english'
  ) {
    return DEFAULT_BOOK_ID;
  }
  return clean;
}

/**
 * Validates if the given bookId corresponds to a supported book.
 */
export function isValidBookId(bookId: string | undefined): boolean {
  return normalizeBookId(bookId) === DEFAULT_BOOK_ID;
}

/**
 * Resolves the Stripe Price ID for the English Audiobook.
 */
export function getAudiobookPriceId(): string {
  const priceId =
    process.env.STRIPE_AUDIOBOOK_PRICE_ID_EN ||
    process.env.STRIPE_AUDIOBOOK_PRICE_ID ||
    process.env.STRIPE_BOOK_PRICE_ID_EN;

  if (!priceId) {
    throw new Error('STRIPE_AUDIOBOOK_PRICE_ID_EN (or STRIPE_BOOK_PRICE_ID_EN) is not configured');
  }
  return priceId;
}

/**
 * Securely synchronizes the original audiobook from the private Supabase 'audio' bucket
 * using the backend's SUPABASE_SERVICE_ROLE_KEY.
 * The file is stored only in the backend's private directory and is never publicly exposed.
 */
export async function ensureAudiobookFromSupabase(): Promise<string | null> {
  const destDir = path.resolve(process.cwd(), 'private');
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  const localFile = path.join(destDir, 'reset-by-discipline.mp3');

  if (fs.existsSync(localFile) && fs.statSync(localFile).size > 1000000) {
    return localFile;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.warn('[Audiobook Storage] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured');
    return null;
  }

  try {
    const supabase = createClient(supabaseUrl, serviceKey);
    const bucket = process.env.SUPABASE_AUDIO_BUCKET || 'audio';
    const remoteFile = 'reset-by-discipline.mp3';

    console.log(`[Audiobook Storage] Securely pulling '${remoteFile}' from Supabase bucket '${bucket}'...`);
    const { data, error } = await supabase.storage.from(bucket).download(remoteFile);
    if (error || !data) {
      console.warn('[Audiobook Storage] Supabase download error:', error?.message);
      return null;
    }

    const buffer = Buffer.from(await data.arrayBuffer());
    fs.writeFileSync(localFile, buffer);
    console.log(`[Audiobook Storage] Successfully downloaded and secured ${remoteFile} (${buffer.length} bytes).`);
    return localFile;
  } catch (err: any) {
    console.warn('[Audiobook Storage] Error retrieving audio from Supabase:', err.message);
    return null;
  }
}

/**
 * Resolves the absolute file path to the private English audiobook audio file.
 * Checks environment overrides, private storage directory, and fallbacks.
 */
export function getAudiobookFilePath(): { filePath: string; fileName: string } | null {
  const envPath = process.env.AUDIOBOOK_FILE_PATH_EN || process.env.AUDIOBOOK_FILE_PATH;
  const fileName = 'reset-by-discipline.mp3';

  const candidates = [
    envPath,
    path.resolve(process.cwd(), 'private', 'reset-by-discipline.mp3'),
    path.resolve(process.cwd(), 'private', 'RESET BY DISCIPLINE - ENGLISH.mp3'),
    path.resolve(__dirname, '../../../private', 'reset-by-discipline.mp3'),
    path.resolve(__dirname, '../../../private', 'RESET BY DISCIPLINE - ENGLISH.mp3'),
    path.resolve(__dirname, '../../private', 'reset-by-discipline.mp3'),
    path.resolve(__dirname, '../../private', 'RESET BY DISCIPLINE - ENGLISH.mp3'),
    path.resolve(process.cwd(), 'private', 'reset-by-discipline-en.mp3'),
    path.resolve(process.cwd(), 'private', 'audiobook-en.mp3'),
    path.resolve(process.cwd(), 'test_audio.mp3'),
  ].filter(Boolean) as string[];

  let resolved = candidates.find((p) => fs.existsSync(p));

  // Dynamic directory scan in private/ if not matched by fixed name
  if (!resolved) {
    const dirCandidates = [
      path.resolve(process.cwd(), 'private'),
      path.resolve(__dirname, '../../../private'),
      path.resolve(__dirname, '../../private'),
    ];

    for (const dir of dirCandidates) {
      if (fs.existsSync(dir)) {
        try {
          const files = fs.readdirSync(dir);
          const match = files.find((f) => {
            const lower = f.toLowerCase();
            return (
              (lower.endsWith('.mp3') || lower.endsWith('.m4a') || lower.endsWith('.wav')) &&
              (lower.includes('discipline') || lower.includes('audiobook') || lower.includes('english'))
            );
          });
          if (match) {
            resolved = path.resolve(dir, match);
            break;
          }
        } catch {
          // Ignore scan errors
        }
      }
    }
  }

  if (!resolved || !fs.existsSync(resolved)) {
    return null;
  }

  return { filePath: path.resolve(resolved), fileName };
}

/**
 * Calculates the exact byte offset for a 60-second audio preview.
 * Inspects MP3 ID3v2 header and first MPEG frame to determine bitrate (e.g. 128 kbps = 16,000 bytes/sec).
 * Returns min(fileSize, headerOffset + bitrate * previewSeconds).
 */
export function calculatePreviewByteLimit(filePath: string, previewSeconds = 60): number {
  const stat = fs.statSync(filePath);
  const totalSize = stat.size;

  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(Math.min(totalSize, 8192));
  fs.readSync(fd, buffer, 0, buffer.length, 0);
  fs.closeSync(fd);

  let id3Offset = 0;
  if (buffer.length >= 10 && buffer.subarray(0, 3).toString('utf-8') === 'ID3') {
    const tagSize =
      ((buffer[6] & 0x7f) << 21) |
      ((buffer[7] & 0x7f) << 14) |
      ((buffer[8] & 0x7f) << 7) |
      (buffer[9] & 0x7f);
    id3Offset = 10 + tagSize;
  }

  // Default fallback bitrate is 128 kbps (16,000 bytes/sec)
  let bitrateBps = 16000;

  // Scan for sync word 0xFFE0
  for (let i = id3Offset; i < buffer.length - 4; i++) {
    if (buffer[i] === 0xff && (buffer[i + 1] & 0xe0) === 0xe0) {
      const version = (buffer[i + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2
      const layer = (buffer[i + 1] >> 1) & 3; // 1 = Layer III
      const bitrateIdx = (buffer[i + 2] >> 4) & 15;

      const mpeg1L3Bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
      const mpeg2L3Bitrates = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];

      let kbps = 128;
      if (version === 3 && layer === 1 && bitrateIdx < mpeg1L3Bitrates.length) {
        kbps = mpeg1L3Bitrates[bitrateIdx] || 128;
      } else if (version === 2 && layer === 1 && bitrateIdx < mpeg2L3Bitrates.length) {
        kbps = mpeg2L3Bitrates[bitrateIdx] || 64;
      }

      bitrateBps = Math.round((kbps * 1000) / 8);
      break;
    }
  }

  const calculatedLimit = id3Offset + bitrateBps * previewSeconds;
  return Math.min(totalSize, calculatedLimit);
}

/**
 * Generates an unguessable, cryptographically secure purchase entitlement token.
 */
export function generateAccessToken(): string {
  const randomHex = crypto.randomBytes(32).toString('hex');
  return `ab_ent_${randomHex}`;
}

/**
 * Streams private audio file with strict HTTP Range support.
 * If maxAllowedByte is specified, requests beyond that byte are clamped or rejected with 416.
 */
export function streamAudioFile(
  req: Request,
  res: Response,
  filePath: string,
  options: { maxAllowedByte?: number; isPreview?: boolean } = {}
): void {
  const stat = fs.statSync(filePath);
  const totalFileSize = stat.size;
  const maxByte = options.maxAllowedByte ? Math.min(totalFileSize, options.maxAllowedByte) : totalFileSize;
  const rangeHeader = req.headers.range;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader(
    'Cache-Control',
    options.isPreview ? 'public, max-age=3600' : 'private, no-cache, no-store, must-revalidate'
  );

  if (!rangeHeader) {
    // Non-range request: send up to maxByte
    res.setHeader('Content-Length', maxByte);
    res.status(200);

    const stream = fs.createReadStream(filePath, { start: 0, end: maxByte - 1 });
    stream.on('error', (err) => {
      console.error('[Audio Stream] Read error:', err.message);
      if (!res.headersSent) res.status(500).end();
    });
    stream.pipe(res);
    return;
  }

  // Parse Range header: e.g. "bytes=0-1023", "bytes=1024-", "bytes=-500"
  const matches = rangeHeader.match(/bytes=(\d*)-(\d*)/);
  if (!matches) {
    res.status(416).setHeader('Content-Range', `bytes */${maxByte}`).end();
    return;
  }

  let start: number;
  let end: number;

  if (matches[1] === '' && matches[2] !== '') {
    // Suffix range: bytes=-500
    const suffix = parseInt(matches[2], 10);
    start = Math.max(0, maxByte - suffix);
    end = maxByte - 1;
  } else if (matches[1] !== '' && matches[2] === '') {
    // Open-ended range: bytes=1024-
    start = parseInt(matches[1], 10);
    end = maxByte - 1;
  } else {
    // Bounded range: bytes=1024-2047
    start = parseInt(matches[1], 10);
    end = parseInt(matches[2], 10);
  }

  // Range validation against maxByte boundary
  if (start >= maxByte || start < 0) {
    res.status(416).setHeader('Content-Range', `bytes */${maxByte}`).end();
    return;
  }

  // Clamp end byte
  if (end >= maxByte) {
    end = maxByte - 1;
  }

  if (start > end) {
    res.status(416).setHeader('Content-Range', `bytes */${maxByte}`).end();
    return;
  }

  const chunkSize = end - start + 1;
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${maxByte}`);
  res.setHeader('Content-Length', chunkSize);

  const stream = fs.createReadStream(filePath, { start, end });
  stream.on('error', (err) => {
    console.error('[Audio Stream] Range stream error:', err.message);
    if (!res.headersSent) res.status(500).end();
  });
  stream.pipe(res);
}

/**
 * Creates a Stripe Hosted Checkout Session for the English Audiobook.
 */
export async function createAudiobookCheckoutSession(
  bookId: string,
  params: {
    returnPath?: string;
    origin?: string;
    customerEmail?: string;
    customerName?: string;
  }
): Promise<{ url: string; sessionId: string }> {
  const normalized = normalizeBookId(bookId);
  if (normalized !== DEFAULT_BOOK_ID) {
    throw new Error(`Unsupported book ID: ${bookId}`);
  }

  const priceId = getAudiobookPriceId();
  const stripe = getStripeClient();

  let originBase: string | null = null;
  if (params.origin) {
    try {
      originBase = new URL(params.origin).origin;
    } catch {
      originBase = params.origin.replace(/\/$/, '');
    }
  }
  const frontendUrl = (originBase || process.env.FRONTEND_URL || 'http://localhost:8080').replace(/\/$/, '');
  const returnPath = params.returnPath || `/knowledge?book-name=${normalized}&product=audiobook`;

  const accessToken = generateAccessToken();

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    invoice_creation: {
      enabled: true,
      invoice_data: {
        description: 'Reset by Discipline — English Audiobook',
        metadata: {
          bookId: normalized,
          product: 'Reset by Discipline (English Audiobook)',
          author: 'Lionel Eersteling',
        },
      },
    },
    line_items: [
      {
        price: priceId,
        quantity: 1,
      },
    ],
    customer_email: params.customerEmail || undefined,
    success_url: `${frontendUrl}/payment-success?session_id={CHECKOUT_SESSION_ID}&book=${normalized}&product=audiobook&from=${encodeURIComponent(
      returnPath
    )}`,
    cancel_url: `${frontendUrl}${returnPath.startsWith('/') ? returnPath : `/${returnPath}`}`,
    metadata: {
      bookId: normalized,
      productType: 'audiobook',
      version: 'en',
      returnPath,
      product: 'Reset by Discipline (English Audiobook)',
      author: 'Lionel Eersteling',
    },
  });

  if (!session.url) {
    throw new Error('Failed to generate Stripe checkout URL');
  }

  // Create pending purchase record in database
  try {
    await prisma.audiobookPurchase.create({
      data: {
        bookId: normalized,
        version: 'en',
        stripeSessionId: session.id,
        paymentStatus: 'pending',
        accessGranted: false,
        accessToken,
        customerEmail: params.customerEmail || null,
        customerName: params.customerName || null,
        currency: session.currency || 'usd',
      },
    });
  } catch (dbErr: any) {
    console.error('[Audiobook] Error storing pending purchase record:', dbErr.message);
  }

  return { url: session.url, sessionId: session.id };
}

/**
 * Checks purchase access using an accessToken OR a Stripe checkout sessionId.
 * If sessionId is provided, verifies with Stripe if pending, updates status, and returns accessToken.
 */
export async function checkPurchaseAccess(
  bookId: string,
  query: { token?: string; sessionId?: string }
): Promise<{
  hasAccess: boolean;
  bookId: string;
  accessToken?: string;
  customerEmail?: string | null;
  paidAt?: Date | null;
  message?: string;
}> {
  const normalized = normalizeBookId(bookId);
  if (normalized !== DEFAULT_BOOK_ID) {
    return { hasAccess: false, bookId, message: 'Book not found' };
  }

  // 1. Check by access token
  if (query.token && typeof query.token === 'string') {
    const purchase = await prisma.audiobookPurchase.findUnique({
      where: { accessToken: query.token },
    });

    if (purchase && purchase.bookId === normalized && purchase.accessGranted && purchase.paymentStatus === 'paid') {
      if (purchase.expiresAt && purchase.expiresAt < new Date()) {
        return { hasAccess: false, bookId: normalized, message: 'Access entitlement has expired' };
      }
      return {
        hasAccess: true,
        bookId: normalized,
        accessToken: purchase.accessToken,
        customerEmail: purchase.customerEmail,
        paidAt: purchase.paidAt,
      };
    }

    return { hasAccess: false, bookId: normalized, message: 'Invalid or unpaid purchase entitlement' };
  }

  // 2. Check by Stripe Checkout Session ID
  if (query.sessionId && typeof query.sessionId === 'string') {
    const purchase = await prisma.audiobookPurchase.findUnique({
      where: { stripeSessionId: query.sessionId },
    });

    if (purchase && purchase.accessGranted && purchase.paymentStatus === 'paid') {
      return {
        hasAccess: true,
        bookId: normalized,
        accessToken: purchase.accessToken,
        customerEmail: purchase.customerEmail,
        paidAt: purchase.paidAt,
      };
    }

    // Direct Stripe verification if pending or record was missed
    try {
      const stripe = getStripeClient();
      const session = await stripe.checkout.sessions.retrieve(query.sessionId, {
        expand: ['line_items'],
      });

      if (session && session.payment_status === 'paid') {
        const isAudiobook =
          session.metadata?.productType === 'audiobook' ||
          session.metadata?.bookId === normalized ||
          (session.line_items?.data &&
            session.line_items.data.some((item) => item.price?.id === getAudiobookPriceId()));

        if (isAudiobook) {
          const rawEmail = session.customer_details?.email || session.customer_email || null;
          const rawName = session.customer_details?.name || null;
          const paymentIntentId =
            typeof session.payment_intent === 'string'
              ? session.payment_intent
              : session.payment_intent?.id || null;

          if (purchase) {
            const updated = await prisma.audiobookPurchase.update({
              where: { id: purchase.id },
              data: {
                paymentStatus: 'paid',
                accessGranted: true,
                paidAt: purchase.paidAt || new Date(),
                stripePaymentIntentId: paymentIntentId,
                customerEmail: rawEmail || purchase.customerEmail,
                customerName: rawName || purchase.customerName,
                amount: session.amount_total ?? purchase.amount,
              },
            });
            return {
              hasAccess: true,
              bookId: normalized,
              accessToken: updated.accessToken,
              customerEmail: updated.customerEmail,
              paidAt: updated.paidAt,
            };
          } else {
            const newAccessToken = generateAccessToken();
            const created = await prisma.audiobookPurchase.create({
              data: {
                bookId: normalized,
                version: 'en',
                stripeSessionId: session.id,
                stripePaymentIntentId: paymentIntentId,
                paymentStatus: 'paid',
                accessGranted: true,
                accessToken: newAccessToken,
                customerEmail: rawEmail,
                customerName: rawName,
                amount: session.amount_total,
                currency: session.currency || 'usd',
                paidAt: new Date(),
              },
            });
            return {
              hasAccess: true,
              bookId: normalized,
              accessToken: created.accessToken,
              customerEmail: created.customerEmail,
              paidAt: created.paidAt,
            };
          }
        }
      }
    } catch (stripeErr: any) {
      console.warn('[Audiobook] Direct Stripe session check notice:', stripeErr.message);
    }
  }

  return { hasAccess: false, bookId: normalized, message: 'No valid purchase entitlement found' };
}

/**
 * Validates purchase entitlement token for audio streaming.
 * Strict check: rejects missing, invalid, unpaid, or expired entitlements.
 */
export async function verifyEntitlementForStream(
  bookId: string,
  token: string | undefined
): Promise<{ valid: boolean; purchase?: any; error?: string }> {
  if (!token || typeof token !== 'string') {
    return { valid: false, error: 'Missing purchase entitlement token' };
  }

  const normalized = normalizeBookId(bookId);
  if (normalized !== DEFAULT_BOOK_ID) {
    return { valid: false, error: 'Book not found' };
  }

  try {
    const purchase = await prisma.audiobookPurchase.findUnique({
      where: { accessToken: token },
    });

    if (!purchase) {
      return { valid: false, error: 'Invalid purchase entitlement token' };
    }

    if (purchase.bookId !== normalized) {
      return { valid: false, error: 'Entitlement token does not match requested book' };
    }

    if (!purchase.accessGranted || purchase.paymentStatus !== 'paid') {
      return { valid: false, error: 'Payment has not been confirmed for this purchase' };
    }

    if (purchase.expiresAt && purchase.expiresAt < new Date()) {
      return { valid: false, error: 'Purchase entitlement has expired' };
    }

    return { valid: true, purchase };
  } catch (err: any) {
    console.error('[Audiobook] Entitlement verification error:', err.message);
    return { valid: false, error: 'Internal entitlement validation error' };
  }
}

/**
 * Webhook fulfiller for Stripe events matching Audiobook purchases.
 */
export async function handleAudiobookWebhookSession(
  session: Stripe.Checkout.Session,
  eventId: string,
  eventType: string
): Promise<boolean> {
  const sessionId = session.id;

  // Check if session is linked to an AudiobookPurchase
  const purchase = await prisma.audiobookPurchase.findUnique({
    where: { stripeSessionId: sessionId },
  });

  const isAudiobookSession =
    Boolean(purchase) ||
    session.metadata?.productType === 'audiobook' ||
    session.metadata?.bookId === DEFAULT_BOOK_ID;

  if (!isAudiobookSession) {
    return false; // Not an audiobook session
  }

  console.log(`[Audiobook Webhook] Processing event ${eventId} (${eventType}) for session ${sessionId}`);

  const paymentIntentId =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id || null;

  const customerEmail = session.customer_details?.email || session.customer_email || null;
  const customerName = session.customer_details?.name || null;
  const amount = session.amount_total;

  if (eventType === 'checkout.session.completed' || eventType === 'checkout.session.async_payment_succeeded') {
    const isPaid = session.payment_status === 'paid';
    let accessToken = purchase?.accessToken;

    if (purchase) {
      await prisma.audiobookPurchase.update({
        where: { id: purchase.id },
        data: {
          paymentStatus: isPaid ? 'paid' : session.payment_status || 'pending',
          accessGranted: isPaid,
          paidAt: isPaid ? purchase.paidAt || new Date() : null,
          stripePaymentIntentId: paymentIntentId || purchase.stripePaymentIntentId,
          customerEmail: customerEmail || purchase.customerEmail,
          customerName: customerName || purchase.customerName,
          amount: amount ?? purchase.amount,
        },
      });
      accessToken = purchase.accessToken;
    } else {
      accessToken = generateAccessToken();
      await prisma.audiobookPurchase.create({
        data: {
          bookId: session.metadata?.bookId || DEFAULT_BOOK_ID,
          version: 'en',
          stripeSessionId: sessionId,
          stripePaymentIntentId: paymentIntentId,
          paymentStatus: isPaid ? 'paid' : session.payment_status || 'pending',
          accessGranted: isPaid,
          accessToken,
          customerEmail,
          customerName,
          amount,
          currency: session.currency || 'usd',
          paidAt: isPaid ? new Date() : null,
        },
      });
    }

    // Dispatch confirmation email to customer (with Stripe invoice) and staff alert to info@leadersperformance.ae
    const recipientEmail = customerEmail || purchase?.customerEmail;
    if (isPaid && recipientEmail) {
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
        console.warn('[Audiobook Webhook] Notice retrieving invoice details:', invErr.message);
      }

      await sendAudiobookPurchaseEmails({
        customerEmail: recipientEmail,
        customerName: customerName || purchase?.customerName || null,
        amountPaidCents: amount ?? purchase?.amount ?? 999,
        currency: session.currency || 'usd',
        paidAt: new Date(),
        stripeSessionId: sessionId,
        stripePaymentIntentId: paymentIntentId,
        accessToken: accessToken || '',
        invoiceNumber: invoiceNumber || `INV-AB-${sessionId.slice(-8).toUpperCase()}`,
        hostedInvoiceUrl,
        invoicePdf,
      });
    }

    await recordEventProcessed(eventId, eventType, {
      productType: 'audiobook',
      sessionId,
      paid: isPaid,
    });
    return true;
  }

  if (eventType === 'checkout.session.async_payment_failed') {
    if (purchase) {
      await prisma.audiobookPurchase.update({
        where: { id: purchase.id },
        data: {
          paymentStatus: 'failed',
          accessGranted: false,
        },
      });
    }
    await recordEventProcessed(eventId, eventType, {
      productType: 'audiobook',
      sessionId,
      status: 'failed',
    });
    return true;
  }

  if (eventType === 'checkout.session.expired') {
    if (purchase) {
      await prisma.audiobookPurchase.update({
        where: { id: purchase.id },
        data: {
          paymentStatus: 'expired',
          accessGranted: false,
        },
      });
    }
    await recordEventProcessed(eventId, eventType, {
      productType: 'audiobook',
      sessionId,
      status: 'expired',
    });
    return true;
  }

  return false;
}

/**
  * Interface for audiobook purchase confirmation and invoice email data.
  */
export interface AudiobookInvoiceEmailData {
  customerEmail: string;
  customerName?: string | null;
  amountPaidCents?: number | null;
  currency?: string | null;
  paidAt?: Date | string | null;
  stripeSessionId: string;
  stripePaymentIntentId?: string | null;
  accessToken: string;
  invoiceNumber?: string | null;
  hostedInvoiceUrl?: string | null;
  invoicePdf?: string | null;
}

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function loadAudiobookTemplate(filename: string): string {
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

function formatDubaiDate(date?: Date | string | null): string {
  try {
    const d = date ? new Date(date) : new Date();
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
 * Resolves direct PDF invoice download URL from Stripe invoice data.
 */
function resolveInvoiceDownloadUrl(
  invoicePdf?: string | null,
  hostedInvoiceUrl?: string | null,
  sessionId?: string
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
  const frontendUrl = (process.env.FRONTEND_URL || 'https://leadersperformance.ae').replace(/\/$/, '');
  return `${frontendUrl}/payment-success?session_id=${encodeURIComponent(
    sessionId || ''
  )}&book=reset-by-discipline&product=audiobook`;
}

/**
  * Builds the customer email HTML from audiobook-invoice-confirmation.html template.
  */
export function buildAudiobookInvoiceEmailHtml(data: AudiobookInvoiceEmailData): string {
  const rawTemplate = loadAudiobookTemplate('audiobook-invoice-confirmation.html');
  const frontendUrl = (process.env.FRONTEND_URL || 'https://leadersperformance.ae').replace(/\/$/, '');
  const tokenParam = data.accessToken ? `&token=${encodeURIComponent(data.accessToken)}` : '';
  const sessionParam = data.stripeSessionId ? `&session_id=${encodeURIComponent(data.stripeSessionId)}` : '';
  const audiobookUrl = `${frontendUrl}/knowledge?book-name=reset-by-discipline&product=audiobook&format=audiobook${tokenParam}${sessionParam}#reset-by-discipline`;
  const directDownloadUrl = `${frontendUrl}/api/v1/books/reset-by-discipline/audio?token=${encodeURIComponent(
    data.accessToken
  )}&download=true`;
  const invoiceNumber = data.invoiceNumber || `INV-AB-${data.stripeSessionId.slice(-8).toUpperCase()}`;
  const fullName = escapeHtml(data.customerName || 'Audiobook Reader');
  const email = escapeHtml(data.customerEmail);
  const paidAtFormatted = formatDubaiDate(data.paidAt);
  const amountPaidCents = data.amountPaidCents ?? 999;
  const amountPaidFormatted = (amountPaidCents / 100).toFixed(2);
  const invoiceDownloadUrl = resolveInvoiceDownloadUrl(
    data.invoicePdf,
    data.hostedInvoiceUrl,
    data.stripeSessionId
  );

  let invoiceLinksHtml = '';
  invoiceLinksHtml += `<td style="padding: 0 10px;"><a href="${escapeHtml(
    invoiceDownloadUrl
  )}" target="_blank" style="color: #9f6511; font-family: 'Inter', Arial, sans-serif; font-size: 13.5px; font-weight: 700; text-decoration: underline;">Download Tax Invoice (PDF) &darr;</a></td>`;

  if (data.hostedInvoiceUrl && data.hostedInvoiceUrl !== invoiceDownloadUrl) {
    invoiceLinksHtml += `<td style="padding: 0 10px;"><a href="${escapeHtml(
      data.hostedInvoiceUrl
    )}" target="_blank" style="color: #9f6511; font-family: 'Inter', Arial, sans-serif; font-size: 13.5px; font-weight: 600; text-decoration: underline;">View Online Invoice &rarr;</a></td>`;
  }

  if (rawTemplate) {
    return rawTemplate
      .replace(/{{invoice_number}}/g, escapeHtml(invoiceNumber))
      .replace(/{{full_name}}/g, fullName)
      .replace(/{{email}}/g, email)
      .replace(/{{paid_at}}/g, escapeHtml(paidAtFormatted))
      .replace(/{{amount_paid_formatted}}/g, amountPaidFormatted)
      .replace(/{{audiobook_url}}/g, escapeHtml(audiobookUrl))
      .replace(/{{direct_download_url}}/g, escapeHtml(directDownloadUrl))
      .replace(/{{invoice_download_url}}/g, escapeHtml(invoiceDownloadUrl))
      .replace(/{{invoice_links_html}}/g, invoiceLinksHtml);
  }

  return `<!DOCTYPE html><html><body><h1>Reset by Discipline Audiobook - Invoice</h1><p>Invoice: ${escapeHtml(
    invoiceNumber
  )}</p><p>Amount: US $${amountPaidFormatted}</p><p><a href="${escapeHtml(
    invoiceDownloadUrl
  )}">Download Tax Invoice (PDF)</a></p><p><a href="${escapeHtml(
    audiobookUrl
  )}">Listen to Complete Audiobook</a></p><p><a href="${escapeHtml(
    directDownloadUrl
  )}">Direct Download Audio (MP3)</a></p></body></html>`;
}

/**
  * Builds the staff alert email HTML from audiobook-staff-alert.html template.
  */
export function buildAudiobookStaffAlertHtml(data: AudiobookInvoiceEmailData): string {
  const rawTemplate = loadAudiobookTemplate('audiobook-staff-alert.html');
  const invoiceNumber = data.invoiceNumber || `INV-AB-${data.stripeSessionId.slice(-8).toUpperCase()}`;
  const fullName = escapeHtml(data.customerName || 'Audiobook Reader');
  const email = escapeHtml(data.customerEmail);
  const paidAtFormatted = formatDubaiDate(data.paidAt);
  const amountPaidCents = data.amountPaidCents ?? 999;
  const amountPaidFormatted = (amountPaidCents / 100).toFixed(2);
  const currency = escapeHtml((data.currency || 'usd').toUpperCase());
  const invoiceDownloadUrl = resolveInvoiceDownloadUrl(
    data.invoicePdf,
    data.hostedInvoiceUrl,
    data.stripeSessionId
  );

  let staffActionButtonsHtml = `
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

  if (rawTemplate) {
    return rawTemplate
      .replace(/{{headline}}/g, `[Staff Alert] Audiobook Purchased: ${fullName} (Invoice ${escapeHtml(invoiceNumber)})`)
      .replace(/{{full_name}}/g, fullName)
      .replace(/{{email}}/g, email)
      .replace(/{{paid_at}}/g, escapeHtml(paidAtFormatted))
      .replace(/{{amount_paid_formatted}}/g, amountPaidFormatted)
      .replace(/{{currency}}/g, currency)
      .replace(/{{invoice_number}}/g, escapeHtml(invoiceNumber))
      .replace(/{{stripe_session_id}}/g, escapeHtml(data.stripeSessionId))
      .replace(/{{stripe_payment_intent_id}}/g, escapeHtml(data.stripePaymentIntentId || 'N/A'))
      .replace(/{{access_token}}/g, escapeHtml(data.accessToken))
      .replace(/{{invoice_download_url}}/g, escapeHtml(invoiceDownloadUrl))
      .replace(/{{staff_action_buttons_html}}/g, staffActionButtonsHtml);
  }

  return `<!DOCTYPE html><html><body><h1>[Staff Alert] New Audiobook Purchase</h1><p>Customer: ${fullName} (${email})</p><p>Amount: US $${amountPaidFormatted} ${currency}</p><p>Invoice: ${escapeHtml(
    invoiceNumber
  )}</p><p><a href="${escapeHtml(invoiceDownloadUrl)}">Download PDF Invoice</a></p></body></html>`;
}

/**
  * Dispatches confirmation email to customer (with Stripe tax invoice) and alert to info@leadersperformance.ae.
  */
export async function sendAudiobookPurchaseEmails(
  data: AudiobookInvoiceEmailData
): Promise<{ customerDelivered: boolean; staffDelivered: boolean }> {
  const invoiceNumber = data.invoiceNumber || `INV-AB-${data.stripeSessionId.slice(-8).toUpperCase()}`;
  const amountPaidCents = data.amountPaidCents ?? 999;
  const amountPaidFormatted = (amountPaidCents / 100).toFixed(2);
  let customerDelivered = false;
  let staffDelivered = false;

  // 1. Dispatch confirmation & invoice email to customer
  try {
    const contactId = await upsertContact({
      email: data.customerEmail,
      firstName: data.customerName?.split(' ')[0] || 'Reader',
      lastName: data.customerName?.split(' ').slice(1).join(' ') || undefined,
      tags: ['Audiobook Customer', 'Reset by Discipline Audiobook', 'Invoice Sent'],
    });

    if (contactId) {
      const customerSubject = `Reset by Discipline Audiobook — Payment Receipt & Tax Invoice (${invoiceNumber})`;
      const customerHtml = buildAudiobookInvoiceEmailHtml(data);
      await sendEmail(contactId, customerSubject, customerHtml);
      console.log(
        `[Audiobook Invoice] Successfully delivered invoice email to customer ${data.customerEmail} (Invoice: ${invoiceNumber})`
      );
      customerDelivered = true;
    }
  } catch (err: any) {
    console.warn('[Audiobook Invoice] Notice dispatching invoice email to customer:', err.message);
  }

  // 2. Dispatch staff alert email to info@leadersperformance.ae
  try {
    const staffContactId = await upsertContact({
      email: 'info@leadersperformance.ae',
      firstName: 'Leaders',
      lastName: 'Performance',
      tags: ['lp-staff', 'internal-notification', 'audiobook-sale'],
    });

    if (staffContactId) {
      const staffSubject = `[Audiobook Purchased] ${data.customerName || 'Customer'} (${data.customerEmail}) — US $${amountPaidFormatted} — Invoice ${invoiceNumber}`;
      const staffHtml = buildAudiobookStaffAlertHtml(data);
      await sendEmail(staffContactId, staffSubject, staffHtml);
      console.log(`[Audiobook Invoice] Staff sale alert delivered to: info@leadersperformance.ae`);
      staffDelivered = true;
    }
  } catch (err: any) {
    console.warn('[Audiobook Invoice] Notice dispatching staff alert email to info@leadersperformance.ae:', err.message);
  }

  return { customerDelivered, staffDelivered };
}
