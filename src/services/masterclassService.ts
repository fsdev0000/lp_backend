import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import { randomUUID } from 'crypto';
import { promises as dnsPromises } from 'dns';
import { upsertContact, sendEmail, getFreeSlots, getMonthAvailability, getCalendarInfo, bookAppointment } from './ghl';
import { escapeHtml, formatOperationalSubmissionDate, renderTemplate } from './email';
import { getMasterclassBucketFiles, createMasterclassSignedUrl } from './supabaseStorageService';
import { generateIcsContent, generateGoogleCalendarUrl, generateOutlookCalendarUrl, CalendarEventDetails } from './calendarInvite';

let prismaInstance: PrismaClient | null = null;
function getPrisma(): any {
  if (!prismaInstance) {
    prismaInstance = new PrismaClient();
  }
  return prismaInstance;
}
const prisma = getPrisma();

export const LIONEL_MEETING_ROOM = {
  title: "Lionel Eersteling's Private Meeting Room (Leaders Performance)",
  url: process.env.MASTERCLASS_MEETING_URL || 'https://zoom.us/j/7114427991?pwd=RnkwdHdnMWtyVnBnQXp3dmw1NW9kUT09',
  meetingId: process.env.MASTERCLASS_MEETING_ID || '711 442 7991',
  passcode: process.env.MASTERCLASS_MEETING_PASSCODE || '097248',
};

// Helper to obtain Stripe client
function getStripe(): Stripe {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY environment variable is not configured');
  }
  return new Stripe(secretKey);
}

const dnsResolver = new dnsPromises.Resolver();
try {
  dnsResolver.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
} catch {
  // Fall back to default system servers
}

/**
 * Validates whether an email domain exists on the internet and can receive email (via DNS MX/A lookup)
 */
export async function verifyEmailDomainExistence(email: string): Promise<{ valid: boolean; reason?: string }> {
  const parts = email.trim().toLowerCase().split('@');
  if (parts.length !== 2 || !parts[1]) {
    return { valid: false, reason: 'Invalid email structure.' };
  }
  const domain = parts[1];

  // Common domain typo mappings
  const typoMap: Record<string, string> = {
    'gmail.co': 'gmail.com',
    'gamil.com': 'gmail.com',
    'gmial.com': 'gmail.com',
    'gmal.com': 'gmail.com',
    'yahoo.co': 'yahoo.com',
    'yaho.com': 'yahoo.com',
    'hotmail.co': 'hotmail.com',
    'outlok.com': 'outlook.com',
    'outlook.co': 'outlook.com',
  };

  if (typoMap[domain]) {
    return {
      valid: false,
      reason: `Did you mean @${typoMap[domain]}? "@${domain}" appears to be a typo.`,
    };
  }

  try {
    const lookupPromise = (async () => {
      try {
        const mxRecords = await dnsResolver.resolveMx(domain);
        if (mxRecords && mxRecords.length > 0) {
          return { valid: true };
        }
      } catch (err: any) {
        // ENOTFOUND means the domain definitively does not exist on DNS
        if (err.code === 'ENOTFOUND') {
          return {
            valid: false,
            reason: `The domain "@${domain}" does not exist on the internet.`,
          };
        }
        // Try A record fallback if domain exists but uses direct mail host or unusual config
        try {
          const aRecords = await dnsResolver.resolve(domain);
          if (aRecords && aRecords.length > 0) {
            return { valid: true };
          }
        } catch (aErr: any) {
          if (aErr.code === 'ENOTFOUND') {
            return {
              valid: false,
              reason: `The domain "@${domain}" does not exist on the internet.`,
            };
          }
          if (aErr.code === 'ENODATA') {
            return {
              valid: false,
              reason: `The domain "@${domain}" has no active mail servers configured.`,
            };
          }
        }

        // For local development or network connectivity glitches (ECONNREFUSED, ETIMEOUT, ESERVFAIL),
        // fail open gracefully so valid email domains are never blocked.
        return { valid: true };
      }

      return {
        valid: false,
        reason: `The domain "@${domain}" cannot receive emails. Please enter a valid email address.`,
      };
    })();

    // 2500ms safety timeout to prevent hanging on slow network lookup
    const timeoutPromise = new Promise<{ valid: boolean; reason?: string }>((resolve) =>
      setTimeout(() => resolve({ valid: true }), 2500)
    );

    return await Promise.race([lookupPromise, timeoutPromise]);
  } catch {
    // Fail open on unexpected errors
    return { valid: true };
  }
}

// Generates unique reference number for Masterclass Workbook: FNM-YYYY-XXXX
export function generateMasterclassReference(): string {
  const year = new Date().getFullYear();
  const seq = String(Math.floor(1000 + Math.random() * 9000));
  return `FNM-${year}-${seq}`;
}

// Generates booking reference number: MBK-YYYY-XXXX
export function generateBookingReference(): string {
  const year = new Date().getFullYear();
  const seq = String(Math.floor(1000 + Math.random() * 9000));
  return `MBK-${year}-${seq}`;
}

export interface MasterclassUserPayload {
  fullName: string;
  email: string;
  company: string;
  role?: string;
  phone?: string;
  how_did_you_hear?: string;
  how_did_you_hear_other?: string;
  attribution?: Record<string, any>;
  marketingConsent?: boolean;
  privacyConsent?: boolean;
  source?: string;
  returnUrl?: string;
}

export interface MasterclassDraftPayload {
  email: string;
  currentStage?: number;
  formData: Record<string, any>;
  personalNotes?: Record<string, any>;
}

export interface MasterclassWorkbookSubmissionPayload {
  participantDetails: {
    fullName: string;
    email: string;
    company: string;
    role?: string;
    phone?: string;
  };
  formData: {
    stage1_nextStage: string;
    stage1_possibility: string;
    stage1_strength: string;
    stage2_changes: string;
    stage2_demand1: string;
    stage2_demand2?: string;
    stage2_demand3?: string;
    stage2_investment: string;
    stage3_founderStrength: string;
    stage3_founderStandard?: string;
    stage3_teamStrength: string;
    stage3_teamStandard?: string;
    stage3_orgStrength: string;
    stage3_orgInvestment?: string;
    stage3_focusArea?: string;
    stage4_priority30Days: string;
    stage4_milestone1?: string;
    stage4_milestone2?: string;
    stage4_milestone3?: string;
    stage4_action7Days: string;
    stage4_actionTiming?: string;
    stage4_evidence: string;
    [key: string]: any;
  };
  personalNotes?: {
    stage1_notes?: string;
    stage2_notes?: string;
    stage3_notes?: string;
    stage4_notes?: string;
    [key: string]: any;
  };
  token?: string;
  submissionRef?: string;
}

export interface MasterclassBookingPayload {
  submissionId?: string;
  submissionRef?: string;
  enrollmentId?: string;
  email: string;
  fullName: string;
  company: string;
  selectedSlot: string;
  timezone?: string;
  scheduledAt?: string;
  notes?: string;
}

/**
 * 1. User Identification & Recognition Logic
 * Recognizes if user is registered, has already purchased, or has in-progress workbook.
 */
export async function identifyUser(email: string) {
  const normalizedEmail = email.trim().toLowerCase();

  // Validate domain existence via DNS lookup
  const domainCheck = await verifyEmailDomainExistence(normalizedEmail);
  if (!domainCheck.valid) {
    return {
      success: false,
      domainValid: false,
      error: 'DOMAIN_INVALID',
      message: domainCheck.reason,
      recognized: false,
      isExistingUser: false,
      hasPaid: false,
      accessGranted: false,
      user: null,
      enrollment: null,
      submission: null,
      booking: null,
      token: null,
    };
  }

  let enrollment: any = null;
  try {
    const db = getPrisma();
    if (db.masterclassEnrollment) {
      enrollment = await db.masterclassEnrollment.findFirst({
        where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
        orderBy: { createdAt: 'desc' },
        include: {
          submissions: {
            orderBy: { updatedAt: 'desc' },
            take: 1,
          },
          bookings: {
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      });
    }
  } catch (err: any) {
    console.warn('[Masterclass] Database lookup notice in identifyUser:', err.message);
  }

  if (!enrollment) {
    return {
      success: true,
      domainValid: true,
      recognized: false,
      isExistingUser: false,
      hasPaid: false,
      accessGranted: false,
      user: null,
      enrollment: null,
      submission: null,
      booking: null,
      token: null,
    };
  }

  // Issue or preserve session token
  let token = enrollment.sessionToken;
  if (!token) {
    token = randomUUID();
    await prisma.masterclassEnrollment.update({
      where: { id: enrollment.id },
      data: { sessionToken: token },
    });
  }

  const latestSubmission = enrollment.submissions[0] || null;
  const latestBooking = enrollment.bookings[0] || null;

  return {
    recognized: true,
    isExistingUser: true,
    hasPaid: enrollment.paymentStatus === 'paid',
    accessGranted: enrollment.accessGranted,
    user: {
      id: enrollment.id,
      email: enrollment.email,
      fullName: enrollment.fullName,
      company: enrollment.company,
      role: enrollment.role,
      phone: enrollment.phone,
      currentStage: enrollment.currentStage,
      courseProgress: enrollment.courseProgress,
      paymentStatus: enrollment.paymentStatus,
      paidAt: enrollment.paidAt,
    },
    enrollment: {
      id: enrollment.id,
      status: enrollment.paymentStatus,
      accessGranted: enrollment.accessGranted,
      amount: enrollment.amount,
      currency: enrollment.currency,
      stripeSessionId: enrollment.stripeSessionId,
    },
    submission: latestSubmission
      ? {
        id: latestSubmission.id,
        submissionRef: latestSubmission.submissionRef,
        status: latestSubmission.status,
        currentStage: latestSubmission.currentStage,
        submittedAt: latestSubmission.submittedAt,
        lastSavedAt: latestSubmission.lastSavedAt,
      }
      : null,
    booking: latestBooking
      ? {
        id: latestBooking.id,
        bookingRef: latestBooking.bookingRef,
        slotTime: latestBooking.slotTime,
        timezone: latestBooking.timezone,
        status: latestBooking.status,
      }
      : null,
    token,
  };
}

/**
 * 2. Registration & Stripe Session Creation
 * Before Stripe payment: recognizes user, logs in/issues token, and returns checkout session.
 */
export async function createSessionAndEnrollment(payload: MasterclassUserPayload) {
  const normalizedEmail = payload.email.trim().toLowerCase();
  const normalizedName = payload.fullName.trim();
  const normalizedCompany = payload.company.trim();
  const frontendUrl = (process.env.FRONTEND_URL || 'https://leadersperformance.ae').replace(/\/$/, '');

  // 1. Check if user already exists
  let enrollment = await prisma.masterclassEnrollment.findFirst({
    where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
    orderBy: { createdAt: 'desc' },
  });

  const sessionToken = enrollment?.sessionToken || randomUUID();

  // Verify if participant already enrolled with verified payment
  if (enrollment && enrollment.accessGranted && enrollment.paymentStatus === 'paid') {
    return {
      recognized: true,
      isExistingUser: true,
      alreadyPaid: true,
      accessGranted: true,
      paymentStatus: 'paid',
      token: sessionToken,
      enrollment: {
        id: enrollment.id,
        email: enrollment.email,
        fullName: enrollment.fullName,
        company: enrollment.company,
        paymentStatus: enrollment.paymentStatus,
        accessGranted: enrollment.accessGranted,
      },
      checkoutUrl: null,
      message: 'Participant already enrolled with verified payment. Direct access unlocked.',
    };
  }

  // Upsert or create enrollment
  if (enrollment) {
    enrollment = await prisma.masterclassEnrollment.update({
      where: { id: enrollment.id },
      data: {
        fullName: normalizedName,
        company: normalizedCompany,
        role: payload.role || enrollment.role,
        phone: payload.phone || enrollment.phone,
        marketingConsent: payload.marketingConsent ?? enrollment.marketingConsent,
        privacyConsent: payload.privacyConsent ?? enrollment.privacyConsent,
        source: payload.source || enrollment.source,
        sessionToken,
      },
    });
  } else {
    enrollment = await prisma.masterclassEnrollment.create({
      data: {
        email: normalizedEmail,
        fullName: normalizedName,
        company: normalizedCompany,
        role: payload.role,
        phone: payload.phone,
        marketingConsent: payload.marketingConsent ?? false,
        privacyConsent: payload.privacyConsent ?? true,
        source: payload.source || 'website',
        amount: 50000, // US $500 in cents
        currency: 'usd',
        paymentStatus: 'pending',
        accessGranted: false,
        sessionToken,
      },
    });
  }

  // 2. Create Stripe Checkout Session
  const stripe = getStripe();
  const returnPath = payload.returnUrl || '/masterclass';
  const successUrl = `${frontendUrl}${returnPath.startsWith('/') ? returnPath : `/${returnPath}`}?session_id={CHECKOUT_SESSION_ID}&success=true`;
  const cancelUrl = `${frontendUrl}${returnPath.startsWith('/') ? returnPath : `/${returnPath}`}?cancelled=true`;

  const priceId = process.env.STRIPE_MASTERCLASS_PRICE_ID;
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = priceId
    ? [{ price: priceId, quantity: 1 }]
    : [
      {
        price_data: {
          currency: 'usd',
          unit_amount: 50000, // US $500.00
          product_data: {
            name: "The Founder’s Next Move — Executive Masterclass",
            description: '4 Video Briefing Modules, Digital Interactive Workbook & 1-on-1 Strategic Review with Lionel Eersteling',
            images: ['https://leadersperformance.ae/og-image.jpg'],
          },
        },
        quantity: 1,
      },
    ];

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    customer_email: normalizedEmail,
    line_items: lineItems,
    invoice_creation: {
      enabled: true,
      invoice_data: {
        description: 'The Founder’s Next Move — Executive Masterclass',
        metadata: {
          enrollmentId: enrollment.id,
          product: 'The Founder’s Next Move',
        },
      },
    },
    payment_intent_data: {
      receipt_email: normalizedEmail,
      description: 'The Founder’s Next Move — Executive Masterclass',
    },
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: {
      enrollmentId: enrollment.id,
      email: normalizedEmail,
      fullName: normalizedName,
      company: normalizedCompany,
      source: payload.source || 'website',
      product: 'The Founder’s Next Move',
    },
  });

  // Store Stripe session ID on enrollment
  await prisma.masterclassEnrollment.update({
    where: { id: enrollment.id },
    data: { stripeSessionId: session.id },
  });

  // Optionally register lead in GHL with attribution & how_did_you_hear
  try {
    await upsertContact({
      email: normalizedEmail,
      firstName: normalizedName.split(' ')[0],
      lastName: normalizedName.split(' ').slice(1).join(' ') || undefined,
      phone: payload.phone,
      source: `Masterclass Enrollment (${payload.source || 'Direct'})`,
      tags: ['Masterclass Lead', 'The Founders Next Move'],
      howDidYouHear: payload.how_did_you_hear,
      attribution: payload.attribution,
    });
  } catch (err: any) {
    console.warn('[GHL] Non-fatal upsert error during masterclass registration:', err.message);
  }

  return {
    recognized: true,
    isExistingUser: Boolean(enrollment),
    alreadyPaid: false,
    accessGranted: false,
    paymentStatus: 'pending',
    token: sessionToken,
    sessionId: session.id,
    checkoutUrl: session.url,
    enrollment: {
      id: enrollment.id,
      email: enrollment.email,
      fullName: enrollment.fullName,
      company: enrollment.company,
      paymentStatus: enrollment.paymentStatus,
      amount: enrollment.amount,
      currency: enrollment.currency,
    },
    message: 'User recognized and enrolled. Proceed to Stripe checkout.',
  };
}

/**
 * 3. Verify Stripe Payment
 */
export async function verifyPayment(sessionId: string) {
  const stripe = getStripe();
  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['payment_intent'],
  });

  if (!session) {
    throw new Error('Stripe session not found');
  }

  const isPaid = session.payment_status === 'paid';

  // Find enrollment by stripeSessionId or metadata
  let enrollment = await prisma.masterclassEnrollment.findFirst({
    where: {
      OR: [
        { stripeSessionId: sessionId },
        { id: session.metadata?.enrollmentId },
        { email: session.customer_email || session.metadata?.email },
      ].filter(Boolean) as any,
    },
  });

  if (isPaid && enrollment) {
    const paymentIntentId =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id;

    enrollment = await prisma.masterclassEnrollment.update({
      where: { id: enrollment.id },
      data: {
        paymentStatus: 'paid',
        accessGranted: true,
        paidAt: enrollment.paidAt || new Date(),
        stripePaymentIntentId: paymentIntentId || enrollment.stripePaymentIntentId,
      },
    });

    // Tag contact in GHL as paid customer
    try {
      await upsertContact({
        email: enrollment.email,
        firstName: enrollment.fullName.split(' ')[0],
        lastName: enrollment.fullName.split(' ').slice(1).join(' ') || undefined,
        tags: ['Masterclass Paid', 'The Founders Next Move Customer'],
      });
    } catch (err: any) {
      console.warn('[GHL] Non-fatal tagging error upon payment:', err.message);
    }
  }

  return {
    verified: isPaid,
    paymentStatus: session.payment_status,
    accessGranted: isPaid,
    enrollment: enrollment
      ? {
        id: enrollment.id,
        email: enrollment.email,
        fullName: enrollment.fullName,
        company: enrollment.company,
        accessGranted: enrollment.accessGranted,
        paymentStatus: enrollment.paymentStatus,
      }
      : null,
    token: enrollment?.sessionToken || null,
  };
}

/**
 * 4. Save Draft & Get Draft
 */
