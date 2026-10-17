import {
  buildBookInvoiceEmailHtml,
  buildBookStaffAlertHtml,
  isTextBookSession,
  detectBookVersion,
  sendBookPurchaseEmails,
  isBookInvoiceEmailSent,
  handleTextBookWebhookSession,
  getBackendUrl,
  resolveStaffBookDownloadUrl,
} from '../services/bookInvoiceEmailService';
import { upsertContact, sendEmail } from '../services/ghl';

// In-memory mock storage for SystemLog
const mockSystemLogs: any[] = [];

jest.mock('@prisma/client', () => {
  return {
    PrismaClient: jest.fn().mockImplementation(() => ({
      systemLog: {
        create: jest.fn().mockImplementation(({ data }) => {
          mockSystemLogs.push(data);
          return Promise.resolve({ id: `log_${Date.now()}`, ...data });
        }),
        findFirst: jest.fn().mockImplementation(({ where }) => {
          const match = mockSystemLogs.find((l) => {
            if (where.action && l.action !== where.action) return false;
            if (where.details?.contains && !l.details.includes(where.details.contains)) return false;
            return true;
          });
          return Promise.resolve(match || null);
        }),
        deleteMany: jest.fn().mockImplementation(() => {
          mockSystemLogs.length = 0;
          return Promise.resolve({ count: 0 });
        }),
      },
      $disconnect: jest.fn().mockResolvedValue(undefined),
    })),
  };
});

jest.mock('../services/ghl', () => ({
  upsertContact: jest.fn().mockResolvedValue('mock-contact-id-123'),
  sendEmail: jest.fn().mockResolvedValue(true),
}));

