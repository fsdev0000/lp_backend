import { PrismaClient } from '@prisma/client';
import { Request } from 'express';
import { getLionelWebsiteConfig } from '../config/lionelWebsite.config';
import { TEST_LEAD_EMAILS } from '../../analytics/utils/inquiries';
import { inboxService } from '../../automation/notifications/inbox.service';

const prisma = new PrismaClient();

export interface LionelContactInquiryInput {
  first_name?: string;
  last_name?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  email: string;
  phone?: string;
  company?: string;
  role?: string;
  preferred_contact_method?: string;
  preferredContactMethod?: string;
  how_did_you_hear?: string;
  howDidYouHear?: string;
  message?: string;
  context?: string;
  date?: string;
  createdAt?: string;
  source?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  landing_page?: string;
  referrer?: string;
  honeypot?: string;
  ghlContactId?: string;
  skipGhlUpsert?: boolean;
  skipEmailNotification?: boolean;
  attribution?: {
    utm_source?: string;
    utm_medium?: string;
    utm_campaign?: string;
    utm_term?: string;
    utm_content?: string;
    landing_page?: string;
    referrer?: string;
  };
}

export interface NormalizedLionelInquiry {
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  phone: string | null;
  company: string | null;
  role: string | null;
  preferredContactMethod: string;
  howDidYouHear: string | null;
  message: string;
  createdAt: Date;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  landingPage: string;
  referrer: string | null;
  ghlContactId: string | null;
  honeypot: string;
  skipGhlUpsert: boolean;
  skipEmailNotification: boolean;
}

export interface StoredLionelInquiry {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  company: string | null;
  role: string | null;
  message: string;
  preferredContactMethod: string;
  howDidYouHear: string | null;
  source: string;
  form: string;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  landingPage: string;
  timestamp: string;
}

const INTERNAL_OR_QA_EMAILS = new Set([
  ...TEST_LEAD_EMAILS.map((e) => e.toLowerCase()),
  'asif@leadersperformance.ae',
  'mirza@leadersperformance.ae',
  'lionel@leadersperformance.ae',
  'info@leadersperformance.ae',
  'john.doe@example.com',
  'ahmed.test@example.com',
  'francois.test@example.com',
  'masif2024@gmail.com',
]);

export class LionelWebsiteService {
  private static lastExternalSyncAt = 0;
  private static readonly SYNC_TTL_MS = 5 * 60 * 1000; // 5 minutes

  public normalizeInput(body: LionelContactInquiryInput): NormalizedLionelInquiry {
    const rawName = (body.name || '').trim();
    let firstName = (body.first_name || body.firstName || '').trim();
    let lastName = (body.last_name || body.lastName || '').trim();

    if (!firstName && rawName) {
      const parts = rawName.split(/\s+/);
      firstName = parts[0] || '';
      lastName = parts.slice(1).join(' ') || '';
    }

    const fullName = [firstName, lastName].filter(Boolean).join(' ').trim() || rawName;
    const email = (body.email || '').trim().toLowerCase();
    const phone = body.phone ? String(body.phone).trim() : null;
    const company = (body.company || '').trim() || null;
    const role = (body.role || '').trim() || null;
    const preferredContactMethod =
      (body.preferred_contact_method || body.preferredContactMethod || 'Email').trim();
    const howDidYouHear =
      (body.how_did_you_hear || body.howDidYouHear || '').trim() || null;
    const message = (body.message || body.context || '').trim();

    const attr = body.attribution || {};
    const utmSource =
      (body.utm_source || attr.utm_source || body.source || '').trim() || null;
    const utmMedium = (body.utm_medium || attr.utm_medium || '').trim() || null;
    const utmCampaign = (body.utm_campaign || attr.utm_campaign || '').trim() || null;
    const utmTerm = (body.utm_term || attr.utm_term || '').trim() || null;
    const utmContent = (body.utm_content || attr.utm_content || '').trim() || null;

    let rawLanding = (body.landing_page || attr.landing_page || '').trim();
    if (!rawLanding) {
      rawLanding = 'https://lioneleersteling.com/contact';
    } else if (rawLanding.startsWith('/')) {
      rawLanding = `https://lioneleersteling.com${rawLanding}`;
    } else if (!rawLanding.toLowerCase().includes('lioneleersteling.com')) {
      rawLanding = `https://lioneleersteling.com/${rawLanding.replace(/^https?:\/\/[^/]+\/?/, '')}`;
    }

    const referrer = (body.referrer || attr.referrer || 'https://lioneleersteling.com').trim();
    const rawDate = body.date || body.createdAt;
    const parsedDate = rawDate ? new Date(rawDate) : new Date();
    const createdAt = isNaN(parsedDate.getTime()) ? new Date() : parsedDate;

    return {
      firstName,
      lastName,
      fullName,
      email,
      phone,
      company,
      role,
      preferredContactMethod,
      howDidYouHear,
      message,
      createdAt,
      utmSource,
      utmMedium,
      utmCampaign,
      utmTerm,
      utmContent,
      landingPage: rawLanding,
      referrer,
      ghlContactId: body.ghlContactId ? String(body.ghlContactId).trim() : null,
      honeypot: (body.honeypot || '').trim(),
      skipGhlUpsert: Boolean(body.skipGhlUpsert),
      skipEmailNotification: Boolean(body.skipEmailNotification),
    };
  }

