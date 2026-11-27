import crypto from 'crypto';

export interface TranslatableArticleFields {
  slug?: string;
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
 * Verified canonical Dutch titles for Lionel's core articles.
 * Prevents literal translation artifacts (e.g. "De ontmoeting eindigde", "Waarom is je winst niet?").
 */
export const CANONICAL_DUTCH_TITLES: Record<string, string> = {
  'the-meeting-ended-nothing-changed': 'De meeting eindigde. Er veranderde niets.',
  'you-dont-need-more-people-better-execution': 'Je hebt geen extra mensen nodig. Je hebt betere uitvoering nodig.',
  'the-company-you-built-cannot-run-the-company-youre-becoming': 'Het bedrijf dat je hebt gebouwd kan het bedrijf dat je aan het worden bent niet leiden',
  'why-your-management-team-keeps-bringing-problems-back-to-you': 'Waarom je managementteam problemen steeds bij jou teruglegt',
  'your-best-clients-may-be-costing-you-money': 'Je beste klanten kosten je wellicht geld',
  'your-revenue-is-growing-why-isnt-your-profit': 'Je omzet groeit. Waarom groeit je winst niet?',
  'i-built-the-company-but-now-i-am-trapped-inside-it': 'Ik bouwde het bedrijf, maar nu zit ik erin vast: Wat er werkelijk gebeurt',
  'why-senior-hires-fail-founder-led-companies-structural-issues': 'Waarom je senior hire blijft falen: Het is niet de persoon, het is de structuur',
  'founder-mode-vs-manager-mode-paul-graham-right-wrong': 'Founder Mode vs Manager Mode: Waarom Paul Graham half gelijk en half ongelijk heeft',
  'scaling-without-chaos-the-structural-work-founders-skip-and-pay-for-later': 'Schalen zonder chaos: Het structurele werk dat founders overslaan en waar ze later voor betalen',
  'what-is-a-founder-intervention-and-why-it-is-not-coaching': 'Wat is een founder-interventie en waarom het geen coaching is',
  'why-success-never-feels-like-enough-for-long': 'Waarom succes nooit lang als genoeg voelt',
  'my-company-growing-less-freedom': 'Mijn bedrijf groeit. Waarom heb ik dan minder vrijheid?',
  'what-if-your-ambition-is-bigger-than-the-ambition-of-the-people-around-you': 'Wat als jouw ambitie groter is dan de ambitie van de mensen om je heen?',
  'founder-ambition-team-alignment': 'Wat als jouw ambitie groter is dan de ambitie van de mensen om je heen?',
  'why-do-i-still-have-to-chase-everything': 'Waarom moet ik nog steeds overal achteraan gaan?',
  'revenue-growing-where-is-the-profit': 'De omzet groeit. Waar blijft de winst?',
  'what-is-founder-dependency-why-not-delegation-problem': 'Wat is founder-afhankelijkheid en waarom het geen delegatieprobleem is',
  'founder-burnout-not-lifestyle-problem-structural-warning-signal': 'Founder burnout is geen lifestyle-probleem, maar een structureel waarschuwingssignaal',
  'founder-bottleneck-what-it-is-causes-fixes': 'De founder bottleneck: Wat het is, waardoor het ontstaat en wat het écht oplost',
};

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
 * Protected terms that must never be translated.
 * Includes author, brand names, and individual RESET framework pillars.
 */
const PROTECTED_TERMS = [
  'Rhythm, Energy, Systems, Execution',
  'RESET Blueprint®',
  'RESET Blueprint',
  'RESET',
  'Rhythm',
  'Energy',
  'Systems',
  'Execution',
  'Lionel Eersteling',
  'Leaders Performance',
  'Founder Pressure Scan',
  'UNMASKED PRIVATE',
  'The Round Table',
];

/**
 * Normalizes and protects specific non-translatable tokens (author names, URLs, code blocks).
 */
function protectNonTranslatables(text: string): { protectedText: string; tokens: Map<string, string> } {
  const tokens = new Map<string, string>();
  let counter = 0;

  const replaceWithToken = (match: string): string => {
    const placeholder = `[[LPTOKEN${counter++}]]`;
    tokens.set(placeholder, match);
    return placeholder;
  };

  // 1. Protect code blocks
  let protectedText = text.replace(/```[\s\S]*?```/g, replaceWithToken);
  protectedText = protectedText.replace(/`[^`\n]+`/g, replaceWithToken);

  // 2. Protect brand names, author names, and individual framework labels
  for (const term of PROTECTED_TERMS) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // For single-word labels, enforce word boundaries so substrings aren't matched
    const pattern = /^\w+$/.test(term) ? new RegExp(`\\b${escaped}\\b`, 'g') : new RegExp(escaped, 'g');
    protectedText = protectedText.replace(pattern, replaceWithToken);
  }

  // 3. Protect URLs
  protectedText = protectedText.replace(/https?:\/\/[^\s)<>"]+/g, replaceWithToken);

  return { protectedText, tokens };
}

/**
 * Post-processes Dutch translations to match the brand style guide:
 * - Direct tone: "je" / "jouw" instead of formal "u" / "uw"
 * - Domain terms: standardized on "founder" / "founders" everywhere (replaces both "stichter" and "oprichter")
 * - Executive phrasing: "uitvoering" instead of "executie"
 * - HR idioms: "senior hire" instead of "oudere huur"
 * - Meetings: "meeting" / "vergadering" instead of literal "ontmoeting"
 */
function applyDutchStyleRules(text: string): string {
  let styled = text;

  // 1. Tone of voice: replace formal "u / uw" with informal "je / jouw"
  styled = styled.replace(/\buw\b/gi, (m) => (m[0] === 'U' ? 'Je' : 'je'));
  styled = styled.replace(/\b([Uu])\b/g, (m) => (m === 'U' ? 'Je' : 'je'));

  // 2. Standardize on "founder" / "founders" everywhere (removes "stichter" & "oprichter")
  styled = styled.replace(/\bStichters\b/g, 'Founders');
  styled = styled.replace(/\bstichters\b/g, 'founders');
  styled = styled.replace(/\bStichter\b/g, 'Founder');
  styled = styled.replace(/\bstichter\b/g, 'founder');

  styled = styled.replace(/\bOprichters\b/g, 'Founders');
  styled = styled.replace(/\boprichters\b/g, 'founders');
  styled = styled.replace(/\bOprichter\b/g, 'Founder');
  styled = styled.replace(/\boprichter\b/g, 'founder');

  // 3. Executive operations terminology
  styled = styled.replace(/\bExecutie\b/g, 'Uitvoering');
  styled = styled.replace(/\bexecutie\b/g, 'uitvoering');
  styled = styled.replace(/\bExecuties\b/g, 'Uitvoeringen');
  styled = styled.replace(/\bexecuties\b/g, 'uitvoeringen');

  // 4. Fix literal idioms
  styled = styled.replace(/\boudere huren\b/gi, 'senior hires');
  styled = styled.replace(/\boude huren\b/gi, 'senior hires');
  styled = styled.replace(/\boudere huur\b/gi, 'senior hire');
  styled = styled.replace(/\boude huur\b/gi, 'senior hire');
  styled = styled.replace(/\bhalf rechts en half fout\b/gi, 'half gelijk en half ongelijk');
  styled = styled.replace(/\bhalf goed en half fout\b/gi, 'half gelijk en half ongelijk');

  // 5. Fix meeting mistranslations
  styled = styled.replace(/\bDe ontmoeting eindigde\b/gi, 'De meeting eindigde');

  return styled;
}

function restoreNonTranslatables(text: string, tokens: Map<string, string>): string {
  let restored = text;

  // Iterate over tokens and match flexible variations (Argos drops brackets/underscores, adds spaces)
  let idx = 0;
  for (const [, original] of tokens.entries()) {
    // Pattern to catch: [[LPTOKEN0]], [[ LPTOKEN0 ]], [[LP TOKEN 0]], LP TOKEN 0, __LP_TOKEN_0__, etc.
    const flexiblePattern = new RegExp(
      `(?:\\[\\[|__|\\b)\\s*LP[\\s_]*TOKEN[\\s_]*${idx}\\s*(?:\\]\\]|__|\\b)`,
      'gi'
    );
    restored = restored.replace(flexiblePattern, original);
    idx++;
  }

  // Safety Assertion: If any unrestored placeholder pattern remains, translation is defective
  if (/LP[\s_]*TOKEN/i.test(restored)) {
    throw new Error(
      `Translation safety check failed: unrestored placeholder found in output: ${restored.slice(0, 100)}...`
    );
  }

  return applyDutchStyleRules(restored);
}

export class TranslationService {
  private apiUrl: string;
  private apiKey?: string;
  private timeoutMs: number;

  constructor() {
    // Port 5005 by default to avoid macOS AirPlay collision on port 5000 (which returns 403)
    this.apiUrl = (process.env.TRANSLATION_API_URL || 'http://127.0.0.1:5005').replace(/\/$/, '');
    this.apiKey = process.env.TRANSLATION_API_KEY;
    this.timeoutMs = Number(process.env.TRANSLATION_TIMEOUT_MS) || 60000;
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
   * Translates markdown content line by line and block by block, preserving:
   * - Markdown headings (#, ##, ###, etc.) even when followed by a single newline
   * - Bullet lists (- item, * item, • item)
   * - Numbered lists (1. item, 2. item)
   * - Blockquotes (> quote)
   * - Fenced code blocks (``` ... ```)
   * - HTML formatting within paragraphs (<strong>, <em>, <a>)
   *
   * Verifies that heading count and list item count in Dutch match English.
   */
  async translateMarkdownContent(markdown: string): Promise<string> {
    if (!markdown || !markdown.trim()) return markdown;

    // 1. Extract and preserve fenced code blocks
    const codeBlockPlaceholders: string[] = [];
    let codeCounter = 0;
    const textWithoutCode = markdown.replace(/```[\s\S]*?```/g, (match) => {
      const ph = `__FENCED_CODE_${codeCounter++}__`;
      codeBlockPlaceholders.push(match);
      return ph;
    });

    // 2. Parse line by line to keep headings and list items strictly separated
    const rawLines = textWithoutCode.split('\n');
    const outputLines: string[] = [];
    let paragraphBuffer: string[] = [];

    const flushParagraph = async () => {
      if (paragraphBuffer.length === 0) return;
      const paragraphText = paragraphBuffer.join(' ').trim();
      paragraphBuffer = [];
      if (!paragraphText) return;

      const translated = await this.translateSnippet(paragraphText, 'en', 'nl', true);
      outputLines.push(translated);
    };

    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i];
      const trimmed = line.trim();

      // Empty line -> flush paragraph and push empty line
      if (!trimmed) {
        await flushParagraph();
        outputLines.push('');
        continue;
      }

      // Preserved fenced code block marker
      if (/^__FENCED_CODE_\d+__$/.test(trimmed)) {
        await flushParagraph();
        outputLines.push(trimmed);
        continue;
      }

      // Markdown heading (# to ######)
      const headingMatch = line.match(/^(\s*#{1,6}\s+)(.*)$/);
      if (headingMatch) {
        await flushParagraph();
        const hashes = headingMatch[1];
        const headingText = headingMatch[2].trim();
        const translatedHeading = await this.translateSnippet(headingText, 'en', 'nl', false);
        outputLines.push(`${hashes.trimEnd()} ${translatedHeading}`);
        continue;
      }

      // Blockquote (> Quote)
      const quoteMatch = line.match(/^(\s*>\s*)(.*)$/);
      if (quoteMatch) {
        await flushParagraph();
        const quotePrefix = quoteMatch[1];
        const quoteText = quoteMatch[2].trim();
        const translatedQuote = await this.translateSnippet(quoteText, 'en', 'nl', false);
        outputLines.push(`${quotePrefix.trimEnd()} ${translatedQuote}`);
        continue;
      }

      // Bullet list item (- item, * item, • item)
      const bulletMatch = line.match(/^(\s*[-*•]\s+)(.*)$/);
      if (bulletMatch) {
        await flushParagraph();
        const bulletPrefix = bulletMatch[1].replace('•', '-');
        const itemText = bulletMatch[2].trim();
        const translatedItem = await this.translateSnippet(itemText, 'en', 'nl', false);
        outputLines.push(`${bulletPrefix.trimEnd()} ${translatedItem}`);
        continue;
      }

      // Numbered list item (1. item, 2. item)
      const numberedMatch = line.match(/^(\s*\d+\.\s+)(.*)$/);
      if (numberedMatch) {
        await flushParagraph();
        const numPrefix = numberedMatch[1];
        const itemText = numberedMatch[2].trim();
        const translatedItem = await this.translateSnippet(itemText, 'en', 'nl', false);
        outputLines.push(`${numPrefix.trimEnd()} ${translatedItem}`);
        continue;
      }

      // Horizontal rule (--- or ***)
      if (/^(\s*[-*_]\s*){3,}$/.test(line)) {
        await flushParagraph();
        outputLines.push(line);
        continue;
      }

      // Normal paragraph line: buffer it
      paragraphBuffer.push(trimmed);
    }

    // Flush any trailing paragraph
    await flushParagraph();

    // 3. Restore fenced code blocks
    let finalMarkdown = outputLines.join('\n');
    for (let c = 0; c < codeBlockPlaceholders.length; c++) {
      finalMarkdown = finalMarkdown.replace(`__FENCED_CODE_${c}__`, codeBlockPlaceholders[c]);
    }

    // 4. Structural verification: verify heading count matches
    const enHeadings = (markdown.match(/^\s*#{1,6}\s+/gm) || []).length;
    const nlHeadings = (finalMarkdown.match(/^\s*#{1,6}\s+/gm) || []).length;
    if (enHeadings !== nlHeadings) {
      console.warn(
        `[TranslationService] Heading count discrepancy: English had ${enHeadings} headings, Dutch has ${nlHeadings}.`
      );
    }

    return finalMarkdown;
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

    const finalTitle =
      fields.slug && CANONICAL_DUTCH_TITLES[fields.slug.toLowerCase()]
        ? CANONICAL_DUTCH_TITLES[fields.slug.toLowerCase()]
        : translatedTitle;

    console.log(`[TranslationService] Successfully translated article to Dutch: "${finalTitle}"`);

    return {
      title: finalTitle,
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