describe('Reset by Discipline Text Version Invoice Emails (English & Dutch)', () => {
  const testSessionIdEn = `cs_test_book_en_${Date.now()}`;
  const testSessionIdNl = `cs_test_book_nl_${Date.now()}`;
  const testEmail = 'reader-test@leadersperformance.ae';

  beforeEach(() => {
    mockSystemLogs.length = 0;
    jest.clearAllMocks();
  });

  describe('1. Template Rendering & Placeholder Integrity', () => {
    it('renders English customer invoice email without unreplaced {{...}} placeholders', () => {
      const html = buildBookInvoiceEmailHtml({
        customerEmail: testEmail,
        customerName: 'Arthur Dent',
        amountPaidCents: 1999,
        currency: 'usd',
        paidAt: new Date('2026-10-17T10:00:00Z'),
        stripeSessionId: testSessionIdEn,
        invoiceNumber: 'INV-BK-EN-001',
        hostedInvoiceUrl: 'https://invoice.stripe.com/test_inv_en',
        invoicePdf: 'https://pay.stripe.com/invoice/test_inv_en/pdf',
        version: 'en',
      });

      expect(html).toContain('INV-BK-EN-001');
      expect(html).toContain('Arthur Dent');
      expect(html).toContain(testEmail);
      expect(html).toContain('19.99');
      expect(html).toContain('Reset by Discipline');
      expect(html).toContain('Download Reset by Discipline (PDF)');
      expect(html).toContain('Download Tax Invoice (PDF)');
      // Customer download CTA redirects to frontend payment-success
      expect(html).toContain(`/payment-success?session_id=${encodeURIComponent(testSessionIdEn)}&amp;version=en&amp;book=reset-by-discipline`);
      // Zero unresolved placeholders
      const leftoverPlaceholders = html.match(/\{\{[a-z0-9_]+\}\}/gi);
      expect(leftoverPlaceholders).toBeNull();
    });

    it('renders Dutch customer invoice email with Dutch labels and without unreplaced {{...}} placeholders', () => {
      const html = buildBookInvoiceEmailHtml({
        customerEmail: testEmail,
        customerName: 'Bram van Dijk',
        amountPaidCents: 1999,
        currency: 'usd',
        paidAt: new Date('2026-10-17T10:00:00Z'),
        stripeSessionId: testSessionIdNl,
        invoiceNumber: 'INV-BK-NL-001',
        hostedInvoiceUrl: 'https://invoice.stripe.com/test_inv_nl',
        invoicePdf: 'https://pay.stripe.com/invoice/test_inv_nl/pdf',
        version: 'nl',
      });

      expect(html).toContain('INV-BK-NL-001');
      expect(html).toContain('Bram van Dijk');
      expect(html).toContain(testEmail);
      expect(html).toContain('19.99');
      expect(html).toContain('Reset door Discipline');
      expect(html).toContain('Download Reset door Discipline (PDF)');
      expect(html).toContain('Download Btw-factuur (PDF)');
      expect(html).toContain('Btw-factuur');
      // Customer download CTA redirects to frontend payment-success
      expect(html).toContain(`/payment-success?session_id=${encodeURIComponent(testSessionIdNl)}&amp;version=nl&amp;book=reset-by-discipline`);
      // Zero unresolved placeholders
      const leftoverPlaceholders = html.match(/\{\{[a-z0-9_]+\}\}/gi);
      expect(leftoverPlaceholders).toBeNull();
    });

    it('renders English staff purchase alert email without unreplaced {{...}} placeholders', () => {
      const html = buildBookStaffAlertHtml({
        customerEmail: testEmail,
        customerName: 'Arthur Dent',
        amountPaidCents: 1999,
        currency: 'usd',
        paidAt: new Date('2026-10-17T10:00:00Z'),
        stripeSessionId: testSessionIdEn,
        stripePaymentIntentId: 'pi_test_staff_en_123',
        invoiceNumber: 'INV-BK-EN-001',
        hostedInvoiceUrl: 'https://invoice.stripe.com/test_inv_en',
        invoicePdf: 'https://pay.stripe.com/invoice/test_inv_en/pdf',
        version: 'en',
      });

      expect(html).toContain('INV-BK-EN-001');
      expect(html).toContain('Arthur Dent');
      expect(html).toContain(testEmail);
      expect(html).toContain('19.99');
      expect(html).toContain('US $19.99');
      expect(html).toContain(testSessionIdEn);
      expect(html).toContain('pi_test_staff_en_123');
      expect(html).toContain('Download Book PDF');
      expect(html).toContain('Download PDF Invoice');
      // Staff email only contains invoice and download action buttons (table rows removed)
      expect(html).not.toContain('INVOICE DOWNLOAD');
      expect(html).not.toContain('BOOK DOWNLOAD');
      expect(html).not.toContain('Reply to Customer');
      const leftoverPlaceholders = html.match(/\{\{[a-z0-9_]+\}\}/gi);
      expect(leftoverPlaceholders).toBeNull();
    });

    it('renders Dutch staff purchase alert email with Dutch labels and without unreplaced {{...}} placeholders', () => {
      const html = buildBookStaffAlertHtml({
        customerEmail: testEmail,
        customerName: 'Bram van Dijk',
        amountPaidCents: 1999,
        currency: 'usd',
        paidAt: new Date('2026-10-17T10:00:00Z'),
        stripeSessionId: testSessionIdNl,
        stripePaymentIntentId: 'pi_test_staff_nl_123',
        invoiceNumber: 'INV-BK-NL-001',
        hostedInvoiceUrl: 'https://invoice.stripe.com/test_inv_nl',
        invoicePdf: 'https://pay.stripe.com/invoice/test_inv_nl/pdf',
        version: 'nl',
      });

      expect(html).toContain('INV-BK-NL-001');
      expect(html).toContain('Bram van Dijk');
      expect(html).toContain(testEmail);
      expect(html).toContain('19.99');
      expect(html).toContain('US $19.99');
      expect(html).toContain('Nederlandse Editie');
      expect(html).toContain('Download PDF Factuur');
      expect(html).toContain('Download Boek PDF');
      // Staff email has direct backend download link
      expect(html).toContain(`/api/download?session_id=${encodeURIComponent(testSessionIdNl)}`);
      // Staff email only contains invoice and download action buttons (table rows removed)
      expect(html).not.toContain('FACTUUR DOWNLOADEN');
      expect(html).not.toContain('BOEK DOWNLOADEN');
      expect(html).not.toContain('Klant Beantwoorden');
      const leftoverPlaceholders = html.match(/\{\{[a-z0-9_]+\}\}/gi);
      expect(leftoverPlaceholders).toBeNull();
    });
  });

  describe('2. Version Detection & Session Identification', () => {
    it('detects English and Dutch versions accurately from session metadata', () => {
      const enSession = {
        id: 'cs_en_1',
        metadata: { version: 'en', product: 'Reset by Discipline (English Edition)' },
      } as any;
      expect(detectBookVersion(enSession)).toBe('en');

      const nlSession = {
        id: 'cs_nl_1',
        metadata: { version: 'nl', product: 'Reset door Discipline (Dutch Edition)' },
      } as any;
      expect(detectBookVersion(nlSession)).toBe('nl');

      const nlSessionByReturnPath = {
        id: 'cs_nl_2',
        metadata: { returnPath: '/knowledge?book-name=reset-by-discipline&version=nl' },
      } as any;
      expect(detectBookVersion(nlSessionByReturnPath)).toBe('nl');
    });

    it('correctly classifies text book sessions vs audiobook vs masterclass sessions', () => {
      const textBookSession = {
        id: 'cs_text_1',
        metadata: {
          product: 'Reset by Discipline (English Edition)',
          version: 'en',
          returnPath: '/knowledge?book-name=reset-by-discipline&version=en',
        },
      } as any;
      expect(isTextBookSession(textBookSession)).toBe(true);

      const audiobookSession = {
        id: 'cs_audio_1',
        metadata: {
          productType: 'audiobook',
          bookId: 'reset-by-discipline',
        },
      } as any;
      expect(isTextBookSession(audiobookSession)).toBe(false);

      const masterclassSession = {
        id: 'cs_mc_1',
        metadata: {
          enrollmentId: 'mc_enrollment_123',
        },
      } as any;
      expect(isTextBookSession(masterclassSession)).toBe(false);
    });
  });

  describe('3. Email Delivery & Idempotency', () => {
    it('sends customer and staff emails in English when version is en and records in SystemLog', async () => {
      const result = await sendBookPurchaseEmails({
        customerEmail: testEmail,
        customerName: 'English Customer',
        amountPaidCents: 1999,
        currency: 'usd',
        paidAt: new Date(),
        stripeSessionId: testSessionIdEn,
        stripePaymentIntentId: 'pi_test_en',
        invoiceNumber: 'INV-BK-EN-999',
        hostedInvoiceUrl: 'https://invoice.stripe.com/test',
        invoicePdf: null,
        version: 'en',
      });

      expect(result.customerDelivered).toBe(true);
      expect(result.staffDelivered).toBe(true);

      // Verify customer upsert and tags
      expect(upsertContact).toHaveBeenCalledWith(
        expect.objectContaining({
          email: testEmail,
          tags: expect.arrayContaining(['Book Customer', 'Reset by Discipline', 'Reset by Discipline English', 'Invoice Sent']),
        })
      );

      // Verify staff alert sent to info@leadersperformance.ae with English tags
      expect(upsertContact).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'info@leadersperformance.ae',
          tags: expect.arrayContaining(['lp-staff', 'internal-notification', 'book-sale-english']),
        })
      );

      // Verify sendEmail was called for both
      expect(sendEmail).toHaveBeenCalledTimes(2);

      // Verify idempotency check is true
      const alreadySent = await isBookInvoiceEmailSent(testSessionIdEn);
      expect(alreadySent).toBe(true);
    });

    it('sends customer and staff emails in Dutch when version is nl and records in SystemLog', async () => {
      const result = await sendBookPurchaseEmails({
        customerEmail: testEmail,
        customerName: 'Nederlandse Klant',
        amountPaidCents: 1999,
        currency: 'usd',
        paidAt: new Date(),
        stripeSessionId: testSessionIdNl,
        stripePaymentIntentId: 'pi_test_nl',
        invoiceNumber: 'INV-BK-NL-999',
        hostedInvoiceUrl: 'https://invoice.stripe.com/test_nl',
        invoicePdf: null,
        version: 'nl',
      });

      expect(result.customerDelivered).toBe(true);
      expect(result.staffDelivered).toBe(true);

      // Verify customer upsert and Dutch tags
      expect(upsertContact).toHaveBeenCalledWith(
        expect.objectContaining({
          email: testEmail,
          tags: expect.arrayContaining(['Book Customer', 'Reset by Discipline', 'Reset by Discipline Dutch', 'Invoice Sent']),
        })
      );

      // Verify staff alert sent with Dutch tags
      expect(upsertContact).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'info@leadersperformance.ae',
          tags: expect.arrayContaining(['lp-staff', 'internal-notification', 'book-sale-dutch']),
        })
      );

      // Verify idempotency check is true
      const alreadySent = await isBookInvoiceEmailSent(testSessionIdNl);
      expect(alreadySent).toBe(true);
    });

    it('skips duplicate sending if emails have already been dispatched for the session', async () => {
      // First seed the log for testSessionIdEn
      mockSystemLogs.push({
        action: 'BOOK_INVOICE_EMAIL_SENT',
        details: JSON.stringify({ sessionId: testSessionIdEn }),
      });

      const webhookHandled = await handleTextBookWebhookSession(
        {
          id: testSessionIdEn,
          payment_status: 'paid',
          customer_details: { email: testEmail, name: 'Arthur Dent' },
          metadata: { version: 'en', product: 'Reset by Discipline (English Edition)' },
        } as any,
        `evt_duplicate_${Date.now()}`,
        'checkout.session.completed'
      );

      expect(webhookHandled).toBe(true);
      // No duplicate emails dispatched
      expect(sendEmail).not.toHaveBeenCalled();
    });
  });

  describe('4. Dynamic Backend URL & Staff Download URL Resolution', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('resolves staff download URL to staging domain when on staging', () => {
      process.env.FRONTEND_URL = 'https://staging.leadersperformance.ae';
      process.env.BACKEND_URL = 'https://staging.leadersperformance.ae';

      const downloadUrl = resolveStaffBookDownloadUrl('cs_test_abc123');
      expect(downloadUrl).toBe('https://staging.leadersperformance.ae/api/download?session_id=cs_test_abc123');
      expect(downloadUrl).not.toContain('api.leadersperformance.ae');
    });

    it('prevents accidental routing to production api.leadersperformance.ae when on staging or test mode', () => {
      process.env.FRONTEND_URL = 'https://staging.leadersperformance.ae';
      // Even if BACKEND_URL was incorrectly set to production api domain
      process.env.BACKEND_URL = 'https://api.leadersperformance.ae';

      const downloadUrl = resolveStaffBookDownloadUrl('cs_test_abc123');
      expect(downloadUrl).toBe('https://staging.leadersperformance.ae/api/download?session_id=cs_test_abc123');
      expect(downloadUrl).not.toContain('api.leadersperformance.ae');
    });

    it('dynamically respects custom BACKEND_URL without hardcoding', () => {
      delete process.env.APP_ENV;
      process.env.FRONTEND_URL = 'https://app.leadersperformance.ae';
      process.env.BACKEND_URL = 'https://api-custom.leadersperformance.ae';

      const url = getBackendUrl();
      expect(url).toBe('https://api-custom.leadersperformance.ae');
    });
  });
});
