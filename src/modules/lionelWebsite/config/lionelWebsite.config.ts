export interface LionelWebsiteConfig {
  domain: string;
  workspace: string;
  supabaseUrl: string;
  supabaseProjectId: string;
  supabaseAnonKey: string;
  cardSupabaseUrl: string;
  cardSupabaseAnonKey: string;
  ghlBaseUrl: string;
  ghlApiKey: string;
  ghlLocationId: string;
  isConfigured: boolean;
}

export function getLionelWebsiteConfig(): LionelWebsiteConfig {
  const supabaseUrl = process.env.LE_SUPABASE_URL?.trim() || '';
  const supabaseProjectId = process.env.LE_SUPABASE_PROJECT_ID?.trim() || '';
  const supabaseAnonKey =
    process.env.LE_SUPABASE_ANON_KEY?.trim() ||
    process.env.LE_SUPABASE_PUBLISHABLE_KEY?.trim() ||
    '';
  const cardSupabaseUrl = process.env.LE_CARD_SUPABASE_URL?.trim() || '';
  const cardSupabaseAnonKey = process.env.LE_CARD_SUPABASE_ANON_KEY?.trim() || '';
  const ghlBaseUrl =
    process.env.GHL_BASE?.trim() || 'https://services.leadconnectorhq.com';
  const ghlApiKey = process.env.LE_GHL_API_KEY?.trim() || '';
  const ghlLocationId = process.env.LE_GHL_LOCATION_ID?.trim() || '';

  const isConfigured = Boolean(
    (supabaseUrl && supabaseAnonKey) || (ghlApiKey && ghlLocationId)
  );

  return {
    domain: 'lioneleersteling.com',
    workspace: 'lionel_eersteling',
    supabaseUrl,
    supabaseProjectId,
    supabaseAnonKey,
    cardSupabaseUrl,
    cardSupabaseAnonKey,
    ghlBaseUrl,
    ghlApiKey,
    ghlLocationId,
    isConfigured,
  };
}
