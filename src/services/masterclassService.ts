import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import { randomUUID } from 'crypto';
import { promises as dnsPromises } from 'dns';
import { upsertContact, sendEmail, getFreeSlots, getCalendarInfo, bookAppointment } from './ghl';
import { escapeHtml, formatOperationalSubmissionDate } from './email';
import { getMasterclassBucketFiles, createMasterclassSignedUrl } from './supabaseStorageService';

let prismaInstance: PrismaClient | null = null;
function getPrisma(): any {
  if (!prismaInstance) {
    prismaInstance = new PrismaClient();
  }
  return prismaInstance;
}
const prisma = getPrisma();

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
    stage4_priority90Days: string;
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

/**
 * 6. Calendar Available Slots & 1:1 Review Booking
 */
export async function getAvailableSlots(date?: string, timezone?: string) {
  const tz = timezone || 'GST (UTC+4)';

  // Try querying GHL calendar if configured
  if (date) {
    try {
      const ghlSlots = await getFreeSlots(date);
      if (ghlSlots && ghlSlots.length > 0) {
        return {
          timezone: tz,
          date,
          slots: ghlSlots.map((s) => `${s} ${tz.split(' ')[0]}`),
        };
      }
    } catch (e: any) {
      console.warn('[GHL] Calendar slots fetch fallback:', e.message);
    }
  }

  // Standard Executive Slots for Masterclass strategic review
  const defaultSlots = [
    'Thursday, Oct 24 • 4:00 PM',
    'Friday, Oct 25 • 2:00 PM',
    'Monday, Oct 28 • 11:00 AM',
    'Tuesday, Oct 29 • 3:30 PM',
    'Wednesday, Oct 30 • 4:00 PM',
  ].map((slot) => `${slot} ${tz.split(' ')[0]}`);

  return {
    timezone: tz,
    format: 'Private 1-on-1 Strategic Review Session • 45 Minutes',
    availableSlots: defaultSlots,
    timezones: [
      { key: 'GST (UTC+4)', label: 'GST (Gulf Standard Time)' },
      { key: 'EST (UTC-5)', label: 'EST (Eastern Time)' },
      { key: 'GMT (UTC+0)', label: 'GMT (London Time)' },
      { key: 'CET (UTC+1)', label: 'CET (Central European Time)' },
    ],
  };
}

