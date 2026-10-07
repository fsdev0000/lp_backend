"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NEWSLETTER_BUCKET = void 0;
exports.getNewsletterPdfAttachmentUrl = getNewsletterPdfAttachmentUrl;
const supabaseStorageService_1 = require("./supabaseStorageService");
exports.NEWSLETTER_BUCKET = 'news-letter';
/**
 * Resolves the Supabase Storage PDF path and generates a signed URL.
 * Automatically handles:
 * - Direct relative path (e.g. '2026/10/NEWSLETTER_DESKTOP_FINAL_REVISED.pdf')
 * - Bucket-prefixed path (e.g. 'news-letter/2026/10/NEWSLETTER_DESKTOP_FINAL_REVISED.pdf')
 * - Campaign key derivation (e.g. '2026-10' -> searches '2026/10')
 */
async function getNewsletterPdfAttachmentUrl(pathOrCampaignKey) {
    try {
        const supabase = await (0, supabaseStorageService_1.getSupabaseClient)();
        let targetPath = (pathOrCampaignKey || '').trim();
        // Strip bucket prefix if user provided 'news-letter/...'
        if (targetPath.startsWith(`${exports.NEWSLETTER_BUCKET}/`)) {
            targetPath = targetPath.slice(`${exports.NEWSLETTER_BUCKET}/`.length);
        }
        // If path is a full Supabase URL already, extract the object path or return it
        if (targetPath.startsWith('http://') || targetPath.startsWith('https://')) {
            const match = targetPath.match(new RegExp(`/storage/v1/object/(?:public|sign)/${exports.NEWSLETTER_BUCKET}/([^?]+)`));
            if (match && match[1]) {
                targetPath = decodeURIComponent(match[1]);
            }
            else {
                // Return existing URL if external
                return targetPath;
            }
        }
        // If path is empty or a campaign key format like '2026-10'
        if (!targetPath || /^20\d\d-\d\d$/.test(targetPath)) {
            const [year, month] = (targetPath || '2026-10').split('-');
            const folderPath = `${year}/${month}`;
            // Query files in that folder from Supabase storage
            const { data: files } = await supabase.storage.from(exports.NEWSLETTER_BUCKET).list(folderPath);
            const pdfFile = files?.find((f) => f.name.toLowerCase().endsWith('.pdf') && f.name !== '.emptyFolderPlaceholder');
            if (pdfFile) {
                targetPath = `${folderPath}/${pdfFile.name}`;
            }
            else {
                // Fallback default convention for October 2026
                targetPath = `${folderPath}/NEWSLETTER_DESKTOP_FINAL_REVISED.pdf`;
            }
        }
        // Generate a secure signed URL (30 days) from private Supabase storage bucket
        const expiresInSeconds = 30 * 24 * 60 * 60; // 30 days
        const { data: signedData, error: signError } = await supabase.storage
            .from(exports.NEWSLETTER_BUCKET)
            .createSignedUrl(targetPath, expiresInSeconds);
        if (signedData?.signedUrl) {
            return signedData.signedUrl;
        }
        if (signError) {
            console.warn(`[NewsletterStorage] Failed to create signed URL for private object ${targetPath}:`, signError.message);
        }
        return null;
    }
    catch (error) {
        console.error('[NewsletterStorage] Error resolving PDF attachment URL from Supabase Storage:', error?.message || error);
        return null;
    }
}
