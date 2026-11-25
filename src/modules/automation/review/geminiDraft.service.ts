import { automationPrisma, transition } from '../state/transition';
import { notificationService } from '../notifications/notification.service';

export const ALLOWED_CONTENT_CATEGORIES = [
  'Founder Pressure',
  'Leadership',
  'Business',
  'Vitality',
  'Personal Development',
  'Cases',
  'Personal Stories',
] as const;

export type AllowedContentCategory = (typeof ALLOWED_CONTENT_CATEGORIES)[number];

export const PLATFORM_LIMITS: Record<
  string,
  { maxCaptionLength: number; maxTitleLength: number; maxHashtags: number }
> = {
  LINKEDIN: { maxCaptionLength: 3000, maxTitleLength: 200, maxHashtags: 15 },
  LINKEDIN_NEWSLETTER: { maxCaptionLength: 10000, maxTitleLength: 150, maxHashtags: 10 },
  INSTAGRAM: { maxCaptionLength: 2200, maxTitleLength: 150, maxHashtags: 30 },
  YOUTUBE: { maxCaptionLength: 5000, maxTitleLength: 100, maxHashtags: 15 },
  TIKTOK: { maxCaptionLength: 2200, maxTitleLength: 150, maxHashtags: 15 },
  DEFAULT: { maxCaptionLength: 3000, maxTitleLength: 150, maxHashtags: 15 },
};

export interface GeminiDraftOutput {
  title?: string | null;
  caption: string;
  hashtags: string[];
  category: AllowedContentCategory;
}

/**
 * Strips AI prompt artifacts, intro phrases ("Here is a caption:"), leading hashtag dumps,
 * and wrapping quotes from captions before saving to database (Task 10).
 */
export function cleanCaptionBoilerplate(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';
  let text = raw.trim();

  const prefixPatterns = [
    /^(here\s+(is|are)\s+(a\s+|the\s+)?(draft\s+|suggested\s+)?(caption|post|text|copy)[:\s\-]*)/i,
    /^(here'?s\s+(a\s+|the\s+)?(draft\s+|suggested\s+)?(caption|post|text|copy)[:\s\-]*)/i,
    /^(option\s+\d+[:\s\-]*)/i,
    /^(draft\s+\d+[:\s\-]*)/i,
    /^(caption\s*[:\-]\s*)/i,
    /^(post\s*[:\-]\s*)/i,
    /^(title\s*[:\-]\s*)/i,
    /^(hook\s*[:\-]\s*)/i,
    /^(main title\s*[:\-]\s*)/i,
    /^(full description\s*[:\-]\s*)/i,
    /^(sure[!,.]?\s*(here\s+is.*)?[:\s\-]*)/i,
    /^(certainly[!,.]?\s*(here\s+is.*)?[:\s\-]*)/i,
  ];

  let cleaned = true;
  while (cleaned) {
    cleaned = false;
    for (const pat of prefixPatterns) {
      if (pat.test(text)) {
        text = text.replace(pat, '').trim();
        cleaned = true;
      }
    }
  }

  // Strip leading hashtag dumps
  const lines = text.split('\n');
  while (lines.length > 0) {
    const firstLine = lines[0].trim();
    if (firstLine.length > 0 && /^(\s*#\w+)+$/.test(firstLine)) {
      lines.shift();
    } else {
      break;
    }
  }
  text = lines.join('\n').trim();

  // Unwrap quotes
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length > 2) ||
    (text.startsWith('“') && text.endsWith('”') && text.length > 2)
  ) {
    text = text.slice(1, -1).trim();
  }

  text = text.replace(/\n{3,}/g, '\n\n');
  return text;
}

export function cleanTitleBoilerplate(rawTitle?: string | null): string | null {
  if (!rawTitle || typeof rawTitle !== 'string') return null;
  let t = rawTitle.trim();
  t = t.replace(/^(title|main title|hook|topic)\s*[:\-]\s*/i, '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('“') && t.endsWith('”'))) {
    t = t.slice(1, -1).trim();
  }
  return t || null;
}

/**
 * Validates a Gemini draft output against all Plan Section 6 Step 9-10 rules:
 * - No word "coach" (unless already present verbatim in Drive file, though rule says "Never use the word coach")
 * - Valid category (one of the 7 allowed categories)
 * - Within platform character and hashtag limits
 */
