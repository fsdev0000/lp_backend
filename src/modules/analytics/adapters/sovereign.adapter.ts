import { PrismaClient } from '@prisma/client';
import { ISovereignAdapter } from './interfaces';
import { resolveWindow, dubaiDateToStartOfDayUtc, dubaiDateToEndOfDayUtc } from '../utils/dateRange';

const prisma = new PrismaClient();

export class SovereignAdapter implements ISovereignAdapter {
  public async getAttributedLeadsCount(startDateOrRange: string, endDate?: string, domain?: string): Promise<number> {
    const { startDate, endDate: resolvedEnd } = this.resolveDates(startDateOrRange, endDate);
    // Item 2.8: Use Asia/Dubai timezone boundaries
    const start = dubaiDateToStartOfDayUtc(startDate);
    const end = dubaiDateToEndOfDayUtc(resolvedEnd);

    const clean = domain ? domain.toLowerCase().trim() : undefined;
    const isLe = clean?.includes('lioneleersteling');

    const visitWhere: any = {
      email: { not: null },
      createdAt: { gte: start, lte: end },
    };

    // Item 2.6: Correct website form attribution without requiring domain in path
    if (isLe) {
      visitWhere.OR = [
        { landingPage: { contains: 'lioneleersteling', mode: 'insensitive' } },
        { referrer: { contains: 'lioneleersteling', mode: 'insensitive' } },
      ];
    } else {
      visitWhere.OR = [
        { landingPage: { startsWith: '/' } },
        { landingPage: { contains: 'leadersperformance', mode: 'insensitive' } },
        { referrer: { contains: 'leadersperformance', mode: 'insensitive' } },
      ];
      visitWhere.NOT = [
        { landingPage: { contains: 'lioneleersteling', mode: 'insensitive' } },
        { referrer: { contains: 'lioneleersteling', mode: 'insensitive' } },
      ];
    }

    const [visitEmails, scanSubmissions] = await Promise.all([
      // Item 2.9: Count distinct lead conversions to avoid visit duplication
      prisma.attributionVisit.findMany({
        where: visitWhere,
        distinct: ['email'],
        select: { email: true },
      }),
      // Item 2.7: Pressure scans belong strictly to Leaders Performance, exclude test scans
      isLe
        ? []
        : prisma.pressureScanSubmission.findMany({
            where: {
              createdAt: { gte: start, lte: end },
              email: { notIn: ['pdf@company.ae', 'dossier@company.ae', 'sanitize@company.ae', 'tieddomains@company.ae', 'domainmean@company.ae'] },
            },
            distinct: ['email'],
            select: { email: true },
          }),
    ]);

    return visitEmails.length + scanSubmissions.length;
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
    const cleanDomain = domain ? domain.toLowerCase().trim() : undefined;
    const isLe = cleanDomain?.includes('lioneleersteling');

    const dateFilter: any = {};
    if (startDate && endDate) {
      dateFilter.gte = dubaiDateToStartOfDayUtc(startDate);
      dateFilter.lte = dubaiDateToEndOfDayUtc(endDate);
    }

    if (isLe) {
      // Return inquiries specifically submitted on Lionel Eersteling workspace
      const visits = await prisma.attributionVisit.findMany({
        where: {
          email: { not: null },
          ...(startDate && endDate ? { createdAt: dateFilter } : {}),
          OR: [
            { landingPage: { contains: 'lioneleersteling', mode: 'insensitive' } },
            { referrer: { contains: 'lioneleersteling', mode: 'insensitive' } },
          ],
        },
        take: limit,
        orderBy: { createdAt: 'desc' },
      });

      return visits.map((v) => ({
        id: v.id,
        name: v.leadName || (v.email ? v.email.split('@')[0] : 'Executive Inquiry'),
        company: v.email ? v.email.split('@')[1] : 'Private Office',
        revenueTier: null, // Item 2.2: Do not invent revenue tier
        leadScore: null,   // Item 2.2: Return null for uncollected score
        status: 'NEW',
        timestamp: v.createdAt,
      }));
    }

    const where: any = {
      ...(startDate && endDate ? { createdAt: dateFilter } : {}),
      email: { notIn: ['pdf@company.ae', 'dossier@company.ae', 'sanitize@company.ae', 'tieddomains@company.ae', 'domainmean@company.ae'] },
    };

    const scans = await prisma.pressureScanSubmission.findMany({
      where,
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
    });

    if (scans.length > 0) {
      return scans.map((s) => ({
        id: s.id,
        name: s.fullName,
        company: s.companyName,
        revenueTier: null, // Item 2.2: Return null for uncollected revenueTier
        leadScore: Math.round(s.overallNormalised), // Item 2.1: overallNormalised is already 0-100
        status: s.signalClassification,
        timestamp: s.createdAt,
      }));
    }

    // Also check general website inquiries if no scans found (Item 2.6)
    const websiteVisits = await prisma.attributionVisit.findMany({
      where: {
        email: { not: null },
        ...(startDate && endDate ? { createdAt: dateFilter } : {}),
        OR: [
          { landingPage: { startsWith: '/' } },
          { landingPage: { contains: 'leadersperformance', mode: 'insensitive' } },
          { referrer: { contains: 'leadersperformance', mode: 'insensitive' } },
        ],
        NOT: [
          { landingPage: { contains: 'lioneleersteling', mode: 'insensitive' } },
        ],
      },
      take: limit,
      orderBy: { createdAt: 'desc' },
    });

    return websiteVisits.map((v) => ({
      id: v.id,
      name: v.leadName || (v.email ? v.email.split('@')[0] : 'Website Inquiry'),
      company: v.email ? v.email.split('@')[1] : 'Executive Inquiry',
      revenueTier: null,
      leadScore: null,
      status: 'NEW',
      timestamp: v.createdAt,
    }));
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

    const cleanDomain = domain ? domain.toLowerCase().trim() : undefined;
    const isLe = cleanDomain?.includes('lioneleersteling');

    const visitWhere: any = {
      createdAt: { gte: start, lte: end },
      utmSource: { not: null },
    };

    if (isLe) {
      visitWhere.OR = [
        { landingPage: { contains: 'lioneleersteling', mode: 'insensitive' } },
        { referrer: { contains: 'lioneleersteling', mode: 'insensitive' } },
      ];
    } else {
      visitWhere.OR = [
        { landingPage: { startsWith: '/' } },
        { landingPage: { contains: 'leadersperformance', mode: 'insensitive' } },
        { referrer: { contains: 'leadersperformance', mode: 'insensitive' } },
      ];
      visitWhere.NOT = [
        { landingPage: { contains: 'lioneleersteling', mode: 'insensitive' } },
      ];
    }

    try {
      // Fetch visits with utmSource in window and matching domain
      const visits = await prisma.attributionVisit.findMany({
        where: visitWhere,
        select: {
          utmSource: true,
          email: true,
        },
      });

      for (const v of visits) {
        const src = (v.utmSource || '').toLowerCase();
        for (const ch of channels) {
          if (src.includes(ch)) {
            if (v.email) {
              result[ch].leads += 1;
              result[ch].pipelineValueEur += 0;
              result[ch].pipelineValueUsd += 0;
            }
          }
        }
      }

      // Previous period if requested
      if (prevStartDate && prevEndDate) {
        const prevStart = dubaiDateToStartOfDayUtc(prevStartDate);
        const prevEnd = dubaiDateToEndOfDayUtc(prevEndDate);

        const prevVisitWhere: any = {
          createdAt: { gte: prevStart, lte: prevEnd },
          utmSource: { not: null },
        };

        if (isLe) {
          prevVisitWhere.OR = [
            { landingPage: { contains: 'lioneleersteling', mode: 'insensitive' } },
            { referrer: { contains: 'lioneleersteling', mode: 'insensitive' } },
          ];
        } else {
          prevVisitWhere.OR = [
            { landingPage: { startsWith: '/' } },
            { landingPage: { contains: 'leadersperformance', mode: 'insensitive' } },
            { referrer: { contains: 'leadersperformance', mode: 'insensitive' } },
          ];
          prevVisitWhere.NOT = [
            { landingPage: { contains: 'lioneleersteling', mode: 'insensitive' } },
          ];
        }

        const prevVisits = await prisma.attributionVisit.findMany({
          where: prevVisitWhere,
          select: {
            utmSource: true,
            email: true,
          },
        });

        for (const v of prevVisits) {
          const src = (v.utmSource || '').toLowerCase();
          for (const ch of channels) {
            if (src.includes(ch)) {
              if (v.email) {
                result[ch].prevLeads += 1;
                result[ch].prevPipelineValueEur += 0;
                result[ch].prevPipelineValueUsd += 0;
              }
            }
          }
        }
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
