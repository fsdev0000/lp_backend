import { getSupabaseClient } from './supabaseStorageService';

export const NEWSLETTER_BUCKET = 'news-letter';

/**
 * Resolves the Supabase Storage PDF path and generates a signed URL.
 * Automatically handles:
 * - Direct relative path (e.g. '2026/10/NEWSLETTER_DESKTOP_FINAL_REVISED.pdf')
 * - Bucket-prefixed path (e.g. 'news-letter/2026/10/NEWSLETTER_DESKTOP_FINAL_REVISED.pdf')
 * - Campaign key derivation (e.g. '2026-10' -> searches '2026/10')
 */
export async function getNewsletterPdfAttachmentUrl(
  pathOrCampaignKey?: string | null
): Promise<string | null> {
  try {
    const supabase = await getSupabaseClient();
    let targetPath = (pathOrCampaignKey || '').trim();

    // Strip bucket prefix if user provided 'news-letter/...'
    if (targetPath.startsWith(`${NEWSLETTER_BUCKET}/`)) {
      targetPath = targetPath.slice(`${NEWSLETTER_BUCKET}/`.length);
    }

    // If path is a full Supabase URL already, extract the object path or return it
    if (targetPath.startsWith('http://') || targetPath.startsWith('https://')) {
      const match = targetPath.match(new RegExp(`/storage/v1/object/(?:public|sign)/${NEWSLETTER_BUCKET}/([^?]+)`));
      if (match && match[1]) {
        targetPath = decodeURIComponent(match[1]);
      } else {
        // Return existing URL if external
        return targetPath;
      }
    }

    // If path is empty or a campaign key format like '2026-10'
    if (!targetPath || /^20\d\d-\d\d$/.test(targetPath)) {
      const now = new Date();
      const defaultYear = now.getUTCFullYear();
      const defaultMonth = now.getUTCMonth() + 1;

      let targetYear = targetPath ? parseInt(targetPath.split('-')[0], 10) : defaultYear;
      let targetMonth = targetPath ? parseInt(targetPath.split('-')[1], 10) : defaultMonth;
      let resolvedFile: string | null = null;

      // Check target month; if empty, fall back to the latest available preceding month (up to 12 months)
      for (let i = 0; i < 12; i++) {
        const folderPath = `${targetYear}/${String(targetMonth).padStart(2, '0')}`;
        try {
          const { data: files, error } = await supabase.storage.from(NEWSLETTER_BUCKET).list(folderPath);

          if (!error && Array.isArray(files) && files.length > 0) {
            const pdfFile = files.find(
              (f) => f.name.toLowerCase().endsWith('.pdf') && f.name !== '.emptyFolderPlaceholder'
            );

            if (pdfFile) {
              resolvedFile = `${folderPath}/${pdfFile.name}`;
              break;
            }
          }
        } catch (_) {
          // Continue search in previous month
        }

        targetMonth--;
        if (targetMonth < 1) {
          targetMonth = 12;
          targetYear--;
        }
      }

      if (resolvedFile) {
        targetPath = resolvedFile;
      } else {
        // Fallback default convention
        targetPath = '2026/11/NEWSLETTER NOVEMBER.pdf';
      }
    }

    // Generate a secure signed URL (30 days) from private Supabase storage bucket
    const expiresInSeconds = 30 * 24 * 60 * 60; // 30 days
    const { data: signedData, error: signError } = await supabase.storage
      .from(NEWSLETTER_BUCKET)
      .createSignedUrl(targetPath, expiresInSeconds);

    if (signedData?.signedUrl) {
      return signedData.signedUrl;
    }

    if (signError) {
      console.warn(`[NewsletterStorage] Failed to create signed URL for private object ${targetPath}:`, signError.message);
    }

    return null;
  } catch (error: any) {
    console.error('[NewsletterStorage] Error resolving PDF attachment URL from Supabase Storage:', error?.message || error);
    return null;
  }
}
