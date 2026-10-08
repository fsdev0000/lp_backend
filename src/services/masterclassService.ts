import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import { randomUUID } from 'crypto';
import { upsertContact, sendEmail, getFreeSlots, getCalendarInfo, bookAppointment } from './ghl';
import { escapeHtml, formatOperationalSubmissionDate } from './email';

const prisma = new PrismaClient();

// Helper to obtain Stripe client
function getStripe(): Stripe {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY environment variable is not configured');
  }
  return new Stripe(secretKey);
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
  
  const enrollment = await prisma.masterclassEnrollment.findFirst({
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

  if (!enrollment) {
    return {
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

  // If already paid and access granted, system recognizes them immediately!
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
        amount: 50000, // US$500 in cents
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
            unit_amount: 50000, // US$500.00
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

  // Optionally register lead in GHL
  try {
    await upsertContact({
      email: normalizedEmail,
      firstName: normalizedName.split(' ')[0],
      lastName: normalizedName.split(' ').slice(1).join(' ') || undefined,
      phone: payload.phone,
      source: `Masterclass Enrollment (${payload.source || 'Direct'})`,
      tags: ['Masterclass Lead', 'The Founders Next Move'],
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

  const serializedFormData = JSON.stringify(payload.formData || {});
  const serializedNotes = JSON.stringify(payload.personalNotes || {});
  const stage = payload.currentStage || 1;

  let submissionRecord;
  if (existingSubmission) {
    submissionRecord = await prisma.masterclassWorkbookSubmission.update({
      where: { id: existingSubmission.id },
      data: {
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
  } catch {}
  try {
    parsedNotes = draft.personalNotes ? JSON.parse(draft.personalNotes) : {};
  } catch {}

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
      formData,
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
  } catch {}
  try {
    parsedNotes = submission.personalNotes ? JSON.parse(submission.personalNotes) : {};
  } catch {}

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
 * 7. Email Notification Helpers
 */
async function sendWorkbookSubmissionNotifications(data: {
  submissionRef: string;
  fullName: string;
  email: string;
  company: string;
  formData: any;
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
}
