import crypto from 'crypto';

export interface TranslatableArticleFields {
  title: string;
  excerpt: string;
  content: string;
  meta_title: string;
  meta_description: string;
  keywords?: string[];
}

export interface TranslatedArticleResult {
  title: string;
  excerpt: string;
  content: string;
  meta_title: string;
  meta_description: string;
  keywords: string[];
  source_hash: string;
  translated_at: string;
  provider: string;
}

/**
 * Calculates a deterministic SHA-256 hash of the translatable source fields.
 * Used to detect changes and avoid redundant re-translations.
 */
export function calculateSourceHash(fields: TranslatableArticleFields): string {
  const payload = [
    fields.title.trim(),
    fields.excerpt.trim(),
    fields.content.trim(),
    fields.meta_title.trim(),
    fields.meta_description.trim(),
    (fields.keywords || []).map((k) => k.trim()).sort().join(','),
  ].join(':::');

  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Normalizes and protects specific non-translatable tokens (author names, URLs, code blocks).
 */
function protectNonTranslatables(text: string): { protectedText: string; tokens: Map<string, string> } {
  const tokens = new Map<string, string>();
  let counter = 0;

  const replaceWithToken = (match: string): string => {
    const placeholder = `__LP_TOKEN_${counter++}__`;
    tokens.set(placeholder, match);
    return placeholder;
  };

  // 1. Protect code blocks
  let protectedText = text.replace(/```[\s\S]*?```/g, replaceWithToken);
  protectedText = protectedText.replace(/`[^`\n]+`/g, replaceWithToken);

  // 2. Protect author name
  protectedText = protectedText.replace(/Lionel Eersteling/g, replaceWithToken);

  // 3. Protect URLs
  protectedText = protectedText.replace(/https?:\/\/[^\s)<>"]+/g, replaceWithToken);

  return { protectedText, tokens };
}

function restoreNonTranslatables(text: string, tokens: Map<string, string>): string {
  let restored = text;
  for (const [placeholder, original] of tokens.entries()) {
    // Some engines might add spaces around underscores: e.g. __ LP_TOKEN_0 __
    const regex = new RegExp(placeholder.replace(/_/g, '\\s*_\\s*'), 'g');
    restored = restored.replace(regex, original);
  }
  return restored;
}

export class TranslationService {
  private apiUrl: string;
  private apiKey?: string;
  private timeoutMs: number;

  constructor() {
    this.apiUrl = (process.env.TRANSLATION_API_URL || 'http://localhost:5000').replace(/\/$/, '');
    this.apiKey = process.env.TRANSLATION_API_KEY;
    this.timeoutMs = Number(process.env.TRANSLATION_TIMEOUT_MS) || 30000;
  }

  /**
   * Translates a single text or HTML snippet using LibreTranslate / Argos HTTP endpoint.
   */
  async translateSnippet(
    text: string,
    sourceLang: string = 'en',
    targetLang: string = 'nl',
    isHtml: boolean = false
  ): Promise<string> {
    if (!text || !text.trim()) {
      return text;
    }

    const { protectedText, tokens } = protectNonTranslatables(text);

    try {
      const response = await fetch(`${this.apiUrl}/translate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { 'X-API-Key': this.apiKey } : {}),
        },
        body: JSON.stringify({
          q: protectedText,
          source: sourceLang,
          target: targetLang,
          format: isHtml ? 'html' : 'text',
          api_key: this.apiKey,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new Error(`Translation API error (HTTP ${response.status}): ${errorBody || response.statusText}`);
      }

      const data = (await response.json()) as { translatedText?: string };
      if (!data || typeof data.translatedText !== 'string') {
        throw new Error('Translation API returned invalid JSON or missing translatedText');
      }

      return restoreNonTranslatables(data.translatedText, tokens);
    } catch (err: any) {
      console.warn(`[TranslationService] Engine call to ${this.apiUrl} failed:`, err.message);
      throw err;
    }
  }

  /**
   * Translates markdown content block by block, preserving markdown headings, bullet lists, and links.
   */
  async translateMarkdownContent(markdown: string): Promise<string> {
    if (!markdown || !markdown.trim()) return markdown;

    // Split into paragraphs / blocks by double newlines
    const blocks = markdown.split(/\n\n+/);
    const translatedBlocks: string[] = [];

    for (const block of blocks) {
      const trimmed = block.trim();
      if (!trimmed) {
        translatedBlocks.push(block);
        continue;
      }

      // Check for markdown headings (# Heading, ## Heading)
      const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (headingMatch) {
        const hashes = headingMatch[1];
        const headingText = headingMatch[2];
        const translatedHeading = await this.translateSnippet(headingText, 'en', 'nl', false);
        translatedBlocks.push(`${hashes} ${translatedHeading}`);
        continue;
      }

      // Check for blockquote (> Quote)
      const quoteMatch = trimmed.match(/^>\s+(.*)$/);
      if (quoteMatch) {
        const quoteText = quoteMatch[1];
        const translatedQuote = await this.translateSnippet(quoteText, 'en', 'nl', false);
        translatedBlocks.push(`> ${translatedQuote}`);
        continue;
      }

      // Check for bullet lists (- item, * item, • item)
      if (/^[ \t]*[-*•]\s+/m.test(trimmed)) {
        const lines = trimmed.split('\n');
        const translatedLines: string[] = [];
        for (const line of lines) {
          const itemMatch = line.match(/^([ \t]*[-*•]\s+)(.*)$/);
          if (itemMatch) {
            const bullet = itemMatch[1].replace('•', '-');
            const itemText = itemMatch[2];
            const translatedItem = await this.translateSnippet(itemText, 'en', 'nl', false);
            translatedLines.push(`${bullet}${translatedItem}`);
          } else {
            translatedLines.push(await this.translateSnippet(line, 'en', 'nl', false));
          }
        }
        translatedBlocks.push(translatedLines.join('\n'));
        continue;
      }

      // Standard paragraph (with HTML format support so inline <strong>, <em>, <a> tags are kept)
      const translatedParagraph = await this.translateSnippet(trimmed, 'en', 'nl', true);
      translatedBlocks.push(translatedParagraph);
    }

    return translatedBlocks.join('\n\n');
  }

  /**
   * Translates all translatable article fields from English to Dutch.
   */
  async translateArticle(fields: TranslatableArticleFields): Promise<TranslatedArticleResult> {
    const sourceHash = calculateSourceHash(fields);

    console.log(`[TranslationService] Translating article "${fields.title}" to Dutch...`);

    const [translatedTitle, translatedExcerpt, translatedContent, translatedMetaTitle, translatedMetaDesc] =
      await Promise.all([
        this.translateSnippet(fields.title, 'en', 'nl', false),
        this.translateSnippet(fields.excerpt, 'en', 'nl', false),
        this.translateMarkdownContent(fields.content),
        this.translateSnippet(fields.meta_title, 'en', 'nl', false),
        this.translateSnippet(fields.meta_description, 'en', 'nl', false),
      ]);

    // Translate keywords array
    let translatedKeywords: string[] = [];
    if (fields.keywords && fields.keywords.length > 0) {
      translatedKeywords = await Promise.all(
        fields.keywords.map((k) => this.translateSnippet(k, 'en', 'nl', false).catch(() => k))
      );
    }

    console.log(`[TranslationService] Successfully translated article to Dutch: "${translatedTitle}"`);

    return {
      title: translatedTitle,
      excerpt: translatedExcerpt,
      content: translatedContent,
      meta_title: translatedMetaTitle,
      meta_description: translatedMetaDesc,
      keywords: translatedKeywords,
      source_hash: sourceHash,
      translated_at: new Date().toISOString(),
      provider: 'libretranslate',
    };
  }
}

export const translationService = new TranslationService();
