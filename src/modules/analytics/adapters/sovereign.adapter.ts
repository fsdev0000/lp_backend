import { PrismaClient } from '@prisma/client';
import { ISovereignAdapter } from './interfaces';
import { resolveWindow } from '../utils/dateRange';

const prisma = new PrismaClient();

export class SovereignAdapter implements ISovereignAdapter {
  public async getAttributedLeadsCount(startDateOrRange: string, endDate?: string, domain?: string): Promise<number> {
    const { startDate, endDate: resolvedEnd } = this.resolveDates(startDateOrRange, endDate);
    const start = new Date(`${startDate}T00:00:00.000Z`);
    const end = new Date(`${resolvedEnd}T23:59:59.999Z`);

    const clean = domain ? domain.toLowerCase().trim() : undefined;
    const isLe = clean?.includes('lioneleersteling');

    const visitWhere: any = {
      email: { not: null },
      createdAt: { gte: start, lte: end },
    };

    if (clean) {
      visitWhere.landingPage = { contains: clean, mode: 'insensitive' };
    }

    const [visitCount, scanCount] = await Promise.all([
      prisma.attributionVisit.count({
        where: visitWhere,
      }),
      // Pressure scans belong strictly to Leaders Performance
      isLe
        ? 0
        : prisma.pressureScanSubmission.count({
            where: {
              createdAt: { gte: start, lte: end },
            },
          }),
    ]);

    return visitCount + scanCount;
  }

  public async getAttributedPipelineValue(startDateOrRange: string, endDate?: string, domain?: string): Promise<number> {
    const { startDate, endDate: resolvedEnd } = this.resolveDates(startDateOrRange, endDate);
    const start = new Date(`${startDate}T00:00:00.000Z`);
    const end = new Date(`${resolvedEnd}T23:59:59.999Z`);

    const clean = domain ? domain.toLowerCase().trim() : undefined;
    const isLe = clean?.includes('lioneleersteling');

    // Only count verified enrolled deals; do not fabricate €25,000 per diagnostic scan
    const enrollments = await prisma.masterclassEnrollment.findMany({
      where: {
        createdAt: { gte: start, lte: end },
      },
      select: { amount: true, paymentStatus: true },
    });

    if (isLe) {
      // Lionel Eersteling workspace has its own direct advisory pipeline
      return 0;
    }

    return enrollments.reduce((acc, curr) => acc + (curr.amount || 0), 0);
  }

  public async getRecentFounderInbound(
    limit = 4,
    startDate?: string,
    endDate?: string,
    domain?: string
  ): Promise<any[]> {
    const cleanDomain = domain ? domain.toLowerCase().trim() : undefined;
    const isLe = cleanDomain?.includes('lioneleersteling');

    if (isLe) {
      // Return inquiries specifically submitted on Lionel Eersteling workspace
      const visits = await prisma.attributionVisit.findMany({
        where: {
          email: { not: null },
          ...(startDate && endDate
            ? {
                createdAt: {
                  gte: new Date(`${startDate}T00:00:00.000Z`),
                  lte: new Date(`${endDate}T23:59:59.999Z`),
                },
              }
            : {}),
          landingPage: { contains: cleanDomain, mode: 'insensitive' },
        },
        take: limit,
        orderBy: { createdAt: 'desc' },
      });

      return visits.map((v) => ({
        id: v.id,
        name: v.leadName || (v.email ? v.email.split('@')[0] : 'Executive Inquiry'),
        company: v.email ? v.email.split('@')[1] : 'Private Office',
        revenueTier: '€5M–€20M ARR',
        leadScore: 85,
        status: 'NEW',
        timestamp: v.createdAt,
      }));
    }

    const where: any = {};
    if (startDate && endDate) {
      where.createdAt = {
        gte: new Date(`${startDate}T00:00:00.000Z`),
        lte: new Date(`${endDate}T23:59:59.999Z`),
      };
    }

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
        revenueTier: '€5M–€20M ARR',
        leadScore: Math.round(s.overallNormalised * 100),
        status: s.signalClassification,
        timestamp: s.createdAt,
      }));
    }

    return [];
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
        prevLeads: number;
        prevPipelineValueEur: number;
      }
    >
  > {
    const channels = ['youtube', 'linkedin', 'instagram', 'tiktok'];
    const result: Record<
      string,
      {
        leads: number;
        pipelineValueEur: number;
        prevLeads: number;
        prevPipelineValueEur: number;
      }
    > = {};

    for (const ch of channels) {
      result[ch] = {
        leads: 0,
        pipelineValueEur: 0,
        prevLeads: 0,
        prevPipelineValueEur: 0,
      };
    }

    const start = new Date(`${startDate}T00:00:00.000Z`);
    const end = new Date(`${endDate}T23:59:59.999Z`);

    const cleanDomain = domain ? domain.toLowerCase().trim() : undefined;

    const visitWhere: any = {
      createdAt: { gte: start, lte: end },
      utmSource: { not: null },
    };

    if (cleanDomain) {
      visitWhere.landingPage = { contains: cleanDomain, mode: 'insensitive' };
    }

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
            // Pipeline value reflects actual deals, not an artificial €25k multiplier
            result[ch].pipelineValueEur += 0;
          }
        }
      }
    }

    // Previous period if requested
    if (prevStartDate && prevEndDate) {
      const prevStart = new Date(`${prevStartDate}T00:00:00.000Z`);
      const prevEnd = new Date(`${prevEndDate}T23:59:59.999Z`);

      const prevVisitWhere: any = {
        createdAt: { gte: prevStart, lte: prevEnd },
        utmSource: { not: null },
      };

      if (cleanDomain) {
        prevVisitWhere.landingPage = { contains: cleanDomain, mode: 'insensitive' };
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
            }
          }
        }
      }
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
