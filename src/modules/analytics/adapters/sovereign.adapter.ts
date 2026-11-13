import { PrismaClient } from '@prisma/client';
import { ISovereignAdapter } from './interfaces';
import { resolveWindow, dubaiDateToStartOfDayUtc, dubaiDateToEndOfDayUtc } from '../utils/dateRange';
import {
  NOT_SCAN_VISIT,
  countDistinctEmails,
  inquiryVisitWhere,
  isLeDomain,
  scanWhere,
} from '../utils/inquiries';

const prisma = new PrismaClient();

export class SovereignAdapter implements ISovereignAdapter {
  public async getAttributedLeadsCount(startDateOrRange: string, endDate?: string, domain?: string): Promise<number> {
    const { startDate, endDate: resolvedEnd } = this.resolveDates(startDateOrRange, endDate);
    // Item 2.8: Use Asia/Dubai timezone boundaries
    const start = dubaiDateToStartOfDayUtc(startDate);
    const end = dubaiDateToEndOfDayUtc(resolvedEnd);

    const createdAt = { gte: start, lte: end };

    const [visitEmails, scanEmails] = await Promise.all([
      // Item 2.6: website forms, matched to the site without requiring the domain in the path
      prisma.attributionVisit.findMany({
        where: inquiryVisitWhere(domain, createdAt),
        distinct: ['email'],
        select: { email: true },
      }),
      // Item 2.7: Pressure scans belong strictly to Leaders Performance, exclude test scans
      isLeDomain(domain)
        ? []
        : prisma.pressureScanSubmission.findMany({
            where: scanWhere(createdAt),
            distinct: ['email'],
            select: { email: true },
          }),
    ]);

    // Item 2.9: one person counts once. A scan also saves an attribution visit with the email, so adding the two
    // lists counted every scan twice.
    return countDistinctEmails([...visitEmails, ...scanEmails]);
  }

  public async getAttributedPipelineValue(startDateOrRange: string, endDate?: string, domain?: string): Promise<number> {
    const { startDate, endDate: resolvedEnd } = this.resolveDates(startDateOrRange, endDate);
    // Item 2.8: Use Asia/Dubai timezone boundaries
    const start = dubaiDateToStartOfDayUtc(startDate);
    const end = dubaiDateToEndOfDayUtc(resolvedEnd);

    const clean = domain ? domain.toLowerCase().trim() : undefined;
    const isLe = clean?.includes('lioneleersteling');

    if (isLe) {
      // Lionel Eersteling workspace has its own direct advisory pipeline
      return 0;
    }

    // Item 2.3: Only count verified paid deals; divide cents by 100
    const enrollments = await prisma.masterclassEnrollment.findMany({
      where: {
        createdAt: { gte: start, lte: end },
        paymentStatus: { in: ['paid', 'PAID'] },
      },
      select: { amount: true, paymentStatus: true },
    });

    const totalCents = enrollments.reduce((acc, curr) => acc + (curr.amount || 0), 0);
    return Math.round((totalCents / 100) * 100) / 100;
  }

  public async getRecentFounderInbound(
    limit = 4,
    startDate?: string,
    endDate?: string,
    domain?: string
  ): Promise<any[]> {
    const createdAt =
      startDate && endDate
        ? { gte: dubaiDateToStartOfDayUtc(startDate), lte: dubaiDateToEndOfDayUtc(endDate) }
        : undefined;
    const isLe = isLeDomain(domain);

    const [visits, scans] = await Promise.all([
      // Website forms. A scan's own visit (lead_form founder_pressure_scan) is left out: the scan is listed itself.
      // Older submissions copied the email onto earlier visits, so read extra rows and keep the latest per email.
      prisma.attributionVisit.findMany({
        where: { AND: [inquiryVisitWhere(domain, createdAt), NOT_SCAN_VISIT] },
        take: limit * 10,
        orderBy: { createdAt: 'desc' },
      }),
      isLe
        ? []
        : prisma.pressureScanSubmission.findMany({
            where: scanWhere(createdAt),
            take: limit,
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              fullName: true,
              companyName: true,
              overallNormalised: true,
              signalClassification: true,
              createdAt: true,
            },
          }),
    ]);