export function validateGeminiDraftOutput(
  draft: any,
  platform: string
): { valid: boolean; reason?: string; normalized?: GeminiDraftOutput } {
  if (!draft || typeof draft !== 'object') {
    return { valid: false, reason: 'Draft output is not a JSON object' };
  }

  const rawCaption = typeof draft.caption === 'string' ? draft.caption : '';
  const caption = cleanCaptionBoilerplate(rawCaption);
  if (!caption) {
    return { valid: false, reason: 'Draft caption is empty' };
  }

  const rawTitle =
    typeof draft.title === 'string' && draft.title.trim() ? draft.title.trim() : null;
  const title = cleanTitleBoilerplate(rawTitle);

  // Hard rule: Never use the word "coach"
  if (/\bcoach(ing|es|ed)?\b/i.test(caption) || (title && /\bcoach(ing|es|ed)?\b/i.test(title))) {
    return { valid: false, reason: 'Draft contains forbidden word "coach"' };
  }

  const limits = PLATFORM_LIMITS[platform] || PLATFORM_LIMITS.DEFAULT;
  if (caption.length > limits.maxCaptionLength) {
    return {
      valid: false,
      reason: `Caption length (${caption.length}) exceeds ${platform} limit of ${limits.maxCaptionLength}`,
    };
  }

  if (title && title.length > limits.maxTitleLength) {
    return {
      valid: false,
      reason: `Title length (${title.length}) exceeds ${platform} limit of ${limits.maxTitleLength}`,
    };
  }

  const rawHashtags = Array.isArray(draft.hashtags) ? draft.hashtags : [];
  const hashtags = rawHashtags
    .map((h: any) => String(h || '').trim())
    .filter(Boolean)
    .map((h: string) => (h.startsWith('#') ? h : `#${h}`))
    .filter((h: string) => !/\bcoach/i.test(h));

  if (hashtags.length > limits.maxHashtags) {
    return {
      valid: false,
      reason: `Hashtag count (${hashtags.length}) exceeds ${platform} limit of ${limits.maxHashtags}`,
    };
  }

  const rawCat = typeof draft.category === 'string' ? draft.category.trim() : '';
  const matchedCat = ALLOWED_CONTENT_CATEGORIES.find(
    (c) => c.toLowerCase() === rawCat.toLowerCase()
  );
  if (!matchedCat) {
    return {
      valid: false,
      reason: `Invalid category "${rawCat}"; must be one of: ${ALLOWED_CONTENT_CATEGORIES.join(', ')}`,
    };
  }

  return {
    valid: true,
    normalized: {
      title,
      caption,
      hashtags,
      category: matchedCat,
    },
  };
}

/**
 * Builds the system prompt for Gemini per Plan Section 6 Step 9.
 */
