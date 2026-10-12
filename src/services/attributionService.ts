import { Request } from 'express';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { upsertContact } from './ghl';

const prisma = new PrismaClient();

export const HOW_DID_YOU_HEAR_OPTIONS = [
  'Google / Search',
  'LinkedIn',
  'YouTube',
  'Instagram',
  'Referral / Someone recommended me',
  'Event / Conference',
  'Other',
] as const;

export type HowDidYouHearOption = typeof HOW_DID_YOU_HEAR_OPTIONS[number];

export interface TechnicalAttribution {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  referrer?: string;
  landing_page?: string;
  anonymous_id?: string;
  first_touch?: {
    utm_source?: string;
    utm_medium?: string;
    utm_campaign?: string;
    utm_content?: string;
    referrer?: string;
    landing_page?: string;
    timestamp?: string;
  };
  latest_touch?: {
    utm_source?: string;
    utm_medium?: string;
    utm_campaign?: string;
    utm_content?: string;
    referrer?: string;
    landing_page?: string;
    timestamp?: string;
  };
}

export interface VisitorAttributionPayload {
  anonymousId?: string;
  module?: string;
  landingPage: string;
  referrer?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  timezone?: string;
  device?: string;
  first_touch?: any;
  latest_touch?: any;
}

export interface LeadConversionAttributionPayload {
  email: string;
  leadName?: string;
  leadForm: string; // 'contact' | 'unmasked_private' | 'founder_pressure_scan' | 'masterclass' | 'newsletter'
  howDidYouHear?: string;
  attribution?: TechnicalAttribution;
  anonymousId?: string;
  ghlContactId?: string;
  phone?: string;
  tags?: string[];
  customFields?: { id?: string; key?: string; name?: string; value: any }[];
}

let tableInitPromise: Promise<void> | null = null;

