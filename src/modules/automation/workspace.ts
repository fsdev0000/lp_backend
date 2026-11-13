/**
 * Which CRM workspace a content-calendar post belongs to (item 32). Instagram, TikTok and YouTube are Lionel's
 * personal-brand channels; LinkedIn and the rest stay with Leaders Performance until the calendar says otherwise.
 */
export type CrmWorkspace = 'leaders_performance' | 'lionel_eersteling';

const LIONEL_EERSTELING_PLATFORMS = ['INSTAGRAM', 'TIKTOK', 'YOUTUBE'];

export function workspaceForPlatform(platform: string | null | undefined): CrmWorkspace {
  return LIONEL_EERSTELING_PLATFORMS.includes(String(platform || '').toUpperCase())
    ? 'lionel_eersteling'
    : 'leaders_performance';
}
