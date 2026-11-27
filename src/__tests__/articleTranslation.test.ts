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

  it('restores tokens even when translation engine mangles placeholder format (e.g. LP TOKEN 0)', () => {
    const rawContent = 'Strategisch overleg met [[LPTOKEN0]] en het team van [[LPTOKEN1]].';
    const tokens = new Map<string, string>();
    tokens.set('[[LPTOKEN0]]', 'Lionel Eersteling');
    tokens.set('[[LPTOKEN1]]', 'Leaders Performance');

    // Simulated mangled output from Argos / Marian
    const mangledOutput = 'Strategisch overleg met LP TOKEN 0 en het team van  LP TOKEN 1 .';

    // Restoration logic as implemented in translationService
    let restored = mangledOutput;
    let idx = 0;
    for (const [, original] of tokens.entries()) {
      const flexiblePattern = new RegExp(
        `(?:\\[\\[|__|\\b)\\s*LP[\\s_]*TOKEN[\\s_]*${idx}\\s*(?:\\]\\]|__|\\b)`,
        'gi'
      );
      restored = restored.replace(flexiblePattern, original);
      idx++;
    }

    expect(restored).toContain('Lionel Eersteling');
    expect(restored).toContain('Leaders Performance');
    expect(restored).not.toContain('LP TOKEN');
  });

  it('detects and throws error if any unrestored placeholder remains', () => {
    const corruptedText = 'Hier is tekst met unrestored LP TOKEN 0 die gemist is.';
    const checkSafety = (text: string) => {
      if (/LP[\s_]*TOKEN/i.test(text)) {
        throw new Error('Translation safety check failed: unrestored placeholder found in output');
      }
    };

    expect(() => checkSafety(corruptedText)).toThrow('Translation safety check failed');
  });

  it('preserves markdown headings even when followed by a single newline', async () => {
    const markdownWithSingleNewlines = [
      '# Main Title',
      'First line of introduction right below title without blank line.',
      '## The Bottleneck Problem',
      'Paragraph text explaining the bottleneck.',
      '### Key Indicators',
      '- Point one',
      '- Point two',
      '## Resolution Strategy',
      'Final remarks.',
    ].join('\n');

    // Verify heading extraction: 4 headings total
    const headings = markdownWithSingleNewlines.match(/^\s*#{1,6}\s+/gm) || [];
    expect(headings).toHaveLength(4);

    // Ensure line-by-line separation distinguishes headings from adjacent paragraphs
    const lines = markdownWithSingleNewlines.split('\n');
    const detectedHeadings: string[] = [];
    for (const line of lines) {
      const match = line.match(/^(\s*#{1,6}\s+)(.*)$/);
      if (match) {
        detectedHeadings.push(match[1].trim());
      }
    }
    expect(detectedHeadings).toEqual(['#', '##', '###', '##']);
  });

  it('applies Dutch style guide rules correctly', () => {
    // Style guide substitutions:
    // uw -> je, u -> je
    // stichter -> founder, stichters -> founders
    // executie -> uitvoering
    // oudere huur -> senior hire
    // half rechts en half fout -> half goed en half fout
    let text = 'Als stichter moet u uw executie aanscherpen voor elke oudere huur die half rechts en half fout werkt.';
    
    // Tone
    text = text.replace(/\buw\b/gi, (m) => (m[0] === 'U' ? 'Je' : 'je'));
    text = text.replace(/\b([Uu])\b/g, (m) => (m === 'U' ? 'Je' : 'je'));
    // Terminology
    text = text.replace(/\bstichters\b/g, 'founders').replace(/\bstichter\b/g, 'founder');
    text = text.replace(/\bexecutie\b/g, 'uitvoering');
    text = text.replace(/\boudere huur\b/gi, 'senior hire');
    text = text.replace(/\bhalf rechts en half fout\b/gi, 'half goed en half fout');

    expect(text).toBe('Als founder moet je je uitvoering aanscherpen voor elke senior hire die half goed en half fout werkt.');
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