export async function bookReviewSlot(payload: MasterclassBookingPayload) {
  const normalizedEmail = payload.email.trim().toLowerCase();
  const normalizedName = payload.fullName.trim();
  const normalizedCompany = payload.company.trim();
  const tz = payload.timezone || 'GST (UTC+4)';
  const bookingRef = generateBookingReference();

  // Find linked submission
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

  const booking = await prisma.masterclassBooking.create({
    data: {
      bookingRef,
      enrollmentId,
      submissionId,
      email: normalizedEmail,
      fullName: normalizedName,
      company: normalizedCompany,
      slotTime: payload.selectedSlot,
      timezone: tz,
      status: 'confirmed',
      notes: payload.notes,
      meetingLink: 'https://leadersperformance.ae/meeting/room-lionel',
    },
  });

  // Attempt booking appointment in GHL if configured
  try {
    const contactId = await upsertContact({
      email: normalizedEmail,
      firstName: normalizedName.split(' ')[0],
      lastName: normalizedName.split(' ').slice(1).join(' ') || undefined,
      tags: ['Masterclass Review Booked', '1-on-1 Strategy Session'],
    });

    if (contactId && payload.scheduledAt) {
      await bookAppointment(
        contactId,
        payload.scheduledAt,
        `Strategic Review: ${normalizedName} (${normalizedCompany})`
      );
    }
  } catch (err: any) {
    console.warn('[GHL] Calendar booking sync notice:', err.message);
  }

  // Send booking confirmation email to participant
  try {
    await sendBookingConfirmationEmail({
      bookingRef,
      fullName: normalizedName,
      email: normalizedEmail,
      company: normalizedCompany,
      slotTime: payload.selectedSlot,
      timezone: tz,
      submissionRef: payload.submissionRef || 'FNM-VERIFIED',
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
    message: 'Your 1-on-1 strategic review with Lionel Eersteling is confirmed.',
  };
}

/**
 * 7. Email Notification Helpers & Staff Briefings
 */

const MASTERCLASS_STAFF_RECIPIENTS = [
  { email: 'info@leadersperformance.ae', firstName: 'Leaders', lastName: 'Performance' },
];

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
      <tr>
        <td style="padding: 10px 14px; font-weight: 600; color: #8A652A; width: 220px; vertical-align: top; border-bottom: 1px solid #E8E2D5; font-size: 13px;">
          ${escapeHtml(label)}
        </td>
        <td style="padding: 10px 14px; color: #1A1A1A; vertical-align: top; border-bottom: 1px solid #E8E2D5; font-size: 13.5px; line-height: 1.5; white-space: pre-wrap;">
          ${escapeHtml(String(value))}
        </td>
      </tr>
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

  const stage4Rows = [
    renderField('1. 90-Day Main Preparation Priority', f.stage4_priority90Days),
    renderField('Milestone 1 (30-Day Marker)', f.stage4_milestone1),
    renderField('Milestone 2 (60-Day Marker)', f.stage4_milestone2),
    renderField('Milestone 3 (90-Day Marker)', f.stage4_milestone3),
    renderField('2. Single Action Within 7 Days', f.stage4_action7Days),
    renderField('When Action Will Be Taken', f.stage4_actionTiming),
    renderField('Evidence to Look For Afterward', f.stage4_evidence),
  ].filter(Boolean).join('');

  // Collect any additional dynamic answers that are in formData but not in standard keys
  const standardKeys = new Set([
    'stage1_nextStage', 'stage1_possibility', 'stage1_strength',
    'stage2_changes', 'stage2_demand1', 'stage2_demand2', 'stage2_demand3', 'stage2_investment',
    'stage3_founderStrength', 'stage3_founderStandard', 'stage3_teamStrength', 'stage3_teamStandard',
    'stage3_orgStrength', 'stage3_orgInvestment', 'stage3_focusArea',
    'stage4_priority90Days', 'stage4_milestone1', 'stage4_milestone2', 'stage4_milestone3',
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

  // Personal notes & reflections
  let personalNotesRows = '';
  if (notes && typeof notes === 'object') {
    for (const [k, v] of Object.entries(notes)) {
      if (v !== null && v !== undefined && String(v).trim()) {
        const cleanKey = k.replace(/([A-Z])/g, ' $1').replace(/[_-]/g, ' ').trim();
        personalNotesRows += renderField(`Note: ${cleanKey}`, v);
      }
    }
  }

  return `
    <div style="font-family: Arial, Helvetica, sans-serif; background-color: #F8F6F1; padding: 28px; color: #1A1A1A;">
      <div style="max-width: 680px; margin: 0 auto; background: #FFFFFF; border: 1px solid #E8E2D5; border-radius: 6px; padding: 32px; box-shadow: 0 2px 8px rgba(0,0,0,0.04);">
        
        <!-- Header -->
        <div style="border-bottom: 2px solid #CFA25A; padding-bottom: 16px; margin-bottom: 24px;">
          <p style="font-size: 11px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; color: #8A652A; margin: 0 0 4px 0;">
            Leaders Performance • Executive Masterclass
          </p>
          <h2 style="font-size: 22px; font-weight: 700; color: #010D20; margin: 0 0 6px 0;">
            The Founder’s Next Move — Completed Workbook Briefing
          </h2>
          <p style="font-size: 13px; color: #666; margin: 0;">
            Submission Reference: <strong>${escapeHtml(data.submissionRef)}</strong> &bull; Received <strong>${escapeHtml(submittedAt)}</strong>
          </p>
        </div>

        <!-- Participant Profile -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; margin-bottom: 28px; background: #FAF8F4; border: 1px solid #E8E2D5; border-radius: 4px;">
          <tr>
            <td style="padding: 10px 14px; font-weight: 600; color: #8A652A; width: 170px; border-bottom: 1px solid #E8E2D5; font-size: 13px;">Participant Name:</td>
            <td style="padding: 10px 14px; color: #010D20; font-weight: 700; border-bottom: 1px solid #E8E2D5; font-size: 14px;">${escapeHtml(data.fullName)}</td>
          </tr>
          <tr>
            <td style="padding: 10px 14px; font-weight: 600; color: #8A652A; border-bottom: 1px solid #E8E2D5; font-size: 13px;">Email:</td>
            <td style="padding: 10px 14px; border-bottom: 1px solid #E8E2D5; font-size: 13px;"><a href="mailto:${escapeHtml(data.email)}" style="color: #1A365D; text-decoration: underline; font-weight: 600;">${escapeHtml(data.email)}</a></td>
          </tr>
          <tr>
            <td style="padding: 10px 14px; font-weight: 600; color: #8A652A; border-bottom: 1px solid #E8E2D5; font-size: 13px;">Company:</td>
            <td style="padding: 10px 14px; color: #010D20; border-bottom: 1px solid #E8E2D5; font-size: 13px;">${escapeHtml(data.company || 'Not provided')}</td>
          </tr>
          <tr>
            <td style="padding: 10px 14px; font-weight: 600; color: #8A652A; border-bottom: 1px solid #E8E2D5; font-size: 13px;">Role:</td>
            <td style="padding: 10px 14px; color: #010D20; border-bottom: 1px solid #E8E2D5; font-size: 13px;">${escapeHtml(data.role || 'Executive')}</td>
          </tr>
          <tr>
            <td style="padding: 10px 14px; font-weight: 600; color: #8A652A; font-size: 13px;">Phone / WhatsApp:</td>
            <td style="padding: 10px 14px; color: #010D20; font-size: 13px;">${data.phone ? `<a href="tel:${escapeHtml(data.phone)}" style="color: #1A365D;">${escapeHtml(data.phone)}</a>` : 'Not provided'}</td>
          </tr>
        </table>

        <!-- Stage 1 -->
        <div style="margin-bottom: 24px;">
          <h3 style="font-size: 14px; font-weight: 700; color: #010D20; text-transform: uppercase; letter-spacing: 0.8px; margin: 0 0 8px 0; border-left: 3px solid #CFA25A; padding-left: 8px;">
            Stage 1: Define the Next Stage
          </h3>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; border: 1px solid #E8E2D5;">
            ${stage1Rows || '<tr><td style="padding: 10px; color: #777;">No Stage 1 answers submitted.</td></tr>'}
          </table>
        </div>

        <!-- Stage 2 -->
        <div style="margin-bottom: 24px;">
          <h3 style="font-size: 14px; font-weight: 700; color: #010D20; text-transform: uppercase; letter-spacing: 0.8px; margin: 0 0 8px 0; border-left: 3px solid #CFA25A; padding-left: 8px;">
            Stage 2: Success Changes the Game
          </h3>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; border: 1px solid #E8E2D5;">
            ${stage2Rows || '<tr><td style="padding: 10px; color: #777;">No Stage 2 answers submitted.</td></tr>'}
          </table>
        </div>

        <!-- Stage 3 -->
        <div style="margin-bottom: 24px;">
          <h3 style="font-size: 14px; font-weight: 700; color: #010D20; text-transform: uppercase; letter-spacing: 0.8px; margin: 0 0 8px 0; border-left: 3px solid #CFA25A; padding-left: 8px;">
            Stage 3: Prepare for Performance
          </h3>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; border: 1px solid #E8E2D5;">
            ${stage3Rows || '<tr><td style="padding: 10px; color: #777;">No Stage 3 answers submitted.</td></tr>'}
          </table>
        </div>

        <!-- Stage 4 -->
        <div style="margin-bottom: 24px;">
          <h3 style="font-size: 14px; font-weight: 700; color: #010D20; text-transform: uppercase; letter-spacing: 0.8px; margin: 0 0 8px 0; border-left: 3px solid #CFA25A; padding-left: 8px;">
            Stage 4: Your Next Move
          </h3>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; border: 1px solid #E8E2D5;">
            ${stage4Rows || '<tr><td style="padding: 10px; color: #777;">No Stage 4 answers submitted.</td></tr>'}
          </table>
        </div>

        ${extraRows ? `
        <!-- Additional Responses -->
        <div style="margin-bottom: 24px;">
          <h3 style="font-size: 14px; font-weight: 700; color: #010D20; text-transform: uppercase; letter-spacing: 0.8px; margin: 0 0 8px 0; border-left: 3px solid #CFA25A; padding-left: 8px;">
            Additional Responses
          </h3>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; border: 1px solid #E8E2D5;">
            ${extraRows}
          </table>
        </div>
        ` : ''}

        ${personalNotesRows ? `
        <!-- Personal Notes -->
        <div style="margin-bottom: 24px;">
          <h3 style="font-size: 14px; font-weight: 700; color: #010D20; text-transform: uppercase; letter-spacing: 0.8px; margin: 0 0 8px 0; border-left: 3px solid #CFA25A; padding-left: 8px;">
            Participant Reflections & Personal Notes
          </h3>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; border: 1px solid #E8E2D5; background: #FAF8F4;">
            ${personalNotesRows}
          </table>
        </div>
        ` : ''}

        <!-- Actions -->
        <div style="margin-top: 32px; padding-top: 20px; border-top: 1px solid #E8E2D5; text-align: center;">
          <a href="mailto:${escapeHtml(data.email)}?subject=Re:%20The%20Founder%E2%80%99s%20Next%20Move%20%E2%80%94%20${encodeURIComponent(data.submissionRef)}" style="display: inline-block; background: #010D20; color: #FFFFFF; font-weight: 600; font-size: 13px; letter-spacing: 0.5px; text-transform: uppercase; padding: 12px 24px; text-decoration: none; border-radius: 4px;">
            Reply Directly to ${escapeHtml(data.fullName)} (${escapeHtml(data.email)})
          </a>
        </div>

        <p style="margin-top: 24px; font-size: 11px; color: #888; text-align: center;">
          Internal notification generated for Leaders Performance Advisory Team.
        </p>
      </div>
    </div>
  `;
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
  const bookedAt = formatOperationalSubmissionDate();
  return `
    <div style="font-family: Arial, Helvetica, sans-serif; background-color: #F8F6F1; padding: 28px; color: #1A1A1A;">
      <div style="max-width: 620px; margin: 0 auto; background: #FFFFFF; border: 1px solid #E8E2D5; border-radius: 6px; padding: 32px; box-shadow: 0 2px 8px rgba(0,0,0,0.04);">
        <div style="border-bottom: 2px solid #CFA25A; padding-bottom: 16px; margin-bottom: 24px;">
          <p style="font-size: 11px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; color: #8A652A; margin: 0 0 4px 0;">
            Leaders Performance • Calendar Confirmation
          </p>
          <h2 style="font-size: 20px; font-weight: 700; color: #010D20; margin: 0 0 6px 0;">
            Private 1-on-1 Strategic Review Booked
          </h2>
          <p style="font-size: 13px; color: #666; margin: 0;">
            Booking Reference: <strong>${escapeHtml(data.bookingRef)}</strong> &bull; Recorded <strong>${escapeHtml(bookedAt)}</strong>
          </p>
        </div>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; margin-bottom: 24px; background: #FAF8F4; border: 1px solid #E8E2D5;">
          <tr>
            <td style="padding: 10px 14px; font-weight: 600; color: #8A652A; width: 170px; border-bottom: 1px solid #E8E2D5; font-size: 13px;">Selected Slot:</td>
            <td style="padding: 10px 14px; color: #010D20; font-weight: 700; border-bottom: 1px solid #E8E2D5; font-size: 14px;">${escapeHtml(data.slotTime)}</td>
          </tr>
          <tr>
            <td style="padding: 10px 14px; font-weight: 600; color: #8A652A; border-bottom: 1px solid #E8E2D5; font-size: 13px;">Time Zone:</td>
            <td style="padding: 10px 14px; color: #010D20; border-bottom: 1px solid #E8E2D5; font-size: 13px;">${escapeHtml(data.timezone)}</td>
          </tr>
          <tr>
            <td style="padding: 10px 14px; font-weight: 600; color: #8A652A; border-bottom: 1px solid #E8E2D5; font-size: 13px;">Duration:</td>
            <td style="padding: 10px 14px; color: #010D20; border-bottom: 1px solid #E8E2D5; font-size: 13px;">45 Minutes (Private 1-on-1 Review with Lionel Eersteling)</td>
          </tr>
          <tr>
            <td style="padding: 10px 14px; font-weight: 600; color: #8A652A; border-bottom: 1px solid #E8E2D5; font-size: 13px;">Participant:</td>
            <td style="padding: 10px 14px; color: #010D20; border-bottom: 1px solid #E8E2D5; font-size: 13px;">${escapeHtml(data.fullName)} (${escapeHtml(data.company)})</td>
          </tr>
          <tr>
            <td style="padding: 10px 14px; font-weight: 600; color: #8A652A; border-bottom: 1px solid #E8E2D5; font-size: 13px;">Email:</td>
            <td style="padding: 10px 14px; border-bottom: 1px solid #E8E2D5; font-size: 13px;"><a href="mailto:${escapeHtml(data.email)}" style="color: #1A365D; text-decoration: underline;">${escapeHtml(data.email)}</a></td>
          </tr>
          <tr>
            <td style="padding: 10px 14px; font-weight: 600; color: #8A652A; font-size: 13px;">Workbook Ref:</td>
            <td style="padding: 10px 14px; color: #010D20; font-size: 13px;">${escapeHtml(data.submissionRef)}</td>
          </tr>
        </table>

        <div style="margin-top: 24px; text-align: center;">
          <a href="mailto:${escapeHtml(data.email)}?subject=Re:%20Strategic%20Review%20Confirmation%20(${encodeURIComponent(data.bookingRef)})" style="display: inline-block; background: #010D20; color: #FFFFFF; font-weight: 600; font-size: 13px; letter-spacing: 0.5px; text-transform: uppercase; padding: 12px 24px; text-decoration: none; border-radius: 4px;">
            Reply to ${escapeHtml(data.fullName)}
          </a>
        </div>
      </div>
    </div>
  `;
}

async function sendWorkbookSubmissionNotifications(data: {
  submissionRef: string;
  fullName: string;
  email: string;
  company: string;
  role?: string;
  phone?: string;
  formData: any;
  personalNotes?: any;
}) {
  const subject = `The Founder’s Next Move — Submission Received (${data.submissionRef})`;
  const html = `
    <div style="font-family: Arial, sans-serif; background-color: #031126; color: #F8F4ED; padding: 32px; border-radius: 8px;">
      <h2 style="color: #CFA25A; margin-bottom: 8px;">The Founder’s Next Move</h2>
      <p style="font-size: 16px; margin-bottom: 24px;">Dear ${escapeHtml(data.fullName)},</p>
      <p style="font-size: 14px; line-height: 1.6; color: rgba(248,244,237,0.85);">
        Your 4-Stage Interactive Workbook has been received and secured for review with Lionel Eersteling.
      </p>
      <div style="background: rgba(255,255,255,0.05); border: 1px solid rgba(207,162,90,0.3); padding: 16px; border-radius: 6px; margin: 20px 0;">
        <p style="margin: 4px 0; font-size: 13px;"><strong>Submission Reference:</strong> <span style="color: #CFA25A;">${escapeHtml(data.submissionRef)}</span></p>
        <p style="margin: 4px 0; font-size: 13px;"><strong>Participant:</strong> ${escapeHtml(data.fullName)} (${escapeHtml(data.company)})</p>
        <p style="margin: 4px 0; font-size: 13px;"><strong>Submission Status:</strong> Verified & Protected</p>
      </div>
      <p style="font-size: 14px; line-height: 1.6; color: rgba(248,244,237,0.85);">
        If you haven't yet confirmed your private 45-minute 1-on-1 strategic review session, please return to the platform to select your preferred time slot.
      </p>
      <p style="margin-top: 30px; font-size: 12px; color: rgba(248,244,237,0.5);">
        Leaders Performance • Confidential Executive Learning Protocol
      </p>
    </div>
  `;

  // 1. Participant Confirmation Dispatch
  try {
    const contactId = await upsertContact({
      email: data.email,
      firstName: data.fullName.split(' ')[0],
      lastName: data.fullName.split(' ').slice(1).join(' ') || undefined,
      tags: ['Masterclass Workbook Submitted'],
    });
    if (contactId) {
      await sendEmail(contactId, subject, html);
    }
  } catch (err: any) {
    console.warn('[Email] Fallback participant notification notice:', err.message);
  }

  // 2. Company Staff Briefing Dispatch (info@leadersperformance.ae)
  try {
    const staffSubject = `[Masterclass Workbook Submission] ${data.fullName} (${data.company || 'Individual'}) — ${data.submissionRef}`;
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
          console.log(`[Masterclass] Staff workbook briefing delivered to: ${recipient.email}`);
        }
      } catch (staffErr: any) {
        console.warn(`[Masterclass] Staff notification notice for ${recipient.email}:`, staffErr?.message || staffErr);
      }
    }
  } catch (staffGlobalErr: any) {
    console.warn('[Masterclass] Error dispatching staff workbook briefing:', staffGlobalErr?.message || staffGlobalErr);
  }
}