export function buildGeminiSystemPrompt(
  platform: string,
  channelToneReference?: string | null
): string {
  const limits = PLATFORM_LIMITS[platform] || PLATFORM_LIMITS.DEFAULT;
  const languageRule =
    platform === 'TIKTOK'
      ? 'Use Dutch (Nederlands) for the TikTok account.'
      : 'Keep the language of the source text (English unless the source text is Dutch).';

  return [
    `You are the editorial formatting assistant for Mr. Lionel Eersteling (Leaders Performance).`,
    `Target platform: ${platform}.`,
    `Strict rules:`,
    `1. When a caption file text is provided, keep Lionel's exact wording. Only select the right platform section, format line breaks cleanly, and trim to ${limits.maxCaptionLength} characters max.`,
    `2. Never invent or add facts. Never use the word "coach" or "coaching" anywhere in title, caption, or hashtags.`,
    `3. ${languageRule}`,
    `4. Classify "category" into one of: ${ALLOWED_CONTENT_CATEGORIES.join(', ')}.`,
    `5. Return strict JSON matching { "title": string, "caption": string, "hashtags": string[], "category": string }.`,
    channelToneReference ? `\nChannel Tone & System Prompt Reference:\n${channelToneReference}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export class GeminiDraftService {
  /**
   * Calls the Gemini REST API with strict `responseSchema` and timeout, retrying once on error (Edge Case #16).
   */
  public async callGeminiWithRetry(params: {
    platform: string;
    contentType?: string | null;
    subject?: string | null;
    sourceCaptionText: string;
    channelToneReference?: string | null;
    customGenerator?: (attempt: number) => Promise<any>;
  }): Promise<{
    success: boolean;
    draft?: GeminiDraftOutput;
    attempts: number;
    errorReason?: string;
  }> {
    const maxAttempts = 2; // Edge Case #16: Retry once (2 total attempts)
    let lastError = 'Unknown Gemini error';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        let rawJson: any;
        if (params.customGenerator) {
          rawJson = await params.customGenerator(attempt);
        } else {
          rawJson = await this.invokeGeminiApi(params);
        }

        const validation = validateGeminiDraftOutput(rawJson, params.platform);
        if (validation.valid && validation.normalized) {
          return {
            success: true,
            draft: validation.normalized,
            attempts: attempt,
          };
        }

        lastError = validation.reason || 'Validation failed';
      } catch (err: any) {
        lastError = err?.message || 'Gemini request failed';
      }
    }

    return {
      success: false,
      attempts: maxAttempts,
      errorReason: lastError,
    };
  }

  private async invokeGeminiApi(params: {
    platform: string;
    contentType?: string | null;
    subject?: string | null;
    sourceCaptionText: string;
    channelToneReference?: string | null;
  }): Promise<any> {
    const apiKey = (process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not configured');
    }

    const model = (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();
    const systemPrompt = buildGeminiSystemPrompt(
      params.platform,
      params.channelToneReference
    );

    const userPrompt = [
      `Platform: ${params.platform}`,
      `Content Type: ${params.contentType || 'Post'}`,
      `Subject: ${params.subject || ''}`,
      `Source Caption Text:\n${params.sourceCaptionText}`,
    ].join('\n');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        model
      )}:generateContent?key=${encodeURIComponent(apiKey)}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemPrompt }],
          },
          contents: [
            {
              role: 'user',
              parts: [{ text: userPrompt }],
            },
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'OBJECT',
              properties: {
                title: { type: 'STRING' },
                caption: { type: 'STRING' },
                hashtags: {
                  type: 'ARRAY',
                  items: { type: 'STRING' },
                },
                category: {
                  type: 'STRING',
                  enum: [...ALLOWED_CONTENT_CATEGORIES],
                },
              },
              required: ['caption', 'hashtags', 'category'],
            },
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`Gemini HTTP ${response.status}`);
      }

      const data: any = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw new Error('Empty response from Gemini');
      }

      return JSON.parse(text);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Step 10 of Flow 1 (`POST /internal/posts/:id/draft`):
   * Formats or validates the draft for a post, handles Edge Case #16 fallback when Gemini fails,
   * ensures status is PENDING_REVIEW, records a PostRevision, and queues REVIEW_REQUEST notification.
   */
  public async saveDraftForPost(
    postId: string,
    input: {
      title?: string | null;
      caption?: string | null;
      hashtags?: string[];
      category?: string | null;
      useBackendGemini?: boolean;
      channelToneReference?: string | null;
      customGenerator?: (attempt: number) => Promise<any>;
    } = {}
  ) {
    const post = await automationPrisma.post.findUnique({
      where: { id: postId },
      include: {
        contentItem: true,
        media: {
          include: { asset: true },
        },
      },
    });

    if (!post) {
      throw new Error(`Post ${postId} not found`);
    }

    // Do not overwrite an already APPROVED or PUBLISHED post's caption during background draft runs
    if (post.status === 'APPROVED' || post.status === 'PUBLISHED') {
      return {
        post,
        usedFallback: false,
        skippedBecauseApproved: true,
      };
    }

    const sourceText =
      (post.caption && post.caption.trim()) ||
      (post.contentItem.subject && post.contentItem.subject.trim()) ||
      post.title ||
      'Scheduled post';

    const hasDriveCaptionAsset = post.media.some(
      (m) => m.role === 'CAPTION_SOURCE' && m.asset.status === 'READY'
    );

    const limits = PLATFORM_LIMITS[post.platform] || PLATFORM_LIMITS.DEFAULT;

    let finalTitle = post.title || post.contentItem.subject || null;
    let finalCaption = sourceText;
    let finalHashtags: string[] = post.hashtags || [];
    let finalCategory: string | null = post.contentItem.category || null;
    let captionSource = hasDriveCaptionAsset ? 'DRIVE_FILE' : 'CALENDAR';
    let usedFallback = false;
    let fallbackReason: string | null = null;

    // Case A: Direct draft payload sent by n8n (without useBackendGemini)
    if (input.caption !== undefined && input.caption !== null && !input.useBackendGemini && !input.customGenerator) {
      const check = validateGeminiDraftOutput(
        {
          title: input.title ?? finalTitle,
          caption: input.caption,
          hashtags: input.hashtags ?? [],
          category: input.category || 'Leadership',
        },
        post.platform
      );

      if (check.valid && check.normalized) {
        finalTitle = check.normalized.title ?? finalTitle;
        finalCaption = check.normalized.caption;
        finalHashtags = check.normalized.hashtags;
        finalCategory = check.normalized.category;
        captionSource = hasDriveCaptionAsset ? 'DRIVE_FILE' : 'GEMINI';
      } else {
        // Retry once via backend Gemini if direct payload failed validation, then fallback
        const retryRes = await this.callGeminiWithRetry({
          platform: post.platform,
          contentType: post.contentItem.contentType,
          subject: post.contentItem.subject,
          sourceCaptionText: sourceText,
          channelToneReference: input.channelToneReference,
          customGenerator: input.customGenerator,
        });
        if (retryRes.success && retryRes.draft) {
          finalTitle = retryRes.draft.title ?? finalTitle;
          finalCaption = retryRes.draft.caption;
          finalHashtags = retryRes.draft.hashtags;
          finalCategory = retryRes.draft.category;
          captionSource = hasDriveCaptionAsset ? 'DRIVE_FILE' : 'GEMINI';
        } else {
          usedFallback = true;
          fallbackReason = check.reason || retryRes.errorReason || 'Validation failed';
          finalCaption = sourceText.slice(0, limits.maxCaptionLength);
          captionSource = hasDriveCaptionAsset ? 'DRIVE_FILE' : 'CALENDAR';
        }
      }
    } else {
      // Case B: Run Gemini formatting with 1 retry (Edge Case #16)
      const geminiRes = await this.callGeminiWithRetry({
        platform: post.platform,
        contentType: post.contentItem.contentType,
        subject: post.contentItem.subject,
        sourceCaptionText: sourceText,
        channelToneReference: input.channelToneReference,
        customGenerator: input.customGenerator,
      });

      if (geminiRes.success && geminiRes.draft) {
        finalTitle = geminiRes.draft.title ?? finalTitle;
        finalCaption = geminiRes.draft.caption;
        finalHashtags = geminiRes.draft.hashtags;
        finalCategory = geminiRes.draft.category;
        captionSource = hasDriveCaptionAsset ? 'DRIVE_FILE' : 'GEMINI';
      } else {
        usedFallback = true;
        fallbackReason = geminiRes.errorReason || 'Gemini formatting failed';
        finalCaption = sourceText.slice(0, limits.maxCaptionLength);
        captionSource = hasDriveCaptionAsset ? 'DRIVE_FILE' : 'CALENDAR';
      }
    }

    const currentOpts =
      typeof post.options === 'object' && post.options !== null
        ? (post.options as Record<string, any>)
        : {};

    const updatedPost = await automationPrisma.post.update({
      where: { id: post.id },
      data: {
        title: finalTitle ? finalTitle.slice(0, limits.maxTitleLength) : null,
        caption: finalCaption,
        hashtags: finalHashtags,
        captionSource,
        options: {
          ...currentOpts,
          geminiFallback: usedFallback,
          geminiFallbackReason: fallbackReason,
          category: finalCategory,
        },
      },
    });

    if (finalCategory && finalCategory !== post.contentItem.category) {
      await automationPrisma.contentItem.update({
        where: { id: post.contentItemId },
        data: { category: finalCategory },
      });
    }

    // Ensure post is in PENDING_REVIEW if all media are READY
    let finalPost = updatedPost;
    const allMediaReady =
      post.media.length === 0 || post.media.every((m) => m.asset.status === 'READY');
    if (finalPost.status === 'BLOCKED' && allMediaReady) {
      finalPost = await transition(post.id, 'FILE_RESOLVED', {
        actorId: 'gemini-draft',
        comment: usedFallback
          ? `Draft saved via fallback (${captionSource}): ${fallbackReason}`
          : 'Gemini draft formatted and validated',
      });
    }

    // Upsert PostRevision snapshot for current revision
    const existingRevision = await automationPrisma.postRevision.findFirst({
      where: { postId: post.id, revision: finalPost.revision },
    });
    const mediaSnapshot = post.media.map((m) => ({
      assetId: m.assetId,
      role: m.role,
      position: m.position,
      fileName: m.asset.fileName,
      objectKey: m.asset.objectKey,
    }));

    if (existingRevision) {
      await automationPrisma.postRevision.update({
        where: { id: existingRevision.id },
        data: {
          title: finalPost.title,
          caption: finalPost.caption,
          mediaSnapshot,
        },
      });
    } else {
      await automationPrisma.postRevision.create({
        data: {
          postId: post.id,
          revision: finalPost.revision,
          title: finalPost.title,
          caption: finalPost.caption,
          mediaSnapshot,
          createdById: 'gemini-draft',
        },
      });
    }

    // Queue REVIEW_REQUEST email notification if post is PENDING_REVIEW
    if (finalPost.status === 'PENDING_REVIEW') {
      await notificationService.queueReviewRequest({
        id: finalPost.id,
        platform: finalPost.platform,
        scheduledAt: finalPost.scheduledAt,
        title: finalPost.title,
        caption: finalPost.caption,
        revision: finalPost.revision,
      });
    }

    console.log(
      `[GeminiDraft] postId=${finalPost.id} status=${finalPost.status} source=${captionSource} fallback=${usedFallback}`
    );

    return {
      post: finalPost,
      usedFallback,
      fallbackReason,
    };
  }
}

export const geminiDraftService = new GeminiDraftService();

