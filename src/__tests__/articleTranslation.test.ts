import { describe, it, expect } from '@jest/globals';
import { calculateSourceHash } from '../services/translation/translationService';

describe('Article Translation Architecture & Formatting Tests', () => {
  it('calculateSourceHash should be deterministic and sensitive to field changes', () => {
    const baseFields = {
      title: 'Pressure and Ambition',
      excerpt: 'Executive briefing on leadership under scale.',
      content: '## The Decisive Moment\n\nLeadership is tested when ambiguity peaks.',
      meta_title: 'Pressure and Ambition | Leaders Performance',
      meta_description: 'Strategic guide for high-growth founders.',
      keywords: ['leadership', 'pressure', 'scaling'],
    };

    const hash1 = calculateSourceHash(baseFields);
    const hash2 = calculateSourceHash(baseFields);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex length

    // Changing content should change the hash
    const changedFields = {
      ...baseFields,
      content: '## The Decisive Moment\n\nLeadership is tested when ambiguity peaks and stakes are high.',
    };
    const hashChanged = calculateSourceHash(changedFields);
    expect(hashChanged).not.toBe(hash1);

    // Changing keywords should change the hash
    const changedKeywords = {
      ...baseFields,
      keywords: ['leadership', 'pressure', 'scaling', 'governance'],
    };
    expect(calculateSourceHash(changedKeywords)).not.toBe(hash1);
  });

  it('preserves non-translatable tokens (author names, URLs, code blocks)', () => {
    const rawContent = `
# Executive Framework by Lionel Eersteling

Visit https://leadersperformance.ae/meetlionel for details.

Here is an example code block:
\`\`\`bash
npm run articles:translate-backfill
\`\`\`

Inline code \`x-api-key\` should remain untouched.
    `.trim();

    // Verify token protection regex
    const tokens = new Map<string, string>();
    let counter = 0;
    const replaceWithToken = (match: string): string => {
      const placeholder = `__LP_TOKEN_${counter++}__`;
      tokens.set(placeholder, match);
      return placeholder;
    };

    let protectedText = rawContent.replace(/```[\s\S]*?```/g, replaceWithToken);
    protectedText = protectedText.replace(/`[^`\n]+`/g, replaceWithToken);
    protectedText = protectedText.replace(/Lionel Eersteling/g, replaceWithToken);
    protectedText = protectedText.replace(/https?:\/\/[^\s)<>"]+/g, replaceWithToken);

    expect(protectedText).not.toContain('Lionel Eersteling');
    expect(protectedText).not.toContain('https://leadersperformance.ae/meetlionel');
    expect(protectedText).toContain('__LP_TOKEN_');

    // Verify token restoration
    let restored = protectedText;
    for (const [placeholder, original] of tokens.entries()) {
      const regex = new RegExp(placeholder, 'g');
      restored = restored.replace(regex, original);
    }

    expect(restored).toBe(rawContent);
  });

  it('preserves markdown headers and bullet lists during translation mapping', () => {
    const markdown = [
      '## The Core Problem',
      '',
      'When scale expands, informal habits fail.',
      '',
      '- First crucial shift: operating cadence',
      '- Second crucial shift: decision clarity',
      '- Third crucial shift: accountability',
      '',
      '> Pressure is not the enemy; lack of structure is.',
    ].join('\n');

    const blocks = markdown.split(/\n\n+/);
    expect(blocks).toHaveLength(4);

    // Block 1: heading
    expect(blocks[0]).toMatch(/^##\s+/);

    // Block 2: paragraph
    expect(blocks[1]).toBe('When scale expands, informal habits fail.');

    // Block 3: bullet list
    expect(blocks[2]).toMatch(/^[ \t]*- /m);

    // Block 4: blockquote
    expect(blocks[3]).toMatch(/^>\s+/);
  });
});