export async function saveDraft(payload: MasterclassDraftPayload) {
  const normalizedEmail = payload.email.trim().toLowerCase();

  const enrollment = await prisma.masterclassEnrollment.findFirst({
    where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
  });

  const existingSubmission = await prisma.masterclassWorkbookSubmission.findFirst({
    where: {
      email: { equals: normalizedEmail, mode: 'insensitive' },
      status: 'draft',
    },
    orderBy: { updatedAt: 'desc' },
  });

  // Validate maximum answer length (1000 characters)
  if (payload.formData && typeof payload.formData === 'object') {
    for (const [key, val] of Object.entries(payload.formData)) {
      if (typeof val === 'string' && val.length > 1000) {
        throw new Error(`Answer for ${key} cannot exceed 1,000 characters.`);
      }
    }
  }
  if (payload.personalNotes && typeof payload.personalNotes === 'object') {
    for (const [key, val] of Object.entries(payload.personalNotes)) {
      if (typeof val === 'string' && val.length > 1000) {
        throw new Error(`Personal note for ${key} cannot exceed 1,000 characters.`);
      }
    }
  }

  const serializedFormData = JSON.stringify(payload.formData || {});
  const serializedNotes = JSON.stringify(payload.personalNotes || {});
  const stage = payload.currentStage || 1;

  let submissionRecord;
  if (existingSubmission) {
    submissionRecord = await prisma.masterclassWorkbookSubmission.update({
      where: { id: existingSubmission.id },
      data: {
        enrollmentId: enrollment?.id || existingSubmission.enrollmentId,
        currentStage: stage,
        formData: serializedFormData,
        personalNotes: serializedNotes,
        lastSavedAt: new Date(),
      },
    });
  } else {
    submissionRecord = await prisma.masterclassWorkbookSubmission.create({
      data: {
        submissionRef: generateMasterclassReference(),
        enrollmentId: enrollment?.id,
        email: normalizedEmail,
        fullName: enrollment?.fullName || 'Draft Participant',
        company: enrollment?.company || 'Draft Company',
        status: 'draft',
        currentStage: stage,
        formData: serializedFormData,
        personalNotes: serializedNotes,
        lastSavedAt: new Date(),
      },
    });
  }

  // Update enrollment current stage & progress
  if (enrollment) {
    const progress = Math.min(100, Math.round((stage / 4) * 100));
    await prisma.masterclassEnrollment.update({
      where: { id: enrollment.id },
      data: {
        currentStage: stage,
        courseProgress: Math.max(enrollment.courseProgress, progress),
      },
    });
  }

  return {
    success: true,
    submissionRef: submissionRecord.submissionRef,
    lastSavedAt: submissionRecord.lastSavedAt.toISOString(),
  };
}

export async function getDraft(email: string) {
  const normalizedEmail = email.trim().toLowerCase();

  const draft = await prisma.masterclassWorkbookSubmission.findFirst({
    where: {
      email: { equals: normalizedEmail, mode: 'insensitive' },
    },
    orderBy: { updatedAt: 'desc' },
  });

  if (!draft) {
    return { hasDraft: false, draft: null };
  }

  let parsedFormData = {};
  let parsedNotes = {};
  try {
    parsedFormData = JSON.parse(draft.formData);
  } catch { }
  try {
    parsedNotes = draft.personalNotes ? JSON.parse(draft.personalNotes) : {};
  } catch { }

  return {
    hasDraft: true,
    draft: {
      id: draft.id,
      submissionRef: draft.submissionRef,
      status: draft.status,
      currentStage: draft.currentStage,
      formData: parsedFormData,
      personalNotes: parsedNotes,
      lastSavedAt: draft.lastSavedAt,
      submittedAt: draft.submittedAt,
    },
  };
}

/**
 * 5. Submit Final 4-Stage Workbook
 */
export async function submitWorkbook(payload: MasterclassWorkbookSubmissionPayload) {
  const { participantDetails, formData, personalNotes } = payload;
  const normalizedEmail = participantDetails.email.trim().toLowerCase();
  const normalizedName = participantDetails.fullName.trim();
  const normalizedCompany = participantDetails.company.trim();

  // Find enrollment
  let enrollment = await prisma.masterclassEnrollment.findFirst({
    where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
  });

  // Validate maximum answer length (1000 characters)
  if (formData && typeof formData === 'object') {
    for (const [key, val] of Object.entries(formData)) {
      if (typeof val === 'string' && val.length > 1000) {
        throw new Error(`Answer for ${key} cannot exceed 1,000 characters.`);
      }
    }
  }
  if (personalNotes && typeof personalNotes === 'object') {
    for (const [key, val] of Object.entries(personalNotes)) {
      if (typeof val === 'string' && val.length > 1000) {
        throw new Error(`Personal note for ${key} cannot exceed 1,000 characters.`);
      }
    }
  }

  // Use provided ref or existing draft ref or generate a new unique ref
  const submissionRef = payload.submissionRef || generateMasterclassReference();
  const serializedFormData = JSON.stringify(formData);
  const serializedNotes = JSON.stringify(personalNotes || {});

  // Check if draft exists to convert to submitted
  const existingDraft = await prisma.masterclassWorkbookSubmission.findFirst({
    where: {
      email: { equals: normalizedEmail, mode: 'insensitive' },
      status: 'draft',
    },
    orderBy: { updatedAt: 'desc' },
  });

  let submissionRecord;
  if (existingDraft) {
    submissionRecord = await prisma.masterclassWorkbookSubmission.update({
      where: { id: existingDraft.id },
      data: {
        submissionRef,
        enrollmentId: enrollment?.id,
        fullName: normalizedName,
        company: normalizedCompany,
        role: participantDetails.role,
        phone: participantDetails.phone,
        status: 'submitted',
        currentStage: 4,
        formData: serializedFormData,
        personalNotes: serializedNotes,
        submittedAt: new Date(),
        lastSavedAt: new Date(),
      },
    });
  } else {
    submissionRecord = await prisma.masterclassWorkbookSubmission.create({
      data: {
        submissionRef,
        enrollmentId: enrollment?.id,
        email: normalizedEmail,
        fullName: normalizedName,
        company: normalizedCompany,
        role: participantDetails.role,
        phone: participantDetails.phone,
        status: 'submitted',
        currentStage: 4,
        formData: serializedFormData,
        personalNotes: serializedNotes,
        submittedAt: new Date(),
        lastSavedAt: new Date(),
      },
    });
  }

  // Update enrollment completion
  if (enrollment) {
    await prisma.masterclassEnrollment.update({
      where: { id: enrollment.id },
      data: {
        courseProgress: 100,
        currentStage: 4,
      },
    });
  }

  // Send notifications
  try {
    await sendWorkbookSubmissionNotifications({
      submissionRef,
      fullName: normalizedName,
      email: normalizedEmail,
      company: normalizedCompany,
      role: participantDetails.role,
      phone: participantDetails.phone,
      formData,
      personalNotes,
    });
  } catch (err: any) {
    console.error('[Notification] Error sending workbook submission notification:', err.message);
  }

  return {
    success: true,
    submissionId: submissionRecord.id,
    submissionRef,
    submittedAt: submissionRecord.submittedAt?.toISOString(),
    nextStep: 'book_review_session',
    message: 'Your 4-Stage Workbook has been securely recorded. Please select your 1-on-1 strategic review slot.',
  };
}

export async function getSubmission(submissionRefOrId: string) {
  const submission = await prisma.masterclassWorkbookSubmission.findFirst({
    where: {
      OR: [
        { id: submissionRefOrId },
        { submissionRef: submissionRefOrId },
      ],
    },
    include: {
      bookings: true,
      enrollment: true,
    },
  });

  if (!submission) {
    return null;
  }

  let parsedFormData = {};
  let parsedNotes = {};
  try {
    parsedFormData = JSON.parse(submission.formData);
  } catch { }
  try {
    parsedNotes = submission.personalNotes ? JSON.parse(submission.personalNotes) : {};
  } catch { }

  return {
    ...submission,
    formData: parsedFormData,
    personalNotes: parsedNotes,
  };
}

// ==========================================
// CANONICAL MASTERCLASS STRATEGIC REVIEW SLOTS
// ==========================================
// 1. Availability: 1:30 PM to 7:00 PM Dubai time (Asia/Dubai).
// 2. Session duration: 60 minutes per booking.
// 3. Rest time: 30-minute break between consecutive sessions.
// 4. Expected slots (Dubai Time / Asia/Dubai / GST / UTC+4):
//    - Slot 1: 1:30 PM – 2:30 PM (13:30 – 14:30)
//    - Slot 2: 3:00 PM – 4:00 PM (15:00 – 16:00)
//    - Slot 3: 4:30 PM – 5:30 PM (16:30 – 17:30)
//    - Slot 4: 6:00 PM – 7:00 PM (18:00 – 19:00)

export interface CanonicalMasterclassSlot {
  slotIndex: number;
  time24: string;           // "13:30", "15:00", "16:30", "18:00"
  startDubai: string;       // "13:30", "15:00", "16:30", "18:00"
  endDubai: string;         // "14:30", "16:00", "17:30", "19:00"
  labelDubai: string;       // "1:30 PM – 2:30 PM"
  durationMinutes: number;  // 60
  bufferMinutes: number;    // 30
}

export const CANONICAL_MASTERCLASS_SLOTS: CanonicalMasterclassSlot[] = [
  {
    slotIndex: 1,
    time24: '13:30',
    startDubai: '13:30',
    endDubai: '14:30',
    labelDubai: '1:30 PM – 2:30 PM',
    durationMinutes: 60,
    bufferMinutes: 30,
  },
  {
    slotIndex: 2,
    time24: '15:00',
    startDubai: '15:00',
    endDubai: '16:00',
    labelDubai: '3:00 PM – 4:00 PM',
    durationMinutes: 60,
    bufferMinutes: 30,
  },
  {
    slotIndex: 3,
    time24: '16:30',
    startDubai: '16:30',
    endDubai: '17:30',
    labelDubai: '4:30 PM – 5:30 PM',
    durationMinutes: 60,
    bufferMinutes: 30,
  },
  {
    slotIndex: 4,
    time24: '18:00',
    startDubai: '18:00',
    endDubai: '19:00',
    labelDubai: '6:00 PM – 7:00 PM',
    durationMinutes: 60,
    bufferMinutes: 30,
  },
];

export function resolveIanaTimezone(tz?: string): string {
  if (!tz) return 'Asia/Dubai';
  const clean = tz.trim();
  const map: Record<string, string> = {
    'GST (UTC+4)': 'Asia/Dubai',
    'GST': 'Asia/Dubai',
    'EST (UTC-5)': 'America/New_York',
    'EST': 'America/New_York',
    'EDT': 'America/New_York',
    'GMT (UTC+0)': 'Europe/London',
    'GMT': 'Europe/London',
    'UTC': 'UTC',
    'CET (UTC+1)': 'Europe/Paris',
    'CET': 'Europe/Paris',
    'CEST': 'Europe/Paris',
    'PST (UTC-8)': 'America/Los_Angeles',
    'PST': 'America/Los_Angeles',
    'PDT': 'America/Los_Angeles',
    'CST (UTC-6)': 'America/Chicago',
    'SGT (UTC+8)': 'Asia/Singapore',
  };
  if (map[clean]) return map[clean];
  try {
    Intl.DateTimeFormat(undefined, { timeZone: clean });
    return clean;
  } catch {
    return 'Asia/Dubai';
  }
}

export function getSlotDatesUtc(dateStr: string, slot: CanonicalMasterclassSlot): { startDate: Date; endDate: Date } {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hour, min] = slot.startDubai.split(':').map(Number);
  // Dubai is UTC+4, so UTC hour = hour - 4
  const startDate = new Date(Date.UTC(y, m - 1, d, hour - 4, min, 0, 0));
  const endDate = new Date(startDate.getTime() + slot.durationMinutes * 60 * 1000);
  return { startDate, endDate };
}

export function formatSlotForParticipant(
  dateStr: string,
  slot: CanonicalMasterclassSlot,
  userTimezone?: string
) {
  const iana = resolveIanaTimezone(userTimezone);
  const { startDate, endDate } = getSlotDatesUtc(dateStr, slot);

  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: iana,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const tzNameFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: iana,
    timeZoneName: 'short',
  });

  const tzParts = tzNameFormatter.formatToParts(startDate);
  const tzAbbr = tzParts.find((p) => p.type === 'timeZoneName')?.value || '';

  const localStart = timeFormatter.format(startDate);
  const localEnd = timeFormatter.format(endDate);
  const localRange = `${localStart} – ${localEnd} ${tzAbbr}`.trim();

  const isLocalSameAsDubai = iana === 'Asia/Dubai';
  const fullLabel = isLocalSameAsDubai
    ? `${dateStr} • ${slot.labelDubai} GST`
    : `${dateStr} • ${localRange} (${slot.labelDubai} Dubai Time)`;

  return {
    slotId: `${dateStr}_${slot.time24.replace(':', '-')}`,
    date: dateStr,
    time24: slot.time24,
    dubaiStartTime: slot.startDubai,
    dubaiEndTime: slot.endDubai,
    dubaiLabel: `${slot.labelDubai} GST`,
    localStartTime: localStart,
    localEndTime: localEnd,
    localRange,
    timezoneAbbr: tzAbbr,
    resolvedTimezone: iana,
    displayLabel: fullLabel,
    startIso: startDate.toISOString(),
    endIso: endDate.toISOString(),
  };
}

const monthAvailabilityCache: Record<string, { data: Record<string, string[]>; expiresAt: number }> = {};

/**
 * Returns month availability mapping for DaisyBookingScreen:
 * Record<dateStr, string[]> (where string[] contains available 24-hr times e.g. ["13:30", "14:30", "15:30"])
 */
export async function getMasterclassMonthAvailability(
  year: number,
  month: number,
  _timezone?: string
): Promise<Record<string, string[]>> {
  const cacheKey = `${year}-${month}`;
  if (monthAvailabilityCache[cacheKey] && monthAvailabilityCache[cacheKey].expiresAt > Date.now()) {
    return monthAvailabilityCache[cacheKey].data;
  }

  const daysInMonth = new Date(year, month, 0).getDate();
  const todayDubaiStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(new Date());

  // 1. Fetch confirmed database bookings for this month
  const startOfMonthUtc = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const endOfMonthUtc = new Date(Date.UTC(year, month, 0, 23, 59, 59));

  let existingBookings: any[] = [];
  try {
    const db = getPrisma();
    existingBookings = await db.masterclassBooking.findMany({
      where: {
        status: 'confirmed',
        scheduledAt: { gte: startOfMonthUtc, lte: endOfMonthUtc },
      },
      select: { slotTime: true, scheduledAt: true },
    });
  } catch (err: any) {
    console.warn('[Masterclass Calendar] Existing booking lookup notice:', err.message);
  }

  // 2. Fetch GHL calendar free slots for Lionel if configured with fast 1500ms safety timeout
  let ghlMonthMap: Record<string, string[]> = {};
  try {
    const ghlPromise = getMonthAvailability(year, month);
    const timeoutPromise = new Promise<Record<string, string[]>>((resolve) => setTimeout(() => resolve({}), 1500));
    ghlMonthMap = await Promise.race([ghlPromise, timeoutPromise]);
  } catch (err: any) {
    // If GHL is offline or times out, continue with database validation
  }

  const availabilityMap: Record<string, string[]> = {};

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

    // Skip weekends (0 is Sun, 6 is Sat)
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      continue;
    }
    // Skip past days
    if (dateStr < todayDubaiStr) {
      continue;
    }

    const availableSlotsForDay: string[] = [];

    for (const canonical of CANONICAL_MASTERCLASS_SLOTS) {
      // Check database booking collision
      const hasDbConflict = existingBookings.some((b) => {
        if (b.slotTime && b.slotTime.includes(dateStr) && (b.slotTime.includes(canonical.time24) || b.slotTime.includes(canonical.labelDubai))) {
          return true;
        }
        if (b.scheduledAt) {
          const { startDate } = getSlotDatesUtc(dateStr, canonical);
          return Math.abs(new Date(b.scheduledAt).getTime() - startDate.getTime()) < 30 * 60 * 1000;
        }
        return false;
      });

      if (hasDbConflict) {
        continue;
      }

      // Check GHL calendar collision if GHL data exists
      if (ghlMonthMap[dateStr]) {
        const ghlDaySlots = ghlMonthMap[dateStr];
        if (ghlDaySlots.length === 0) {
          continue;
        }
      }

      availableSlotsForDay.push(canonical.time24);
    }

    availabilityMap[dateStr] = availableSlotsForDay;
  }

  monthAvailabilityCache[cacheKey] = {
    data: availabilityMap,
    expiresAt: Date.now() + 60 * 1000,
  };

  return availabilityMap;
}

/**
 * 6. Calendar Available Slots & 1:1 Review Booking
 */
export async function getAvailableSlots(date?: string, timezone?: string) {
  const tz = timezone || 'GST (UTC+4)';
  const iana = resolveIanaTimezone(tz);

  if (date && date.match(/^\d{4}-\d{2}-\d{2}$/)) {
    const [y, m] = date.split('-').map(Number);
    const monthMap = await getMasterclassMonthAvailability(y, m, tz);
    const availableTime24s = monthMap[date] || [];

    const slots = CANONICAL_MASTERCLASS_SLOTS.map((slot) => {
      const formatted = formatSlotForParticipant(date, slot, tz);
      const isAvailable = availableTime24s.includes(slot.time24);
      return {
        ...formatted,
        available: isAvailable,
      };
    });

    const activeSlotStrings = slots
      .filter((s) => s.available)
      .map((s) => s.displayLabel);

    return {
      success: true,
      date,
      timezone: tz,
      resolvedTimezone: iana,
      format: 'Private 1-on-1 Strategic Review Session • 45 Minutes',
      slots,
      availableSlots: activeSlotStrings.length > 0 ? activeSlotStrings : slots.map((s) => s.displayLabel),
      timezones: [
        { key: 'GST (UTC+4)', label: 'GST (Gulf Standard Time)' },
        { key: 'EST (UTC-5)', label: 'EST (Eastern Time)' },
        { key: 'GMT (UTC+0)', label: 'GMT (London Time)' },
        { key: 'CET (UTC+1)', label: 'CET (Central European Time)' },
        { key: 'PST (UTC-8)', label: 'PST (Pacific Time)' },
      ],
    };
  }

  // If no specific date passed, query upcoming business days
  const today = new Date();
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth() + 1;

  const currentMonthMap = await getMasterclassMonthAvailability(currentYear, currentMonth, tz);
  const activeDates = Object.keys(currentMonthMap).filter((d) => (currentMonthMap[d] || []).length > 0);

  let merged = currentMonthMap;
  if (activeDates.length < 5) {
    const nextMonthDate = new Date(currentYear, currentMonth, 1);
    const nextMonthMap = await getMasterclassMonthAvailability(nextMonthDate.getFullYear(), nextMonthDate.getMonth() + 1, tz);
    merged = { ...currentMonthMap, ...nextMonthMap };
  }

  const dates = Object.keys(merged).sort();
  const allFormattedSlots: string[] = [];
  const detailedSlots: any[] = [];

  for (const d of dates.slice(0, 10)) {
    const times = merged[d] || [];
    for (const canonical of CANONICAL_MASTERCLASS_SLOTS) {
      if (times.includes(canonical.time24)) {
        const formatted = formatSlotForParticipant(d, canonical, tz);
        allFormattedSlots.push(formatted.displayLabel);
        detailedSlots.push({ ...formatted, available: true });
      }
    }
  }

  return {
    success: true,
    timezone: tz,
    resolvedTimezone: iana,
    format: 'Private 1-on-1 Strategic Review Session • 45 Minutes',
    availableSlots: allFormattedSlots.slice(0, 15),
    slots: detailedSlots.slice(0, 15),
    timezones: [
      { key: 'GST (UTC+4)', label: 'GST (Gulf Standard Time)' },
      { key: 'EST (UTC-5)', label: 'EST (Eastern Time)' },
      { key: 'GMT (UTC+0)', label: 'GMT (London Time)' },
      { key: 'CET (UTC+1)', label: 'CET (Central European Time)' },
      { key: 'PST (UTC-8)', label: 'PST (Pacific Time)' },
    ],
  };
}

