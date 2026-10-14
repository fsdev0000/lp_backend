import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { checkoutRouter } from '../api/routes/checkout';
import {
  isProductionEnvironment,
  getStripeWebhookSecret,
  getStripeSecretKey,
  setInvoiceEmailDispatcherForTesting,
  dispatchInvoiceEmailWithRetries,
} from '../services/stripeWebhookService';

const prisma = new PrismaClient();

const app = express();
app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use('/api', checkoutRouter);
app.use('/api/v1', checkoutRouter);

jest.setTimeout(30000);

/**
 * Helper to generate valid Stripe HMAC-SHA256 signature header
 */
function createStripeSignature(payloadString: string, secret: string, timestamp?: number): string {
  const t = timestamp || Math.floor(Date.now() / 1000);
  const signaturePayload = `${t}.${payloadString}`;
  const hmac = crypto.createHmac('sha256', secret).update(signaturePayload, 'utf8').digest('hex');
  return `t=${t},v1=${hmac}`;
}

describe('Stripe Webhook Multi-Environment & Invoice Delivery', () => {
  const TEST_WEBHOOK_SECRET = 'whsec_test_secret_for_unit_tests_123456';
  const PROD_WEBHOOK_SECRET = 'whsec_prod_secret_for_unit_tests_987654';

  const testEnrollmentEmail = 'staging-customer@leadersperformance.ae';
  const testSessionId = 'cs_test_mock_staging_session_9988';
  const testPaymentIntentId = 'pi_test_mock_staging_pi_9988';
  let createdEnrollmentId: string;

  beforeAll(async () => {
    jest.setTimeout(30000);
    // Clean up test records
    await prisma.masterclassEnrollment.deleteMany({
      where: { email: testEnrollmentEmail },
    });
    await prisma.systemLog.deleteMany({
      where: { action: { in: ['STRIPE_WEBHOOK_PROCESSED', 'STRIPE_PAYMENT_FAILED', 'STRIPE_INVOICE_FAILED'] } },
    });

    // Create a seed enrollment for webhook fulfillment
    const enrollment = await prisma.masterclassEnrollment.create({
      data: {
        email: testEnrollmentEmail,
        fullName: 'Asif Test Founder',
        company: 'Leaders Performance Staging',
        amount: 75000,
        currency: 'usd',
        paymentStatus: 'pending',
        stripeSessionId: testSessionId,
        accessGranted: false,
      },
    });
    createdEnrollmentId = enrollment.id;
  });

  afterAll(async () => {
    setInvoiceEmailDispatcherForTesting(null);
    await prisma.masterclassEnrollment.deleteMany({
      where: { email: testEnrollmentEmail },
    });
    await prisma.$disconnect();
  });

  beforeEach(() => {
    // Reset to staging test environment defaults
    process.env.APP_ENV = 'staging';
    process.env.NODE_ENV = 'test';
    process.env.STRIPE_SECRET_KEY = 'sk_test_mock_secret_key';
    process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
    delete process.env.STRIPE_SECRET_KEY_PRODUCTION;
    delete process.env.STRIPE_WEBHOOK_SECRET_PRODUCTION;
    delete process.env.STRIPE_SECRET_KEY_STAGING;
    delete process.env.STRIPE_WEBHOOK_SECRET_STAGING;

    setInvoiceEmailDispatcherForTesting(null);
  });

  describe('1. Environment Isolation and Secret Separation', () => {
    it('should correctly detect staging vs production environments', () => {
      process.env.APP_ENV = 'staging';
      process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
      expect(isProductionEnvironment()).toBe(false);

      process.env.APP_ENV = 'production';
      process.env.STRIPE_SECRET_KEY = 'sk_live_dummy';
      expect(isProductionEnvironment()).toBe(true);
    });

    it('should resolve environment-specific webhook signing secrets independently', () => {
      process.env.STRIPE_WEBHOOK_SECRET_STAGING = 'whsec_staging_specific';
      process.env.STRIPE_WEBHOOK_SECRET_PRODUCTION = 'whsec_prod_specific';

      process.env.APP_ENV = 'staging';
      expect(getStripeWebhookSecret()).toBe('whsec_staging_specific');

      process.env.APP_ENV = 'production';
      expect(getStripeWebhookSecret()).toBe('whsec_prod_specific');
    });

    it('should resolve environment-specific API keys independently without sharing', () => {
      process.env.STRIPE_SECRET_KEY_STAGING = 'sk_test_staging_unique';
      process.env.STRIPE_SECRET_KEY_PRODUCTION = 'sk_live_prod_unique';

      process.env.APP_ENV = 'staging';
      expect(getStripeSecretKey()).toBe('sk_test_staging_unique');

      process.env.APP_ENV = 'production';
      expect(getStripeSecretKey()).toBe('sk_live_prod_unique');
    });
  });

  describe('2. Webhook Signature Verification & Livemode Protection', () => {
    it('should reject requests without stripe-signature header with 400', async () => {
      const res = await request(app)
        .post('/api/v1/stripe/webhook')
        .send({ id: 'evt_1', type: 'checkout.session.completed' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('stripe-signature');
    });

    it('should reject requests with invalid HMAC signature with 400', async () => {
      const payload = JSON.stringify({ id: 'evt_bad_sig', type: 'checkout.session.completed' });

      const res = await request(app)
        .post('/api/v1/stripe/webhook')
        .set('stripe-signature', 't=1234567,v1=invalid_hmac_signature')
        .set('Content-Type', 'application/json')
        .send(payload);

      expect(res.status).toBe(400);
    });

    it('should reject live-mode events received on staging environment (livemode mismatch)', async () => {
      process.env.APP_ENV = 'staging';
      process.env.STRIPE_SECRET_KEY = 'sk_test_key';
      process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;

      const liveEvent = {
        id: `evt_live_${Date.now()}`,
        object: 'event',
        type: 'checkout.session.completed',
        livemode: true, // LIVE event accidentally sent to staging
        data: {
          object: {
            id: 'cs_live_123',
            payment_status: 'paid',
          },
        },
      };

      const payloadString = JSON.stringify(liveEvent);
      const signature = createStripeSignature(payloadString, TEST_WEBHOOK_SECRET);

      const res = await request(app)
        .post('/api/v1/stripe/webhook')
        .set('stripe-signature', signature)
        .set('Content-Type', 'application/json')
        .send(payloadString);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Environment livemode mismatch');
      expect(res.body.receivedLivemode).toBe(true);
      expect(res.body.expectedLivemode).toBe(false);
    });

    it('should reject test-mode events received on production environment (livemode mismatch)', async () => {
      process.env.APP_ENV = 'production';
      process.env.STRIPE_SECRET_KEY = 'sk_live_key';
      process.env.STRIPE_WEBHOOK_SECRET = PROD_WEBHOOK_SECRET;

      const testEvent = {
        id: `evt_test_${Date.now()}`,
        object: 'event',
        type: 'checkout.session.completed',
        livemode: false, // TEST event sent to production
        data: {
          object: {
            id: 'cs_test_123',
            payment_status: 'paid',
          },
        },
      };

      const payloadString = JSON.stringify(testEvent);
      const signature = createStripeSignature(payloadString, PROD_WEBHOOK_SECRET);

      const res = await request(app)
        .post('/api/v1/stripe/webhook')
        .set('stripe-signature', signature)
        .set('Content-Type', 'application/json')
        .send(payloadString);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Environment livemode mismatch');
      expect(res.body.receivedLivemode).toBe(false);
      expect(res.body.expectedLivemode).toBe(true);
    });
  });

  describe('3. Successful Sandbox Payment & Invoice Email Delivery', () => {
    it('should fulfill checkout, retrieve invoice, and send invoice email to customer', async () => {
      // Reset test enrollment to clean pending state
      await prisma.masterclassEnrollment.update({
        where: { id: createdEnrollmentId },
        data: { paymentStatus: 'pending', accessGranted: false, metadata: null },
      });

      process.env.APP_ENV = 'staging';
      process.env.STRIPE_SECRET_KEY = 'sk_test_key';
      process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;

      // Mock email delivery function
      const emailMock = jest.fn().mockImplementation(async () => true);
      setInvoiceEmailDispatcherForTesting(emailMock);

      const eventId = `evt_stage_success_${Date.now()}`;
      const successfulEvent = {
        id: eventId,
        object: 'event',
        type: 'checkout.session.completed',
        livemode: false,
        data: {
          object: {
            id: testSessionId,
            payment_status: 'paid',
            customer_email: testEnrollmentEmail,
            payment_intent: testPaymentIntentId,
            invoice: {
              id: 'in_test_invoice_123',
              number: 'LP-TEST-0001',
              hosted_invoice_url: 'https://invoice.stripe.com/test_123',
              invoice_pdf: 'https://pay.stripe.com/invoice/test_123/pdf',
            },
          },
        },
      };

      const payloadString = JSON.stringify(successfulEvent);
      const signature = createStripeSignature(payloadString, TEST_WEBHOOK_SECRET);

      const res = await request(app)
        .post('/api/v1/stripe/webhook')
        .set('stripe-signature', signature)
        .set('Content-Type', 'application/json')
        .send(payloadString);

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
      expect(res.body.success).toBe(true);

      // Verify email service was called with trusted customer email and invoice details
      expect(emailMock).toHaveBeenCalledTimes(1);
      const calledArgs = emailMock.mock.calls[0][0];
      expect(calledArgs.enrollment.email).toBe(testEnrollmentEmail);
      expect(calledArgs.invoiceNumber).toBe('LP-TEST-0001');
      expect(calledArgs.hostedInvoiceUrl).toBe('https://invoice.stripe.com/test_123');

      // Verify DB enrollment was updated
      const updatedEnrollment = await prisma.masterclassEnrollment.findUnique({
        where: { id: createdEnrollmentId },
      });
      expect(updatedEnrollment?.paymentStatus).toBe('paid');
      expect(updatedEnrollment?.accessGranted).toBe(true);

      const meta = JSON.parse(updatedEnrollment?.metadata || '{}');
      expect(meta.invoiceEmailSent).toBe(true);
      expect(meta.invoiceNumber).toBe('LP-TEST-0001');
    }, 30000);

    it('should be strictly idempotent: repeated webhook delivery does NOT send duplicate emails', async () => {
      process.env.APP_ENV = 'staging';
      process.env.STRIPE_SECRET_KEY = 'sk_test_key';
      process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;

      const emailMock = jest.fn().mockImplementation(async () => true);
      setInvoiceEmailDispatcherForTesting(emailMock);

      const eventId = `evt_idempotent_test_${Date.now()}`;
      const payloadObj = {
        id: eventId,
        object: 'event',
        type: 'checkout.session.completed',
        livemode: false,
        data: {
          object: {
            id: testSessionId,
            payment_status: 'paid',
            customer_email: testEnrollmentEmail,
          },
        },
      };

      const payloadString = JSON.stringify(payloadObj);
      const signature = createStripeSignature(payloadString, TEST_WEBHOOK_SECRET);

      // First delivery: processes successfully
      const res1 = await request(app)
        .post('/api/v1/stripe/webhook')
        .set('stripe-signature', signature)
        .set('Content-Type', 'application/json')
        .send(payloadString);

      expect(res1.status).toBe(200);
      expect(res1.body.received).toBe(true);

      emailMock.mockClear();

      // Second delivery of EXACT same event: must be deduplicated
      const res2 = await request(app)
        .post('/api/v1/stripe/webhook')
        .set('stripe-signature', signature)
        .set('Content-Type', 'application/json')
        .send(payloadString);

      expect(res2.status).toBe(200);
      expect(res2.body.received).toBe(true);
      expect(res2.body.duplicate).toBe(true);
      expect(emailMock).not.toHaveBeenCalled();
    }, 30000);
  });

  describe('4. Payment Failure Events', () => {
    it('should record payment_intent.payment_failed without sending invoice email', async () => {
      process.env.APP_ENV = 'staging';
      process.env.STRIPE_SECRET_KEY = 'sk_test_key';
      process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;

      const emailMock = jest.fn().mockImplementation(async () => true);
      setInvoiceEmailDispatcherForTesting(emailMock);

      const failedEvent = {
        id: `evt_failed_${Date.now()}`,
        object: 'event',
        type: 'payment_intent.payment_failed',
        livemode: false,
        data: {
          object: {
            id: 'pi_test_failed_123',
            receipt_email: testEnrollmentEmail,
            last_payment_error: { message: 'Your card was declined.' },
          },
        },
      };

      const payloadString = JSON.stringify(failedEvent);
      const signature = createStripeSignature(payloadString, TEST_WEBHOOK_SECRET);

      const res = await request(app)
        .post('/api/v1/stripe/webhook')
        .set('stripe-signature', signature)
        .set('Content-Type', 'application/json')
        .send(payloadString);

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
      expect(res.body.message).toBe('Payment failure recorded');
      expect(emailMock).not.toHaveBeenCalled();

      // Confirm logged in SystemLog
      const failureLog = await prisma.systemLog.findFirst({
        where: { action: 'STRIPE_PAYMENT_FAILED' },
        orderBy: { createdAt: 'desc' },
      });
      expect(failureLog).not.toBeNull();
      expect(failureLog?.details).toContain('Your card was declined.');
    });
  });

  describe('5. Email Failure and Exponential Backoff Retries', () => {
    it('should retry email delivery when provider temporarily fails', async () => {
      let callCount = 0;
      const failingDispatcher = jest.fn().mockImplementation(async () => {
        callCount++;
        if (callCount < 2) {
          throw new Error('GHL rate limit error');
        }
        return true;
      });
      setInvoiceEmailDispatcherForTesting(failingDispatcher);

      const result = await dispatchInvoiceEmailWithRetries(
        {
          enrollment: {
            id: 'mock_id',
            email: 'founder@test.com',
            fullName: 'Test Founder',
          },
          invoiceNumber: 'INV-RETRY-001',
        },
        3
      );

      expect(result).toBe(true);
      expect(callCount).toBe(2);
    });
  });
});
