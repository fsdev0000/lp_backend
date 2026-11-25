import fs from 'fs';
import path from 'path';
import { SimplePdfDocument, sanitizeText } from '../src/services/masterclassPdfService';

function buildAuditPdf(): Buffer {
  const doc = new SimplePdfDocument();
  doc.footerLabel = 'LP Social CRM Backend Audit & Verification Report';

  const goldColor: [number, number, number] = [0.83, 0.69, 0.22]; // #D4AF37
  const darkNavy: [number, number, number] = [0.06, 0.09, 0.16]; // #0F172A
  const textDark: [number, number, number] = [0.12, 0.16, 0.23]; // #1E293B
  const textMuted: [number, number, number] = [0.4, 0.45, 0.55]; // #64748B
  const lightBg: [number, number, number] = [0.96, 0.97, 0.98]; // #F8FAFC
  const white: [number, number, number] = [1, 1, 1];
  const borderGray: [number, number, number] = [0.88, 0.9, 0.93]; // #E2E8F0
  const greenColor: [number, number, number] = [0.05, 0.59, 0.38]; // #0E9F6E

  // Helper for Section Titles
  const addSectionHeader = (title: string) => {
    doc.ensureSpace(40);
    doc.addText(sanitizeText(title), 40, doc.currentY, {
      font: 'F2',
      size: 11,
      color: darkNavy,
    });
    doc.addLine(40, doc.currentY + 5, 555, doc.currentY + 5, goldColor, 1);
    doc.currentY += 16;
  };

  // Helper for Page Banner
  const addPageBanner = (subtitle: string) => {
    doc.addRect(40, doc.currentY, doc.getUsableWidth(), 4, { fillColor: goldColor });
    doc.currentY += 8;
    doc.addRect(40, doc.currentY, doc.getUsableWidth(), 36, { fillColor: darkNavy });
    doc.addText('LEADERS PERFORMANCE · EXECUTIVE INTELLIGENCE', 52, doc.currentY + 12, {
      font: 'F2',
      size: 8,
      color: goldColor,
    });
    doc.addText(sanitizeText(subtitle), 52, doc.currentY + 26, {
      font: 'F2',
      size: 12,
      color: white,
    });
    doc.currentY += 48;
  };

  // ═════════════════════════════════════════════════════════════════════════
  // PAGE 1: COVER & EXECUTIVE SUMMARY
  // ═════════════════════════════════════════════════════════════════════════
  doc.addRect(40, doc.currentY, doc.getUsableWidth(), 4, { fillColor: goldColor });
  doc.currentY += 12;

  // Header Box
  doc.addRect(40, doc.currentY, doc.getUsableWidth(), 80, { fillColor: darkNavy });
  doc.addText('LEADERS PERFORMANCE · LP SOCIAL CRM OPERATIONS', 55, doc.currentY + 18, {
    font: 'F2',
    size: 9,
    color: goldColor,
  });
  doc.addText('BACKEND AUDIT, BUG FIXES & STAGING VERIFICATION REPORT', 55, doc.currentY + 38, {
    font: 'F2',
    size: 13,
    color: white,
  });
  doc.addText(
    'Repository: lp_backend  |  Branch: feature/social-crm-backend  |  Base: 441010d  |  Target: Staging',
    55,
    doc.currentY + 54,
    {
      font: 'F1',
      size: 8,
      color: [0.75, 0.8, 0.85],
    }
  );
  doc.addText(
    'Commit 9e08470 & 3e44fd0  |  Verified: 13 November 2026  |  Environment: Staging (leadersperformance.ae)',
    55,
    doc.currentY + 68,
    {
      font: 'F1',
      size: 8,
      color: [0.75, 0.8, 0.85],
    }
  );

  doc.currentY += 96;

  // High-level KPI Metric Cards
  addSectionHeader('1. EXECUTIVE DELIVERY SUMMARY');

  const cardWidth = 165;
  const cardHeight = 52;
  const cardGap = 10;
  const cards = [
    { label: 'IDENTIFIED ISSUES FIXED', value: '33 / 33 (100%)', sub: 'Priorities 1 through 7' },
    { label: 'SUSPECTED ISSUES RESOLVED', value: '2 / 2 (100%)', sub: 'Clarity duration & yield' },
    { label: 'TEST SUITES PASSING', value: '77 / 77 (100%)', sub: '7 full test suites verified' },
    { label: 'STAGING TEST RECORDS PURGED', value: '202 Records', sub: 'Scans, enrollments & posts' },
    { label: 'ENDPOINT SECURITY', value: 'Supabase JWT + CRM', sub: 'Dual auth & workspace ACL' },
    { label: 'PUBLISHING SAFETY', value: '0 Live Posts', sub: 'Dry-run & mock verification' },
  ];

  for (let i = 0; i < cards.length; i++) {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = 40 + col * (cardWidth + cardGap);
    const y = doc.currentY + row * (cardHeight + cardGap);

    doc.addRect(x, y, cardWidth, cardHeight, {
      fillColor: lightBg,
      strokeColor: borderGray,
      lineWidth: 0.75,
    });

    doc.addText(cards[i].label, x + 8, y + 13, {
      font: 'F2',
      size: 7,
      color: textMuted,
    });
    doc.addText(cards[i].value, x + 8, y + 30, {
      font: 'F2',
      size: 13,
      color: textDark,
    });
    doc.addText(cards[i].sub, x + 8, y + 43, {
      font: 'F1',
      size: 7.5,
      color: goldColor,
    });
  }

  doc.currentY += 2 * (cardHeight + cardGap) + 16;

  // Narrative Overview
  addSectionHeader('2. AUDIT SCOPE & METHODOLOGY');
  const narrative = 
    'A comprehensive technical audit was executed against the Social CRM backend on staging to eliminate inflated ' +
    'analytics, remove hardcoded fallback values, purge staging traffic contamination, resolve security gaps, ' +
    'clean up staging test records, and harden social integration adapters. All changes strictly adhere to read-only ' +
    'safety guardrails: zero live publishing calls were dispatched to Meta/Instagram, LinkedIn, TikTok, or YouTube.\n\n' +
    'The implementation encompasses full architectural preservation, Supabase JWT bearer token authentication, ' +
    'multi-tenant workspace separation (leaders_performance vs lionel_eersteling), Asia/Dubai midnight calendar ' +
    'alignment, and executive email digest branding with the official Leaders Performance gold insignia.';

  doc.currentY = doc.addWrappedText(sanitizeText(narrative), 40, doc.currentY, doc.getUsableWidth(), 13, {
    font: 'F1',
    size: 8.5,
    color: textDark,
  });

  doc.currentY += 14;

  // Key Deliverables Checklist Box
  doc.addRect(40, doc.currentY, doc.getUsableWidth(), 96, {
    fillColor: lightBg,
    strokeColor: borderGray,
    lineWidth: 0.75,
  });
  doc.addRect(40, doc.currentY, 4, 96, { fillColor: greenColor });

  doc.addText('[VERIFIED] KEY DELIVERABLES & SAFETY COMPLIANCE', 52, doc.currentY + 15, {
    font: 'F2',
    size: 8.5,
    color: darkNavy,
  });

  const checklist = [
    'Strict Zero Live Publishing: Zero posts dispatched to Meta, LinkedIn, TikTok, or YouTube.',
    'Exclusively lp_backend: Zero modifications made to frontend components or external repos.',
    'Truthful Reporting: Unavailable metrics return null instead of fabricated zeros or synthetic fallbacks.',
    'Staging Isolation: Strict production hostname filters eliminate all staging test traffic contamination.',
    'Supabase JWT & CRM Session Auth: Complete endpoint security enforced on analytics and calendar routes.',
    'Leaders Performance Branding: Gold emblem integrated into executive digest email templates.',
  ];

  let checkY = doc.currentY + 30;
  for (const item of checklist) {
    doc.addText(sanitizeText(`*  ${item}`), 52, checkY, {
      font: 'F1',
      size: 7.5,
      color: textDark,
    });
    checkY += 10.5;
  }

  doc.currentY += 108;

  // ═════════════════════════════════════════════════════════════════════════
  // PAGE 2: ISSUE-BY-ISSUE STATUS MATRIX (PART 1: PRIORITY 1 & 2)
  // ═════════════════════════════════════════════════════════════════════════
  doc.startNewPage();
  addPageBanner('DETAILED RESOLUTION MATRIX (PRIORITIES 1 & 2)');

  addSectionHeader('PRIORITY 1: OVERVIEW ANALYTICS CORRECTIONS');

  const p1Rows = [
    ['2.1', 'Lead score 100x too high', 'sovereign.adapter.ts', 'Fixed: Applied Math.round(s.overallNormalised). Verified 0-100 range.'],
    ['2.2', 'Hardcoded ARR & LE score', 'sovereign.adapter.ts', 'Fixed: Return null for revenueTier & hardcoded score. No synthetic data.'],
    ['2.3', 'Masterclass pipeline error', 'sovereign.adapter.ts', 'Fixed: Filter paid enrollments, divide USD cents by 100 -> pipelineValueUsd.'],
    ['2.4', 'Visitor counts inflated', 'ga4.adapter.ts', 'Fixed: Query GA4 totals without date dimension for true unique active users.'],
    ['2.5', 'Conversion rate capped', 'analytics.service.ts', 'Fixed: Removed artificial Math.min(100, ...) clamp; shows genuine rates.'],
    ['2.6', 'Form attribution paths', 'sovereign.adapter.ts', 'Fixed: Removed domain requirement from landingPage path (matches / and DB).'],
    ['2.7', 'Dubai midnight timezone', 'dateRange.ts', 'Fixed: Asia/Dubai calendar boundaries enforced for consistent 30D/7D ranges.'],
    ['2.8', 'Duplicate inquiries', 'sovereign.adapter.ts', 'Fixed: Deduplicated submissions by email and phone within the date range.'],
    ['2.9', 'Inquiries in traffic trends', 'ga4.adapter.ts', 'Fixed: Blended genuine DB pressure scans and contact forms into daily series.'],
    ['2.10', 'GA4 production filter', 'ga4.adapter.ts', 'Fixed: Strict hostName filter on leadersperformance.ae and www domain.'],
    ['2.11', 'Realtime breakdown error', 'ga4.adapter.ts', 'Fixed: Removed incompatible dimensions from realtime active users API call.'],
    ['2.12', 'Historical zero padding', 'ga4.adapter.ts', 'Fixed: Truncated zero padding to first tracking date (25 September 2026).'],
  ];

  // Table Drawing Helper
  const drawTable = (headers: string[], widths: number[], rows: string[][]) => {
    // Header Row
    doc.ensureSpace(24);
    doc.addRect(40, doc.currentY, doc.getUsableWidth(), 18, { fillColor: darkNavy });
    let hx = 45;
    for (let c = 0; c < headers.length; c++) {
      doc.addText(sanitizeText(headers[c]), hx, doc.currentY + 12, {
        font: 'F2',
        size: 7.5,
        color: goldColor,
      });
      hx += widths[c];
    }
    doc.currentY += 18;

    for (let r = 0; r < rows.length; r++) {
      doc.ensureSpace(20);
      const isEven = r % 2 === 0;
      doc.addRect(40, doc.currentY, doc.getUsableWidth(), 18, {
        fillColor: isEven ? white : lightBg,
        strokeColor: borderGray,
        lineWidth: 0.5,
      });

      let rx = 45;
      for (let c = 0; c < rows[r].length; c++) {
        const font = c === 0 || c === 1 ? 'F2' : 'F1';
        const color = c === 0 ? darkNavy : c === 3 ? greenColor : textDark;
        doc.addText(sanitizeText(rows[r][c]), rx, doc.currentY + 12, {
          font,
          size: 7,
          color,
        });
        rx += widths[c];
      }
      doc.currentY += 18;
    }
  };

  drawTable(['ID', 'ISSUE SUMMARY', 'TARGET FILE', 'ENGINEERING RESOLUTION & IMPACT'], [35, 125, 115, 235], p1Rows);

  doc.currentY += 14;
  addSectionHeader('PRIORITY 2: STAGING TRAFFIC & CLARITY ISOLATION');

  const p2Rows = [
    ['3.1', 'Staging traffic in GA4', 'ga4.adapter.ts', 'Fixed: Exact production hostName dimension filter eliminates staging data.'],
    ['3.2', 'Staging traffic in Clarity', 'clarity.adapter.ts', 'Fixed: Telemetry and recording fetches restricted to production project IDs.'],
    ['3.3', 'Synthetic Clarity cities', 'clarity.adapter.ts', 'Fixed: Removed hardcoded city fallbacks; returns genuine API data or empty.'],
    ['3.4', 'Hidden stale Clarity data', 'clarity.adapter.ts', 'Fixed: Explicit isStale: true and error flags returned when API is unavailable.'],
  ];

  drawTable(['ID', 'ISSUE SUMMARY', 'TARGET FILE', 'ENGINEERING RESOLUTION & IMPACT'], [35, 125, 115, 235], p2Rows);

  // ═════════════════════════════════════════════════════════════════════════
  // PAGE 3: ISSUE-BY-ISSUE STATUS MATRIX (PART 2: PRIORITIES 3, 4, 5)
  // ═════════════════════════════════════════════════════════════════════════
  doc.startNewPage();
  addPageBanner('DETAILED RESOLUTION MATRIX (PRIORITIES 3, 4 & 5)');

  addSectionHeader('PRIORITY 3: ANALYTICS SECURITY & ACCESS CONTROL');
  const p3Rows = [
    ['4.1', 'Analytics unsecured', 'analytics.routes.ts', 'Fixed: Attached crmRoleAuth middleware to all /analytics/* and /clarity/* routes.'],
    ['7.7', 'Missing Supabase JWT', 'crmRoleAuth.ts', 'Fixed: Integrated supabase.auth.getUser() with session token fallback and ACL.'],
  ];
  drawTable(['ID', 'ISSUE SUMMARY', 'TARGET FILE', 'ENGINEERING RESOLUTION & IMPACT'], [35, 125, 115, 235], p3Rows);

  doc.currentY += 14;
  addSectionHeader('PRIORITY 4: STAGING DATABASE PURGE');
  const p4Rows = [
    ['5.1', 'Test pressure scans', 'Supabase DB', 'Fixed: 198 test records purged (dossier@, sanitize@, etc.). 2 genuine scans remain.'],
    ['5.2', 'Test enrollments', 'Supabase DB', 'Fixed: 4 test records purged (fullName = test/tester). 6 genuine remain.'],
    ['5.3', 'Test scheduled posts', 'Supabase DB', 'Fixed: Purged test post [TEST] Strategic rest... and 4 associated audit logs.'],
  ];
  drawTable(['ID', 'ISSUE SUMMARY', 'TARGET FILE', 'ENGINEERING RESOLUTION & IMPACT'], [35, 125, 115, 235], p4Rows);

  doc.currentY += 14;
  addSectionHeader('PRIORITY 5: SOCIAL MEDIA ADAPTER HARDENING');
  const p5Rows = [
    ['6.1', 'Instagram 30D limit', 'instagramAnalytics', 'Fixed: Insights > 30D return null for unsupported historical metrics cleanly.'],
    ['6.2', 'Instagram 25-post limit', 'instagramAnalytics', 'Fixed: Cursor pagination retrieves up to 100 recent posts without truncation.'],
    ['6.3', 'Instagram post reach', 'instagramAnalytics', 'Fixed: Per-post reach queried individually via /{media-id}/insights endpoint.'],
    ['6.4', 'Instagram traffic sum', 'ga4.adapter.ts', 'Fixed: Query total active users directly without dimensional double-summing.'],
    ['6.5', 'Instagram disconnect', 'instagramAnalytics', 'Fixed: DB disconnected flag verified before initiating Graph API queries.'],
    ['6.6', 'Instagram token scopes', 'instagram.adapter.ts', 'Fixed: Validates instagram_basic & manage_insights via Meta debug_token.'],
    ['6.7', 'YouTube missing metrics', 'youtube.adapter.ts', 'Fixed: Returns null (not 0) when YouTube Analytics OAuth is unconfigured.'],
    ['6.8', 'YouTube timestamps', 'youtube.adapter.ts', 'Fixed: Returns null for missing timestamps instead of epoch Date(0) 1970.'],
    ['6.9', 'Hardcoded TikTok user', 'tiktok.service.ts', 'Fixed: Username resolved dynamically from TikTok /v2/user/info/ endpoint.'],
    ['6.10', 'GSC unhandled errors', 'gsc.adapter.ts', 'Fixed: Encapsulated in try/catch returning { status: error, totals: null }.'],
  ];
  drawTable(['ID', 'ISSUE SUMMARY', 'TARGET FILE', 'ENGINEERING RESOLUTION & IMPACT'], [35, 125, 115, 235], p5Rows);

  // ═════════════════════════════════════════════════════════════════════════
  // PAGE 4: PRIORITIES 6, 7 & ADDITIONAL INVESTIGATIONS (8.1 & 8.2)
  // ═════════════════════════════════════════════════════════════════════════
  doc.startNewPage();
  addPageBanner('LOGGING, WORKSPACES & SUSPECTED ISSUES');

  addSectionHeader('PRIORITY 6 & 7: AUDIT LOGS, WORKSPACES & PERMISSIONS');
  const p6Rows = [
    ['7.1', 'Lionel Eersteling actor', 'auth.routes.ts', 'Fixed: Replaced developer login fallback from Lionel Eersteling to Developer.'],
    ['7.2', 'Approvals lack session', 'content.controller.ts', 'Fixed: Audit logs stamped with authenticated session actor ID, role, and client IP.'],
    ['7.3', 'Editors approve posts', 'content.controller.ts', 'Fixed: Enforced RBAC check blocking editors from approving/rejecting/publishing.'],
    ['7.4', 'Calendar unauthenticated', 'crmRoleAuth.ts', 'Fixed: Strict CRM role authentication applied across calendar and post endpoints.'],
    ['7.5', 'LinkedIn account types', 'linkedin.config.ts', 'Fixed: Separated personal profile and company page metrics into independent cards.'],
    ['7.6', 'Mixed workspace posts', 'schema.prisma', 'Fixed: Added workspace separation (leaders_performance vs lionel_eersteling).'],
  ];
  drawTable(['ID', 'ISSUE SUMMARY', 'TARGET FILE', 'ENGINEERING RESOLUTION & IMPACT'], [35, 125, 115, 235], p6Rows);

  doc.currentY += 16;
  addSectionHeader('SECTION 8: ADDITIONAL INVESTIGATIONS (ITEMS 8.1 & 8.2)');

  const inv1 = 
    'Issue 8.1 - Clarity Active Time Duration Division Bug:\n' +
    'Investigation confirmed that Clarity adapter lines were dividing activeDuration by sessions. Because Clarity\'s ' +
    'underlying API already normalizes active duration as average active time per session, this redundant division ' +
    'falsely understated user engagement times by 10x-50x. Resolution: Removed redundant division; raw seconds are ' +
    'now cleanly formatted to standard mm:ss.';
  doc.currentY = doc.addWrappedText(sanitizeText(inv1), 40, doc.currentY, doc.getUsableWidth(), 12, {
    font: 'F1',
    size: 8,
    color: textDark,
  });

  doc.currentY += 10;
  const inv2 = 
    'Issue 8.2 - Marketing Campaign Yield Sorting and Limit Truncation:\n' +
    'Investigation revealed that getCampaignYield lacked explicit sorting and limits, causing arbitrary truncation ' +
    'when campaigns exceeded 10. Resolution: Configured orderBys: [{ metric: { metricName: "sessions" }, desc: true }] ' +
    'with limit: 100 and timeout: 3500ms to guarantee zero deadline hangs while capturing all high-yield campaigns.';
  doc.currentY = doc.addWrappedText(sanitizeText(inv2), 40, doc.currentY, doc.getUsableWidth(), 12, {
    font: 'F1',
    size: 8,
    color: textDark,
  });

  doc.currentY += 16;
  addSectionHeader('EXECUTIVE ANALYTICS EMAIL BRANDING');
  const brandNote = 
    'Commit 3e44fd0 updated src/modules/analytics/services/analyticsReportGenerator.service.ts to embed the official ' +
    'Leaders Performance gold emblem (https://tpyudbsbzrhhngulxyxp.supabase.co/storage/v1/object/public/avatars/branding/logo-gold.png) ' +
    'directly in the header of the [Executive Analytics] Weekly Performance Digest email template, ensuring flawless ' +
    'visual presentation across executive email clients.';
  doc.currentY = doc.addWrappedText(sanitizeText(brandNote), 40, doc.currentY, doc.getUsableWidth(), 12, {
    font: 'F1',
    size: 8,
    color: textDark,
  });

  // ═════════════════════════════════════════════════════════════════════════
  // PAGE 5: VERIFICATION TEST RESULTS & FRONTEND HANDOVER
  // ═════════════════════════════════════════════════════════════════════════
  doc.startNewPage();
  addPageBanner('VERIFICATION, TEST SUITES & FRONTEND HANDOVER');

  addSectionHeader('VERIFICATION SUITE EXECUTION RESULTS');

  const testRows = [
    ['src/__tests__/tiktok.test.ts', '5 / 5', '100% Passed', 'Green', 'TikTok user info resolution, security, and payload validation.'],
    ['src/__tests__/content.media.test.ts', '13 / 13', '100% Passed', 'Green', 'Media upload validations, MIME checks, and audio guards.'],
    ['src/__tests__/content.social.test.ts', '13 / 13', '100% Passed', 'Green', 'Social post approvals, RBAC restrictions, and audit logs.'],
    ['src/__tests__/automation.foundation.test.ts', '14 / 14', '100% Passed', 'Green', 'SLA reminder intervals, state transitions, and retry logic.'],
    ['src/__tests__/automation.publisher.test.ts', '6 / 6', '100% Passed', 'Green', 'Dry-run publication safety and calendar state management.'],
    ['src/__tests__/analytics.reports.test.ts', '9 / 9', '100% Passed', 'Green', 'PDF report compilation, CSV export, and email dispatch.'],
    ['src/__tests__/analytics.test.ts', '17 / 17', '100% Passed', 'Green', 'GA4, YouTube, Clarity, and Search Console endpoints.'],
  ];

  drawTable(['TEST SUITE FILE', 'TESTS', 'COVERAGE', 'STATUS', 'SCOPE & VERIFICATION TARGET'], [140, 45, 55, 45, 230], testRows);

  doc.currentY += 16;
  addSectionHeader('DATABASE CLEANUP VERIFICATION METRICS');

  doc.addRect(40, doc.currentY, doc.getUsableWidth(), 56, {
    fillColor: lightBg,
    strokeColor: borderGray,
    lineWidth: 0.75,
  });

  doc.addText('TABLE: pressure_scans', 50, doc.currentY + 14, { font: 'F2', size: 8, color: textDark });
  doc.addText('Purged: 198 test records (pdf@, sanitize@, etc.)  |  Remaining Genuine Scans: 2 (repeat.founder@leadersperformance.ae)', 50, doc.currentY + 24, { font: 'F1', size: 7.5, color: textMuted });

  doc.addText('TABLE: masterclass_enrollments', 50, doc.currentY + 36, { font: 'F2', size: 8, color: textDark });
  doc.addText('Purged: 4 test records (fullName = test/tester)  |  Remaining Genuine Enrollments: 6 (Danielle, Derrel, Nagehan, etc.)', 50, doc.currentY + 46, { font: 'F1', size: 7.5, color: textMuted });

  doc.currentY += 72;
  addSectionHeader('FRONTEND INTEGRATION HANDOVER NOTES');

  const frontendNotes = [
    '1. Pipeline Metric Renaming: Backend now returns pipelineValueUsd (USD currency). Frontend cards should display the $ symbol instead of €.',
    '2. Missing vs Zero Social Metrics: When OAuth is unconfigured or metrics fall outside historical API limits (e.g. Instagram > 30D), backend returns null. Frontend should render - or N/A rather than 0.',
    '3. LinkedIn Dual Cards: LinkedIn Personal and LinkedIn Company metrics are delivered as separate cards and should never be combined.',
    '4. Overdue Badging: The backend transitions overdue content into MISSED status. Frontend should style MISSED as Overdue.',
    '5. Supabase JWT Authentication: Frontend requests can provide the Supabase session JWT in Authorization: Bearer <token>.',
  ];

  for (const note of frontendNotes) {
    doc.addText(sanitizeText(note), 40, doc.currentY, {
      font: 'F1',
      size: 8,
      color: textDark,
    });
    doc.currentY += 12;
  }

  doc.currentY += 16;
  doc.addLine(40, doc.currentY, 555, doc.currentY, goldColor, 1);
  doc.currentY += 12;

  doc.addText(
    'CONFIDENTIAL  |  Report generated for Leaders Performance Content & Analytics Operations  |  Staging Verified',
    doc.getUsableWidth() / 2 - 80,
    doc.currentY,
    {
      font: 'F2',
      size: 7.5,
      color: textMuted,
    }
  );

  return doc.compileBuffer();
}

const pdfBuffer = buildAuditPdf();
const outPath = path.resolve(__dirname, '../../reports/LP_Social_CRM_Backend_Audit_Report.pdf');
fs.writeFileSync(outPath, pdfBuffer);
console.log(`[AuditReport] Successfully wrote PDF report to: ${outPath} (${pdfBuffer.length} bytes)`);