export async function bookReviewSlot(payload: MasterclassBookingPayload) {
  const normalizedEmail = payload.email.trim().toLowerCase();
  const normalizedName = payload.fullName.trim();
  const normalizedCompany = payload.company.trim();
  const tz = payload.timezone || 'GST (UTC+4)';
  const bookingRef = generateBookingReference();

  // Find linked submission and enrollment
  let submissionId = payload.submissionId;
  let enrollmentId = payload.enrollmentId;

  if (!submissionId && payload.submissionRef) {
    const sub = await prisma.masterclassWorkbookSubmission.findUnique({
      where: { submissionRef: payload.submissionRef },
    });
    if (sub) {
      submissionId = sub.id;
      enrollmentId = enrollmentId || sub.enrollmentId || undefined;
    }
  }

  if (!enrollmentId) {
    const enr = await prisma.masterclassEnrollment.findFirst({
      where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
    });
    if (enr) enrollmentId = enr.id;
  }

  // Parse date and canonical slot
  const rawSlot = payload.selectedSlot || '';
  const dateMatch = rawSlot.match(/\d{4}-\d{2}-\d{2}/) || (payload.scheduledAt ? payload.scheduledAt.match(/\d{4}-\d{2}-\d{2}/) : null);
  
  let dateStr: string;
  if (dateMatch) {
    dateStr = dateMatch[0];
  } else {
    // Pick first upcoming business day if date not explicit
    const nextDay = new Date();
    nextDay.setDate(nextDay.getDate() + 1);
    while (nextDay.getDay() === 0 || nextDay.getDay() === 6) {
      nextDay.setDate(nextDay.getDate() + 1);
    }
    dateStr = nextDay.toISOString().split('T')[0];
  }

  // Match slot to canonical definitions (13:30, 15:00, 16:30, 18:00)
  const matchedSlot = CANONICAL_MASTERCLASS_SLOTS.find(
    (s) =>
      rawSlot.includes(s.time24) ||
      rawSlot.includes(s.startDubai) ||
      rawSlot.includes(s.labelDubai) ||
      (s.slotIndex === 1 && (rawSlot.includes('1:30') || rawSlot.includes('01:30') || rawSlot.includes('13:30'))) ||
      (s.slotIndex === 2 && (rawSlot.includes('3:00') || rawSlot.includes('03:00') || rawSlot.includes('15:00'))) ||
      (s.slotIndex === 3 && (rawSlot.includes('4:30') || rawSlot.includes('04:30') || rawSlot.includes('16:30'))) ||
      (s.slotIndex === 4 && (rawSlot.includes('6:00') || rawSlot.includes('06:00') || rawSlot.includes('18:00')))
  ) || CANONICAL_MASTERCLASS_SLOTS[0];

  const { startDate, endDate } = getSlotDatesUtc(dateStr, matchedSlot);
  const formattedSlot = formatSlotForParticipant(dateStr, matchedSlot, tz);

  // ── Conflict Prevention ──
  // Check if this slot on this date is already booked by another confirmed participant
  const existingConflict = await prisma.masterclassBooking.findFirst({
    where: {
      status: 'confirmed',
      OR: [
        {
          AND: [
            { slotTime: { contains: dateStr } },
            {
              OR: [
                { slotTime: { contains: matchedSlot.time24 } },
                { slotTime: { contains: matchedSlot.labelDubai } },
              ],
            },
          ],
        },
        {
          scheduledAt: {
            gte: new Date(startDate.getTime() - 15 * 60 * 1000),
            lte: new Date(endDate.getTime() + 15 * 60 * 1000),
          },
        },
      ],
    },
  });

  if (existingConflict) {
    const error: any = new Error('This time slot is no longer available. Please select another slot.');
    error.code = 'CONFLICT';
    error.statusCode = 409;
    throw error;
  }

  const slotDisplay = `${dateStr} at ${matchedSlot.labelDubai} (Dubai Time)`;

  const booking = await prisma.masterclassBooking.create({
    data: {
      bookingRef,
      enrollmentId,
      submissionId,
      email: normalizedEmail,
      fullName: normalizedName,
      company: normalizedCompany,
      slotTime: slotDisplay,
      scheduledAt: startDate,
      timezone: tz,
      status: 'confirmed',
      notes: payload.notes,
      meetingLink: LIONEL_MEETING_ROOM.url,
    },
  });

  // Attempt booking appointment in GHL if configured
  try {
    const contactId = await upsertContact({
      email: normalizedEmail,
      firstName: normalizedName.split(' ')[0],
      lastName: normalizedName.split(' ').slice(1).join(' ') || undefined,
      tags: ['Masterclass Review Booked', '1-on-1 Strategic Review'],
    });

    if (contactId) {
      await bookAppointment(
        contactId,
        dateStr + 'T' + matchedSlot.startDubai,
        `Strategic Review: ${normalizedName} (${normalizedCompany})`
      );
    }
  } catch (err: any) {
    console.warn('[GHL] Calendar booking sync notice:', err.message);
  }

  // Generate .ics calendar invite and universal calendar links
  const frontendUrl = process.env.FRONTEND_URL || 'https://leadersperformance.ae';
  const meetingAccessUrl = booking.meetingLink || LIONEL_MEETING_ROOM.url;
  const icsEvent: CalendarEventDetails = {
    uid: `strategic-review-${bookingRef}@leadersperformance.ae`,
    title: '1-on-1 Strategic Review with Lionel Eersteling',
    description: `Private 1-on-1 Strategic Review with Lionel Eersteling.\n\nLionel Eersteling's Private Meeting Room (Leaders Performance):\nDirect Meeting Link: ${meetingAccessUrl}\nMeeting ID: ${LIONEL_MEETING_ROOM.meetingId}\nPasscode: ${LIONEL_MEETING_ROOM.passcode}\n\nParticipant: ${normalizedName} (${normalizedCompany})\nBooking Reference: ${bookingRef}\nWorkSheet Reference: ${payload.submissionRef || 'FNM-VERIFIED'}\nDuration: 45 Minutes\n\nReschedule: ${frontendUrl}/masterclass?reschedule=${bookingRef}`,
    location: meetingAccessUrl,
    meetingUrl: meetingAccessUrl,
    start: startDate,
    end: endDate,
    organizerName: 'Lionel Eersteling',
    organizerEmail: 'info@leadersperformance.ae',
    attendeeName: normalizedName,
    attendeeEmail: normalizedEmail,
  };

  const googleCalendarUrl = generateGoogleCalendarUrl(icsEvent);
  const outlookCalendarUrl = generateOutlookCalendarUrl(icsEvent);

  // Send booking confirmation email to participant
  try {
    await sendBookingConfirmationEmail({
      bookingRef,
      fullName: normalizedName,
      email: normalizedEmail,
      company: normalizedCompany,
      slotTime: formattedSlot.displayLabel,
      timezone: tz,
      submissionRef: payload.submissionRef || 'FNM-VERIFIED',
      googleCalendarUrl,
      outlookCalendarUrl,
      meetingLink: meetingAccessUrl,
      meetingId: LIONEL_MEETING_ROOM.meetingId,
      meetingPasscode: LIONEL_MEETING_ROOM.passcode,
    });
  } catch (err: any) {
    console.error('[Email] Failed to send booking confirmation email:', err.message);
  }

  return {
    success: true,
    bookingId: booking.id,
    bookingRef,
    slotTime: booking.slotTime,
    timezone: booking.timezone,
    status: booking.status,
    meetingLink: booking.meetingLink,
    googleCalendarUrl,
    outlookCalendarUrl,
    message: 'Your 1-on-1 strategic review with Lionel Eersteling is confirmed.',
  };
}

export interface MasterclassReschedulePayload {
  bookingRef: string;
  newDate: string;
  newSlotTime: string;
  timezone?: string;
  reason?: string;
}

export async function rescheduleReviewSlot(payload: MasterclassReschedulePayload) {
  const booking = await prisma.masterclassBooking.findUnique({
    where: { bookingRef: payload.bookingRef },
  });
  if (!booking) {
    const error: any = new Error(`Booking ${payload.bookingRef} was not found.`);
    error.statusCode = 404;
    throw error;
  }

  const dateStr = payload.newDate.trim();
  const matchedSlot = CANONICAL_MASTERCLASS_SLOTS.find(
    (s) =>
      payload.newSlotTime.includes(s.time24) ||
      payload.newSlotTime.includes(s.startDubai) ||
      payload.newSlotTime.includes(s.labelDubai) ||
      (s.slotIndex === 1 && (payload.newSlotTime.includes('1:30') || payload.newSlotTime.includes('01:30') || payload.newSlotTime.includes('13:30'))) ||
      (s.slotIndex === 2 && (payload.newSlotTime.includes('3:00') || payload.newSlotTime.includes('03:00') || payload.newSlotTime.includes('15:00'))) ||
      (s.slotIndex === 3 && (payload.newSlotTime.includes('4:30') || payload.newSlotTime.includes('04:30') || payload.newSlotTime.includes('16:30'))) ||
      (s.slotIndex === 4 && (payload.newSlotTime.includes('6:00') || payload.newSlotTime.includes('06:00') || payload.newSlotTime.includes('18:00')))
  ) || CANONICAL_MASTERCLASS_SLOTS[0];

  const tz = payload.timezone || booking.timezone;
  const { startDate, endDate } = getSlotDatesUtc(dateStr, matchedSlot);
  const formattedSlot = formatSlotForParticipant(dateStr, matchedSlot, tz);

  // Check conflict for new requested slot
  const conflict = await prisma.masterclassBooking.findFirst({
    where: {
      status: 'confirmed',
      id: { not: booking.id },
      OR: [
        {
          AND: [
            { slotTime: { contains: dateStr } },
            {
              OR: [
                { slotTime: { contains: matchedSlot.time24 } },
                { slotTime: { contains: matchedSlot.labelDubai } },
              ],
            },
          ],
        },
        {
          scheduledAt: {
            gte: new Date(startDate.getTime() - 15 * 60 * 1000),
            lte: new Date(endDate.getTime() + 15 * 60 * 1000),
          },
        },
      ],
    },
  });

  if (conflict) {
    const error: any = new Error('The requested new time slot is already booked. Please choose another slot.');
    error.statusCode = 409;
    throw error;
  }

  const slotDisplay = `${dateStr} at ${matchedSlot.labelDubai} (Dubai Time)`;

  const updatedBooking = await prisma.masterclassBooking.update({
    where: { id: booking.id },
    data: {
      slotTime: slotDisplay,
      scheduledAt: startDate,
      timezone: tz,
      notes: payload.reason ? `Rescheduled. Reason: ${payload.reason}` : booking.notes,
    },
  });

  const frontendUrl = process.env.FRONTEND_URL || 'https://leadersperformance.ae';
  const meetingAccessUrl = updatedBooking.meetingLink || booking.meetingLink || LIONEL_MEETING_ROOM.url;
  const icsEvent: CalendarEventDetails = {
    uid: `strategic-review-${booking.bookingRef}@leadersperformance.ae`,
    title: '1-on-1 Strategic Review with Lionel Eersteling (Rescheduled)',
    description: `Rescheduled Private 1-on-1 Strategic Review with Lionel Eersteling.\n\nLionel Eersteling's Private Meeting Room (Leaders Performance):\nDirect Meeting Link: ${meetingAccessUrl}\nMeeting ID: ${LIONEL_MEETING_ROOM.meetingId}\nPasscode: ${LIONEL_MEETING_ROOM.passcode}\n\nParticipant: ${booking.fullName} (${booking.company})\nBooking Reference: ${booking.bookingRef}\nDuration: 45 Minutes\n\nReschedule Link: ${frontendUrl}/masterclass?reschedule=${booking.bookingRef}`,
    location: meetingAccessUrl,
    meetingUrl: meetingAccessUrl,
    start: startDate,
    end: endDate,
    organizerName: 'Lionel Eersteling',
    organizerEmail: 'info@leadersperformance.ae',
    attendeeName: booking.fullName,
    attendeeEmail: booking.email,
    sequence: 1,
  };

  const googleCalendarUrl = generateGoogleCalendarUrl(icsEvent);
  const outlookCalendarUrl = generateOutlookCalendarUrl(icsEvent);

  await sendBookingConfirmationEmail({
    bookingRef: booking.bookingRef,
    fullName: booking.fullName,
    email: booking.email,
    company: booking.company,
    slotTime: formattedSlot.displayLabel,
    timezone: tz,
    submissionRef: 'FNM-VERIFIED',
    googleCalendarUrl,
    outlookCalendarUrl,
    meetingLink: meetingAccessUrl,
    meetingId: LIONEL_MEETING_ROOM.meetingId,
    meetingPasscode: LIONEL_MEETING_ROOM.passcode,
    isReschedule: true,
  });

  return {
    success: true,
    bookingRef: booking.bookingRef,
    slotTime: updatedBooking.slotTime,
    scheduledAt: updatedBooking.scheduledAt,
    timezone: updatedBooking.timezone,
    googleCalendarUrl,
    outlookCalendarUrl,
    message: 'Your 1-on-1 strategic review with Lionel Eersteling has been rescheduled successfully.',
  };
}

/**
 * 7. Email Notification Helpers & Staff Briefings
 */

const MASTERCLASS_STAFF_RECIPIENTS = [
  { email: 'info@leadersperformance.ae', firstName: 'Leaders', lastName: 'Performance' },
];

function loadMasterclassTemplate(filename: string): string | null {
  try {
    const templatePath = path.join(__dirname, '../../templates', filename);
    if (fs.existsSync(templatePath)) {
      return fs.readFileSync(templatePath, 'utf8');
    }
  } catch (err) {
    console.warn(`[Masterclass] Could not load template file ${filename}:`, err);
  }
  return null;
}

export function getMasterclassReviewUrl(ref: string): string {
  const backendBaseUrl =
    process.env.BACKEND_URL ||
    process.env.API_BASE_URL ||
    (process.env.NODE_ENV === 'production'
      ? 'https://api.leadersperformance.ae'
      : 'http://localhost:4000');
  const cleanBase = backendBaseUrl.replace(/\/+$/, '');
  const cleanRef = encodeURIComponent((ref || '').trim());
  return `${cleanBase}/masterclass/review/${cleanRef}`;
}

