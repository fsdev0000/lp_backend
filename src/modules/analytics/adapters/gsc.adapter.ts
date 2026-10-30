import { google } from 'googleapis';
import { PrismaClient } from '@prisma/client';
import { IGscAdapter, GscQueryRow, GscTotals, GscKeywordsResponse } from './interfaces';
import { validateAnalyticsCredentials } from './credentialValidator';
import { LiveErrorBoundary } from './liveErrorBoundary';
import { resolveWindow } from '../utils/dateRange';

import path from 'path';
import fs from 'fs';

const prisma = new PrismaClient();

// Polyfill global.window with globalThis so Gaxios uses Node's native fetch
// rather than attempting an experimental-vm dynamic import of node-fetch in Jest/Node environments.
if (typeof (global as any).window === 'undefined') {
  (global as any).window = globalThis;
}

export class GscAdapter implements IGscAdapter {
  private searchconsole: any = null;
  private defaultSiteUrl: string;

  constructor() {
    const creds = validateAnalyticsCredentials().gsc;
    this.defaultSiteUrl = creds.siteUrl || 'https://leadersperformance.ae/';

    const keyPath = path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS || './private/service_account.json');

    if (fs.existsSync(keyPath)) {
      try {
        const auth = new google.auth.GoogleAuth({
          keyFilename: keyPath,
          scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
        });
        this.searchconsole = google.searchconsole({ version: 'v1', auth });
      } catch (err) {
        console.warn('[GscAdapter] Failed to initialize Google Search Console client with keyfile:', err);
      }
    } else if (creds.isConfigured && creds.serviceAccountEmail && creds.privateKey) {
      try {
        const auth = new google.auth.JWT({
          email: creds.serviceAccountEmail,
          key: creds.privateKey.replace(/\\n/g, '\n'),
          scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
        });
        this.searchconsole = google.searchconsole({ version: 'v1', auth });
      } catch (err) {
        console.warn('[GscAdapter] Failed to initialize Google Search Console client:', err);
      }
    } else {
      try {
        const auth = new google.auth.GoogleAuth({
          scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
        });
        this.searchconsole = google.searchconsole({ version: 'v1', auth });
      } catch (err) {
        console.warn('[GscAdapter] Google ADC Search Console fallback notice:', err);
      }
    }
  }

  /**
   * Resolves target siteUrl based on requested domain or fallback default
   */
  public resolveSiteUrl(domain?: string): string {
    if (!domain) {
      return this.defaultSiteUrl;
    }
    const clean = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (clean === 'leadersperformance.ae' || clean.includes('leadersperformance')) {
      return 'https://leadersperformance.ae/';
    }
    if (clean === 'lioneleersteling.com' || clean.includes('lioneleersteling')) {
      return 'https://lioneleersteling.com/';
    }
    return `https://${clean}/`;
  }

  /**
   * Resolves dates honoring Google Search Console's 2-day finalization lag
   */
  public resolveDateRange(days: number | string = 30, customStartDate?: string, customEndDate?: string) {
    const rangeStr = typeof days === 'number' ? `${days}d` : days;
    const win = resolveWindow(rangeStr, 2, customStartDate, customEndDate);
    return {
      startDate: win.startDate,
      endDate: win.endDate,
      rangeLabel: customStartDate && customEndDate ? `${customStartDate}..${customEndDate}` : win.range,
    };
  }

  /**
   * Retrieves Google Search Console top queries alongside true aggregate site totals
   * (including hidden / low-volume queries)
   */
  public async getTopSearchQueries(
    days = 30,
    limit = 100,
    domain?: string,
    customStartDate?: string,
    customEndDate?: string
  ): Promise<GscKeywordsResponse> {
    const siteUrl = this.resolveSiteUrl(domain);
    const { startDate, endDate, rangeLabel } = this.resolveDateRange(days, customStartDate, customEndDate);

    const emptyTotals: GscTotals = {
      clicks: 0,
      impressions: 0,
      ctr: '0.0%',
      ctrValue: 0,
      position: 0,
    };

    if (!this.searchconsole) {
      console.warn('[GscAdapter] Search Console client not initialized');
      return {
        totals: emptyTotals,
        queries: [],
        range: rangeLabel,
        domain: siteUrl,
        startDate,
        endDate,
        totalQueries: 0,
      };
    }

    try {
      // 1. Query real totals without dimensions (includes hidden and anonymized queries)
      // 2. Query individual query rows with dimensions: ['query']
      const [totalRes, queryRes] = await Promise.all([
        this.searchconsole.searchanalytics.query({
          siteUrl,
          requestBody: {
            startDate,
            endDate,
          },
        }).catch((err: any) => {
          console.warn('[GscAdapter] Failed to query totals:', err.message || err);
          return { data: { rows: [] } };
        }),
        this.searchconsole.searchanalytics.query({
          siteUrl,
          requestBody: {
            startDate,
            endDate,
            dimensions: ['query'],
            rowLimit: limit,
          },
        }).catch((err: any) => {
          console.warn('[GscAdapter] Failed to query search queries:', err.message || err);
          return { data: { rows: [] } };
        }),
      ]);

      const totalRow = totalRes.data?.rows?.[0];
      const totals: GscTotals = totalRow
        ? {
            clicks: totalRow.clicks ?? 0,
            impressions: totalRow.impressions ?? 0,
            ctr: `${((totalRow.ctr ?? 0) * 100).toFixed(1)}%`,
            ctrValue: totalRow.ctr ?? 0,
            position: Number((totalRow.position ?? 0).toFixed(1)),
          }
        : emptyTotals;

      const rows = queryRes.data?.rows || [];
      const queries: GscQueryRow[] = rows.map((r: any) => ({
        query: r.keys?.[0] || 'Unknown Query',
        impressions: r.impressions || 0,
        clicks: r.clicks || 0,
        ctr: `${((r.ctr || 0) * 100).toFixed(1)}%`,
        position: Number((r.position || 0).toFixed(1)),
      }));

      return {
        totals,
        queries,
        range: rangeLabel,
        domain: siteUrl,
        startDate,
        endDate,
        totalQueries: queries.length,
      };
    } catch (error: any) {
      await LiveErrorBoundary.logUpstreamError('GSC', 'searchanalytics.query', error);
      // Clean zeroed state - NEVER return fabricated/fake fallback queries!
      return {
        totals: emptyTotals,
        queries: [],
        range: rangeLabel,
        domain: siteUrl,
        startDate,
        endDate,
        totalQueries: 0,
      };
    }
  }

  /**
   * 4.1 & 4.2: Ingests Search Console queries with dimensions ['query', 'page'],
   * calculates SERP rank rounded to 1 decimal place, and upserts into SearchConsoleKeyword table.
   */
  public async syncKeywords(days = 30, limit = 50, domain?: string): Promise<{ upserted: number; siteUrl: string }> {
    const siteUrl = this.resolveSiteUrl(domain);
    const { startDate, endDate } = this.resolveDateRange(days);

    if (!this.searchconsole) {
      console.warn('[GscAdapter] Cannot sync keywords: client not initialized');
      return { upserted: 0, siteUrl };
    }

    try {
      const queryRes = await this.searchconsole.searchanalytics.query({
        siteUrl,
        requestBody: {
          startDate,
          endDate,
          dimensions: ['query', 'page'],
          rowLimit: limit,
        },
      });

      const rows = queryRes.data?.rows || [];
      let upserted = 0;
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);

      for (const row of rows) {
        const query = row.keys?.[0] || 'unknown';
        const targetPage = row.keys?.[1] || null;
        const impressions = row.impressions || 0;
        const clicks = row.clicks || 0;
        const ctr = parseFloat(Number(row.ctr || 0).toFixed(4));
        const position = parseFloat(Number(row.position || 0).toFixed(1));

        await prisma.searchConsoleKeyword.upsert({
          where: {
            query_snapshotDate_country: {
              query,
              snapshotDate: today,
              country: 'GLOBAL',
            },
          },
          create: {
            query,
            targetPage,
            impressions,
            clicks,
            ctr,
            position,
            country: 'GLOBAL',
            snapshotDate: today,
          },
          update: {
            targetPage,
            impressions,
            clicks,
            ctr,
            position,
          },
        });
        upserted++;
      }

      console.log(`[GscAdapter] Successfully synchronized ${upserted} keywords for ${siteUrl}`);
      return { upserted, siteUrl };
    } catch (error: any) {
      await LiveErrorBoundary.logUpstreamError('GSC', 'syncKeywords', error);
      return { upserted: 0, siteUrl };
    }
  }

  public async ping(): Promise<{ status: 'HEALTHY' | 'DEGRADED' | 'DOWN'; latencyMs: number }> {
    const start = Date.now();
    if (!this.searchconsole) {
      return { status: 'DEGRADED', latencyMs: Date.now() - start };
    }
    try {
      await this.searchconsole.sites.get({ siteUrl: this.defaultSiteUrl });
      return { status: 'HEALTHY', latencyMs: Date.now() - start };
    } catch {
      return { status: 'DOWN', latencyMs: Date.now() - start };
    }
  }
}
