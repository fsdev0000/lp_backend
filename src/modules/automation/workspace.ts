/**
 * Which CRM workspace a content-calendar post belongs to:
 * - Instagram, TikTok, YouTube, and personal LinkedIn ("LinkedIn") belong to `lionel_eersteling`.
 * - "LinkedIn Business" (company page) and website/LP channels belong to `leaders_performance`.
 */
export type CrmWorkspace = 'leaders_performance' | 'lionel_eersteling';

const LIONEL_EERSTELING_PLATFORMS = ['INSTAGRAM', 'TIKTOK', 'YOUTUBE'];
const LP_LINKEDIN_BUSINESS_REGEX = /\b(business|company|page|leaders\s*performance|lp)\b/i;

export function workspaceForPlatform(
  platform: string | null | undefined,
  channelRaw?: string | null
): CrmWorkspace {
  const upperPlatform = String(platform || '').toUpperCase();
  const rawChannel = String(channelRaw || '').trim();

  if (LIONEL_EERSTELING_PLATFORMS.includes(upperPlatform)) {
    return 'lionel_eersteling';
  }

  if (upperPlatform === 'LINKEDIN' || upperPlatform === 'LINKEDIN_NEWSLETTER') {
    if (rawChannel && LP_LINKEDIN_BUSINESS_REGEX.test(rawChannel)) {
      return 'leaders_performance';
    }
    return 'lionel_eersteling';
  }

  if (rawChannel && /\blionel\b/i.test(rawChannel)) {
    return 'lionel_eersteling';
  }

  return 'leaders_performance';
}

export function resolvePostWorkspace(post: {
  workspace?: string | null;
  platform?: string | null;
  contentItem?: { channelRaw?: string | null } | null;
  options?: any;
}): CrmWorkspace {
  const channelRaw =
    post.contentItem?.channelRaw ||
    (typeof post.options === 'object' && post.options !== null ? post.options.rawChannel : null);

  if (channelRaw) {
    return workspaceForPlatform(post.platform, channelRaw);
  }

  if (post.workspace === 'lionel_eersteling' || post.workspace === 'leaders_performance') {
    return post.workspace;
  }

  return workspaceForPlatform(post.platform, null);
}
