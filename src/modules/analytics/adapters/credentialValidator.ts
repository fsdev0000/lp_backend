export interface ProviderCredentials {
  ga4: {
    propertyId: string | null;
    serviceAccountEmail: string | null;
    privateKey: string | null;
    isConfigured: boolean;
  };
  gsc: {
    siteUrl: string | null;
    serviceAccountEmail: string | null;
    privateKey: string | null;
    isConfigured: boolean;
  };
  clarity: {
    projectId: string | null;
    apiKey: string | null;
    isConfigured: boolean;
  };
  ghl: {
    apiKey: string | null;
    locationId: string | null;
    isConfigured: boolean;
  };
}

export function validateAnalyticsCredentials(): ProviderCredentials {
  const ga4PropertyId = process.env.GA4_PROPERTY_ID || null;
  const googleEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || null;
  const googleKey = process.env.GOOGLE_PRIVATE_KEY || null;

  const gscSiteUrl = process.env.GSC_SITE_URL || 'https://leadersperformance.ae/';
  const clarityProjectId = process.env.CLARITY_PROJECT_ID || 'wu4o652peo';
  const clarityApiKey = process.env.CLARITY_API_KEY || null;

  const ghlApiKey = process.env.GHL_API_KEY || null;
  const ghlLocationId = process.env.GHL_LOCATION_ID || null;

  return {
    ga4: {
      propertyId: ga4PropertyId,
      serviceAccountEmail: googleEmail,
      privateKey: googleKey,
      isConfigured: Boolean(ga4PropertyId && googleEmail && googleKey),
    },
    gsc: {
      siteUrl: gscSiteUrl,
      serviceAccountEmail: googleEmail,
      privateKey: googleKey,
      isConfigured: Boolean(gscSiteUrl && googleEmail && googleKey),
    },
    clarity: {
      projectId: clarityProjectId,
      apiKey: clarityApiKey,
      isConfigured: Boolean(clarityProjectId && clarityApiKey),
    },
    ghl: {
      apiKey: ghlApiKey,
      locationId: ghlLocationId,
      isConfigured: Boolean(ghlApiKey && ghlLocationId),
    },
  };
}
