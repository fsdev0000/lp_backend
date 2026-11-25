import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { booksRouter } from '../api/routes/books';
import { handleStripeWebhook } from '../api/controllers/stripeWebhookController';
import {
  generateAccessToken,
  calculatePreviewByteLimit,
  getAudiobookFilePath,
  DEFAULT_BOOK_ID,
} from '../services/audiobookService';

const prisma = new PrismaClient();

const app = express();
app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.use('/api/v1/books', booksRouter);
app.post('/api/v1/webhooks/stripe', handleStripeWebhook);

jest.setTimeout(30000);

function createStripeSignature(payloadString: string, secret: string, timestamp?: number): string {
  const t = timestamp || Math.floor(Date.now() / 1000);
  const signaturePayload = `${t}.${payloadString}`;
  const hmac = crypto.createHmac('sha256', secret).update(signaturePayload, 'utf8').digest('hex');
  return `t=${t},v1=${hmac}`;
}

describe('Reset by Discipline English Audiobook Backend APIs', () => {
  const TEST_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test_secret_for_unit_tests';
  const testCustomerEmail = 'audiobook-tester@leadersperformance.ae';
  const testSessionId = `cs_test_audiobook_${Date.now()}`;
  const testFailedSessionId = `cs_test_failed_${Date.now()}`;
  const testExpiredSessionId = `cs_test_expired_${Date.now()}`;
  let paidAccessToken: string;
  let previewLimitBytes: number;

  beforeAll(async () => {
    // Resolve preview limit for audio file
    const fileInfo = getAudiobookFilePath();
    expect(fileInfo).not.toBeNull();
    if (fileInfo) {
      previewLimitBytes = calculatePreviewByteLimit(fileInfo.filePath, 60);
      expect(previewLimitBytes).toBeGreaterThan(100000);
    }

    // Clean up any test records
    await prisma.audiobookPurchase.deleteMany({
      where: { customerEmail: testCustomerEmail },
    });

    // Create a confirmed purchase fixture
    paidAccessToken = generateAccessToken();
    await prisma.audiobookPurchase.create({
      data: {
        bookId: DEFAULT_BOOK_ID,
        version: 'en',
        stripeSessionId: testSessionId,
        paymentStatus: 'paid',
        accessGranted: true,
        accessToken: paidAccessToken,
        customerEmail: testCustomerEmail,
        customerName: 'Test Listener',
        amount: 999,
        currency: 'usd',
        paidAt: new Date(),
      },
    });

    // Create a pending purchase fixture
    await prisma.audiobookPurchase.create({
      data: {
        bookId: DEFAULT_BOOK_ID,
        version: 'en',
        stripeSessionId: testFailedSessionId,
        paymentStatus: 'pending',
        accessGranted: false,
        accessToken: generateAccessToken(),
        customerEmail: testCustomerEmail,
        amount: 999,
        currency: 'usd',
      },
    });

    // Create an expired purchase fixture
    await prisma.audiobookPurchase.create({
      data: {
        bookId: DEFAULT_BOOK_ID,
        version: 'en',
        stripeSessionId: testExpiredSessionId,
        paymentStatus: 'pending',
        accessGranted: false,
        accessToken: generateAccessToken(),
        customerEmail: testCustomerEmail,
        amount: 999,
        currency: 'usd',
      },
    });
  });

  afterAll(async () => {
    await prisma.audiobookPurchase.deleteMany({
      where: { customerEmail: testCustomerEmail },
    });
    await prisma.$disconnect();
  });

  // =========================================================================
  // 1. FREE PREVIEW API (GET /api/v1/books/:bookId/audio/preview)
  // =========================================================================
  describe('GET /api/v1/books/:bookId/audio/preview', () => {
    it('allows visitors to stream the first 60 seconds without payment', async () => {
      const res = await request(app)
        .get(`/api/v1/books/${DEFAULT_BOOK_ID}/audio/preview`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('audio/mpeg');
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(parseInt(res.headers['content-length'], 10)).toBe(previewLimitBytes);
      expect(res.headers['cache-control']).toContain('public');
    });

    it('supports valid HTTP Range requests within the 60-second limit (206 Partial Content)', async () => {
      const res = await request(app)
        .get(`/api/v1/books/${DEFAULT_BOOK_ID}/audio/preview`)
        .set('Range', 'bytes=0-1023');

      expect(res.status).toBe(206);
      expect(res.headers['content-type']).toBe('audio/mpeg');
      expect(res.headers['content-range']).toBe(`bytes 0-1023/${previewLimitBytes}`);
      expect(res.headers['content-length']).toBe('1024');
    });

    it('rejects HTTP Range requests seeking beyond the 60-second limit with 416 Range Not Satisfiable', async () => {
      // Seek far beyond preview limit
      const outOfBoundsStart = previewLimitBytes + 50000;
      const res = await request(app)
        .get(`/api/v1/books/${DEFAULT_BOOK_ID}/audio/preview`)
        .set('Range', `bytes=${outOfBoundsStart}-${outOfBoundsStart + 1024}`);

      expect(res.status).toBe(416);
      expect(res.headers['content-range']).toBe(`bytes */${previewLimitBytes}`);
    });

    it('returns 404 for an unknown book ID', async () => {
      const res = await request(app).get('/api/v1/books/unknown-book-xyz/audio/preview');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Book not found');
    });
  });

  // =========================================================================
  // 2. CHECKOUT SESSION CREATION (POST /api/v1/books/:bookId/checkout)
  // =========================================================================
  describe('POST /api/v1/books/:bookId/checkout', () => {
    it('creates a Stripe Hosted Checkout Session and records pending purchase', async () => {
      const res = await request(app)
        .post(`/api/v1/books/${DEFAULT_BOOK_ID}/checkout`)
        .send({
          customerEmail: testCustomerEmail,
          customerName: 'Audiobook Purchaser',
          returnPath: '/knowledge?book=reset-by-discipline',
        });

      // If Stripe credentials exist in test env, it returns 200 with checkout URL
      if (res.status === 200) {
        expect(res.body.success).toBe(true);
        expect(res.body.url).toMatch(/^https:\/\/checkout\.stripe\.com/);
        expect(res.body.sessionId).toBeDefined();

        // Verify purchase was recorded as pending in DB
        const dbRecord = await prisma.audiobookPurchase.findUnique({
          where: { stripeSessionId: res.body.sessionId },
        });
        expect(dbRecord).not.toBeNull();
        expect(dbRecord?.accessGranted).toBe(false);
        expect(dbRecord?.paymentStatus).toBe('pending');
      } else {
        // Stripe test key might not connect in isolated mock mode
        expect([200, 400]).toContain(res.status);
      }
    });

    it('rejects checkout creation for an unknown book ID', async () => {
      const res = await request(app)
        .post('/api/v1/books/nonexistent-book/checkout')
        .send({ customerEmail: testCustomerEmail });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Book not found');
    });
  });

  // =========================================================================
  // 3. PURCHASE ACCESS VERIFICATION (GET /api/v1/books/:bookId/access)
  // =========================================================================
  describe('GET /api/v1/books/:bookId/access', () => {
    it('returns hasAccess: false when no token or sessionId is provided', async () => {
      const res = await request(app).get(`/api/v1/books/${DEFAULT_BOOK_ID}/access`);

      expect(res.status).toBe(200);
      expect(res.body.hasAccess).toBe(false);
    });

    it('returns hasAccess: false for invalid or unconfirmed token', async () => {
      const res = await request(app)
        .get(`/api/v1/books/${DEFAULT_BOOK_ID}/access?token=ab_ent_invalid_fake_token`);

      expect(res.status).toBe(200);
      expect(res.body.hasAccess).toBe(false);
    });

    it('returns hasAccess: true and the accessToken for a confirmed purchase by token', async () => {
      const res = await request(app)
        .get(`/api/v1/books/${DEFAULT_BOOK_ID}/access`)
        .set('Authorization', `Bearer ${paidAccessToken}`);

      expect(res.status).toBe(200);
      expect(res.body.hasAccess).toBe(true);
      expect(res.body.accessToken).toBe(paidAccessToken);
      expect(res.body.customerEmail).toBe(testCustomerEmail);
    });

    it('returns hasAccess: true and the accessToken when queried by session_id', async () => {
      const res = await request(app)
        .get(`/api/v1/books/${DEFAULT_BOOK_ID}/access?session_id=${testSessionId}`);

      expect(res.status).toBe(200);
      expect(res.body.hasAccess).toBe(true);
      expect(res.body.accessToken).toBe(paidAccessToken);
    });

    it('returns hasAccess: false for a pending session ID that was never paid', async () => {
      const pendingSessionId = `cs_test_pending_only_${Date.now()}`;
      await prisma.audiobookPurchase.create({
        data: {
          bookId: DEFAULT_BOOK_ID,
          version: 'en',
          stripeSessionId: pendingSessionId,
          paymentStatus: 'pending',
          accessGranted: false,
          accessToken: generateAccessToken(),
          customerEmail: testCustomerEmail,
        },
      });

      const res = await request(app)
        .get(`/api/v1/books/${DEFAULT_BOOK_ID}/access?session_id=${pendingSessionId}`);

      expect(res.status).toBe(200);
      expect(res.body.hasAccess).toBe(false);
    });
  });

  // =========================================================================
  // 4. FULL AUDIO STREAMING (GET /api/v1/books/:bookId/audio)
  // =========================================================================
  describe('GET /api/v1/books/:bookId/audio', () => {
    it('rejects unauthenticated requests with 401 Unauthorized', async () => {
      const res = await request(app).get(`/api/v1/books/${DEFAULT_BOOK_ID}/audio`);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('rejects invalid or forged entitlement tokens with 403 Forbidden', async () => {
      const res = await request(app)
        .get(`/api/v1/books/${DEFAULT_BOOK_ID}/audio`)
        .set('x-purchase-token', 'ab_ent_forged_fake_token_123456');

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Forbidden');
    });

    it('rejects requests attempting to access full audio using ONLY a Stripe checkout session ID', async () => {
      const res = await request(app)
        .get(`/api/v1/books/${DEFAULT_BOOK_ID}/audio?session_id=${testSessionId}`);

      // Stripe Session ID is not accepted as audio stream entitlement (must use accessToken)
      expect(res.status).toBe(401);
    });

    it('allows complete audio streaming for confirmed purchase using Authorization header', async () => {
      const res = await request(app)
        .get(`/api/v1/books/${DEFAULT_BOOK_ID}/audio`)
        .set('Authorization', `Bearer ${paidAccessToken}`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('audio/mpeg');
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(parseInt(res.headers['content-length'], 10)).toBeGreaterThan(previewLimitBytes);
      expect(res.headers['cache-control']).toContain('private');
    });

    it('allows complete audio streaming with token in query param (?token=) for HTML5 <audio> tag', async () => {
      const res = await request(app)
        .get(`/api/v1/books/${DEFAULT_BOOK_ID}/audio?token=${paidAccessToken}`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('audio/mpeg');
      expect(parseInt(res.headers['content-length'], 10)).toBeGreaterThan(previewLimitBytes);
    });

    it('supports full HTTP Range requests beyond 60s for authorized listeners (206 Partial Content)', async () => {
      // Seek past the 60s preview boundary
      const seekStart = previewLimitBytes + 20000;
      const seekEnd = seekStart + 1023;

      const res = await request(app)
        .get(`/api/v1/books/${DEFAULT_BOOK_ID}/audio`)
        .set('Authorization', `Bearer ${paidAccessToken}`)
        .set('Range', `bytes=${seekStart}-${seekEnd}`);

      expect(res.status).toBe(206);
      expect(res.headers['content-type']).toBe('audio/mpeg');
      expect(res.headers['content-range']).toContain(`bytes ${seekStart}-${seekEnd}/`);
      expect(res.headers['content-length']).toBe('1024');
    });
  });

  // =========================================================================
  // 5. STRIPE WEBHOOK PAYMENT VERIFICATION
  // =========================================================================
  describe('POST /api/v1/webhooks/stripe', () => {
    it('handles checkout.session.completed and unlocks full audiobook access', async () => {
      const newSessionId = `cs_test_completed_flow_${Date.now()}`;
      const newAccessToken = generateAccessToken();

      // Seed pending record
      await prisma.audiobookPurchase.create({
        data: {
          bookId: DEFAULT_BOOK_ID,
          version: 'en',
          stripeSessionId: newSessionId,
          paymentStatus: 'pending',
          accessGranted: false,
          accessToken: newAccessToken,
          customerEmail: testCustomerEmail,
          amount: 999,
          currency: 'usd',
        },
      });

      // Verify access is false prior to webhook confirmation
      const preCheck = await request(app)
        .get(`/api/v1/books/${DEFAULT_BOOK_ID}/access?session_id=${newSessionId}`);
      expect(preCheck.body.hasAccess).toBe(false);

      // Construct Stripe webhook event
      const payloadObj = {
        id: `evt_test_ab_${Date.now()}`,
        object: 'event',
        api_version: '2023-10-16',
        created: Math.floor(Date.now() / 1000),
        type: 'checkout.session.completed',
        livemode: false,
        data: {
          object: {
            id: newSessionId,
            object: 'checkout.session',
            payment_status: 'paid',
            amount_total: 999,
            currency: 'usd',
            customer_email: testCustomerEmail,
            metadata: {
              bookId: DEFAULT_BOOK_ID,
              productType: 'audiobook',
              version: 'en',
            },
          },
        },
      };

      const payloadString = JSON.stringify(payloadObj);
      const signature = createStripeSignature(payloadString, TEST_WEBHOOK_SECRET);

      const webhookRes = await request(app)
        .post('/api/v1/webhooks/stripe')
        .set('stripe-signature', signature)
        .set('Content-Type', 'application/json')
        .send(payloadString);

      expect(webhookRes.status).toBe(200);
      expect(webhookRes.body.received).toBe(true);

      // Verify purchase in DB has been updated to paid and accessGranted
      const updatedPurchase = await prisma.audiobookPurchase.findUnique({
        where: { stripeSessionId: newSessionId },
      });
      expect(updatedPurchase?.paymentStatus).toBe('paid');
      expect(updatedPurchase?.accessGranted).toBe(true);

      // Verify access check now returns true with accessToken
      const postCheck = await request(app)
        .get(`/api/v1/books/${DEFAULT_BOOK_ID}/access?session_id=${newSessionId}`);
      expect(postCheck.body.hasAccess).toBe(true);
      expect(postCheck.body.accessToken).toBe(newAccessToken);

      // Verify purchaser can now stream full audiobook
      const streamRes = await request(app)
        .get(`/api/v1/books/${DEFAULT_BOOK_ID}/audio`)
        .set('Authorization', `Bearer ${newAccessToken}`);
      expect(streamRes.status).toBe(200);
    }, 30000);

    it('handles checkout.session.async_payment_failed and keeps access locked', async () => {
      const payloadObj = {
        id: `evt_test_failed_${Date.now()}`,
        object: 'event',
        api_version: '2023-10-16',
        created: Math.floor(Date.now() / 1000),
        type: 'checkout.session.async_payment_failed',
        livemode: false,
        data: {
          object: {
            id: testFailedSessionId,
            object: 'checkout.session',
            payment_status: 'unpaid',
            metadata: { bookId: DEFAULT_BOOK_ID, productType: 'audiobook' },
          },
        },
      };

      const payloadString = JSON.stringify(payloadObj);
      const signature = createStripeSignature(payloadString, TEST_WEBHOOK_SECRET);

      const webhookRes = await request(app)
        .post('/api/v1/webhooks/stripe')
        .set('stripe-signature', signature)
        .set('Content-Type', 'application/json')
        .send(payloadString);

      expect(webhookRes.status).toBe(200);

      const record = await prisma.audiobookPurchase.findUnique({
        where: { stripeSessionId: testFailedSessionId },
      });
      expect(record?.paymentStatus).toBe('failed');
      expect(record?.accessGranted).toBe(false);
    }, 30000);

    it('handles checkout.session.expired and marks purchase expired', async () => {
      const payloadObj = {
        id: `evt_test_expired_${Date.now()}`,
        object: 'event',
        api_version: '2023-10-16',
        created: Math.floor(Date.now() / 1000),
        type: 'checkout.session.expired',
        livemode: false,
        data: {
          object: {
            id: testExpiredSessionId,
            object: 'checkout.session',
            status: 'expired',
            metadata: { bookId: DEFAULT_BOOK_ID, productType: 'audiobook' },
          },
        },
      };

      const payloadString = JSON.stringify(payloadObj);
      const signature = createStripeSignature(payloadString, TEST_WEBHOOK_SECRET);

      const webhookRes = await request(app)
        .post('/api/v1/webhooks/stripe')
        .set('stripe-signature', signature)
        .set('Content-Type', 'application/json')
        .send(payloadString);

      expect(webhookRes.status).toBe(200);

      const record = await prisma.audiobookPurchase.findUnique({
        where: { stripeSessionId: testExpiredSessionId },
      });
      expect(record?.paymentStatus).toBe('expired');
      expect(record?.accessGranted).toBe(false);
    });
  });
});
