import { PrismaClient } from '@prisma/client';

let prismaInstance: PrismaClient | null = null;
function getPrisma(): any {
  if (!prismaInstance) {
    prismaInstance = new PrismaClient();
  }
  return prismaInstance;
}

export interface ReferralValidationResult {
  valid: boolean;
  code?: string;
  referrerName?: string;
  discountPercent?: number;
  originalPriceUsd?: number;
  discountAmountUsd?: number;
  finalPriceUsd?: number;
  originalAmountCents?: number;
  discountAmountCents?: number;
  finalAmountCents?: number;
  stripeCouponId?: string | null;
  referralId?: string | null;
  message?: string;
  error?: string;
}

/**
 * Built-in managed referral records (Backend-authoritative truth).
 * Ensures instant uptime even before database migrations are synced.
 */
export const DEFAULT_REFERRAL_RECORDS = [
  {
    code: '0XQZ6IN',
    referrerName: 'Danielle',
    referrerEmail: 'danielle@leadersperformance.ae',
    discountPercent: 33.33,
    startDate: new Date('2026-10-01T00:00:00.000Z'),
    endDate: new Date('2027-12-31T23:59:59.999Z'),
    isActive: true,
    notes: 'Official executive referral code for Danielle (33.33% privilege)',
  },
  {
    code: 'DIVALOS',
    referrerName: 'Divalos',
    referrerEmail: 'divalos@leadersperformance.ae',
    discountPercent: 33.33,
    startDate: new Date('2026-10-01T00:00:00.000Z'),
    endDate: new Date('2027-12-31T23:59:59.999Z'),
    isActive: true,
    notes: 'Official executive referral code for Divalos (33.33% privilege)',
  },
  {
    code: 'DIVALOS33',
    referrerName: 'Divalos',
    referrerEmail: 'divalos@leadersperformance.ae',
    discountPercent: 33.33,
    startDate: new Date('2026-10-01T00:00:00.000Z'),
    endDate: new Date('2027-12-31T23:59:59.999Z'),
    isActive: true,
    notes: 'Alias promo code for Divalos (33.33% privilege)',
  },
];

const BASE_PRICE_USD = 750;
const BASE_AMOUNT_CENTS = 75000;

/**
 * Syncs default referral records to PostgreSQL database if table exists.
 */
export async function syncDefaultReferralsToDb(): Promise<void> {
  const prisma = getPrisma();
  try {
    if (!prisma.masterclassReferralCode) return;
    for (const record of DEFAULT_REFERRAL_RECORDS) {
      await prisma.masterclassReferralCode.upsert({
        where: { code: record.code },
        update: {
          referrerName: record.referrerName,
          referrerEmail: record.referrerEmail,
          discountPercent: record.discountPercent,
          startDate: record.startDate,
          endDate: record.endDate,
          isActive: record.isActive,
        },
        create: {
          code: record.code,
          referrerName: record.referrerName,
          referrerEmail: record.referrerEmail,
          discountPercent: record.discountPercent,
          startDate: record.startDate,
          endDate: record.endDate,
          isActive: record.isActive,
          notes: record.notes,
        },
      });
    }
  } catch (err: any) {
    // If table not migrated yet, safe fallback continues
    console.warn('[Referral Service] syncDefaultReferralsToDb notice:', err?.message || err);
  }
}

/**
 * Validate an invite / referral promo code against referrer names (Danielle, Divalos),
 * start date, end date, and usage limits.
 */
export async function validateReferralInvite(rawCode: string | null | undefined): Promise<ReferralValidationResult> {
  if (!rawCode || typeof rawCode !== 'string' || !rawCode.trim()) {
    return {
      valid: false,
      error: 'NO_CODE_PROVIDED',
      message: 'No referral or invite code was provided.',
    };
  }

  const normalizedCode = rawCode.trim().toUpperCase();
  const now = new Date();

  // 1. Try querying PostgreSQL database first
  const prisma = getPrisma();
  let dbRecord: any = null;
  try {
    if (prisma.masterclassReferralCode) {
      dbRecord = await prisma.masterclassReferralCode.findUnique({
        where: { code: normalizedCode },
      });
    }
  } catch (err: any) {
    console.warn('[Referral Service] DB lookup warning, falling back to static config:', err?.message || err);
  }

  // 2. Fall back to authoritative static list if not found in DB
  const referral = dbRecord || DEFAULT_REFERRAL_RECORDS.find((r) => r.code === normalizedCode);

  if (!referral) {
    return {
      valid: false,
      error: 'INVALID_CODE',
      message: `Referral code "${normalizedCode}" is not recognized.`,
    };
  }

  // 3. Check active status
  if (!referral.isActive) {
    return {
      valid: false,
      error: 'CODE_INACTIVE',
      message: `Referral code "${normalizedCode}" is currently inactive.`,
    };
  }

  // 4. Validate Start Date
  const startDate = new Date(referral.startDate);
  if (now < startDate) {
    return {
      valid: false,
      error: 'CODE_NOT_STARTED',
      message: `Referral code "${normalizedCode}" is not valid yet (starts ${startDate.toISOString().split('T')[0]}).`,
    };
  }

  // 5. Validate End Date
  const endDate = new Date(referral.endDate);
  if (now > endDate) {
    return {
      valid: false,
      error: 'CODE_EXPIRED',
      message: `Referral code "${normalizedCode}" expired on ${endDate.toISOString().split('T')[0]}.`,
    };
  }

  // 6. Validate Max Uses
  if (referral.maxUses && typeof referral.usedCount === 'number' && referral.usedCount >= referral.maxUses) {
    return {
      valid: false,
      error: 'MAX_USES_REACHED',
      message: `Referral code "${normalizedCode}" has reached its maximum quota.`,
    };
  }

  // 7. Calculate discount: 33.33% off 750 => 250 off => 500 payable
  const discountPercent = referral.discountPercent || 33.33;
  // 750 * 0.33333333 = 250
  const discountAmountUsd = Math.round(BASE_PRICE_USD * (discountPercent / 100)); // 250
  const finalPriceUsd = BASE_PRICE_USD - discountAmountUsd; // 500

  const discountAmountCents = discountAmountUsd * 100; // 25000
  const finalAmountCents = finalPriceUsd * 100; // 50000

  return {
    valid: true,
    code: referral.code,
    referrerName: referral.referrerName,
    discountPercent,
    originalPriceUsd: BASE_PRICE_USD,
    discountAmountUsd,
    finalPriceUsd,
    originalAmountCents: BASE_AMOUNT_CENTS,
    discountAmountCents,
    finalAmountCents,
    stripeCouponId: referral.stripeCouponId || null,
    referralId: referral.id || null,
    message: `Privilege unlocked: ${discountPercent}% referral discount verified for ${referral.referrerName}.`,
  };
}

/**
 * Increment usage counter for a used referral code
 */
export async function incrementReferralUsage(code: string): Promise<void> {
  const prisma = getPrisma();
  try {
    const normalized = code.trim().toUpperCase();
    if (prisma.masterclassReferralCode) {
      await prisma.masterclassReferralCode.updateMany({
        where: { code: normalized },
        data: {
          usedCount: { increment: 1 },
        },
      });
    }
  } catch (err: any) {
    console.warn('[Referral Service] incrementReferralUsage notice:', err?.message || err);
  }
}