    const seen = new Set<string>();
    const forms = visits
      .filter((v) => {
        const email = v.email?.trim().toLowerCase();
        if (!email || seen.has(email)) return false;
        seen.add(email);
        return true;
      })
      .map((v) => ({
        id: v.id,
        name: v.leadName || (v.email ? v.email.split('@')[0] : 'Website inquiry'),
        company: v.email ? v.email.split('@')[1] : null,
        revenueTier: null, // Item 2.2: Do not invent revenue tier
        leadScore: null, // Item 2.2: forms have no score
        status: 'NEW',
        source: 'form',
        form: v.leadForm,
        timestamp: v.createdAt,
      }));

    const scanRows = scans.map((s) => ({
      id: s.id,
      name: s.fullName,
      company: s.companyName,
      revenueTier: null, // Item 2.2: Return null for uncollected revenueTier
      leadScore: Math.round(s.overallNormalised), // Item 2.1: overallNormalised is already 0-100
      status: s.signalClassification,
      source: 'scan',
      form: 'founder_pressure_scan',
      timestamp: s.createdAt,
    }));

    // Item 2.10: scans and website forms together, newest first (forms used to show only when there were no scans).
    return [...scanRows, ...forms]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, limit);
  }

  public async getChannelAttribution(
    startDate: string,
    endDate: string,
    prevStartDate?: string | null,
    prevEndDate?: string | null,
    domain?: string
  ): Promise<
    Record<
      string,
      {
        leads: number;
        pipelineValueEur: number;
        pipelineValueUsd: number;
        prevLeads: number;
        prevPipelineValueEur: number;
        prevPipelineValueUsd: number;
      }
    >
  > {
    const channels = ['youtube', 'linkedin', 'instagram', 'tiktok'];
    const result: Record<
      string,
      {
        leads: number;
        pipelineValueEur: number;
        pipelineValueUsd: number;
        prevLeads: number;
        prevPipelineValueEur: number;
        prevPipelineValueUsd: number;
      }
    > = {};

    for (const ch of channels) {
      result[ch] = {
        leads: 0,
        pipelineValueEur: 0,
        pipelineValueUsd: 0,
        prevLeads: 0,
        prevPipelineValueEur: 0,
        prevPipelineValueUsd: 0,
      };
    }

    const start = dubaiDateToStartOfDayUtc(startDate);
    const end = dubaiDateToEndOfDayUtc(endDate);

    // Leads per channel: different people (emails) who arrived with that utm_source, not every visit row.
    const countByChannel = async (createdAt: { gte: Date; lte: Date }) => {
      const visits = await prisma.attributionVisit.findMany({
        where: { AND: [inquiryVisitWhere(domain, createdAt), { utmSource: { not: null } }] },
        select: { utmSource: true, email: true },
      });
      const emailsByChannel = new Map<string, Set<string>>();
      for (const v of visits) {
        const src = (v.utmSource || '').toLowerCase();
        const email = v.email?.trim().toLowerCase();
        if (!email) continue;
        for (const ch of channels) {
          if (!src.includes(ch)) continue;
          if (!emailsByChannel.has(ch)) emailsByChannel.set(ch, new Set());
          emailsByChannel.get(ch)!.add(email);
        }
      }
      return emailsByChannel;
    };

    try {
      const current = await countByChannel({ gte: start, lte: end });
      for (const [ch, emails] of current) result[ch].leads = emails.size;

      // Previous period if requested. Pipeline value per channel stays 0: deals aren't linked to channels.
      if (prevStartDate && prevEndDate) {
        const previous = await countByChannel({
          gte: dubaiDateToStartOfDayUtc(prevStartDate),
          lte: dubaiDateToEndOfDayUtc(prevEndDate),
        });
        for (const [ch, emails] of previous) result[ch].prevLeads = emails.size;
      }
    } catch (err) {
      console.warn('[SovereignAdapter] getChannelAttribution database query failed, using empty attribution:', err);
    }

    return result;
  }

  private resolveDates(startDateOrRange: string, endDate?: string): { startDate: string; endDate: string } {
    if (endDate) {
      return { startDate: startDateOrRange, endDate };
    }
    const win = resolveWindow(startDateOrRange, 1);
    return { startDate: win.startDate, endDate: win.endDate };
  }
}
