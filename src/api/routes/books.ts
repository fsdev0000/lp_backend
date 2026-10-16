import { Router, Request, Response } from 'express';
import {
  isValidBookId,
  normalizeBookId,
  getAudiobookFilePath,
  calculatePreviewByteLimit,
  streamAudioFile,
  createAudiobookCheckoutSession,
  checkPurchaseAccess,
  verifyEntitlementForStream,
  DEFAULT_BOOK_ID,
} from '../../services/audiobookService';

export const booksRouter = Router();

/**
 * Extracts purchase entitlement token from standard locations:
 * 1. Authorization: Bearer <token>
 * 2. x-purchase-token header
 * 3. ?token= query parameter (essential for <audio src="..."> element playback)
 */
function extractPurchaseToken(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.substring(7).trim();
    if (token) return token;
  }

  const customHeader = req.headers['x-purchase-token'];
  if (customHeader && typeof customHeader === 'string' && customHeader.trim()) {
    return customHeader.trim();
  }

  const queryToken = req.query.token;
  if (queryToken && typeof queryToken === 'string' && queryToken.trim()) {
    return queryToken.trim();
  }

  return undefined;
}

function getBookIdParam(req: Request): string {
  const raw = req.params?.bookId;
  if (Array.isArray(raw)) return raw[0] || '';
  return typeof raw === 'string' ? raw : '';
}

/**
 * GET /api/v1/books/:bookId/audio/preview
 * 
 * Free 60-second preview stream.
 * Enforces strict byte-level duration clamping on the backend.
 * Returns 416 Range Not Satisfiable if a client attempts to seek beyond the preview limit.
 */
booksRouter.get('/:bookId/audio/preview', async (req: Request, res: Response): Promise<void> => {
  const bookId = getBookIdParam(req);

  if (!isValidBookId(bookId)) {
    res.status(404).json({ error: 'Book not found', bookId });
    return;
  }

  const fileInfo = getAudiobookFilePath();
  if (!fileInfo) {
    console.error(`[Audiobook Preview] Audio file not found for book: ${bookId}`);
    res.status(404).json({ error: 'Audiobook audio file is not available on this server' });
    return;
  }

  try {
    // Dynamically calculate preview byte limit for 60 seconds
    const previewDurationSeconds = 60;
    const maxAllowedByte = calculatePreviewByteLimit(fileInfo.filePath, previewDurationSeconds);

    // Stream audio with strict byte ceiling
    streamAudioFile(req, res, fileInfo.filePath, {
      maxAllowedByte,
      isPreview: true,
    });
  } catch (err: any) {
    console.error('[Audiobook Preview] Streaming error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to stream audio preview' });
    }
  }
});

/**
 * POST /api/v1/books/:bookId/checkout
 * 
 * Initiates a Stripe Hosted Checkout Session for the English audiobook.
 * Returns the hosted checkout URL and session ID.
 */
booksRouter.post('/:bookId/checkout', async (req: Request, res: Response): Promise<void> => {
  const bookId = getBookIdParam(req);

  if (!isValidBookId(bookId)) {
    res.status(404).json({ error: 'Book not found', bookId });
    return;
  }

  try {
    const { returnPath, customerEmail, customerName } = req.body || {};
    const origin = req.headers.origin || req.headers.referer || undefined;

    const sessionData = await createAudiobookCheckoutSession(bookId, {
      returnPath,
      origin: typeof origin === 'string' ? origin : undefined,
      customerEmail: typeof customerEmail === 'string' ? customerEmail : undefined,
      customerName: typeof customerName === 'string' ? customerName : undefined,
    });

    res.status(200).json({
      success: true,
      url: sessionData.url,
      checkoutUrl: sessionData.url,
      sessionId: sessionData.sessionId,
      bookId: normalizeBookId(bookId),
    });
  } catch (err: any) {
    console.error('[Audiobook Checkout] Error creating checkout session:', err.message);
    res.status(400).json({
      error: 'Failed to create checkout session',
      message: err.message,
    });
  }
});

/**
 * GET /api/v1/books/:bookId/access
 * 
 * Verifies purchase access status using an access token or Stripe checkout session ID.
 * Returns { hasAccess: true, accessToken, ... } or { hasAccess: false, ... }.
 */
booksRouter.get('/:bookId/access', async (req: Request, res: Response): Promise<void> => {
  const bookId = getBookIdParam(req);

  if (!isValidBookId(bookId)) {
    res.status(404).json({ hasAccess: false, error: 'Book not found', bookId });
    return;
  }

  const token = extractPurchaseToken(req);
  const sessionId = (req.query.session_id || req.query.sessionId) as string | undefined;

  if (!token && !sessionId) {
    res.status(200).json({
      hasAccess: false,
      bookId: normalizeBookId(bookId),
      message: 'No purchase entitlement token or session ID provided',
    });
    return;
  }

  try {
    const accessResult = await checkPurchaseAccess(bookId, {
      token,
      sessionId,
    });

    res.status(200).json(accessResult);
  } catch (err: any) {
    console.error('[Audiobook Access] Error checking purchase access:', err.message);
    res.status(500).json({
      hasAccess: false,
      error: 'Failed to verify purchase access',
      message: err.message,
    });
  }
});

/**
 * GET /api/v1/books/:bookId/audio
 * 
 * Streams complete audiobook for authorized purchases.
 * Requires a valid, cryptographically verified purchase entitlement token.
 * Full RFC 7233 Range support for uninterrupted scrubbing/seeking across the entire book.
 */
booksRouter.get('/:bookId/audio', async (req: Request, res: Response): Promise<void> => {
  const bookId = getBookIdParam(req);

  if (!isValidBookId(bookId)) {
    res.status(404).json({ error: 'Book not found', bookId });
    return;
  }

  const token = extractPurchaseToken(req);

  if (!token) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Purchase entitlement token is required to access the complete audiobook',
    });
    return;
  }

  const verification = await verifyEntitlementForStream(bookId, token);
  if (!verification.valid) {
    res.status(403).json({
      error: 'Forbidden',
      message: verification.error || 'Access denied: invalid or unconfirmed purchase entitlement',
    });
    return;
  }

  const fileInfo = getAudiobookFilePath();
  if (!fileInfo) {
    console.error(`[Audiobook Stream] Audio file not found for book: ${bookId}`);
    res.status(404).json({ error: 'Audiobook audio file is not available on this server' });
    return;
  }

  try {
    const isDownload = req.query.download === 'true' || req.query.dl === '1';
    if (isDownload) {
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="RESET BY DISCIPLINE - ENGLISH AUDIOBOOK.mp3"'
      );
    }

    // Stream full audio with full Range seeking support
    streamAudioFile(req, res, fileInfo.filePath, {
      isPreview: false,
    });
  } catch (err: any) {
    console.error('[Audiobook Stream] Streaming error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to stream audiobook' });
    }
  }
});
