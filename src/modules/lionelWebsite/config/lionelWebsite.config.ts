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
}

export function getLionelWebsiteConfig(): LionelWebsiteConfig {
  return {
    domain: 'lioneleersteling.com',
    workspace: 'lionel_eersteling',
    supabaseUrl:
      process.env.LE_SUPABASE_URL?.trim() ||
      'https://efhkllmdcduqerevtsbk.supabase.co',
    supabaseProjectId:
      process.env.LE_SUPABASE_PROJECT_ID?.trim() ||
      'efhkllmdcduqerevtsbk',
    supabaseAnonKey:
      process.env.LE_SUPABASE_ANON_KEY?.trim() ||
      process.env.LE_SUPABASE_PUBLISHABLE_KEY?.trim() ||
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVmaGtsbG1kY2R1cWVyZXZ0c2JrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyNzE5OTUsImV4cCI6MjA4OTg0Nzk5NX0.IVWRxQe55cvHUYbg0KAJxWvWUkojeNmMN8b_YNnwyUA',
    cardSupabaseUrl:
      process.env.LE_CARD_SUPABASE_URL?.trim() ||
      'https://xvzutekufsfxhuanthwx.supabase.co',
    cardSupabaseAnonKey:
      process.env.LE_CARD_SUPABASE_ANON_KEY?.trim() ||
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh2enV0ZWt1ZnNmeGh1YW50aHd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTQ3OTE5NTUsImV4cCI6MjA3MDM2Nzk1NX0.1D86GwbHDCkJBBP5R-2Tp5vXl-MGSKqYJzoCYb5FAFs',
    ghlBaseUrl:
      process.env.GHL_BASE?.trim() ||
      'https://services.leadconnectorhq.com',
    ghlApiKey:
      process.env.LE_GHL_API_KEY?.trim() ||
      'pit-3387482f-cd01-4808-972d-86b8977febea',
    ghlLocationId:
      process.env.LE_GHL_LOCATION_ID?.trim() ||
      'XZ4oRG64cpzlz0Pa7fJh',
  };
}