export async function ensureAttributionTable(): Promise<void> {
  if (tableInitPromise) return tableInitPromise;

  tableInitPromise = (async () => {
    try {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS attribution_visits (
          id TEXT PRIMARY KEY,
          anonymous_id TEXT,
          module TEXT,
          landing_page TEXT NOT NULL,
          referrer TEXT,
          utm_source TEXT,
          utm_medium TEXT,
          utm_campaign TEXT,
          utm_term TEXT,
          utm_content TEXT,
          ip_address TEXT,
          country TEXT,
          city TEXT,
          region TEXT,
          timezone TEXT,
          user_agent TEXT,
          device TEXT,
          email TEXT,
          lead_name TEXT,
          lead_form TEXT,
          how_did_you_hear TEXT,
          ghl_contact_id TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
      `);

      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS idx_attribution_visits_anon ON attribution_visits(anonymous_id)`
      ).catch(() => {});
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS idx_attribution_visits_email ON attribution_visits(email)`
      ).catch(() => {});
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS idx_attribution_visits_utm ON attribution_visits(utm_source)`
      ).catch(() => {});
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS idx_attribution_visits_created ON attribution_visits(created_at)`
      ).catch(() => {});
    } catch (err: any) {
      console.warn('[Attribution] Notice initializing attribution_visits table:', err?.message || err);
    }
  })();

  return tableInitPromise;
}

export function extractClientIp(req: Request): string {
  const cfIp = req.headers['cf-connecting-ip'] as string;
  const forwarded = req.headers['x-forwarded-for'] as string;
  const realIp = req.headers['x-real-ip'] as string;

  if (cfIp) return cfIp.trim();
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  if (realIp) return realIp.trim();
  return req.socket?.remoteAddress || req.ip || 'unknown';
}

export function extractClientLocation(req: Request): {
  country?: string;
  city?: string;
  region?: string;
} {
  const country =
    (req.headers['cf-ipcountry'] as string) ||
    (req.headers['x-country'] as string) ||
    (req.headers['geoip-country-code'] as string) ||
    undefined;

  const city =
    (req.headers['cf-ipcity'] as string) ||
    (req.headers['x-city'] as string) ||
    undefined;

  const region =
    (req.headers['cf-region'] as string) ||
    (req.headers['x-region'] as string) ||
    undefined;

  return { country, city, region };
}

/**
 * Capture an incoming visit from external sources (UTMs, Referrer, Landing Page, IP, Geo).
 */
export async function recordVisitorAttribution(
  req: Request,
  payload: VisitorAttributionPayload
): Promise<string> {
  await ensureAttributionTable();

  const id = randomUUID();
  const ipAddress = extractClientIp(req);
  const location = extractClientLocation(req);
  const userAgent = (req.headers['user-agent'] as string) || undefined;

  const anonymousId = payload.anonymousId || undefined;
  const landingPage = payload.landingPage || req.originalUrl || '/';
  const referrer = payload.referrer || (req.headers['referer'] as string) || undefined;
  const utmSource = payload.utm_source || undefined;
  const utmMedium = payload.utm_medium || undefined;
  const utmCampaign = payload.utm_campaign || undefined;
  const utmTerm = payload.utm_term || undefined;
  const utmContent = payload.utm_content || undefined;
  const timezone = payload.timezone || undefined;
  const device = payload.device || undefined;
  const mod = payload.module || undefined;

  try {
    if ((prisma as any).attributionVisit) {
      await (prisma as any).attributionVisit.create({
        data: {
          id,
          anonymousId,
          module: mod,
          landingPage,
          referrer,
          utmSource,
          utmMedium,
          utmCampaign,
          utmTerm,
          utmContent,
          ipAddress,
          country: location.country,
          city: location.city,
          region: location.region,
          timezone,
          userAgent,
          device,
        },
      });
    } else {
      await prisma.$executeRawUnsafe(
        `
        INSERT INTO attribution_visits (
          id, anonymous_id, module, landing_page, referrer,
          utm_source, utm_medium, utm_campaign, utm_term, utm_content,
          ip_address, country, city, region, timezone, user_agent, device,
          created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17,
          NOW(), NOW()
        )
      `,
        id,
        anonymousId || null,
        mod || null,
        landingPage,
        referrer || null,
        utmSource || null,
        utmMedium || null,
        utmCampaign || null,
        utmTerm || null,
        utmContent || null,
        ipAddress || null,
        location.country || null,
        location.city || null,
        location.region || null,
        timezone || null,
        userAgent || null,
        device || null
      );
    }
  } catch (err: any) {
    console.error('[Attribution] Failed to insert visitor attribution row:', err?.message || err);
  }

  return id;
}

/**
 * Links a converted lead with the existing attribution record in PostgreSQL,
 * and pushes the full attribution & "How did you hear about us?" payload to GoHighLevel.
 */
export async function syncLeadAttribution(
  payload: LeadConversionAttributionPayload,
  req?: Request
): Promise<string | null> {
  await ensureAttributionTable();

  const normalizedEmail = payload.email.trim().toLowerCase();
  const attr = payload.attribution || {};
  const anonymousId = payload.anonymousId || attr.anonymous_id;
  const howDidYouHear = payload.howDidYouHear;

  let ghlContactId = payload.ghlContactId;

  // 1. Forward to GoHighLevel with Lead Source - User and UTM Custom Fields
  try {
    const ghlPayload = {
      email: normalizedEmail,
      firstName: payload.leadName?.split(/\s+/)[0],
      lastName: payload.leadName?.split(/\s+/).slice(1).join(' ') || undefined,
      phone: payload.phone,
      source: `Leaders Performance - ${payload.leadForm}`,
      tags: payload.tags || [`Lead: ${payload.leadForm}`],
      howDidYouHear: howDidYouHear || undefined,
      attribution: attr,
      customFields: payload.customFields,
    };

    const syncedId = await upsertContact(ghlPayload);
    if (syncedId) {
      ghlContactId = syncedId;
    }
  } catch (ghlErr: any) {
    console.warn('[Attribution] Warning syncing to GoHighLevel CRM:', ghlErr?.message || ghlErr);
  }

  // 2. Link/Update PostgreSQL Attribution Record
  try {
    const ipAddress = req ? extractClientIp(req) : null;
    const location = req ? extractClientLocation(req) : {};
    const userAgent = req ? (req.headers['user-agent'] as string) : null;

    // First attempt to update existing session matching anonymousId or email
    let updatedCount = 0;
    if (anonymousId) {
      const res = await prisma.$executeRawUnsafe(
        `
        UPDATE attribution_visits
        SET email = $1, lead_name = $2, lead_form = $3, how_did_you_hear = $4, ghl_contact_id = $5, updated_at = NOW()
        WHERE anonymous_id = $6 AND email IS NULL
      `,
        normalizedEmail,
        payload.leadName || null,
        payload.leadForm,
        howDidYouHear || null,
        ghlContactId || null,
        anonymousId
      );
      updatedCount = typeof res === 'number' ? res : 0;
    }

    // If no row was updated, insert a new record for this lead conversion
    if (updatedCount === 0) {
      const id = randomUUID();
      await prisma.$executeRawUnsafe(
        `
        INSERT INTO attribution_visits (
          id, anonymous_id, module, landing_page, referrer,
          utm_source, utm_medium, utm_campaign, utm_term, utm_content,
          ip_address, country, city, region, user_agent,
          email, lead_name, lead_form, how_did_you_hear, ghl_contact_id,
          created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15,
          $16, $17, $18, $19, $20,
          NOW(), NOW()
        )
      `,
        id,
        anonymousId || null,
        payload.leadForm,
        attr.landing_page || '/',
        attr.referrer || null,
        attr.utm_source || null,
        attr.utm_medium || null,
        attr.utm_campaign || null,
        attr.utm_term || null,
        attr.utm_content || null,
        ipAddress || null,
        location.country || null,
        location.city || null,
        location.region || null,
        userAgent || null,
        normalizedEmail,
        payload.leadName || null,
        payload.leadForm,
        howDidYouHear || null,
        ghlContactId || null
      );
    }
  } catch (dbErr: any) {
    console.error('[Attribution] Notice saving lead attribution to DB:', dbErr?.message || dbErr);
  }

  return ghlContactId || null;
}
