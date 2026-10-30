import { PrismaClient } from '@prisma/client';
import { ISovereignAdapter } from './interfaces';
import { resolveWindow } from '../utils/dateRange';

const prisma = new PrismaClient();

export class SovereignAdapter implements ISovereignAdapter {
  public async getAttributedLeadsCount(startDateOrRange: string, endDate?: string, domain?: string): Promise<number> {
    const { startDate, endDate: resolvedEnd } = this.resolveDates(startDateOrRange, endDate);
    const start = new Date(`${startDate}T00:00:00.000Z`);
    const end = new Date(`${resolvedEnd}T23:59:59.999Z`);

    const visitWhere: any = {
      email: { not: null },
      createdAt: { gte: start, lte: end },
    };

    if (domain) {
      const clean = domain.toLowerCase().trim();
      visitWhere.landingPage = { contains: clean, mode: 'insensitive' };
    }

    const [visitCount, scanCount] = await Promise.all([
      prisma.attributionVisit.count({
        where: visitWhere,
      }),
      prisma.pressureScanSubmission.count({
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

    const [enrollments, scans] = await Promise.all([
      prisma.masterclassEnrollment.findMany({
        where: {
          createdAt: { gte: start, lte: end },
        },
        select: { amount: true, paymentStatus: true },
      }),
      prisma.pressureScanSubmission.count({
        where: {
          createdAt: { gte: start, lte: end },
        },
      }),
    ]);

    let value = enrollments.reduce((acc, curr) => acc + (curr.amount || 75000), 0);
    value += scans * 25000;

    return value;
  }

  public async getRecentFounderInbound(
    limit = 4,
    startDate?: string,
    endDate?: string,
    domain?: string
  ): Promise<any[]> {
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

    // Fetch visits with utmSource in window
    const visits = await prisma.attributionVisit.findMany({
      where: {
        createdAt: { gte: start, lte: end },
        utmSource: { not: null },
      },
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
            result[ch].pipelineValueEur += 25000;
          }
        }
      }
    }

    // Previous period if requested
    if (prevStartDate && prevEndDate) {
      const prevStart = new Date(`${prevStartDate}T00:00:00.000Z`);
      const prevEnd = new Date(`${prevEndDate}T23:59:59.999Z`);

      const prevVisits = await prisma.attributionVisit.findMany({
        where: {
          createdAt: { gte: prevStart, lte: prevEnd },
          utmSource: { not: null },
        },
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
              result[ch].prevPipelineValueEur += 25000;
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
