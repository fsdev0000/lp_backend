export interface ClarityWebsiteConfig {
  key: string;
  name: string;
  url: string;
  projectId: string;
  token: string | null;
}

export const CLARITY_WEBSITES: Record<string, ClarityWebsiteConfig> = {
  leaders_performance: {
    key: 'leaders_performance',
    name: 'Leaders Performance',
    url: 'https://leadersperformance.ae',
    projectId: process.env.CLARITY_LP_PROJECT_ID || 'wu4o652peo',
    token: process.env.CLARITY_LP_TOKEN || null,
  },
  lionel_eersteling: {
    key: 'lionel_eersteling',
    name: 'Lionel Eersteling',
    url: 'https://lioneleersteling.com',
    projectId: process.env.CLARITY_LE_PROJECT_ID || '3508325430896273',
    token: process.env.CLARITY_LE_TOKEN || null,
  },
};

export function getClarityWebsiteConfig(key?: string): ClarityWebsiteConfig {
  const normalizedKey = (key || 'leaders_performance').toLowerCase().trim();
  if (CLARITY_WEBSITES[normalizedKey]) {
    return CLARITY_WEBSITES[normalizedKey];
  }

  // Alias checks (e.g. 'lp', 'leadersperformance.ae', 'le', 'lioneleersteling.com')
  if (normalizedKey === 'lp' || normalizedKey.includes('leadersperformance')) {
    return CLARITY_WEBSITES.leaders_performance;
  }
  if (normalizedKey === 'le' || normalizedKey.includes('lioneleersteling')) {
    return CLARITY_WEBSITES.lionel_eersteling;
  }

  return CLARITY_WEBSITES.leaders_performance;
}

export function getAllClarityWebsites(): ClarityWebsiteConfig[] {
  return Object.values(CLARITY_WEBSITES);
}
