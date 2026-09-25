import { describe, it, expect, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { normalizeArticleContent } from '../api/utils/articleContentNormalizer';
import { articlesRoutes } from '../api/routes/articles.routes';
import { articlesRepository } from '../api/repositories/articles.repository';

const app = express();
app.use(express.json());
app.use('/api/articles', articlesRoutes);
app.use('/api/v1/articles', articlesRoutes);

describe('normalizeArticleContent Unit & Integration Tests', () => {
  jest.setTimeout(30000);

  it('Test 1 — malformed escaped list markers: should convert \\* to ● with double newline separation', () => {
    const input = '\\* First item\n\\* Second item';
    const expected = '● First item\n\n● Second item';
    expect(normalizeArticleContent(input)).toBe(expected);
  });

  it('Test 2 — Markdown asterisk list: should convert * to ● and ensure double newline separation', () => {
    const input = '* First item\n* Second item';
    const expected = '● First item\n\n● Second item';
    expect(normalizeArticleContent(input)).toBe(expected);
  });

  it('Test 3 — Markdown hyphen and plus lists: should convert - and + to ● and ensure double newline separation', () => {
    const inputHyphen = '- First item\n- Second item';
    const expectedHyphen = '● First item\n\n● Second item';
    expect(normalizeArticleContent(inputHyphen)).toBe(expectedHyphen);

    const inputPlus = '+ First item\n+ Second item';
    const expectedPlus = '● First item\n\n● Second item';
    expect(normalizeArticleContent(inputPlus)).toBe(expectedPlus);
  });

  it('Test 4 — ensures separation between preceding paragraph, list items, and following paragraph', () => {
    const input = 'Intro paragraph:\n* First item\n* Second item\nFollowing paragraph.';
    const expected = 'Intro paragraph:\n\n● First item\n\n● Second item\n\nFollowing paragraph.';
    expect(normalizeArticleContent(input)).toBe(expected);
  });

  it('Test 5 — normal article content with no list issues: should remain exactly unchanged (same reference)', () => {
    const input = '## Heading\n\nThis is a normal paragraph.\n\nAnother paragraph.';
    expect(normalizeArticleContent(input)).toBe(input);
  });

  it('Test 6 — code blocks and legitimate characters: should not modify code blocks or non-list characters', () => {
    const inputWithCode = '```markdown\n* code line 1\n* code line 2\n# FAQ inside code\n```';
    expect(normalizeArticleContent(inputWithCode)).toBe(inputWithCode);

    const inputWithPunctuation = 'This has \\*bold\\* text, an escaped price \\$100, and mid-sentence \\* marker.\n\\+123456789 (phone without space)\n\\-15 (temperature without space)';
    expect(normalizeArticleContent(inputWithPunctuation)).toBe(inputWithPunctuation);
  });

  it('Test 7 — indented list items: preserves indentation with ● bullet', () => {
    const input = '  * Nested item 1\n    - Deeply nested item 2';
    const expected = '  ● Nested item 1\n\n    ● Deeply nested item 2';
    expect(normalizeArticleContent(input)).toBe(expected);
  });

  it('Test 8 — null/undefined/empty input safety', () => {
    expect(normalizeArticleContent('')).toBe('');
    expect(normalizeArticleContent(undefined as any)).toBeUndefined();
    expect(normalizeArticleContent(null as any)).toBeNull();
  });

  it('Test 9 — mid-article H1 headings: should normalize # FAQ and mid-article H1 to ## while preserving article title', () => {
    const input = '# Main Article Title\n\nParagraph text.\n\n# FAQ\n\n## Question 1\n\nAnswer 1.';
    const expected = '# Main Article Title\n\nParagraph text.\n\n## FAQ\n\n## Question 1\n\nAnswer 1.';
    expect(normalizeArticleContent(input)).toBe(expected);

    const inputFaqOnly = 'Some text.\n\n# FAQ\n\n## Question 1';
    const expectedFaqOnly = 'Some text.\n\n## FAQ\n\n## Question 1';
    expect(normalizeArticleContent(inputFaqOnly)).toBe(expectedFaqOnly);
  });

  it('Test 10 — full affected article: verify "i-built-the-company-but-now-i-am-trapped-inside-it"', async () => {
    const slug = 'i-built-the-company-but-now-i-am-trapped-inside-it';
    const rawArticle = await articlesRepository.findArticleBySlug(slug, false);

    if (rawArticle) {
      const normalizedContent = normalizeArticleContent(rawArticle.content);
      // List items normalized
      expect(normalizedContent).toContain('● Identity fusion:');
      expect(normalizedContent).toContain('● Structural dependency:');
      expect(normalizedContent).toMatch(/● Identity fusion:[^\n]+\n\n● Structural dependency:/);

      // # FAQ normalized to ## FAQ
      expect(normalizedContent).toContain('## FAQ');
      expect(normalizedContent).not.toMatch(/^#\s+FAQ\b/m);

      // Verify through actual API endpoints
      const resV1 = await request(app).get(`/api/v1/articles/${slug}`);
      expect(resV1.status).toBe(200);
      expect(resV1.body.article).toBeDefined();
      expect(resV1.body.article.content).toContain('● Identity fusion:');
      expect(resV1.body.article.content).toContain('● Structural dependency:');
      expect(resV1.body.article.content).toContain('## FAQ');
      expect(resV1.body.article.content).not.toMatch(/^#\s+FAQ\b/m);
      expect(resV1.body.article.content).toBe(normalizedContent);

      const resLegacy = await request(app).get(`/api/articles/${slug}`);
      expect(resLegacy.status).toBe(200);
      expect(resLegacy.body.article.content).toBe(normalizedContent);
    }
  });

  it('Test 11 — other articles: articles without formatting issues remain unchanged', async () => {
    const published = await articlesRepository.findPublishedArticles();
    for (const item of published.slice(0, 5)) {
      const article = await articlesRepository.findArticleBySlug(item.slug, false);
      if (article && !/^[ \t]*\\?[*\-+•●][ \t]+(?!\*|-|\+)\S/m.test(article.content) && !/\n#\s+/m.test(article.content)) {
        const normalized = normalizeArticleContent(article.content);
        expect(normalized).toBe(article.content);

        const res = await request(app).get(`/api/v1/articles/${article.slug}`);
        if (res.status === 200) {
          expect(res.body.article.content).toBe(article.content);
        }
      }
    }
  });
});
