/**
 * One set of rules for website inquiries, shared by the Overview's "New inquiries", "Recent inquiries" and the traffic
 * trend's inquiry line, so the three always agree.
 */

/** Addresses used by automated tests: their scans and forms are never counted. */
export const TEST_LEAD_EMAILS = [
  'pdf@company.ae',
  'dossier@company.ae',
  'sanitize@company.ae',
  'tieddomains@company.ae',
  'domainmean@company.ae',
];

/** Domains and patterns used by automated tests or QA submissions: their scans and forms are never counted. */
export const TEST_EMAIL_DOMAINS = [
  'example.com',
  'test.com',
  'enterprise.ae',
];

export function isTestLeadEmail(email?: string | null): boolean {
  if (!email) return false;
  const lower = email.trim().toLowerCase();
  if (TEST_LEAD_EMAILS.some((e) => e.toLowerCase() === lower)) return true;
  for (const dom of TEST_EMAIL_DOMAINS) {
    if (lower.endsWith(`@${dom}`) || lower.endsWith(`.${dom}`)) return true;
  }
  if (lower.includes('alexander.vance') || lower.includes('john.doe@') || lower.includes('.test@')) {
    return true;
  }
  return false;
}

/** Lead forms a Pressure Scan writes on its attribution visit. The scan itself is counted from its own table. */
export const SCAN_LEAD_FORMS = ['founder_pressure_scan', 'scan'];

export function isLeDomain(domain?: string): boolean {
  return Boolean(domain?.toLowerCase().includes('lioneleersteling'));
}

/**
 * Attribution visits that belong to this site. leadersperformance.ae stores its landing pages as paths ('/'), so a
 * path counts for Leaders Performance; anything mentioning lioneleersteling belongs to Lionel Eersteling.
 *
 * Combine it with other conditions through `AND`, never by spreading: it uses `AND` itself.
 */
export function siteVisitWhere(domain?: string): Record<string, any> {
  if (isLeDomain(domain)) {
    return {
      OR: [
        { leadForm: 'le_contact_form' },
        { module: 'le_website' },
        {
          AND: [
            { landingPage: { contains: 'lioneleersteling', mode: 'insensitive' } },
            { NOT: { landingPage: { contains: 'leadersperformance', mode: 'insensitive' } } },
          ],
        },
      ],
    };
  }
  return {
    OR: [
      { landingPage: { startsWith: '/' } },
      { landingPage: { contains: 'leadersperformance', mode: 'insensitive' } },
      { referrer: { contains: 'leadersperformance', mode: 'insensitive' } },
      { module: 'leaders_performance' },
    ],
  };
}

type CreatedAt = { gte: Date; lte: Date } | undefined;

/** Website form inquiries: this site's visits that carry an email, minus test addresses. */
export function inquiryVisitWhere(domain: string | undefined, createdAt?: CreatedAt): Record<string, any> {
  return {
    AND: [
      { email: { not: null, notIn: TEST_LEAD_EMAILS } },
      {
        NOT: [
          { email: { endsWith: '@example.com' } },
          { email: { endsWith: '@test.com' } },
          { email: { endsWith: '@enterprise.ae' } },
          { email: { contains: 'alexander.vance' } },
          { leadName: { contains: 'Alexander Vance', mode: 'insensitive' } },
        ],
      },
      ...(createdAt ? [{ createdAt }] : []),
      siteVisitWhere(domain),
    ],
  };
}

/** Visits that aren't a scan's own visit. `lead_form` is often empty, and NOT IN on NULL would drop those. */
export const NOT_SCAN_VISIT = { OR: [{ leadForm: null }, { leadForm: { notIn: SCAN_LEAD_FORMS } }] };

/** Pressure Scan submissions, minus test addresses. Scans exist on leadersperformance.ae only. */
export function scanWhere(createdAt?: CreatedAt): Record<string, any> {
  return {
    email: { notIn: TEST_LEAD_EMAILS },
    NOT: [
      { email: { endsWith: '@example.com' } },
      { email: { endsWith: '@test.com' } },
      { email: { endsWith: '@enterprise.ae' } },
      { email: { contains: 'alexander.vance' } },
      { fullName: { contains: 'Alexander Vance', mode: 'insensitive' } },
    ],
    ...(createdAt ? { createdAt } : {}),
  };
}

/** How many different people: a person who sent a form and a scan (or several) counts once. */
export function countDistinctEmails(rows: Array<{ email: string | null }>): number {
  return new Set(
    rows
      .map((r) => r.email?.trim().toLowerCase())
      .filter((e): e is string => Boolean(e) && !isTestLeadEmail(e))
  ).size;
}