function buildMasterclassStaffBriefingHtml(data: {
  submissionRef: string;
  fullName: string;
  email: string;
  company: string;
  role?: string;
  phone?: string;
  formData: any;
  personalNotes?: any;
}): string {
  const f = data.formData || {};
  const notes = data.personalNotes || {};
  const submittedAt = formatOperationalSubmissionDate();

  const renderField = (label: string, value: any): string => {
    if (value === null || value === undefined || !String(value).trim()) return '';
    return `
      <tr style="border-bottom: 1px solid #ebe4db;">
        <td style="padding: 14px 0; width: 200px; vertical-align: top; font-family: 'Inter', Arial, Helvetica, sans-serif; font-size: 12px; font-weight: 600; line-height: 17px; letter-spacing: 1.44px; text-transform: uppercase; color: #9f6511;">
          ${escapeHtml(label)}
        </td>
        <td style="padding: 14px 0; vertical-align: top; font-family: 'Inter', Arial, Helvetica, sans-serif; font-size: 14.5px; font-weight: 400; line-height: 22px; color: #1b2637; white-space: pre-wrap;">
          ${escapeHtml(String(value))}
        </td>
      </tr>
    `;
  };

  const renderStageSection = (title: string, rows: string): string => {
    if (!rows) return '';
    return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 28px; margin-bottom: 8px;">
        <tr>
          <td style="font-family: 'Inter', Arial, Helvetica, sans-serif; font-size: 12px; font-weight: 600; line-height: 17px; letter-spacing: 1.44px; text-transform: uppercase; color: #9f6511; border-bottom: 1px solid #ebe4db; padding-bottom: 8px;">
            ${escapeHtml(title)}
          </td>
        </tr>
      </table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse; margin-bottom: 12px;">
        ${rows}
      </table>
    `;
  };

  const stage1Rows = [
    renderField('1. Next Stage of Growth', f.stage1_nextStage),
    renderField('2. What This Makes Possible', f.stage1_possibility),
    renderField('3. Core Strength to Carry Through', f.stage1_strength),
  ].filter(Boolean).join('');

  const stage2Rows = [
    renderField('1. What Changes Most as You Scale', f.stage2_changes),
    renderField('2. Demand 1 (Leadership & Strategy)', f.stage2_demand1),
    renderField('Demand 2 (Team & Accountability)', f.stage2_demand2),
    renderField('Demand 3 (Pace & Governance)', f.stage2_demand3),
    renderField('3. Performance Investment Required', f.stage2_investment),
  ].filter(Boolean).join('');

  const stage3Rows = [
    renderField('1. Founder Capability to Elevate', f.stage3_founderStrength),
    renderField('Founder Standard to Uphold', f.stage3_founderStandard),
    renderField('2. Leadership Team Capability', f.stage3_teamStrength),
    renderField('Leadership Team Standard', f.stage3_teamStandard),
    renderField('3. Organisation System to Reinforce', f.stage3_orgStrength),
    renderField('Organizational Investment', f.stage3_orgInvestment),
    renderField('Primary Focus Area', f.stage3_focusArea),
  ].filter(Boolean).join('');

  const priority30 = f.stage4_priority30Days || f.stage4_priority90Days || '';
  const stage4Rows = [
    renderField('1. 30-Day Main Preparation Priority', priority30),
    renderField('Milestone 1 (10-Day Marker)', f.stage4_milestone1),
    renderField('Milestone 2 (20-Day Marker)', f.stage4_milestone2),
    renderField('Milestone 3 (30-Day Marker)', f.stage4_milestone3),
    renderField('2. Single Action Within 7 Days', f.stage4_action7Days),
    renderField('When Action Will Be Taken', f.stage4_actionTiming),
    renderField('Evidence to Look For Afterward', f.stage4_evidence),
  ].filter(Boolean).join('');

  const standardKeys = new Set([
    'stage1_nextStage', 'stage1_possibility', 'stage1_strength',
    'stage2_changes', 'stage2_demand1', 'stage2_demand2', 'stage2_demand3', 'stage2_investment',
    'stage3_founderStrength', 'stage3_founderStandard', 'stage3_teamStrength', 'stage3_teamStandard',
    'stage3_orgStrength', 'stage3_orgInvestment', 'stage3_focusArea',
    'stage4_priority30Days', 'stage4_priority90Days', 'stage4_milestone1', 'stage4_milestone2', 'stage4_milestone3',
    'stage4_action7Days', 'stage4_actionTiming', 'stage4_evidence',
  ]);

  let extraRows = '';
  if (typeof f === 'object') {
    for (const [k, v] of Object.entries(f)) {
      if (!standardKeys.has(k) && v !== null && v !== undefined && String(v).trim()) {
        const cleanKey = k.replace(/([A-Z])/g, ' $1').replace(/[_-]/g, ' ').trim();
        extraRows += renderField(cleanKey, v);
      }
    }
  }

  let personalNotesRows = '';
  if (notes && typeof notes === 'object') {
    for (const [k, v] of Object.entries(notes)) {
      if (v !== null && v !== undefined && String(v).trim()) {
        const cleanKey = k.replace(/([A-Z])/g, ' $1').replace(/[_-]/g, ' ').trim();
        personalNotesRows += renderField(`Note: ${cleanKey}`, v);
      }
    }
  }

  const personalNotesCallout = personalNotesRows ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #ebe4db; border-left: 3px solid #9f6511; border-radius: 0 2px 2px 0; margin-top: 24px; margin-bottom: 16px;">
      <tr>
        <td style="padding: 22px 24px;">
          <div style="font-family: 'Inter', Arial, Helvetica, sans-serif; font-size: 12px; font-weight: 600; line-height: 17px; letter-spacing: 1.44px; text-transform: uppercase; color: #9f6511; margin-bottom: 8px;">
            PARTICIPANT REFLECTIONS &amp; PERSONAL NOTES
          </div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            ${personalNotesRows}
          </table>
        </td>
      </tr>
    </table>
  ` : '';

  const stageSectionsHtml = [
    renderStageSection('Stage 1: Define the Next Stage', stage1Rows),
    renderStageSection('Stage 2: Success Changes the Game', stage2Rows),
    renderStageSection('Stage 3: Prepare for Performance', stage3Rows),
    renderStageSection('Stage 4: Your Next Move', stage4Rows),
    extraRows ? renderStageSection('Additional Responses', extraRows) : '',
    personalNotesCallout,
  ].filter(Boolean).join('');

  const replyUrl = `mailto:${escapeHtml(data.email)}?subject=Re:%20The%20Founder%E2%80%99s%20Next%20Move%20%E2%80%94%20${encodeURIComponent(data.submissionRef)}`;
  const reviewUrl = getMasterclassReviewUrl(data.submissionRef);

  const template = loadMasterclassTemplate('masterclass-staff-briefing.html');
  if (template) {
    return renderTemplate(template, {
      participant_name: escapeHtml(data.fullName),
      company_name: escapeHtml(data.company || 'Not provided'),
      role: escapeHtml(data.role || 'Executive'),
      email: escapeHtml(data.email),
      phone: escapeHtml(data.phone || 'Not provided'),
      submitted_at: escapeHtml(submittedAt),
      submission_ref: escapeHtml(data.submissionRef),
      review_url: reviewUrl,
      reply_url: replyUrl,
      stage_sections_html: stageSectionsHtml,
    });
  }

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <title>Completed WorkSheet Briefing</title>
  <style type="text/css">
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Playfair+Display:wght@400;500&display=swap');
    body { margin: 0; padding: 0; background-color: #f2ede3; font-family: 'Inter', Arial, sans-serif; -webkit-font-smoothing: antialiased; }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #f2ede3; font-family: 'Inter', Arial, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f2ede3; width: 100%; margin: 0; padding: 32px 0;">
    <tr>
      <td align="center" style="padding: 0 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; width: 100%; background-color: #fbf8f2; border: 1px solid #ebe4db; border-collapse: separate; margin: 0 auto; text-align: left;">
          <tr>
            <td style="background-color: #021329; border-bottom: 1px solid #d0a35a; padding: 34px 40px;">
              <a href="https://leadersperformance.ae" target="_blank" style="text-decoration: none; display: inline-block;">
                <img src="https://leadersperformance.ae/assets/home/logo-gold.png" alt="Leaders Performance" width="146" height="58" style="display: block; width: 146px; height: auto; border: 0; outline: none;" />
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding: 40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-family: 'Inter', Arial, sans-serif; font-size: 12px; font-weight: 600; line-height: 17px; letter-spacing: 1.44px; text-transform: uppercase; color: #9f6511; padding-bottom: 12px;">
                    EXECUTIVE MASTERCLASS · THE FOUNDER’S NEXT MOVE
                  </td>
                </tr>
                <tr>
                  <td style="font-family: 'Playfair Display', Georgia, serif; font-size: 30px; font-weight: 400; line-height: 36px; color: #1b2637; padding-bottom: 12px;">
                    Completed WorkSheet Briefing
                  </td>
                </tr>
                <tr>
                  <td style="font-family: 'Inter', Arial, sans-serif; font-size: 15px; font-weight: 400; line-height: 24px; color: #4a5568; padding-bottom: 32px;">
                    A new 4-stage masterclass WorkSheet submission has been received and is ready for strategic review with Lionel Eersteling.
                  </td>
                </tr>
              </table>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top: 1px solid #ebe4db; border-collapse: collapse;">
                <tr style="border-bottom: 1px solid #ebe4db;">
                  <td style="padding: 15px 0; width: 170px; font-size: 12px; font-weight: 600; letter-spacing: 1.44px; text-transform: uppercase; color: #9f6511;">PARTICIPANT</td>
                  <td style="padding: 15px 0; font-size: 15px; font-weight: 500; color: #1b2637;">${escapeHtml(data.fullName)}</td>
                </tr>
                <tr style="border-bottom: 1px solid #ebe4db;">
                  <td style="padding: 15px 0; width: 170px; font-size: 12px; font-weight: 600; letter-spacing: 1.44px; text-transform: uppercase; color: #9f6511;">COMPANY</td>
                  <td style="padding: 15px 0; font-size: 15px; font-weight: 500; color: #1b2637;">${escapeHtml(data.company || 'Not provided')}</td>
                </tr>
                <tr style="border-bottom: 1px solid #ebe4db;">
                  <td style="padding: 15px 0; width: 170px; font-size: 12px; font-weight: 600; letter-spacing: 1.44px; text-transform: uppercase; color: #9f6511;">ROLE</td>
                  <td style="padding: 15px 0; font-size: 15px; font-weight: 500; color: #1b2637;">${escapeHtml(data.role || 'Executive')}</td>
                </tr>
                <tr style="border-bottom: 1px solid #ebe4db;">
                  <td style="padding: 15px 0; width: 170px; font-size: 12px; font-weight: 600; letter-spacing: 1.44px; text-transform: uppercase; color: #9f6511;">EMAIL</td>
                  <td style="padding: 15px 0; font-size: 15px; font-weight: 500; color: #1b2637;"><a href="mailto:${escapeHtml(data.email)}" style="color: #1b2637; text-decoration: underline;">${escapeHtml(data.email)}</a></td>
                </tr>
                <tr style="border-bottom: 1px solid #ebe4db;">
                  <td style="padding: 15px 0; width: 170px; font-size: 12px; font-weight: 600; letter-spacing: 1.44px; text-transform: uppercase; color: #9f6511;">PHONE / WHATSAPP</td>
                  <td style="padding: 15px 0; font-size: 15px; font-weight: 500; color: #1b2637;">${escapeHtml(data.phone || 'Not provided')}</td>
                </tr>
                <tr style="border-bottom: 1px solid #ebe4db;">
                  <td style="padding: 15px 0; width: 170px; font-size: 12px; font-weight: 600; letter-spacing: 1.44px; text-transform: uppercase; color: #9f6511;">SUBMITTED</td>
                  <td style="padding: 15px 0; font-size: 15px; font-weight: 500; color: #1b2637;">${escapeHtml(submittedAt)}</td>
                </tr>
                <tr style="border-bottom: 1px solid #ebe4db;">
                  <td style="padding: 15px 0; width: 170px; font-size: 12px; font-weight: 600; letter-spacing: 1.44px; text-transform: uppercase; color: #9f6511;">WORKSHEET REF</td>
                  <td style="padding: 15px 0; font-size: 15px; font-weight: 500; color: #1b2637;">${escapeHtml(data.submissionRef)}</td>
                </tr>
              </table>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 32px; margin-bottom: 24px;">
                <tr>
                  <td>
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td style="padding-right: 12px;">
                          <a href="${reviewUrl}" target="_blank" style="display: inline-block; background-color: #d0a35a; border: 1px solid #d0a35a; color: #010d20; text-decoration: none; font-family: 'Inter', Arial, sans-serif; font-size: 15px; font-weight: 500; line-height: 22px; padding: 14px 28px; text-align: center; border-radius: 2px;">
                            Review WorkSheet&nbsp;&nbsp;&rarr;
                          </a>
                        </td>
                        <td>
                          <a href="${replyUrl}" target="_blank" style="display: inline-block; background-color: transparent; border: 1px solid #9f6511; color: #1b2637; text-decoration: none; font-family: 'Inter', Arial, sans-serif; font-size: 14px; font-weight: 500; line-height: 20px; padding: 12px 24px; text-align: center; border-radius: 2px;">
                            Reply to ${escapeHtml(data.fullName)}
                          </a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
              ${stageSectionsHtml}
            </td>
          </tr>
          <tr>
            <td style="background-color: #010d20; border-top: 1px solid rgba(248,244,237,0.14); padding: 24px 40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-family: 'Inter', Arial, sans-serif; font-size: 12px; font-weight: 600; line-height: 18px; color: #fbf8f2; text-align: left;">
                    Leaders Performance
                  </td>
                  <td style="font-family: 'Inter', Arial, sans-serif; font-size: 12px; font-weight: 400; line-height: 18px; color: #fbf8f2; text-align: right;">
                    Internal WorkSheet Notification
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildMasterclassBookingStaffAlertHtml(data: {
  bookingRef: string;
  fullName: string;
  email: string;
  company: string;
  slotTime: string;
  timezone: string;
  submissionRef: string;
}): string {
  const replyUrl = `mailto:${escapeHtml(data.email)}?subject=Re:%20Strategic%20Review%20Confirmation%20(${encodeURIComponent(data.bookingRef)})`;
  const reviewUrl = getMasterclassReviewUrl(data.submissionRef || data.bookingRef);
  const template = loadMasterclassTemplate('masterclass-booking-staff-alert.html');

  if (template) {
    return renderTemplate(template, {
      headline: 'Private 1-on-1 Strategic Review Booked',
      preheader: 'Private 1-on-1 strategic review booked with Lionel Eersteling.',
      slot_time: escapeHtml(data.slotTime),
      timezone: escapeHtml(data.timezone),
      participant_name: escapeHtml(data.fullName),
      company_name: escapeHtml(data.company || 'Individual'),
      email: escapeHtml(data.email),
      submission_ref: escapeHtml(data.submissionRef),
      booking_ref: escapeHtml(data.bookingRef),
      meeting_url: escapeHtml(LIONEL_MEETING_ROOM.url),
      meeting_id: escapeHtml(LIONEL_MEETING_ROOM.meetingId),
      meeting_passcode: escapeHtml(LIONEL_MEETING_ROOM.passcode),
      review_url: reviewUrl,
      reply_url: replyUrl,
    });
  }

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <title>Private 1-on-1 Strategic Review Booked</title>
  <style type="text/css">
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Playfair+Display:wght@400;500&display=swap');
    body { margin: 0; padding: 0; background-color: #f2ede3; font-family: 'Inter', Arial, sans-serif; -webkit-font-smoothing: antialiased; }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #f2ede3; font-family: 'Inter', Arial, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f2ede3; width: 100%; margin: 0; padding: 32px 0;">
    <tr>
      <td align="center" style="padding: 0 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; width: 100%; background-color: #fbf8f2; border: 1px solid #ebe4db; border-collapse: separate; margin: 0 auto; text-align: left;">
          <tr>
            <td style="background-color: #021329; border-bottom: 1px solid #d0a35a; padding: 34px 40px;">
              <a href="https://leadersperformance.ae" target="_blank" style="text-decoration: none; display: inline-block;">
                <img src="https://leadersperformance.ae/assets/home/logo-gold.png" alt="Leaders Performance" width="146" height="58" style="display: block; width: 146px; height: auto; border: 0; outline: none;" />
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding: 40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-family: 'Inter', Arial, sans-serif; font-size: 12px; font-weight: 600; line-height: 17px; letter-spacing: 1.44px; text-transform: uppercase; color: #9f6511; padding-bottom: 12px;">
                    CALENDAR CONFIRMATION · STRATEGIC REVIEW
                  </td>
                </tr>
                <tr>
                  <td style="font-family: 'Playfair Display', Georgia, serif; font-size: 30px; font-weight: 400; line-height: 36px; color: #1b2637; padding-bottom: 12px;">
                    Private 1-on-1 Strategic Review Booked
                  </td>
                </tr>
                <tr>
                  <td style="font-family: 'Inter', Arial, sans-serif; font-size: 15px; font-weight: 400; line-height: 24px; color: #4a5568; padding-bottom: 32px;">
                    A private 45-minute strategic review with Lionel Eersteling has been confirmed on the executive calendar.
                  </td>
                </tr>
              </table>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top: 1px solid #ebe4db; border-collapse: collapse;">
                <tr style="border-bottom: 1px solid #ebe4db;">
                  <td style="padding: 15px 0; width: 170px; font-size: 12px; font-weight: 600; letter-spacing: 1.44px; text-transform: uppercase; color: #9f6511;">SELECTED SLOT</td>
                  <td style="padding: 15px 0; font-size: 15px; font-weight: 600; color: #1b2637;">${escapeHtml(data.slotTime)}</td>
                </tr>
                <tr style="border-bottom: 1px solid #ebe4db;">
                  <td style="padding: 15px 0; width: 170px; font-size: 12px; font-weight: 600; letter-spacing: 1.44px; text-transform: uppercase; color: #9f6511;">TIME ZONE</td>
                  <td style="padding: 15px 0; font-size: 15px; font-weight: 500; color: #1b2637;">${escapeHtml(data.timezone)}</td>
                </tr>
                <tr style="border-bottom: 1px solid #ebe4db;">
                  <td style="padding: 15px 0; width: 170px; font-size: 12px; font-weight: 600; letter-spacing: 1.44px; text-transform: uppercase; color: #9f6511;">DURATION</td>
                  <td style="padding: 15px 0; font-size: 15px; font-weight: 500; color: #1b2637;">45 Minutes (Private 1-on-1 Review with Lionel Eersteling)</td>
                </tr>
                <tr style="border-bottom: 1px solid #ebe4db;">
                  <td style="padding: 15px 0; width: 170px; font-size: 12px; font-weight: 600; letter-spacing: 1.44px; text-transform: uppercase; color: #9f6511;">PARTICIPANT</td>
                  <td style="padding: 15px 0; font-size: 15px; font-weight: 500; color: #1b2637;">${escapeHtml(data.fullName)} (${escapeHtml(data.company || 'Individual')})</td>
                </tr>
                <tr style="border-bottom: 1px solid #ebe4db;">
                  <td style="padding: 15px 0; width: 170px; font-size: 12px; font-weight: 600; letter-spacing: 1.44px; text-transform: uppercase; color: #9f6511;">EMAIL</td>
                  <td style="padding: 15px 0; font-size: 15px; font-weight: 500; color: #1b2637;"><a href="mailto:${escapeHtml(data.email)}" style="color: #1b2637; text-decoration: underline;">${escapeHtml(data.email)}</a></td>
                </tr>
                <tr style="border-bottom: 1px solid #ebe4db;">
                  <td style="padding: 15px 0; width: 170px; font-size: 12px; font-weight: 600; letter-spacing: 1.44px; text-transform: uppercase; color: #9f6511;">WORKSHEET REF</td>
                  <td style="padding: 15px 0; font-size: 15px; font-weight: 500; color: #1b2637;">${escapeHtml(data.submissionRef)}</td>
                </tr>
                <tr style="border-bottom: 1px solid #ebe4db;">
                  <td style="padding: 15px 0; width: 170px; font-size: 12px; font-weight: 600; letter-spacing: 1.44px; text-transform: uppercase; color: #9f6511;">BOOKING REF</td>
                  <td style="padding: 15px 0; font-size: 15px; font-weight: 500; color: #1b2637;">${escapeHtml(data.bookingRef)}</td>
                </tr>
                <tr style="border-bottom: 1px solid #ebe4db;">
                  <td style="padding: 15px 0; width: 170px; font-size: 12px; font-weight: 600; letter-spacing: 1.44px; text-transform: uppercase; color: #9f6511;">MEETING ROOM</td>
                  <td style="padding: 15px 0; font-size: 15px; font-weight: 500; color: #1b2637;">
                    <a href="${escapeHtml(LIONEL_MEETING_ROOM.url)}" target="_blank" style="color: #9f6511; font-weight: 600; text-decoration: underline;">Join Meeting</a>
                    <div style="font-size: 13px; color: #4a5568; margin-top: 6px; line-height: 20px;">
                      <div>Meeting ID: <strong>${escapeHtml(LIONEL_MEETING_ROOM.meetingId)}</strong></div>
                      <div>Passcode: <strong>${escapeHtml(LIONEL_MEETING_ROOM.passcode)}</strong></div>
                    </div>
                  </td>
                </tr>
              </table>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 32px;">
                <tr>
                  <td>
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td style="padding-right: 12px;">
                          <a href="${reviewUrl}" target="_blank" style="display: inline-block; background-color: #d0a35a; border: 1px solid #d0a35a; color: #010d20; text-decoration: none; font-family: 'Inter', Arial, sans-serif; font-size: 15px; font-weight: 500; line-height: 22px; padding: 14px 28px; text-align: center; border-radius: 2px;">
                            Review WorkSheet&nbsp;&nbsp;&rarr;
                          </a>
                        </td>
                        <td>
                          <a href="${replyUrl}" target="_blank" style="display: inline-block; background-color: transparent; border: 1px solid #9f6511; color: #1b2637; text-decoration: none; font-family: 'Inter', Arial, sans-serif; font-size: 14px; font-weight: 500; line-height: 20px; padding: 12px 24px; text-align: center; border-radius: 2px;">
                            Reply to ${escapeHtml(data.fullName)}
                          </a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background-color: #010d20; border-top: 1px solid rgba(248,244,237,0.14); padding: 24px 40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-family: 'Inter', Arial, sans-serif; font-size: 12px; font-weight: 600; line-height: 18px; color: #fbf8f2; text-align: left;">
                    Leaders Performance
                  </td>
                  <td style="font-family: 'Inter', Arial, sans-serif; font-size: 12px; font-weight: 400; line-height: 18px; color: #fbf8f2; text-align: right;">
                    Internal Calendar Alert
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export async function sendWorkbookSubmissionNotifications(data: {
  submissionRef: string;
  fullName: string;
  email: string;
  company: string;
  role?: string;
  phone?: string;
  formData: any;
  personalNotes?: any;
}) {
  const subject = `The Founder’s Next Move — WorkSheet Received (${data.submissionRef})`;
  const frontendUrl = process.env.FRONTEND_URL || 'https://leadersperformance.ae';
  const bookingUrl = `${frontendUrl}/masterclass?step=booking&ref=${encodeURIComponent(data.submissionRef)}`;

  const template = loadMasterclassTemplate('masterclass-worksheet-confirmation.html');
  let html = '';

  if (template) {
    html = renderTemplate(template, {
      participant_name: escapeHtml(data.fullName),
      company_name: escapeHtml(data.company || 'Not provided'),
      submission_ref: escapeHtml(data.submissionRef),
      booking_url: bookingUrl,
    });
  } else {
    html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <title>WorkSheet Submission Received</title>
  <style type="text/css">
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Playfair+Display:wght@400;500&display=swap');
    body { margin: 0; padding: 0; background-color: #f2ede3; font-family: 'Inter', Arial, sans-serif; -webkit-font-smoothing: antialiased; }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #f2ede3; font-family: 'Inter', Arial, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f2ede3; width: 100%; margin: 0; padding: 32px 0;">
    <tr>
      <td align="center" style="padding: 0 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; width: 100%; background-color: #fbf8f2; border: 1px solid #ebe4db; border-collapse: separate; margin: 0 auto; text-align: left;">
          <tr>
            <td style="background-color: #021329; border-bottom: 1px solid #d0a35a; padding: 34px 40px;">
              <a href="https://leadersperformance.ae" target="_blank" style="text-decoration: none; display: inline-block;">
                <img src="https://leadersperformance.ae/assets/home/logo-gold.png" alt="Leaders Performance" width="146" height="58" style="display: block; width: 146px; height: auto; border: 0; outline: none;" />
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding: 40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-family: 'Inter', Arial, sans-serif; font-size: 12px; font-weight: 600; line-height: 17px; letter-spacing: 1.44px; text-transform: uppercase; color: #9f6511; padding-bottom: 12px;">
                    EXECUTIVE MASTERCLASS · THE FOUNDER’S NEXT MOVE
                  </td>
                </tr>
                <tr>
                  <td style="font-family: 'Playfair Display', Georgia, serif; font-size: 30px; font-weight: 400; line-height: 36px; color: #1b2637; padding-bottom: 12px;">
                    WorkSheet Submission Received
                  </td>
                </tr>
                <tr>
                  <td style="font-family: 'Inter', Arial, sans-serif; font-size: 15px; font-weight: 400; line-height: 24px; color: #4a5568; padding-bottom: 32px;">
                    Dear ${escapeHtml(data.fullName)}, your 4-Stage Interactive WorkSheet has been received and secured for review with Lionel Eersteling.
                  </td>
                </tr>
              </table>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top: 1px solid #ebe4db; border-collapse: collapse;">
                <tr style="border-bottom: 1px solid #ebe4db;">
                  <td style="padding: 15px 0; width: 170px; font-size: 12px; font-weight: 600; letter-spacing: 1.44px; text-transform: uppercase; color: #9f6511;">PARTICIPANT</td>
                  <td style="padding: 15px 0; font-size: 15px; font-weight: 500; color: #1b2637;">${escapeHtml(data.fullName)}</td>
                </tr>
                <tr style="border-bottom: 1px solid #ebe4db;">
                  <td style="padding: 15px 0; width: 170px; font-size: 12px; font-weight: 600; letter-spacing: 1.44px; text-transform: uppercase; color: #9f6511;">COMPANY</td>
                  <td style="padding: 15px 0; font-size: 15px; font-weight: 500; color: #1b2637;">${escapeHtml(data.company || 'Not provided')}</td>
                </tr>
                <tr style="border-bottom: 1px solid #ebe4db;">
                  <td style="padding: 15px 0; width: 170px; font-size: 12px; font-weight: 600; letter-spacing: 1.44px; text-transform: uppercase; color: #9f6511;">SUBMISSION REF</td>
                  <td style="padding: 15px 0; font-size: 15px; font-weight: 500; color: #1b2637;">${escapeHtml(data.submissionRef)}</td>
                </tr>
                <tr style="border-bottom: 1px solid #ebe4db;">
                  <td style="padding: 15px 0; width: 170px; font-size: 12px; font-weight: 600; letter-spacing: 1.44px; text-transform: uppercase; color: #9f6511;">SESSION FORMAT</td>
                  <td style="padding: 15px 0; font-size: 15px; font-weight: 500; color: #1b2637;">Private 1-on-1 Review with Lionel Eersteling (45 Min)</td>
                </tr>
              </table>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 32px;">
                <tr>
                  <td>
                    <a href="${bookingUrl}" target="_blank" style="display: inline-block; background-color: #d0a35a; border: 1px solid #d0a35a; color: #010d20; text-decoration: none; font-family: 'Inter', Arial, sans-serif; font-size: 15px; font-weight: 500; line-height: 22px; padding: 14px 28px; text-align: center; border-radius: 2px;">
                      Schedule Strategic Review &rarr;
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background-color: #010d20; border-top: 1px solid rgba(248,244,237,0.14); padding: 24px 40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-family: 'Inter', Arial, sans-serif; font-size: 12px; font-weight: 600; line-height: 18px; color: #fbf8f2; text-align: left;">
                    Leaders Performance
                  </td>
                  <td style="font-family: 'Inter', Arial, sans-serif; font-size: 12px; font-weight: 400; line-height: 18px; color: #fbf8f2; text-align: right;">
                    Executive Advisory · Dubai, UAE
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  // 1. Participant Confirmation Dispatch
  try {
    const contactId = await upsertContact({
      email: data.email,
      firstName: data.fullName.split(' ')[0],
      lastName: data.fullName.split(' ').slice(1).join(' ') || undefined,
      tags: ['Masterclass WorkSheet Submitted'],
    });
    if (contactId) {
      await sendEmail(contactId, subject, html);
    }
  } catch (err: any) {
    console.warn('[Email] Fallback participant notification notice:', err.message);
  }

  // 2. Company Staff Briefing Dispatch (info@leadersperformance.ae)
  try {
    const staffSubject = `[Masterclass WorkSheet Submission] ${data.fullName} (${data.company || 'Individual'}) — ${data.submissionRef}`;
    const staffHtml = buildMasterclassStaffBriefingHtml(data);

    for (const recipient of MASTERCLASS_STAFF_RECIPIENTS) {
      try {
        const staffContactId = await upsertContact({
          email: recipient.email,
          firstName: recipient.firstName,
          lastName: recipient.lastName,
          tags: ['lp-staff', 'internal-notification', 'masterclass-admin'],
        });
        if (staffContactId) {
          await sendEmail(staffContactId, staffSubject, staffHtml);
          console.log(`[Masterclass] Staff worksheet briefing delivered to: ${recipient.email}`);
        }
      } catch (staffErr: any) {
        console.warn(`[Masterclass] Staff notification notice for ${recipient.email}:`, staffErr?.message || staffErr);
      }
    }
  } catch (staffGlobalErr: any) {
    console.warn('[Masterclass] Error dispatching staff worksheet briefing:', staffGlobalErr?.message || staffGlobalErr);
  }
}

export async function sendBookingConfirmationEmail(data: {
  bookingRef: string;
  fullName: string;
  email: string;
  company: string;
  slotTime: string;
  timezone: string;
  submissionRef: string;
  meetingLink?: string;
  meetingId?: string;
  meetingPasscode?: string;
  googleCalendarUrl?: string;
  outlookCalendarUrl?: string;
  isReschedule?: boolean;
}) {
  const isResched = Boolean(data.isReschedule);
  const subject = isResched
    ? `Updated: Private 1-on-1 Strategic Review with Lionel Eersteling (${data.bookingRef})`
    : `Confirmed: Private 1-on-1 Strategic Review with Lionel Eersteling (${data.bookingRef})`;

  const frontendUrl = process.env.FRONTEND_URL || 'https://leadersperformance.ae';
  const rescheduleUrl = `${frontendUrl}/masterclass?reschedule=${encodeURIComponent(data.bookingRef)}`;
  const headline = isResched ? 'Strategic Review Session Rescheduled' : 'Strategic Review Session Confirmed';
  const preheader = isResched
    ? 'Your private 1-on-1 strategic review with Lionel Eersteling has been rescheduled.'
    : 'Your private 1-on-1 strategic review with Lionel Eersteling is confirmed.';

  const meetingUrl = data.meetingLink || LIONEL_MEETING_ROOM.url;
  const meetingId = data.meetingId || LIONEL_MEETING_ROOM.meetingId;
  const meetingPasscode = data.meetingPasscode || LIONEL_MEETING_ROOM.passcode;

  let calendarActionsHtml = '';
  if (data.googleCalendarUrl || data.outlookCalendarUrl) {
    calendarActionsHtml = `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 20px; margin-bottom: 12px;">
        <tr>
          <td style="font-family: 'Inter', Arial, Helvetica, sans-serif; font-size: 12px; font-weight: 600; line-height: 17px; letter-spacing: 1.44px; text-transform: uppercase; color: #9f6511; padding-bottom: 10px;">
            ADD TO YOUR CALENDAR
          </td>
        </tr>
        <tr>
          <td>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                ${
                  data.googleCalendarUrl
                    ? `<td style="padding-right: 12px;">
                        <a href="${data.googleCalendarUrl}" target="_blank" class="cta-secondary" style="display: inline-block; background-color: transparent; border: 1px solid #9f6511; color: #1b2637; text-decoration: none; font-family: 'Inter', Arial, Helvetica, sans-serif; font-size: 13px; font-weight: 500; line-height: 20px; padding: 10px 18px; text-align: center; border-radius: 2px;">
                          Add to Google Calendar
                        </a>
                      </td>`
                    : ''
                }
                ${
                  data.outlookCalendarUrl
                    ? `<td>
                        <a href="${data.outlookCalendarUrl}" target="_blank" class="cta-secondary" style="display: inline-block; background-color: transparent; border: 1px solid #9f6511; color: #1b2637; text-decoration: none; font-family: 'Inter', Arial, Helvetica, sans-serif; font-size: 13px; font-weight: 500; line-height: 20px; padding: 10px 18px; text-align: center; border-radius: 2px;">
                          Add to Outlook
                        </a>
                      </td>`
                    : ''
                }
              </tr>
            </table>
          </td>
        </tr>
      </table>
    `;
  }

  const template = loadMasterclassTemplate('masterclass-booking-confirmation.html');
  let html = '';

  if (template) {
    html = renderTemplate(template, {
      headline,
      preheader,
      participant_name: escapeHtml(data.fullName),
      slot_time: escapeHtml(data.slotTime),
      timezone: escapeHtml(data.timezone),
      booking_ref: escapeHtml(data.bookingRef),
      submission_ref: escapeHtml(data.submissionRef),
      meeting_url: escapeHtml(meetingUrl),
      meeting_id: escapeHtml(meetingId),
      meeting_passcode: escapeHtml(meetingPasscode),
      calendar_actions_html: calendarActionsHtml,
      reschedule_url: rescheduleUrl,
    });
  } else {
    html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(headline)}</title>
  <style type="text/css">
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Playfair+Display:wght@400;500&display=swap');
    body { margin: 0; padding: 0; background-color: #f2ede3; font-family: 'Inter', Arial, sans-serif; -webkit-font-smoothing: antialiased; }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #f2ede3; font-family: 'Inter', Arial, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f2ede3; width: 100%; margin: 0; padding: 32px 0;">
    <tr>
      <td align="center" style="padding: 0 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; width: 100%; background-color: #fbf8f2; border: 1px solid #ebe4db; border-collapse: separate; margin: 0 auto; text-align: left;">
          <tr>
            <td style="background-color: #021329; border-bottom: 1px solid #d0a35a; padding: 34px 40px;">
              <a href="https://leadersperformance.ae" target="_blank" style="text-decoration: none; display: inline-block;">
                <img src="https://leadersperformance.ae/assets/home/logo-gold.png" alt="Leaders Performance" width="146" height="58" style="display: block; width: 146px; height: auto; border: 0; outline: none;" />
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding: 40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-family: 'Inter', Arial, sans-serif; font-size: 12px; font-weight: 600; line-height: 17px; letter-spacing: 1.44px; text-transform: uppercase; color: #9f6511; padding-bottom: 12px;">
                    PRIVATE 1-ON-1 STRATEGIC REVIEW
                  </td>
                </tr>
                <tr>
                  <td style="font-family: 'Playfair Display', Georgia, serif; font-size: 30px; font-weight: 400; line-height: 36px; color: #1b2637; padding-bottom: 12px;">
                    ${escapeHtml(headline)}
                  </td>
                </tr>
                <tr>
                  <td style="font-family: 'Inter', Arial, sans-serif; font-size: 15px; font-weight: 400; line-height: 24px; color: #4a5568; padding-bottom: 32px;">
                    Dear ${escapeHtml(data.fullName)}, your private 45-minute 1-on-1 strategic review with <strong>Lionel Eersteling</strong> is officially confirmed.
                  </td>
                </tr>
              </table>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top: 1px solid #ebe4db; border-collapse: collapse;">
                <tr style="border-bottom: 1px solid #ebe4db;">
                  <td style="padding: 15px 0; width: 170px; font-size: 12px; font-weight: 600; letter-spacing: 1.44px; text-transform: uppercase; color: #9f6511;">CONFIRMED TIME</td>
                  <td style="padding: 15px 0; font-size: 15px; font-weight: 600; color: #1b2637;">${escapeHtml(data.slotTime)}</td>
                </tr>
                <tr style="border-bottom: 1px solid #ebe4db;">
                  <td style="padding: 15px 0; width: 170px; font-size: 12px; font-weight: 600; letter-spacing: 1.44px; text-transform: uppercase; color: #9f6511;">TIME ZONE</td>
                  <td style="padding: 15px 0; font-size: 15px; font-weight: 500; color: #1b2637;">${escapeHtml(data.timezone)}</td>
                </tr>
                <tr style="border-bottom: 1px solid #ebe4db;">
                  <td style="padding: 15px 0; width: 170px; font-size: 12px; font-weight: 600; letter-spacing: 1.44px; text-transform: uppercase; color: #9f6511;">DURATION</td>
                  <td style="padding: 15px 0; font-size: 15px; font-weight: 500; color: #1b2637;">45 Minutes (Private 1-on-1 Strategic Review with Lionel Eersteling)</td>
                </tr>
                <tr style="border-bottom: 1px solid #ebe4db;">
                  <td style="padding: 15px 0; width: 170px; font-size: 12px; font-weight: 600; letter-spacing: 1.44px; text-transform: uppercase; color: #9f6511;">BOOKING REFERENCE</td>
                  <td style="padding: 15px 0; font-size: 15px; font-weight: 500; color: #1b2637;">${escapeHtml(data.bookingRef)}</td>
                </tr>
                <tr style="border-bottom: 1px solid #ebe4db;">
                  <td style="padding: 15px 0; width: 170px; font-size: 12px; font-weight: 600; letter-spacing: 1.44px; text-transform: uppercase; color: #9f6511;">WORKSHEET REFERENCE</td>
                  <td style="padding: 15px 0; font-size: 15px; font-weight: 500; color: #1b2637;">${escapeHtml(data.submissionRef)}</td>
                </tr>
              </table>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #ebe4db; border-left: 3px solid #9f6511; border-radius: 0 2px 2px 0; margin-top: 32px; margin-bottom: 28px;">
                <tr>
                  <td style="padding: 24px;">
                    <div style="font-family: 'Inter', Arial, sans-serif; font-size: 12px; font-weight: 600; line-height: 17px; letter-spacing: 1.44px; text-transform: uppercase; color: #9f6511; margin-bottom: 8px;">
                      LIONEL EERSTELING'S PRIVATE MEETING ROOM
                    </div>
                    <div style="margin-bottom: 16px;">
                      <a href="${escapeHtml(meetingUrl)}" target="_blank" style="display: inline-block; background-color: #d0a35a; border: 1px solid #d0a35a; color: #010d20; text-decoration: none; font-family: 'Inter', Arial, sans-serif; font-size: 15px; font-weight: 500; line-height: 22px; padding: 14px 28px; text-align: center; border-radius: 2px;">
                        Join Meeting&nbsp;&nbsp;&rarr;
                      </a>
                    </div>
                    <div style="font-family: 'Inter', Arial, sans-serif; font-size: 13px; color: #1b2637; line-height: 22px;">
                      <div>Meeting ID: <strong>${escapeHtml(meetingId)}</strong></div>
                      <div>Passcode: <strong>${escapeHtml(meetingPasscode)}</strong></div>
                    </div>
                  </td>
                </tr>
              </table>
              ${calendarActionsHtml}
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top: 1px solid #ebe4db; padding-top: 16px; margin-top: 20px;">
                <tr>
                  <td style="font-family: 'Inter', Arial, sans-serif; font-size: 12px; font-weight: 400; line-height: 18px; color: #656e7c;">
                    Need to reschedule? <a href="${rescheduleUrl}" style="color: #9f6511; text-decoration: underline;">Click here to choose an alternative strategic review slot</a>.
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background-color: #010d20; border-top: 1px solid rgba(248,244,237,0.14); padding: 24px 40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-family: 'Inter', Arial, sans-serif; font-size: 12px; font-weight: 600; line-height: 18px; color: #fbf8f2; text-align: left;">
                    Leaders Performance
                  </td>
                  <td style="font-family: 'Inter', Arial, sans-serif; font-size: 12px; font-weight: 400; line-height: 18px; color: #fbf8f2; text-align: right;">
                    Executive Advisory · Dubai, UAE
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  // 1. Participant Confirmation Dispatch
  try {
    const contactId = await upsertContact({
      email: data.email,
      firstName: data.fullName.split(' ')[0],
      lastName: data.fullName.split(' ').slice(1).join(' ') || undefined,
      tags: ['Masterclass Review Confirmed'],
    });
    if (contactId) {
      await sendEmail(contactId, subject, html);
    }
  } catch (err: any) {
    console.warn('[Email] Fallback booking email notice:', err.message);
  }

  // 2. Company Staff Alert Dispatch (info@leadersperformance.ae)
  try {
    const staffSubject = `[Masterclass 1:1 Review Booked] ${data.fullName} (${data.company || 'Individual'}) — ${data.bookingRef}`;
    const staffHtml = buildMasterclassBookingStaffAlertHtml(data);

    for (const recipient of MASTERCLASS_STAFF_RECIPIENTS) {
      try {
        const staffContactId = await upsertContact({
          email: recipient.email,
          firstName: recipient.firstName,
          lastName: recipient.lastName,
          tags: ['lp-staff', 'internal-notification', 'masterclass-admin'],
        });
        if (staffContactId) {
          await sendEmail(staffContactId, staffSubject, staffHtml);
          console.log(`[Masterclass] Staff review booking alert delivered to: ${recipient.email}`);
        }
      } catch (staffErr: any) {
        console.warn(`[Masterclass] Staff booking notice for ${recipient.email}:`, staffErr?.message || staffErr);
      }
    }
  } catch (staffGlobalErr: any) {
    console.warn('[Masterclass] Error dispatching staff booking alert:', staffGlobalErr?.message || staffGlobalErr);
  }
}

// ==========================================
// 8. MASTERCLASS DYNAMIC CONFIG & 6 VIDEOS LOGIC
// ==========================================

let cachedMasterclassConfig: any = null;
let masterclassConfigCacheTime = 0;
const CONFIG_CACHE_TTL = 5 * 60 * 1000; // 5 mins

export const DEFAULT_MASTERCLASS_CONFIG = {
  title: "The Founder’s Next Move — Executive Masterclass",
  subtitle: "4 Video Briefing Modules, Digital Interactive WorkSheet & 1-on-1 Strategic Review with Lionel Eersteling",
  host: "Lionel Eersteling",
  investment: "US $500",
  reflectionPauseDurationSeconds: 45,
  totalStages: 4,
  totalVideos: 6,
  welcomeThumbnail: 'WELCOME.jpg',
  closingThumbnail: 'CLOSING.jpg',
  stages: [
    {
      stageNumber: 1,
      id: 'stage1',
      title: 'Define the Next Stage',
      moduleTitle: 'Module 1: Operating System & Shift',
      subtitle: 'Clarity on the business stage you are building for and what makes it distinct from where you stand today.',
      videoId: 2,
      videoKey: 'stage_1',
      thumbnailFileName: 'STAGE-01.jpg',
      reflectionPauseSeconds: 45,
      reflectionPrompt: 'Reflect on the next stage you are preparing your business for and what you want that stage to make possible. Record your answers in Stage 1.',
      questions: [
        {
          id: 'stage1_nextStage',
          label: '1. What is the next stage of business growth you are preparing for? *',
          type: 'textarea',
          required: true,
          maxLength: 1000,
          placeholder: 'e.g. Scaling from $5M to $15M ARR across 3 GCC markets...',
          helpText: 'Define the clear operational horizon and scale target.',
        },
        {
          id: 'stage1_possibility',
          label: '2. What will that next stage make possible that is not possible today? *',
          type: 'textarea',
          required: true,
          maxLength: 1000,
          placeholder: 'e.g. Attracting Tier-1 strategic partners and running self-sufficient business units...',
          helpText: 'Articulate the strategic unlock and enterprise advantage.',
        },
        {
          id: 'stage1_strength',
          label: '3. What single core strength from today must carry through into that next stage? *',
          type: 'textarea',
          required: true,
          maxLength: 1000,
          placeholder: 'e.g. Our obsessive standard for product quality and client trust...',
          helpText: 'Identify your non-negotiable competitive foundation.',
        },
      ],
    },
    {
      stageNumber: 2,
      id: 'stage2',
      title: 'Success Changes the Game',
      moduleTitle: 'Module 2: Evaluation & Resonance',
      subtitle: 'Recognizing how scale changes the demands on leadership, time allocation, and organizational standards.',
      videoId: 3,
      videoKey: 'stage_2',
      thumbnailFileName: 'STAGE-02.jpg',
      reflectionPauseSeconds: 45,
      reflectionPrompt: 'Reflect on how operational pace, scale, and demands will change as you grow. Record your answers in Stage 2.',
      questions: [
        {
          id: 'stage2_changes',
          label: '1. What changes most as your company scales to that next stage? *',
          type: 'textarea',
          required: true,
          maxLength: 1000,
          placeholder: 'e.g. Direct founder execution stops working; management infrastructure becomes mandatory...',
          helpText: 'What fundamental shifts occur in your day-to-day role?',
        },
        {
          id: 'stage2_demand1',
          label: '2. Demand 1: Leadership & Strategic Bandwidth *',
          type: 'text',
          required: true,
          maxLength: 1000,
          placeholder: 'e.g. Stepping out of daily tactical troubleshooting...',
        },
        {
          id: 'stage2_demand2',
          label: 'Demand 2: Team Execution & Accountability',
          type: 'text',
          required: false,
          maxLength: 1000,
          placeholder: 'e.g. Expecting directors to own KPIs without escalation...',
        },
        {
          id: 'stage2_demand3',
          label: 'Demand 3: Operational Pace & Governance',
          type: 'text',
          required: false,
          maxLength: 1000,
          placeholder: 'e.g. Weekly operating cadence replacing informal chat alignment...',
        },
        {
          id: 'stage2_investment',
          label: '3. What performance investment must you make to prepare for those demands? *',
          type: 'textarea',
          required: true,
          maxLength: 1000,
          placeholder: 'e.g. Hire a VP Operations and install a rigorous executive review rhythm...',
          helpText: 'Capital, talent, or operational governance investments.',
        },
      ],
    },
    {
      stageNumber: 3,
      id: 'stage3',
      title: 'Prepare for Performance',
      moduleTitle: 'Module 3: Capabilities & Standards',
      subtitle: 'Aligning personal founder capabilities, leadership team ownership, and organizational standards.',
      videoId: 4,
      videoKey: 'stage_3',
      thumbnailFileName: 'STAGE-03.jpg',
      reflectionPauseSeconds: 45,
      reflectionPrompt: 'Reflect on the performance capabilities and standards required across Founder, Leadership Team, and Organisation. Record your answers in Stage 3.',
      questions: [
        {
          id: 'stage3_founderStrength',
          label: '1. Founder Capability: What standard must YOU personally elevate? *',
          type: 'textarea',
          required: true,
          maxLength: 1000,
          placeholder: 'e.g. Ruthless calendar discipline and strategic delegation...',
        },
        {
          id: 'stage3_founderStandard',
          label: 'Founder Standard to uphold',
          type: 'text',
          required: false,
          maxLength: 1000,
          placeholder: 'e.g. No meetings without pre-read memos...',
        },
        {
          id: 'stage3_teamStrength',
          label: '2. Leadership Team: What capability must your executives embody? *',
          type: 'textarea',
          required: true,
          maxLength: 1000,
          placeholder: 'e.g. End-to-end accountability without awaiting founder intervention...',
        },
        {
          id: 'stage3_teamStandard',
          label: 'Leadership Team Standard to uphold',
          type: 'text',
          required: false,
          maxLength: 1000,
          placeholder: 'e.g. Metric-backed weekly business reviews...',
        },
        {
          id: 'stage3_orgStrength',
          label: '3. Organisation: What system requires reinforcement? *',
          type: 'textarea',
          required: true,
          maxLength: 1000,
          placeholder: 'e.g. Transparent reporting rhythm and clear delegation thresholds...',
        },
        {
          id: 'stage3_orgInvestment',
          label: 'Organizational Investment needed',
          type: 'text',
          required: false,
          maxLength: 1000,
          placeholder: 'e.g. Executive operating cadence...',
        },
        {
          id: 'stage3_focusArea',
          label: 'Primary focus area across founder, team, and org',
          type: 'text',
          required: false,
          maxLength: 1000,
          placeholder: 'e.g. Elevate executive team autonomy and operational reporting...',
        },
      ],
    },
    {
      stageNumber: 4,
      id: 'stage4',
      title: 'Your Next Move',
      moduleTitle: 'Module 4: Exploration Blueprint & Execution',
      subtitle: 'Transforming reflections into a high-leverage 30-day roadmap and one immediate action within 24 hours.',
      videoId: 5,
      videoKey: 'stage_4',
      thumbnailFileName: 'STAGE-04.jpg',
      reflectionPauseSeconds: 45,
      reflectionPrompt: 'Reflect on your top 30-day preparation priority and the single high-leverage action you will take within 24 hours. Record your answers in Stage 4.',
      questions: [
        {
          id: 'stage4_priority30Days',
          label: '1. What is your main preparation priority for the next 30 days? *',
          type: 'textarea',
          required: true,
          maxLength: 1000,
          placeholder: 'e.g. Structure clear quarterly KPIs and delegate core revenue operations.',
        },
        {
          id: 'stage4_milestone1',
          label: 'Milestone 1: 10-Day progress marker',
          type: 'text',
          required: false,
          maxLength: 1000,
          placeholder: 'Milestone 1: e.g. Executive alignment framework signed off by Day 10',
        },
        {
          id: 'stage4_milestone2',
          label: 'Milestone 2: 20-Day progress marker',
          type: 'text',
          required: false,
          maxLength: 1000,
          placeholder: 'Milestone 2: e.g. Operational handover completed by Day 20',
        },
        {
          id: 'stage4_milestone3',
          label: 'Milestone 3: 30-Day progress marker',
          type: 'text',
          required: false,
          maxLength: 1000,
          placeholder: 'Milestone 3: e.g. Full performance reset review with Lionel by Day 30',
        },
        {
          id: 'stage4_action7Days',
          label: '3. One action within 24 hours *',
          type: 'text',
          required: true,
          maxLength: 1000,
          placeholder: 'e.g. Audit top 3 time bottlenecks',
        },
        {
          id: 'stage4_actionTiming',
          label: '4. When will you take it? *',
          type: 'text',
          required: false,
          maxLength: 1000,
          placeholder: 'e.g. Next Monday morning 9 AM',
        },
        {
          id: 'stage4_evidence',
          label: '5. What evidence will you look for afterward? *',
          type: 'text',
          required: true,
          maxLength: 1000,
          placeholder: 'e.g. 5 hours saved weekly and clear executive team ownership.',
        },
      ],
    },
  ],
};

/**
 * Retrieves dynamic masterclass questions from DB (SystemConfig), fallback to default.
 */
export async function getMasterclassQuestionsConfig(): Promise<any> {
  const now = Date.now();
  if (cachedMasterclassConfig && now - masterclassConfigCacheTime < CONFIG_CACHE_TTL) {
    return cachedMasterclassConfig;
  }

  try {
    const record = await prisma.systemConfig.findUnique({
      where: { key: 'masterclass_config' },
    });

    if (record && record.value) {
      const parsed = JSON.parse(record.value);
      if (parsed && Array.isArray(parsed.stages)) {
        cachedMasterclassConfig = parsed;
        masterclassConfigCacheTime = now;
        return cachedMasterclassConfig;
      }
    }
  } catch (err: any) {
    console.warn('[Masterclass] Failed reading config from DB, falling back to default:', err.message);
  }

  // Auto-seed to DB if not present
  try {
    await prisma.systemConfig.upsert({
      where: { key: 'masterclass_config' },
      update: { value: JSON.stringify(DEFAULT_MASTERCLASS_CONFIG) },
      create: { key: 'masterclass_config', value: JSON.stringify(DEFAULT_MASTERCLASS_CONFIG) },
    });
  } catch (seedErr: any) {
    console.warn('[Masterclass] Non-fatal auto-seed notice:', seedErr.message);
  }

  cachedMasterclassConfig = DEFAULT_MASTERCLASS_CONFIG;
  masterclassConfigCacheTime = now;
  return cachedMasterclassConfig;
}

/**
 * Updates dynamic masterclass questions and settings in database.
 */
export async function updateMasterclassQuestionsConfig(newConfig: any): Promise<any> {
  const mergedConfig = {
    ...DEFAULT_MASTERCLASS_CONFIG,
    ...newConfig,
  };

  const serialized = JSON.stringify(mergedConfig);
  const updated = await prisma.systemConfig.upsert({
    where: { key: 'masterclass_config' },
    update: { value: serialized },
    create: { key: 'masterclass_config', value: serialized },
  });

  cachedMasterclassConfig = JSON.parse(updated.value);
  masterclassConfigCacheTime = Date.now();
  return cachedMasterclassConfig;
}

/**
 * Generates signed URLs for all 6 videos in the 'masterclass' Supabase storage bucket.
 */
export async function getMasterclassVideosList(expiresInSeconds: number = 315360000) {
  const bucketFiles = await getMasterclassBucketFiles();
  const fileNames = bucketFiles.map((f: any) => f.name);

  // Helper for matching candidate filenames
  const findMatch = (candidates: string[], isVideo: boolean = false): string | null => {
    for (const cand of candidates) {
      const exact = fileNames.find((name: string) => name.toLowerCase() === cand.toLowerCase());
      if (exact) return exact;
    }
    // Substring fallback with extension validation
    for (const cand of candidates) {
      const cleanCand = cand.replace(/\.[^/.]+$/, '').toLowerCase().replace(/\s+/g, '');
      const partial = fileNames.find((name: string) => {
        const nameExt = name.slice(name.lastIndexOf('.')).toLowerCase();
        if (isVideo && nameExt !== '.mp4' && nameExt !== '.mov' && nameExt !== '.webm') {
          return false;
        }
        if (!isVideo && (nameExt === '.mp4' || nameExt === '.mov' || nameExt === '.webm')) {
          return false;
        }
        const cleanName = name.replace(/\.[^/.]+$/, '').toLowerCase().replace(/\s+/g, '');
        return cleanName.includes(cleanCand) || cleanCand.includes(cleanName);
      });
      if (partial) return partial;
    }
    return null;
  };

  const slotDefs = [
    {
      id: 1,
      stage: 0,
      stageName: 'Welcome & Introduction',
      title: "Welcome Briefing: The Founder's Next Move",
      subtitle: 'Executive introduction and participant orientation by Lionel Eersteling',
      fileName: 'WELCOME VIDEO.mp4',
      candidates: ['WELCOME VIDEO.mp4', 'WELCOME_VIDEO.mp4', 'Welcome Video.mp4', 'Intro Video.mp4', 'Overview Video.mp4', 'Intro.mp4'],
      fallbackName: 'WELCOME VIDEO.mp4',
      thumbnailFileName: 'WELCOME.jpg',
      thumbnailCandidates: ['WELCOME.jpg', 'WELCOME.png', 'Welcome.jpg', 'welcome.jpg', 'WELCOME_THUMBNAIL.jpg'],
      thumbnailFallback: 'WELCOME.jpg',
    },
    {
      id: 2,
      stage: 1,
      stageName: 'Stage 1',
      title: 'Module 1: Operating System & Shift',
      subtitle: 'Define the next business stage and the foundational strengths required to achieve it',
      fileName: 'STAGE-01.mp4',
      candidates: ['STAGE-01.mp4', 'STAGE -01.mp4', 'STAGE_01.mp4', 'Stage 1.mp4'],
      fallbackName: 'STAGE-01.mp4',
      thumbnailFileName: 'STAGE-01.jpg',
      thumbnailCandidates: ['STAGE-01.jpg', 'STAGE -01.jpg', 'STAGE-01.png', 'STAGE_01.jpg', 'stage-01.jpg'],
      thumbnailFallback: 'STAGE-01.jpg',
    },
    {
      id: 3,
      stage: 2,
      stageName: 'Stage 2',
      title: 'Module 2: Evaluation & Resonance',
      subtitle: 'Success changes the game: analyzing operational demands, scale, and leadership load',
      fileName: 'STAGE-02.mp4',
      candidates: ['STAGE-02.mp4', 'STAGE -02.mp4', 'STAGE_02.mp4', 'Stage 2.mp4'],
      fallbackName: 'STAGE-02.mp4',
      thumbnailFileName: 'STAGE-02.jpg',
      thumbnailCandidates: ['STAGE-02.jpg', 'STAGE -02.jpg', 'STAGE-02.png', 'STAGE_02.jpg', 'stage-02.jpg'],
      thumbnailFallback: 'STAGE-02.jpg',
    },
    {
      id: 4,
      stage: 3,
      stageName: 'Stage 3',
      title: 'Module 3: Capabilities & Standards',
      subtitle: 'Prepare for performance: aligning personal founder capability, executive team, and org',
      fileName: 'STAGE-03.mp4',
      candidates: ['STAGE-03.mp4', 'STAGE -03.mp4', 'STAGE_03.mp4', 'Stage 3.mp4'],
      fallbackName: 'STAGE-03.mp4',
      thumbnailFileName: 'STAGE-03.jpg',
      thumbnailCandidates: ['STAGE-03.jpg', 'STAGE -03.jpg', 'STAGE-03.png', 'STAGE_03.jpg', 'stage-03.jpg'],
      thumbnailFallback: 'STAGE-03.jpg',
    },
    {
      id: 5,
      stage: 4,
      stageName: 'Stage 4',
      title: 'Module 4: Exploration Blueprint & Execution',
      subtitle: 'Turn reflections into 30-day milestones and a single high-leverage 7-day action',
      fileName: 'STAGE-04.mp4',
      candidates: ['STAGE-04.mp4', 'STAGE -04.mp4', 'STAGE_04.mp4', 'Stage 4.mp4'],
      fallbackName: 'STAGE-04.mp4',
      thumbnailFileName: 'STAGE-04.jpg',
      thumbnailCandidates: ['STAGE-04.jpg', 'STAGE -04.jpg', 'STAGE-04.png', 'STAGE_04.jpg', 'stage-04.jpg'],
      thumbnailFallback: 'STAGE-04.jpg',
    },
    {
      id: 6,
      stage: 5,
      stageName: 'Closing & Strategic Review',
      title: 'Closing Video: Strategic Review Preparation',
      subtitle: 'Final reflections briefing and guidelines for your 1-on-1 strategic session with Lionel',
      fileName: 'CLOSING VIDEO.mp4',
      candidates: ['CLOSING VIDEO.mp4', 'Closing Video.mp4', 'CLOSING_VIDEO.mp4', 'Closing Video (1).mp4', 'Closing.mp4', 'STAGE-05.mp4'],
      fallbackName: 'CLOSING VIDEO.mp4',
      thumbnailFileName: 'CLOSING.jpg',
      thumbnailCandidates: ['CLOSING.jpg', 'CLOSING.png', 'Closing.jpg', 'Closing.png', 'closing.jpg', 'STAGE-05.jpg'],
      thumbnailFallback: 'CLOSING.jpg',
    },
  ];

  const videos = await Promise.all(
    slotDefs.map(async (slot) => {
      const matchedFileName = findMatch(slot.candidates, true);
      const targetFile = matchedFileName || slot.fallbackName;
      let signedUrl: string | null = null;
      let isAvailable = false;

      if (matchedFileName) {
        signedUrl = await createMasterclassSignedUrl(matchedFileName, expiresInSeconds);
        isAvailable = Boolean(signedUrl);
      }

      // Generate signed thumbnail URL
      const matchedThumbnailName = findMatch(slot.thumbnailCandidates, false);
      const targetThumbnail = matchedThumbnailName || slot.thumbnailFallback;
      let thumbnailUrl: string | null = null;
      let hasThumbnail = false;

      if (matchedThumbnailName) {
        thumbnailUrl = await createMasterclassSignedUrl(matchedThumbnailName, expiresInSeconds);
        hasThumbnail = Boolean(thumbnailUrl);
      }

      const fileMeta = bucketFiles.find((f: any) => f.name === matchedFileName);
      const thumbMeta = bucketFiles.find((f: any) => f.name === matchedThumbnailName);

      return {
        id: slot.id,
        stage: slot.stage,
        stageName: slot.stageName,
        title: slot.title,
        subtitle: slot.subtitle,
        fileName: targetFile,
        isAvailable,
        signedUrl,
        thumbnailFileName: targetThumbnail,
        thumbnailUrl,
        thumbnail: thumbnailUrl, // Convenient alias for frontend
        hasThumbnail,
        reflectionPauseSeconds: slot.stage >= 1 && slot.stage <= 4 ? 45 : 0,
        sizeBytes: fileMeta?.metadata?.size || undefined,
        updatedAt: fileMeta?.updated_at || undefined,
        thumbnailSizeBytes: thumbMeta?.metadata?.size || undefined,
      };
    })
  );

  // Fallback missing signed URLs to first available video stream so all 6 catalog slots are playable
  const firstAvailable = videos.find((v) => v.isAvailable && v.signedUrl);
  if (firstAvailable && firstAvailable.signedUrl) {
    videos.forEach((v) => {
      if (!v.signedUrl) {
        v.signedUrl = firstAvailable.signedUrl;
        v.isAvailable = true;
      }
    });
  }

  return videos;
}

/**
 * Returns dynamic configuration, questions for all 4 stages, and private video & thumbnail URLs.
 * Recognizes user if email is supplied.
 */
export async function getMasterclassAppConfig(email?: string) {
  // 1. Fetch dynamic questions from DB
  const questionsConfig = await getMasterclassQuestionsConfig();

  // 2. Fetch 6 private signed video and thumbnail URLs
  const videos = await getMasterclassVideosList();

  // 3. Map thumbnail signed URLs onto stages for direct access
  const enrichedStages = (questionsConfig.stages || []).map((stage: any) => {
    const stageVideo = videos.find((v) => v.stage === stage.stageNumber);
    return {
      ...stage,
      thumbnailFileName: stage.thumbnailFileName || stageVideo?.thumbnailFileName,
      thumbnailUrl: stageVideo?.thumbnailUrl || null,
      thumbnail: stageVideo?.thumbnailUrl || null,
      videoUrl: stageVideo?.signedUrl || null,
    };
  });

  const welcomeVideo = videos.find((v) => v.id === 1) || null;
  const closingVideo = videos.find((v) => v.id === 6) || null;

  const thumbnails = {
    welcome: welcomeVideo?.thumbnailUrl || null,
    stage1: videos.find((v) => v.id === 2)?.thumbnailUrl || null,
    stage2: videos.find((v) => v.id === 3)?.thumbnailUrl || null,
    stage3: videos.find((v) => v.id === 4)?.thumbnailUrl || null,
    stage4: videos.find((v) => v.id === 5)?.thumbnailUrl || null,
    closing: closingVideo?.thumbnailUrl || null,
  };

  // 4. User check if email provided
  if (email && email.trim()) {
    const normalizedEmail = email.trim().toLowerCase();
    const enrollment = await prisma.masterclassEnrollment.findFirst({
      where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
      include: {
        submissions: {
          orderBy: { updatedAt: 'desc' },
          take: 1,
        },
        bookings: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    if (enrollment) {
      const isPaid = enrollment.paymentStatus === 'paid';
      const accessGranted = enrollment.accessGranted || isPaid;

      let latestSubmission = enrollment.submissions[0] || null;
      if (!latestSubmission) {
        latestSubmission = await prisma.masterclassWorkbookSubmission.findFirst({
          where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
          orderBy: { updatedAt: 'desc' },
        });
      }

      let draftData = null;
      if (latestSubmission) {
        try {
          draftData = {
            submissionRef: latestSubmission.submissionRef,
            status: latestSubmission.status,
            currentStage: latestSubmission.currentStage,
            lastSavedAt: latestSubmission.lastSavedAt,
            formData: JSON.parse(latestSubmission.formData),
            personalNotes: latestSubmission.personalNotes ? JSON.parse(latestSubmission.personalNotes) : {},
          };
        } catch {
          draftData = {
            submissionRef: latestSubmission.submissionRef,
            status: latestSubmission.status,
            currentStage: latestSubmission.currentStage,
            lastSavedAt: latestSubmission.lastSavedAt,
          };
        }
      }

      return {
        success: true,
        userExists: true,
        isEnrolled: true,
        hasPaid: isPaid,
        accessGranted,
        paymentStatus: enrollment.paymentStatus,
        token: enrollment.sessionToken,
        user: {
          id: enrollment.id,
          email: enrollment.email,
          fullName: enrollment.fullName,
          company: enrollment.company,
          role: enrollment.role,
          phone: enrollment.phone,
          courseProgress: enrollment.courseProgress,
          currentStage: enrollment.currentStage,
          paidAt: enrollment.paidAt,
        },
        draft: draftData,
        booking: enrollment.bookings[0]
          ? {
            bookingRef: enrollment.bookings[0].bookingRef,
            slotTime: enrollment.bookings[0].slotTime,
            timezone: enrollment.bookings[0].timezone,
            status: enrollment.bookings[0].status,
          }
          : null,
        videos,
        thumbnails,
        welcomeVideo,
        closingVideo,
        ...questionsConfig,
        stages: enrichedStages,
      };
    }

    // Email provided but not found in DB
    return {
      success: true,
      userExists: false,
      isEnrolled: false,
      hasPaid: false,
      accessGranted: false,
      user: null,
      message: 'Participant email not found in masterclass records. Proceed to enrollment checkout.',
      videos,
      thumbnails,
      welcomeVideo,
      closingVideo,
      ...questionsConfig,
      stages: enrichedStages,
    };
  }

  // General config request without email
  return {
    success: true,
    userExists: false,
    isEnrolled: false,
    hasPaid: false,
    accessGranted: false,
    videos,
    thumbnails,
    welcomeVideo,
    closingVideo,
    ...questionsConfig,
    stages: enrichedStages,
  };
}

/**
 * =========================================================================
 * 10. BACKEND WORKBOOK REVIEW DOSSIER RESOLVER & EXECUTIVE UI GENERATOR
 * =========================================================================
 */

export interface WorksheetReviewDossier {
  submission: any;
  booking: any;
  enrollment: any;
  recentSubmissions: any[];
  searchRef: string;
  found: boolean;
}

export async function getWorksheetReviewDossier(refOrQuery?: string): Promise<WorksheetReviewDossier> {
  const searchRef = (refOrQuery || '').trim();

  let submission: any = null;
  let booking: any = null;
  let enrollment: any = null;

  if (searchRef) {
    const isEmail = searchRef.includes('@');

    // 1. Try finding workbook submission by submissionRef, id, or email
    try {
      submission = await prisma.masterclassWorkbookSubmission.findFirst({
        where: {
          OR: [
            { submissionRef: searchRef },
            { id: searchRef },
            ...(isEmail ? [{ email: { equals: searchRef, mode: 'insensitive' } }] : []),
          ],
        },
        include: {
          bookings: { orderBy: { createdAt: 'desc' } },
          enrollment: true,
        },
        orderBy: { updatedAt: 'desc' },
      });
    } catch (err: any) {
      console.warn('[Review Dossier] Error querying submission:', err.message);
    }

    // 2. Try finding booking by bookingRef, id, or email
    try {
      booking = await prisma.masterclassBooking.findFirst({
        where: {
          OR: [
            { bookingRef: searchRef },
            { id: searchRef },
            ...(isEmail ? [{ email: { equals: searchRef, mode: 'insensitive' } }] : []),
          ],
        },
        include: {
          submission: true,
          enrollment: true,
        },
        orderBy: { createdAt: 'desc' },
      });
    } catch (err: any) {
      console.warn('[Review Dossier] Error querying booking:', err.message);
    }

    // Cross-link if one was found but not the other
    if (!submission && booking) {
      if (booking.submission) {
        submission = booking.submission;
      } else if (booking.submissionId) {
        submission = await prisma.masterclassWorkbookSubmission.findUnique({
          where: { id: booking.submissionId },
          include: { enrollment: true, bookings: true },
        });
      } else if (booking.email) {
        submission = await prisma.masterclassWorkbookSubmission.findFirst({
          where: { email: { equals: booking.email, mode: 'insensitive' } },
          include: { enrollment: true, bookings: true },
          orderBy: { updatedAt: 'desc' },
        });
      }
    }

    if (!booking && submission) {
      if (submission.bookings && submission.bookings.length > 0) {
        booking = submission.bookings[0];
      } else {
        booking = await prisma.masterclassBooking.findFirst({
          where: {
            OR: [
              { submissionId: submission.id },
              { email: { equals: submission.email, mode: 'insensitive' } },
            ],
          },
          orderBy: { createdAt: 'desc' },
        });
      }
    }

    if (submission?.enrollment) {
      enrollment = submission.enrollment;
    } else if (booking?.enrollment) {
      enrollment = booking.enrollment;
    } else if (submission?.email || booking?.email) {
      const targetEmail = submission?.email || booking?.email;
      enrollment = await prisma.masterclassEnrollment.findFirst({
        where: { email: { equals: targetEmail, mode: 'insensitive' } },
      });
    }
  }

  // Fetch recent submissions for navigation / directory
  let recentSubmissions: any[] = [];
  try {
    recentSubmissions = await prisma.masterclassWorkbookSubmission.findMany({
      take: 20,
      orderBy: { createdAt: 'desc' },
      include: {
        bookings: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
  } catch (err: any) {
    console.warn('[Review Dossier] Error querying recent submissions:', err.message);
  }

  // If no ref was given, default to the most recent submission if available
  if (!searchRef && recentSubmissions.length > 0 && !submission) {
    submission = recentSubmissions[0];
    if (submission.bookings && submission.bookings.length > 0) {
      booking = submission.bookings[0];
    }
  }

  // Parse JSON formData and personalNotes if stringified
  if (submission) {
    if (typeof submission.formData === 'string') {
      try {
        submission.formData = JSON.parse(submission.formData);
      } catch { }
    }
    if (typeof submission.personalNotes === 'string') {
      try {
        submission.personalNotes = JSON.parse(submission.personalNotes);
      } catch { }
    }
  }

  return {
    submission,
    booking,
    enrollment,
    recentSubmissions,
    searchRef,
    found: Boolean(submission || booking),
  };
}

export function renderWorksheetReviewHtml(searchRef: string, dossier: WorksheetReviewDossier): string {
  const { submission, booking, recentSubmissions, found } = dossier;

  const fullName = submission?.fullName || booking?.fullName || 'Masterclass Participant';
  const company = submission?.company || booking?.company || 'Organization';
  const role = submission?.role || 'Executive';
  const email = submission?.email || booking?.email || '';
  const phone = submission?.phone || 'Not provided';
  const submissionRef = submission?.submissionRef || 'FNM-VERIFIED';
  const bookingRef = booking?.bookingRef || (submission?.bookings?.[0]?.bookingRef || 'Pending Booking');
  
  let formattedSubmittedDate = 'Recently submitted';
  if (submission?.submittedAt) {
    try {
      const d = new Date(submission.submittedAt);
      formattedSubmittedDate = d.toLocaleString('en-US', {
        timeZone: 'Asia/Dubai',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }) + ' GST (Dubai)';
    } catch {
      formattedSubmittedDate = String(submission.submittedAt);
    }
  }

  const f = submission?.formData || {};
  const notes = submission?.personalNotes || {};

  const replyMailto = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(
    `Strategic Review Dossier: ${fullName} (${submissionRef})`
  )}`;

  const renderDossierField = (questionNumber: string, title: string, value: any) => {
    const textVal = value !== null && value !== undefined ? String(value).trim() : '';
    const hasValue = textVal.length > 0;
    return `
      <div class="qa-item ${hasValue ? '' : 'qa-empty'}">
        <div class="qa-header">
          <span class="qa-num">${escapeHtml(questionNumber)}</span>
          <span class="qa-title">${escapeHtml(title)}</span>
        </div>
        <div class="qa-body">
          ${hasValue ? escapeHtml(textVal) : '<span class="qa-placeholder">No response recorded</span>'}
        </div>
      </div>
    `;
  };

  // Standard keys used in stages 1 to 4
  const standardFieldKeys = new Set([
    'stage1_nextStage', 'stage1_possibility', 'stage1_strength',
    'stage2_changes', 'stage2_demand1', 'stage2_demand2', 'stage2_demand3', 'stage2_investment',
    'stage3_founderStrength', 'stage3_founderStandard', 'stage3_teamStrength', 'stage3_teamStandard',
    'stage3_orgStrength', 'stage3_orgInvestment', 'stage3_focusArea',
    'stage4_priority90Days', 'stage4_milestone1', 'stage4_milestone2', 'stage4_milestone3',
    'stage4_action7Days', 'stage4_actionTiming', 'stage4_evidence',
  ]);

  let extraFieldsHtml = '';
  if (f && typeof f === 'object') {
    for (const [k, v] of Object.entries(f)) {
      if (!standardFieldKeys.has(k) && v !== null && v !== undefined && String(v).trim()) {
        const cleanLabel = k.replace(/([A-Z])/g, ' $1').replace(/[_-]/g, ' ').trim();
        extraFieldsHtml += renderDossierField('•', cleanLabel, v);
      }
    }
  }

  let notesHtml = '';
  if (notes && typeof notes === 'object') {
    for (const [k, v] of Object.entries(notes)) {
      if (v !== null && v !== undefined && String(v).trim()) {
        const cleanLabel = k.replace(/([A-Z])/g, ' $1').replace(/[_-]/g, ' ').trim();
        notesHtml += renderDossierField('📝', `Note: ${cleanLabel}`, v);
      }
    }
  }

  // Directory of recent submissions options
  const recentRowsHtml = (recentSubmissions || [])
    .slice(0, 10)
    .map((sub: any) => {
      const active = sub.submissionRef === submissionRef ? 'directory-item-active' : '';
      const bRef = sub.bookings?.[0]?.bookingRef || 'No Booking';
      return `
        <a href="/masterclass/review/${encodeURIComponent(sub.submissionRef)}" class="directory-row ${active}">
          <div class="dir-name">${escapeHtml(sub.fullName || 'Participant')}</div>
          <div class="dir-company">${escapeHtml(sub.company || '—')}</div>
          <div class="dir-refs">
            <span class="ref-tag">${escapeHtml(sub.submissionRef)}</span>
            <span class="ref-tag ref-tag-booking">${escapeHtml(bRef)}</span>
          </div>
        </a>
      `;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WorkSheet Review Dossier · ${escapeHtml(fullName)} · Leaders Performance</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Playfair+Display:ital,wght@0,400;0,600;0,700;1,400&display=swap" rel="stylesheet">
  <style>
    :root {
      --navy-950: #010d20;
      --navy-900: #021329;
      --navy-800: #0a1f3a;
      --navy-700: #142d50;
      --gold-500: #d0a35a;
      --gold-600: #9f6511;
      --gold-400: #e5be78;
      --gold-100: #fbf5eb;
      --sand-50: #fbf8f2;
      --sand-100: #f2ede3;
      --sand-200: #ebe4db;
      --sand-300: #dacfc1;
      --slate-900: #1b2637;
      --slate-700: #334155;
      --slate-600: #4a5568;
      --slate-500: #64748b;
      --slate-400: #94a3b8;
      --green-600: #059669;
      --green-100: #d1fae5;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--sand-100);
      color: var(--slate-900);
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      font-size: 15px;
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
      padding-bottom: 80px;
    }

    /* Executive Top Navigation */
    .topbar {
      background-color: var(--navy-900);
      border-bottom: 1px solid var(--gold-500);
      padding: 14px 28px;
      position: sticky;
      top: 0;
      z-index: 100;
      box-shadow: 0 4px 16px rgba(1, 13, 32, 0.25);
    }

    .topbar-content {
      max-width: 1200px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      flex-wrap: wrap;
    }

    .brand-section {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .brand-logo {
      display: block;
      height: 38px;
      width: auto;
    }

    .brand-divider {
      width: 1px;
      height: 28px;
      background-color: rgba(208, 163, 90, 0.4);
    }

    .brand-badge {
      font-family: 'Inter', sans-serif;
      font-size: 11px;
      letter-spacing: 1.4px;
      text-transform: uppercase;
      font-weight: 600;
      color: var(--gold-400);
    }

    .topbar-controls {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }

    .search-box {
      display: flex;
      align-items: center;
      background-color: var(--navy-950);
      border: 1px solid rgba(208, 163, 90, 0.5);
      border-radius: 4px;
      overflow: hidden;
    }

    .search-box input {
      background: transparent;
      border: none;
      color: #fff;
      padding: 8px 12px;
      font-size: 13px;
      font-family: 'Inter', sans-serif;
      outline: none;
      width: 210px;
    }

    .search-box input::placeholder {
      color: var(--slate-400);
    }

    .search-box button {
      background-color: var(--gold-500);
      color: var(--navy-950);
      border: none;
      padding: 8px 14px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.5px;
      cursor: pointer;
      transition: background-color 0.15s ease;
    }

    .search-box button:hover {
      background-color: #dfb26b;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-family: 'Inter', sans-serif;
      font-size: 13px;
      font-weight: 500;
      line-height: 1.2;
      padding: 9px 16px;
      border-radius: 3px;
      text-decoration: none;
      cursor: pointer;
      transition: all 0.15s ease;
      white-space: nowrap;
    }

    .btn-gold {
      background-color: var(--gold-500);
      border: 1px solid var(--gold-500);
      color: var(--navy-950);
      font-weight: 600;
    }

    .btn-gold:hover {
      background-color: #dfb26b;
      box-shadow: 0 2px 8px rgba(208, 163, 90, 0.35);
    }

    .btn-outline-gold {
      background-color: transparent;
      border: 1px solid var(--gold-500);
      color: var(--gold-400);
    }

    .btn-outline-gold:hover {
      background-color: rgba(208, 163, 90, 0.12);
      color: #fff;
    }

    .btn-navy {
      background-color: var(--navy-800);
      border: 1px solid rgba(255, 255, 255, 0.15);
      color: #fff;
    }

    .btn-navy:hover {
      background-color: var(--navy-700);
    }

    /* Main Container */
    .container {
      max-width: 1120px;
      margin: 36px auto 0;
      padding: 0 20px;
    }

    /* Hero Header */
    .hero-header {
      background-color: #fff;
      border: 1px solid var(--sand-200);
      border-radius: 4px;
      padding: 36px 40px;
      margin-bottom: 28px;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.03);
      position: relative;
    }

    .hero-eyebrow {
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 1.4px;
      text-transform: uppercase;
      color: var(--gold-600);
      margin-bottom: 10px;
    }

    .hero-title {
      font-family: 'Playfair Display', Georgia, serif;
      font-size: 36px;
      line-height: 1.2;
      font-weight: 400;
      color: var(--slate-900);
      margin-bottom: 8px;
    }

    .hero-subtitle {
      font-size: 16px;
      color: var(--slate-600);
      margin-bottom: 22px;
    }

    .badge-bar {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.4px;
      padding: 5px 12px;
      border-radius: 3px;
      text-transform: uppercase;
    }

    .badge-verified {
      background-color: var(--green-100);
      color: var(--green-600);
      border: 1px solid rgba(5, 150, 105, 0.3);
    }

    .badge-pulse {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background-color: var(--green-600);
      box-shadow: 0 0 0 0 rgba(5, 150, 105, 0.7);
      animation: pulse 1.8s infinite;
    }

    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 rgba(5, 150, 105, 0.7); }
      70% { box-shadow: 0 0 0 6px rgba(5, 150, 105, 0); }
      100% { box-shadow: 0 0 0 0 rgba(5, 150, 105, 0); }
    }

    .badge-booking {
      background-color: var(--gold-100);
      color: var(--gold-600);
      border: 1px solid rgba(159, 101, 17, 0.3);
    }

    .badge-gray {
      background-color: #f1f5f9;
      color: var(--slate-600);
      border: 1px solid #cbd5e1;
    }

    /* 2-Column Coordinates Grid */
    .grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
      margin-bottom: 32px;
    }

    @media (max-width: 860px) {
      .grid-2 {
        grid-template-columns: 1fr;
      }
    }

    .card {
      background-color: var(--sand-50);
      border: 1px solid var(--sand-200);
      border-radius: 4px;
      padding: 28px 30px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.02);
    }

    .card-header {
      border-bottom: 1px solid var(--sand-200);
      padding-bottom: 14px;
      margin-bottom: 18px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .card-title {
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 1.2px;
      text-transform: uppercase;
      color: var(--gold-600);
    }

    .coord-table {
      width: 100%;
      border-collapse: collapse;
    }

    .coord-table tr {
      border-bottom: 1px solid var(--sand-200);
    }

    .coord-table tr:last-child {
      border-bottom: none;
    }

    .coord-table td {
      padding: 11px 0;
      vertical-align: top;
    }

    .coord-label {
      width: 140px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.8px;
      text-transform: uppercase;
      color: var(--slate-500);
    }

    .coord-value {
      font-size: 14.5px;
      font-weight: 500;
      color: var(--slate-900);
    }

    .ref-code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-weight: 600;
      background-color: #fff;
      border: 1px solid var(--sand-300);
      padding: 3px 8px;
      border-radius: 3px;
      font-size: 13.5px;
      color: var(--navy-900);
      letter-spacing: 0.5px;
      display: inline-block;
    }

    .meeting-box {
      background-color: #fff;
      border: 1px solid var(--gold-500);
      border-left: 4px solid var(--gold-500);
      border-radius: 4px;
      padding: 16px 18px;
      margin-top: 14px;
    }

    .meeting-box-title {
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 1.2px;
      text-transform: uppercase;
      color: var(--gold-600);
      margin-bottom: 8px;
    }

    .meeting-creds {
      font-size: 13.5px;
      line-height: 1.7;
      color: var(--slate-700);
      margin-bottom: 12px;
    }

    .meeting-creds strong {
      color: var(--slate-900);
      font-family: ui-monospace, SFMono-Regular, monospace;
    }

    /* Stage Sections */
    .stage-card {
      background-color: #fff;
      border: 1px solid var(--sand-200);
      border-radius: 4px;
      margin-bottom: 28px;
      overflow: hidden;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.02);
    }

    .stage-card-header {
      background-color: var(--sand-50);
      border-bottom: 1px solid var(--sand-200);
      padding: 20px 28px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }

    .stage-tag {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 1.4px;
      text-transform: uppercase;
      color: var(--gold-600);
      background-color: var(--gold-100);
      border: 1px solid rgba(159, 101, 17, 0.3);
      padding: 4px 10px;
      border-radius: 3px;
    }

    .stage-title {
      font-family: 'Playfair Display', Georgia, serif;
      font-size: 21px;
      font-weight: 600;
      color: var(--slate-900);
      flex-grow: 1;
    }

    .stage-content {
      padding: 24px 28px;
    }

    .qa-item {
      margin-bottom: 22px;
      padding-bottom: 22px;
      border-bottom: 1px solid var(--sand-200);
    }

    .qa-item:last-child {
      margin-bottom: 0;
      padding-bottom: 0;
      border-bottom: none;
    }

    .qa-header {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 10px;
    }

    .qa-num {
      font-size: 12px;
      font-weight: 700;
      color: var(--gold-600);
      letter-spacing: 0.5px;
    }

    .qa-title {
      font-size: 13.5px;
      font-weight: 600;
      color: var(--slate-900);
      letter-spacing: 0.2px;
    }

    .qa-body {
      background-color: var(--sand-50);
      border: 1px solid var(--sand-200);
      border-left: 3px solid var(--gold-500);
      border-radius: 0 4px 4px 0;
      padding: 14px 18px;
      font-size: 15px;
      line-height: 1.6;
      color: var(--slate-900);
      white-space: pre-wrap;
    }

    .qa-placeholder {
      color: var(--slate-400);
      font-style: italic;
    }

    /* Personal Notes Banner */
    .notes-card {
      background-color: var(--sand-200);
      border: 1px solid var(--sand-300);
      border-left: 4px solid var(--gold-600);
      border-radius: 4px;
      padding: 28px 30px;
      margin-bottom: 28px;
    }

    .notes-eyebrow {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 1.4px;
      text-transform: uppercase;
      color: var(--gold-600);
      margin-bottom: 12px;
    }

    /* Directory Drawer */
    .directory-panel {
      background-color: #fff;
      border: 1px solid var(--sand-200);
      border-radius: 4px;
      padding: 24px;
      margin-top: 36px;
    }

    .directory-title {
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 1.2px;
      text-transform: uppercase;
      color: var(--gold-600);
      margin-bottom: 16px;
      border-bottom: 1px solid var(--sand-200);
      padding-bottom: 8px;
    }

    .directory-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 12px;
    }

    .directory-row {
      display: block;
      padding: 12px 14px;
      background-color: var(--sand-50);
      border: 1px solid var(--sand-200);
      border-radius: 4px;
      text-decoration: none;
      color: inherit;
      transition: all 0.15s ease;
    }

    .directory-row:hover {
      background-color: #fff;
      border-color: var(--gold-500);
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.05);
    }

    .directory-item-active {
      background-color: #fff;
      border-color: var(--gold-500);
      border-left: 3px solid var(--gold-500);
    }

    .dir-name {
      font-weight: 600;
      font-size: 14px;
      color: var(--slate-900);
    }

    .dir-company {
      font-size: 12.5px;
      color: var(--slate-600);
      margin-bottom: 6px;
    }

    .dir-refs {
      display: flex;
      gap: 6px;
      font-size: 11px;
    }

    .ref-tag {
      background-color: #fff;
      border: 1px solid var(--sand-300);
      padding: 2px 6px;
      border-radius: 2px;
      font-family: ui-monospace, SFMono-Regular, monospace;
      color: var(--slate-700);
    }

    .ref-tag-booking {
      background-color: var(--gold-100);
      color: var(--gold-600);
      border-color: rgba(159, 101, 17, 0.3);
    }

    /* Print Styles */
    @media print {
      body {
        background-color: #fff;
        padding-bottom: 0;
      }
      .topbar, .topbar-controls, .search-box, .btn, .directory-panel {
        display: none !important;
      }
      .container {
        max-width: 100%;
        margin: 0;
        padding: 0;
      }
      .hero-header, .card, .stage-card {
        box-shadow: none;
        border: 1px solid #ccc;
        page-break-inside: avoid;
      }
      .qa-body {
        background-color: #fafafa;
      }
    }
  </style>
</head>
<body>

  <!-- Top Executive Bar -->
  <header class="topbar">
    <div class="topbar-content">
      <div class="brand-section">
        <a href="https://leadersperformance.ae" target="_blank">
          <img src="https://leadersperformance.ae/assets/home/logo-gold.png" alt="Leaders Performance" class="brand-logo">
        </a>
        <div class="brand-divider"></div>
        <div class="brand-badge">Lionel Eersteling · Executive Review</div>
      </div>

      <div class="topbar-controls">
        <form class="search-box" action="/masterclass/review" method="GET">
          <input type="text" name="ref" placeholder="Search Ref, Booking, Email..." value="${escapeHtml(searchRef || '')}">
          <button type="submit">Look Up</button>
        </form>

        <button onclick="window.print()" class="btn btn-navy">
          🖨️ Print Dossier
        </button>

        ${
          email
            ? `<a href="${replyMailto}" class="btn btn-outline-gold">
                ✉️ Email Founder
              </a>`
            : ''
        }

        <a href="${escapeHtml(LIONEL_MEETING_ROOM.url)}" target="_blank" class="btn btn-gold">
          🎥 Launch Zoom Meeting
        </a>
      </div>
    </div>
  </header>

  <main class="container">

    ${
      !found && searchRef
        ? `
      <div class="hero-header" style="border-left: 4px solid #ef4444;">
        <div class="hero-eyebrow" style="color:#b91c1c;">REFERENCE LOOKUP NOTICE</div>
        <h1 class="hero-title">WorkSheet Record Not Found</h1>
        <p class="hero-subtitle">
          No WorkSheet submission or booking matched reference <code>"${escapeHtml(searchRef)}"</code>.
          Please verify the reference code or select from the recent verified submissions below.
        </p>
      </div>
    `
        : ''
    }

    <!-- Hero Header -->
    <section class="hero-header">
      <div class="hero-eyebrow">THE FOUNDER’S NEXT MOVE · EXECUTIVE MASTERCLASS</div>
      <h1 class="hero-title">${escapeHtml(fullName)}</h1>
      <div class="hero-subtitle">
        ${escapeHtml(role)} at <strong>${escapeHtml(company)}</strong> · Submitted ${escapeHtml(formattedSubmittedDate)}
      </div>

      <div class="badge-bar">
        <span class="badge badge-verified">
          <span class="badge-pulse"></span>
          Verified 4-Stage WorkSheet
        </span>
        <span class="badge badge-booking">
          ${booking?.slotTime ? 'Strategic Review Booked' : 'Awaiting Slot Booking'}
        </span>
        <span class="badge badge-gray">
          Ref: ${escapeHtml(submissionRef)}
        </span>
        ${
          bookingRef && bookingRef !== 'Pending Booking'
            ? `<span class="badge badge-gray">Booking: ${escapeHtml(bookingRef)}</span>`
            : ''
        }
      </div>
    </section>

    <!-- Coordinates Grid -->
    <section class="grid-2">
      <!-- Card 1: Participant Coordinates -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">Participant Coordinates</div>
          <span class="badge badge-verified">Verified</span>
        </div>
        <table class="coord-table">
          <tr>
            <td class="coord-label">Full Name</td>
            <td class="coord-value">${escapeHtml(fullName)}</td>
          </tr>
          <tr>
            <td class="coord-label">Company</td>
            <td class="coord-value">${escapeHtml(company)}</td>
          </tr>
          <tr>
            <td class="coord-label">Executive Role</td>
            <td class="coord-value">${escapeHtml(role)}</td>
          </tr>
          <tr>
            <td class="coord-label">Email Address</td>
            <td class="coord-value">
              <a href="mailto:${escapeHtml(email)}" style="color:var(--slate-900);text-decoration:underline;">${escapeHtml(email)}</a>
            </td>
          </tr>
          <tr>
            <td class="coord-label">Phone / WhatsApp</td>
            <td class="coord-value">${escapeHtml(phone)}</td>
          </tr>
          <tr>
            <td class="coord-label">WorkSheet Ref</td>
            <td class="coord-value">
              <span class="ref-code">${escapeHtml(submissionRef)}</span>
            </td>
          </tr>
        </table>
      </div>

      <!-- Card 2: 1-on-1 Strategic Review Appointment -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">1-on-1 Strategic Review</div>
          <span class="badge ${booking?.slotTime ? 'badge-booking' : 'badge-gray'}">
            ${booking?.slotTime ? 'Confirmed' : 'Pending'}
          </span>
        </div>
        <table class="coord-table">
          <tr>
            <td class="coord-label">Confirmed Slot</td>
            <td class="coord-value" style="font-weight:600;color:var(--navy-900);">
              ${escapeHtml(booking?.slotTime || 'Participant has not selected slot yet')}
            </td>
          </tr>
          <tr>
            <td class="coord-label">Time Zone</td>
            <td class="coord-value">${escapeHtml(booking?.timezone || 'GST (UTC+4)')}</td>
          </tr>
          <tr>
            <td class="coord-label">Duration</td>
            <td class="coord-value">45 Minutes (Private Strategic Review with Lionel)</td>
          </tr>
          <tr>
            <td class="coord-label">Booking Ref</td>
            <td class="coord-value">
              <span class="ref-code">${escapeHtml(bookingRef)}</span>
            </td>
          </tr>
        </table>

        <!-- Meeting Room Details -->
        <div class="meeting-box">
          <div class="meeting-box-title">Lionel Eersteling's Private Meeting Room</div>
          <div class="meeting-creds">
            <div>Meeting ID: <strong>${escapeHtml(LIONEL_MEETING_ROOM.meetingId)}</strong></div>
            <div>Passcode: <strong>${escapeHtml(LIONEL_MEETING_ROOM.passcode)}</strong></div>
          </div>
          <a href="${escapeHtml(LIONEL_MEETING_ROOM.url)}" target="_blank" class="btn btn-gold" style="width:100%;justify-content:center;">
            Open Zoom Meeting Room&nbsp;&nbsp;&rarr;
          </a>
        </div>
      </div>
    </section>

    <!-- STAGE 1 -->
    <article class="stage-card">
      <header class="stage-card-header">
        <span class="stage-tag">Stage 1</span>
        <h2 class="stage-title">Define the Next Stage</h2>
      </header>
      <div class="stage-content">
        ${renderDossierField('1.', 'The Next Stage of Growth You Are Moving Toward', f.stage1_nextStage)}
        ${renderDossierField('2.', 'What Reaching This Stage Makes Possible', f.stage1_possibility)}
        ${renderDossierField('3.', 'Core Strength That Got You Here That Must Be Carried Through', f.stage1_strength)}
      </div>
    </article>

    <!-- STAGE 2 -->
    <article class="stage-card">
      <header class="stage-card-header">
        <span class="stage-tag">Stage 2</span>
        <h2 class="stage-title">Success Changes the Game</h2>
      </header>
      <div class="stage-content">
        ${renderDossierField('1.', 'What Changes Most as You Move to the Next Stage', f.stage2_changes)}
        ${renderDossierField('2A.', 'Demand 1: Leadership & Strategic Vision', f.stage2_demand1)}
        ${renderDossierField('2B.', 'Demand 2: Team, Delegation & Accountability', f.stage2_demand2)}
        ${renderDossierField('2C.', 'Demand 3: Pace, Governance & Capital Discipline', f.stage2_demand3)}
        ${renderDossierField('3.', 'The Critical Performance Investment Required', f.stage2_investment)}
      </div>
    </article>

    <!-- STAGE 3 -->
    <article class="stage-card">
      <header class="stage-card-header">
        <span class="stage-tag">Stage 3</span>
        <h2 class="stage-title">Prepare for Performance</h2>
      </header>
      <div class="stage-content">
        ${renderDossierField('1A.', 'Founder Capability to Elevate', f.stage3_founderStrength)}
        ${renderDossierField('1B.', 'Founder Standard to Uphold', f.stage3_founderStandard)}
        ${renderDossierField('2A.', 'Leadership Team Capability to Elevate', f.stage3_teamStrength)}
        ${renderDossierField('2B.', 'Leadership Team Standard to Uphold', f.stage3_teamStandard)}
        ${renderDossierField('3A.', 'Organisational System to Reinforce', f.stage3_orgStrength)}
        ${renderDossierField('3B.', 'Organisational Investment Needed', f.stage3_orgInvestment)}
        ${renderDossierField('3C.', 'Primary Performance Focus Area', f.stage3_focusArea)}
      </div>
    </article>

    <!-- STAGE 4 -->
    <article class="stage-card">
      <header class="stage-card-header">
        <span class="stage-tag">Stage 4</span>
        <h2 class="stage-title">Your Next Move</h2>
      </header>
      <div class="stage-content">
        ${renderDossierField('1.', 'Main Preparation Priority for the Next 90 Days', f.stage4_priority90Days)}
        ${renderDossierField('•', '30-Day Milestone Marker', f.stage4_milestone1)}
        ${renderDossierField('•', '60-Day Milestone Marker', f.stage4_milestone2)}
        ${renderDossierField('•', '90-Day Milestone Marker', f.stage4_milestone3)}
        ${renderDossierField('2.', 'Single Decisive Action to Take Within 7 Days', f.stage4_action7Days)}
        ${renderDossierField('•', 'When and How This Action Will Be Taken', f.stage4_actionTiming)}
        ${renderDossierField('•', 'Evidence to Look For Afterward That Proves Traction', f.stage4_evidence)}
      </div>
    </article>

    ${
      notesHtml
        ? `
      <!-- Personal Reflections & Notes -->
      <section class="notes-card">
        <div class="notes-eyebrow">PARTICIPANT REFLECTIONS &amp; PERSONAL NOTES</div>
        ${notesHtml}
      </section>
    `
        : ''
    }

    ${
      extraFieldsHtml
        ? `
      <!-- Additional Responses -->
      <article class="stage-card">
        <header class="stage-card-header">
          <span class="stage-tag">Addendum</span>
          <h2 class="stage-title">Additional Responses</h2>
        </header>
        <div class="stage-content">
          ${extraFieldsHtml}
        </div>
      </article>
    `
        : ''
    }

    <!-- Recent Submissions Directory -->
    <section class="directory-panel">
      <div class="directory-title">Recent WorkSheet Submissions Directory (${(recentSubmissions || []).length})</div>
      <div class="directory-grid">
        ${recentRowsHtml || '<p style="color:var(--slate-500);font-size:13px;">No other submissions recorded yet.</p>'}
      </div>
    </section>

  </main>

</body>
</html>`;
}