async function sendBookingConfirmationEmail(data: {
  bookingRef: string;
  fullName: string;
  email: string;
  company: string;
  slotTime: string;
  timezone: string;
  submissionRef: string;
}) {
  const subject = `Confirmed: Private 1-on-1 Strategic Review with Lionel Eersteling (${data.bookingRef})`;
  const html = `
    <div style="font-family: Arial, sans-serif; background-color: #031126; color: #F8F4ED; padding: 32px; border-radius: 8px;">
      <h2 style="color: #CFA25A; margin-bottom: 8px;">Strategic Review Session Confirmed</h2>
      <p style="font-size: 16px; margin-bottom: 24px;">Dear ${escapeHtml(data.fullName)},</p>
      <p style="font-size: 14px; line-height: 1.6; color: rgba(248,244,237,0.85);">
        Your private 1-on-1 strategic review with <strong>Lionel Eersteling</strong> is officially confirmed.
      </p>
      <div style="background: rgba(255,255,255,0.05); border: 1px solid rgba(207,162,90,0.3); padding: 16px; border-radius: 6px; margin: 20px 0;">
        <p style="margin: 6px 0; font-size: 14px;"><strong>Selected Slot:</strong> <span style="color: #CFA25A; font-weight: bold;">${escapeHtml(data.slotTime)}</span></p>
        <p style="margin: 6px 0; font-size: 13px;"><strong>Time Zone:</strong> ${escapeHtml(data.timezone)}</p>
        <p style="margin: 6px 0; font-size: 13px;"><strong>Duration:</strong> 45 Minutes (Private Zoom Session)</p>
        <p style="margin: 6px 0; font-size: 13px;"><strong>Booking Reference:</strong> ${escapeHtml(data.bookingRef)}</p>
        <p style="margin: 6px 0; font-size: 13px;"><strong>Workbook Reference:</strong> ${escapeHtml(data.submissionRef)}</p>
      </div>
      <p style="font-size: 14px; line-height: 1.6; color: rgba(248,244,237,0.85);">
        Lionel’s office will review your completed 4-stage workbook prior to the call. Calendar invitations with video conference credentials have been scheduled.
      </p>
      <p style="margin-top: 30px; font-size: 12px; color: rgba(248,244,237,0.5);">
        Leaders Performance • Dubai, UAE
      </p>
    </div>
  `;

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
  subtitle: "4 Video Briefing Modules, Digital Interactive Workbook & 1-on-1 Strategic Review with Lionel Eersteling",
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
      subtitle: 'Transforming reflections into a high-leverage 90-day roadmap and one immediate action within 7 days.',
      videoId: 5,
      videoKey: 'stage_4',
      thumbnailFileName: 'STAGE-04.jpg',
      reflectionPauseSeconds: 45,
      reflectionPrompt: 'Reflect on your top 90-day preparation priority and the single high-leverage action you will take within 7 days. Record your answers in Stage 4.',
      questions: [
        {
          id: 'stage4_priority90Days',
          label: '1. What is your main preparation priority for the next 90 days? *',
          type: 'textarea',
          required: true,
          maxLength: 1000,
          placeholder: 'e.g. Structure clear quarterly KPIs and delegate core revenue operations.',
        },
        {
          id: 'stage4_milestone1',
          label: 'Milestone 1: 30-Day progress marker',
          type: 'text',
          required: false,
          maxLength: 1000,
          placeholder: 'Milestone 1: e.g. Executive alignment framework signed off by Day 30',
        },
        {
          id: 'stage4_milestone2',
          label: 'Milestone 2: 60-Day progress marker',
          type: 'text',
          required: false,
          maxLength: 1000,
          placeholder: 'Milestone 2: e.g. Operational handover completed by Day 60',
        },
        {
          id: 'stage4_milestone3',
          label: 'Milestone 3: 90-Day progress marker',
          type: 'text',
          required: false,
          maxLength: 1000,
          placeholder: 'Milestone 3: e.g. Full performance reset review with Lionel by Day 90',
        },
        {
          id: 'stage4_action7Days',
          label: '3. One action within 7 days *',
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
  const findMatch = (candidates: string[]): string | null => {
    for (const cand of candidates) {
      const exact = fileNames.find((name: string) => name.toLowerCase() === cand.toLowerCase());
      if (exact) return exact;
    }
    // Substring fallback
    for (const cand of candidates) {
      const cleanCand = cand.replace('.mp4', '').toLowerCase().replace(/\s+/g, '');
      const partial = fileNames.find((name: string) => {
        const cleanName = name.replace('.mp4', '').toLowerCase().replace(/\s+/g, '');
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
      subtitle: 'Turn reflections into 90-day milestones and a single high-leverage 7-day action',
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
      const matchedFileName = findMatch(slot.candidates);
      const targetFile = matchedFileName || slot.fallbackName;
      let signedUrl: string | null = null;
      let isAvailable = false;

      if (matchedFileName) {
        signedUrl = await createMasterclassSignedUrl(matchedFileName, expiresInSeconds);
        isAvailable = Boolean(signedUrl);
      }

      // Generate signed thumbnail URL
      const matchedThumbnailName = findMatch(slot.thumbnailCandidates);
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

