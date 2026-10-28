import dotenv from 'dotenv';
dotenv.config();

import path from 'path';
import { BetaAnalyticsDataClient } from '@google-analytics/data';
import { google } from 'googleapis';

const keyPath = path.resolve('./private/service_account.json');

export async function fetchLiveGoogleData() {
  console.log('================================================================');
  console.log('   LIVE GOOGLE ANALYTICS 4 & SEARCH CONSOLE DATA REPORT');
  console.log('================================================================\n');

  // --- 1. GOOGLE ANALYTICS 4 ---
  const propertyId = process.env.GA4_PROPERTY_ID || '551289575';
  console.log(`[GA4] Connected Property: properties/${propertyId}`);

  try {
    const ga4Client = new BetaAnalyticsDataClient({ keyFilename: keyPath });

    // Realtime Active Users
    const [realtime] = await ga4Client.runRealtimeReport({
      property: `properties/${propertyId}`,
      dimensions: [{ name: 'country' }],
      metrics: [{ name: 'activeUsers' }],
    });

    let totalActive = 0;
    const countries: Record<string, number> = {};
    realtime.rows?.forEach(row => {
      const country = row.dimensionValues?.[0]?.value || 'Unknown';
      const count = parseInt(row.metricValues?.[0]?.value || '0', 10);
      totalActive += count;
      countries[country] = count;
    });

    console.log(`\n🟢 [GA4 REALTIME] Active Users Right Now: ${totalActive}`);
    if (Object.keys(countries).length > 0) {
      console.log('   Active Users by Country:');
      Object.entries(countries).forEach(([c, n]) => console.log(`   - ${c}: ${n}`));
    } else {
      console.log('   (0 users currently browsing leadersperformance.ae)');
    }

    // 30 Days Traffic / Channel Acquisition
    console.log('\n📊 [GA4 30-DAY ACQUISITION]');
    const [report] = await ga4Client.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'sessionDefaultChannelGroup' }],
      metrics: [
        { name: 'totalUsers' },
        { name: 'sessions' },
        { name: 'conversions' },
        { name: 'bounceRate' },
      ],
    });

    if (report.rows && report.rows.length > 0) {
      console.log('---------------------------------------------------------------------------------------');
      console.log('| Channel Group            | Users    | Sessions | Conversions | Bounce Rate          |');
      console.log('---------------------------------------------------------------------------------------');
      report.rows.forEach(r => {
        const channel = (r.dimensionValues?.[0]?.value || 'Direct').padEnd(24);
        const users = (r.metricValues?.[0]?.value || '0').padEnd(8);
        const sessions = (r.metricValues?.[1]?.value || '0').padEnd(8);
        const conv = (r.metricValues?.[2]?.value || '0').padEnd(11);
        const bounce = `${(parseFloat(r.metricValues?.[3]?.value || '0') * 100).toFixed(1)}%`.padEnd(20);
        console.log(`| ${channel} | ${users} | ${sessions} | ${conv} | ${bounce} |`);
      });
      console.log('---------------------------------------------------------------------------------------');
    } else {
      console.log('   (No traffic recorded in GA4 for this property yet in the last 30 days)');
    }

  } catch (err: any) {
    console.error('❌ [GA4 ERROR]:', err.message);
  }

  // --- 2. GOOGLE SEARCH CONSOLE ---
  const siteUrl = process.env.GSC_SITE_URL || 'https://leadersperformance.ae/';
  console.log(`\n\n🔍 [GSC] Site Property: ${siteUrl}`);

  try {
    const auth = new google.auth.GoogleAuth({
      keyFilename: keyPath,
      scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
    });
    const searchconsole = google.searchconsole({ version: 'v1', auth });

    const today = new Date();
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const endDate = today.toISOString().split('T')[0];

    console.log(`   Reporting Window: ${startDate} to ${endDate}`);
    const res = await searchconsole.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate,
        endDate,
        dimensions: ['query'],
        rowLimit: 15,
      },
    });

    if (res.data.rows && res.data.rows.length > 0) {
      console.log('---------------------------------------------------------------------------------------');
      console.log('| Search Query (Keyword)                    | Clicks | Impressions | CTR    | Avg Pos |');
      console.log('---------------------------------------------------------------------------------------');
      res.data.rows.forEach(row => {
        const query = (row.keys?.[0] || '').padEnd(41);
        const clicks = String(row.clicks || 0).padEnd(6);
        const impressions = String(row.impressions || 0).padEnd(11);
        const ctr = `${((row.ctr || 0) * 100).toFixed(1)}%`.padEnd(6);
        const position = (row.position || 0).toFixed(1).padEnd(7);
        console.log(`| ${query} | ${clicks} | ${impressions} | ${ctr} | ${position} |`);
      });
      console.log('---------------------------------------------------------------------------------------');
    } else {
      console.log('   (No search queries recorded in GSC for this site in the last 30 days)');
    }

  } catch (err: any) {
    console.error('❌ [GSC ERROR]:', err.message);
  }

  console.log('\n================================================================');
}

fetchLiveGoogleData();