  public validateInquiry(inquiry: NormalizedLionelInquiry): string | null {
    if (!inquiry.fullName || inquiry.fullName.length < 2) {
      return 'Please provide your name (at least 2 characters).';
    }
    const emailRegex = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
    if (!inquiry.email || inquiry.email.length > 254 || !emailRegex.test(inquiry.email)) {
      return 'Please provide a valid email address.';
    }
    if (!inquiry.message || inquiry.message.length < 2) {
      return 'Please provide a message.';
    }
    if (inquiry.message.length > 2000) {
      return 'Message cannot exceed 2,000 characters.';
    }
    return null;
  }

  /**
   * Stores a contact-form submission from lioneleersteling.com into lp_backend,
   * keeping it isolated under the Lionel Eersteling domain/workspace.
   */
  public async submitContactInquiry(
    rawBody: LionelContactInquiryInput,
    req?: Request
  ): Promise<{
    success: boolean;
    inquiryId: string;
    contactId: string | null;
    inquiry: StoredLionelInquiry;
  }> {
    const inquiry = this.normalizeInput(rawBody);

    if (inquiry.honeypot) {
      return {
        success: true,
        inquiryId: 'spambot-filtered',
        contactId: 'spambot-filtered',
        inquiry: {
          id: 'spambot-filtered',
          name: inquiry.fullName,
          firstName: inquiry.firstName,
          lastName: inquiry.lastName,
          email: inquiry.email,
          phone: inquiry.phone,
          company: inquiry.company,
          role: inquiry.role,
          message: inquiry.message,
          preferredContactMethod: inquiry.preferredContactMethod,
          howDidYouHear: inquiry.howDidYouHear,
          source: 'form',
          form: 'le_contact_form',
          utmSource: inquiry.utmSource,
          utmMedium: inquiry.utmMedium,
          utmCampaign: inquiry.utmCampaign,
          landingPage: inquiry.landingPage,
          timestamp: inquiry.createdAt.toISOString(),
        },
      };
    }

    const validationError = this.validateInquiry(inquiry);
    if (validationError) {
      const err: any = new Error(validationError);
      err.statusCode = 400;
      throw err;
    }

    let ghlContactId = inquiry.ghlContactId;
    if (!inquiry.skipGhlUpsert && process.env.NODE_ENV !== 'test') {
      try {
        ghlContactId = await this.upsertLionelGhlContact(inquiry);
      } catch (ghlErr: any) {
        console.warn('[LionelWebsiteService] GHL upsert warning:', ghlErr?.message);
      }
    }

    if (
      !inquiry.skipEmailNotification &&
      process.env.NODE_ENV !== 'test' &&
      process.env.ENABLE_OUTBOUND_EMAILS === 'true'
    ) {
      this.sendLionelNotificationEmail(inquiry).catch((emailErr) =>
        console.warn('[LionelWebsiteService] Email notification warning:', emailErr?.message)
      );
    }

    const ipAddress = req
      ? ((req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
          req.socket?.remoteAddress ||
          null)
      : null;
    const userAgent = req ? ((req.headers['user-agent'] as string) || null) : null;

    // Deduplicate rapid double-posts (e.g., direct browser post + Edge Function webhook forward within 2 minutes)
    const twoMinutesAgo = new Date(inquiry.createdAt.getTime() - 2 * 60 * 1000);
    const twoMinutesAhead = new Date(inquiry.createdAt.getTime() + 2 * 60 * 1000);

    let visit = await prisma.attributionVisit.findFirst({
      where: {
        email: inquiry.email,
        leadForm: 'le_contact_form',
        createdAt: { gte: twoMinutesAgo, lte: twoMinutesAhead },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (visit) {
      visit = await prisma.attributionVisit.update({
        where: { id: visit.id },
        data: {
          leadName: inquiry.fullName,
          howDidYouHear: inquiry.howDidYouHear || visit.howDidYouHear,
          utmSource: inquiry.utmSource || visit.utmSource,
          utmMedium: inquiry.utmMedium || visit.utmMedium,
          utmCampaign: inquiry.utmCampaign || visit.utmCampaign,
          utmTerm: inquiry.utmTerm || visit.utmTerm,
          utmContent: inquiry.utmContent || visit.utmContent,
          ghlContactId: ghlContactId || visit.ghlContactId,
        },
      });
    } else {
      visit = await prisma.attributionVisit.create({
        data: {
          module: 'le_website',
          landingPage: inquiry.landingPage,
          referrer: inquiry.referrer,
          utmSource: inquiry.utmSource,
          utmMedium: inquiry.utmMedium,
          utmCampaign: inquiry.utmCampaign,
          utmTerm: inquiry.utmTerm,
          utmContent: inquiry.utmContent,
          ipAddress,
          userAgent,
          email: inquiry.email,
          leadName: inquiry.fullName,
          leadForm: 'le_contact_form',
          howDidYouHear: inquiry.howDidYouHear,
          ghlContactId,
          createdAt: inquiry.createdAt,
        },
      });
    }

    const storedRecord: StoredLionelInquiry = {
      id: visit.id,
      name: inquiry.fullName,
      firstName: inquiry.firstName,
      lastName: inquiry.lastName,
      email: inquiry.email,
      phone: inquiry.phone,
      company: inquiry.company,
      role: inquiry.role,
      message: inquiry.message,
      preferredContactMethod: inquiry.preferredContactMethod,
      howDidYouHear: inquiry.howDidYouHear,
      source: 'form',
      form: 'le_contact_form',
      utmSource: visit.utmSource,
      utmMedium: visit.utmMedium,
      utmCampaign: visit.utmCampaign,
      landingPage: visit.landingPage,
      timestamp: visit.createdAt.toISOString(),
    };

    try {
      await prisma.systemConfig.upsert({
        where: { key: `le_website_inquiry_${visit.id}` },
        update: {
          value: JSON.stringify(storedRecord),
        },
        create: {
          key: `le_website_inquiry_${visit.id}`,
          value: JSON.stringify(storedRecord),
        },
      });
    } catch {
      // Non-blocking metadata storage
    }

    // Notify Social CRM Inbox under the lionel_eersteling workspace
    inboxService
      .notify({
        category: 'LEAD',
        type: 'CONTACT_FORM_SUBMITTED',
        title: 'New Lionel Eersteling Website Inquiry',
        message: `${inquiry.fullName} (${inquiry.company || inquiry.email}) sent a contact message on lioneleersteling.com`,
        link: '/analytics',
        workspace: 'lionel_eersteling',
        entityId: visit.id,
        dedupeKey: `LE_CONTACT_INQUIRY:${visit.id}`,
        roles: ['Approver', 'Advisor'],
      })
      .catch(() => {});

    return {
      success: true,
      inquiryId: visit.id,
      contactId: ghlContactId,
      inquiry: storedRecord,
    };
  }

  /**
   * Links lp_backend with the lioneleersteling.com Supabase project DB and dedicated GHL location
   * to pull any contact inquiries that were submitted directly through the Vercel deployment.
   */
  public async syncExternalInquiries(force = false): Promise<{ synced: number }> {
    const now = Date.now();
    if (!force && now - LionelWebsiteService.lastExternalSyncAt < LionelWebsiteService.SYNC_TTL_MS) {
      return { synced: 0 };
    }
    LionelWebsiteService.lastExternalSyncAt = now;

    if (process.env.NODE_ENV === 'test') {
      return { synced: 0 };
    }

    const cfg = getLionelWebsiteConfig();
    let synced = 0;

    // 1. Check lioneleersteling.com Supabase project (efhkllmdcduqerevtsbk) for any public contact/inquiry rows
    try {
      const tables = ['contact_submissions', 'inquiries', 'contacts'];
      for (const table of tables) {
        const res = await fetch(`${cfg.supabaseUrl}/rest/v1/${table}?select=*&limit=50`, {
          headers: {
            apikey: cfg.supabaseAnonKey,
            Authorization: `Bearer ${cfg.supabaseAnonKey}`,
          },
        });
        if (res.ok) {
          const rows = (await res.json()) as any[];
          for (const row of rows || []) {
            const email = String(row.email || '').trim().toLowerCase();
            if (!email || INTERNAL_OR_QA_EMAILS.has(email) || email.endsWith('@example.com')) continue;
            await this.submitContactInquiry({
              first_name: row.first_name || row.firstName,
              last_name: row.last_name || row.lastName,
              name: row.name || row.full_name,
              email,
              phone: row.phone,
              company: row.company,
              role: row.role,
              message: row.message || row.context || 'Strategic conversation inquiry',
              how_did_you_hear: row.how_did_you_hear,
              preferred_contact_method: row.preferred_contact_method,
              utm_source: row.utm_source,
              utm_medium: row.utm_medium,
              utm_campaign: row.utm_campaign,
              createdAt: row.created_at || row.createdAt,
              skipGhlUpsert: true,
              skipEmailNotification: true,
            });
            synced++;
          }
        }
      }
    } catch {
      // Non-blocking if table is not exposed via PostgREST
    }

    // 2. Sync from Lionel Eersteling's dedicated GHL location (where Supabase Edge Function `contact-us` writes)
    try {
      if (cfg.ghlApiKey && cfg.ghlLocationId) {
        const res = await fetch(
          `${cfg.ghlBaseUrl}/contacts/?locationId=${encodeURIComponent(cfg.ghlLocationId)}&limit=50`,
          {
            headers: {
              Authorization: `Bearer ${cfg.ghlApiKey}`,
              Version: '2021-07-28',
              Accept: 'application/json',
            },
          }
        );

        if (res.ok) {
          const data = (await res.json()) as any;
          const contacts: any[] = data?.contacts || [];
          for (const c of contacts) {
            const source = String(c.source || '');
            const tags: string[] = Array.isArray(c.tags)
              ? c.tags.map((t: any) => String(t).toLowerCase())
              : [];

            const isLeContactForm =
              source === 'Lionel Eersteling Website Contact Form' ||
              tags.includes('contact us form');
            if (!isLeContactForm) continue;

            // Skip internal notification recipient records and synthetic QA test rows
            if (tags.includes('internal-notification') || tags.includes('lp-staff')) continue;

            const email = String(c.email || '').trim().toLowerCase();
            if (!email || INTERNAL_OR_QA_EMAILS.has(email) || email.endsWith('@example.com')) continue;

            const companyName = String(c.companyName || '').trim();
            if (companyName.toLowerCase().includes('testing')) continue;

            const existing = await prisma.attributionVisit.findFirst({
              where: {
                email,
                OR: [
                  { ghlContactId: c.id },
                  { leadForm: 'le_contact_form' },
                ],
              },
            });

            if (!existing) {
              await this.submitContactInquiry({
                first_name: c.firstName || '',
                last_name: c.lastName || '',
                name: c.contactName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
                email,
                phone: c.phone || undefined,
                company: companyName || undefined,
                message: 'Strategic consultation inquiry via lioneleersteling.com',
                createdAt: c.dateAdded || new Date().toISOString(),
                ghlContactId: c.id,
                skipGhlUpsert: true,
                skipEmailNotification: true,
              });
              synced++;
            }
          }
        }
      }
    } catch (err: any) {
      console.warn('[LionelWebsiteService] External GHL sync notice:', err?.message);
    }

    return { synced };
  }

  /**
   * Retrieves stored lioneleersteling.com contact form inquiries.
   */
  public async getInquiries(options: {
    limit?: number;
    startDate?: Date;
    endDate?: Date;
  } = {}): Promise<StoredLionelInquiry[]> {
    await this.syncExternalInquiries(false);

    const limit = options.limit || 50;
    const visits = await prisma.attributionVisit.findMany({
      where: {
        email: { not: null, notIn: TEST_LEAD_EMAILS },
        ...(options.startDate && options.endDate
          ? { createdAt: { gte: options.startDate, lte: options.endDate } }
          : {}),
        OR: [
          { leadForm: 'le_contact_form' },
          { module: 'le_website' },
          { landingPage: { contains: 'lioneleersteling', mode: 'insensitive' } },
          { referrer: { contains: 'lioneleersteling', mode: 'insensitive' } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    if (visits.length === 0) return [];

    const configKeys = visits.map((v) => `le_website_inquiry_${v.id}`);
    const configs = await prisma.systemConfig.findMany({
      where: { key: { in: configKeys } },
    });
    const metaById = new Map<string, any>();
    for (const cfg of configs) {
      const id = cfg.key.replace('le_website_inquiry_', '');
      try {
        const parsed = typeof cfg.value === 'string' ? JSON.parse(cfg.value) : cfg.value;
        metaById.set(id, parsed);
      } catch {}
    }

    return visits.map((v) => {
      const meta = metaById.get(v.id) || {};
      const fullName =
        v.leadName ||
        meta.name ||
        (v.email ? v.email.split('@')[0] : 'Website inquiry');
      const parts = String(fullName).split(/\s+/);
      return {
        id: v.id,
        name: fullName,
        firstName: meta.firstName || parts[0] || '',
        lastName: meta.lastName || parts.slice(1).join(' ') || '',
        email: v.email || '',
        phone: meta.phone || null,
        company: meta.company || (v.email ? v.email.split('@')[1] : null),
        role: meta.role || null,
        message: meta.message || '',
        preferredContactMethod: meta.preferredContactMethod || 'Email',
        howDidYouHear: v.howDidYouHear || meta.howDidYouHear || null,
        source: 'form',
        form: v.leadForm || 'le_contact_form',
        utmSource: v.utmSource,
        utmMedium: v.utmMedium,
        utmCampaign: v.utmCampaign,
        landingPage: v.landingPage,
        timestamp: v.createdAt.toISOString(),
      };
    });
  }

  private async upsertLionelGhlContact(inquiry: NormalizedLionelInquiry): Promise<string | null> {
    const cfg = getLionelWebsiteConfig();
    if (!cfg.ghlApiKey || !cfg.ghlLocationId) return null;

    const tags = [
      'Contact Us Form',
      'Website Lead',
      `Preferred: ${inquiry.preferredContactMethod.toUpperCase()}`,
    ];

    const customFields: Array<{ key: string; field_value: string }> = [];
    if (inquiry.role) customFields.push({ key: 'role', field_value: inquiry.role });
    if (inquiry.preferredContactMethod) {
      customFields.push({
        key: 'preferred_contact_method',
        field_value: inquiry.preferredContactMethod,
      });
    }
    if (inquiry.message) customFields.push({ key: 'message', field_value: inquiry.message });

    const body: Record<string, unknown> = {
      locationId: cfg.ghlLocationId,
      firstName: inquiry.firstName,
      lastName: inquiry.lastName,
      email: inquiry.email,
      phone: inquiry.phone || undefined,
      companyName: inquiry.company || undefined,
      source: 'Lionel Eersteling Website Contact Form',
      tags,
      ...(customFields.length > 0 ? { customFields } : {}),
    };

    const res = await fetch(`${cfg.ghlBaseUrl}/contacts/upsert`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.ghlApiKey}`,
        'Content-Type': 'application/json',
        Version: '2021-07-28',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) return null;
    const data = (await res.json()) as any;
    return data?.contact?.id || null;
  }

  private async sendLionelNotificationEmail(inquiry: NormalizedLionelInquiry): Promise<void> {
    const cfg = getLionelWebsiteConfig();
    if (!cfg.ghlApiKey || !cfg.ghlLocationId) return;

    const recipients = [
      { email: 'asif@leadersperformance.ae', firstName: 'Muhammad', lastName: 'Asif' },
      { email: 'mirza@leadersperformance.ae', firstName: 'Mirza', lastName: 'Asad' },
    ];
    if (process.env.DRY_RUN_EMAIL_OVERRIDE !== 'true') {
      recipients.push({
        email: 'lionel@leadersperformance.ae',
        firstName: 'Lionel',
        lastName: 'Eersteling',
      });
    }

    const headers = {
      Authorization: `Bearer ${cfg.ghlApiKey}`,
      'Content-Type': 'application/json',
      Version: '2021-07-28',
    };

    const subject = `[New Consultation Enquiry] ${inquiry.fullName} (${inquiry.company || 'Individual'})`;
    const html = `<p>New inquiry on <strong>lioneleersteling.com</strong> from <strong>${inquiry.fullName}</strong> (${inquiry.email}).</p><p>Company: ${inquiry.company || 'N/A'} | Role: ${inquiry.role || 'N/A'}</p><p>Message: ${inquiry.message}</p>`;

    for (const r of recipients) {
      const uRes = await fetch(`${cfg.ghlBaseUrl}/contacts/upsert`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          locationId: cfg.ghlLocationId,
          firstName: r.firstName,
          lastName: r.lastName,
          email: r.email,
          tags: ['internal-notification', 'lp-staff'],
        }),
      });
      const uData = (await uRes.json()) as any;
      const contactId = uData?.contact?.id;
      if (!contactId) continue;

      await fetch(`${cfg.ghlBaseUrl}/conversations/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          type: 'Email',
          contactId,
          subject,
          html,
          emailFrom: 'Lionel Eersteling <info@lioneleersteling.com>',
        }),
      });
    }
  }
}

export const lionelWebsiteService = new LionelWebsiteService();
