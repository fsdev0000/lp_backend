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
        { landingPage: { contains: 'lioneleersteling', mode: 'insensitive' } },
        { referrer: { contains: 'lioneleersteling', mode: 'insensitive' } },
      ],
    };
  }
  return {
    AND: [
      {
        OR: [
          { landingPage: { startsWith: '/' } },
          { landingPage: { contains: 'leadersperformance', mode: 'insensitive' } },
          { referrer: { contains: 'leadersperformance', mode: 'insensitive' } },
        ],
      },
      { NOT: { landingPage: { contains: 'lioneleersteling', mode: 'insensitive' } } },
      // Most visits have no referrer. In SQL, NOT (NULL LIKE …) is NULL, which dropped every such visit (and so every
      // website form) from the count; a missing referrer has to pass explicitly.
      {
        OR: [
          { referrer: null },
          { NOT: { referrer: { contains: 'lioneleersteling', mode: 'insensitive' } } },
        ],
      },
    ],
  };
}

type CreatedAt = { gte: Date; lte: Date } | undefined;

/** Website form inquiries: this site's visits that carry an email, minus test addresses. */
export function inquiryVisitWhere(domain: string | undefined, createdAt?: CreatedAt): Record<string, any> {
  return {
    AND: [
      { email: { not: null, notIn: TEST_LEAD_EMAILS } },
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
    ...(createdAt ? { createdAt } : {}),
  };
}

/** How many different people: a person who sent a form and a scan (or several) counts once. */
export function countDistinctEmails(rows: Array<{ email: string | null }>): number {
  return new Set(rows.map((r) => r.email?.trim().toLowerCase()).filter(Boolean)).size;
}
