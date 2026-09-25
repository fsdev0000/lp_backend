"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const globals_1 = require("@jest/globals");
const supertest_1 = __importDefault(require("supertest"));
const express_1 = __importDefault(require("express"));
const articleContentNormalizer_1 = require("../api/utils/articleContentNormalizer");
const articles_routes_1 = require("../api/routes/articles.routes");
const articles_repository_1 = require("../api/repositories/articles.repository");
const app = (0, express_1.default)();
app.use(express_1.default.json());
app.use('/api/articles', articles_routes_1.articlesRoutes);
app.use('/api/v1/articles', articles_routes_1.articlesRoutes);
(0, globals_1.describe)('normalizeArticleContent Unit & Integration Tests', () => {
    globals_1.jest.setTimeout(30000);
    (0, globals_1.it)('Test 1 — malformed escaped list markers: should convert \\* to ● with double newline separation', () => {
        const input = '\\* First item\n\\* Second item';
        const expected = '● First item\n\n● Second item';
        (0, globals_1.expect)((0, articleContentNormalizer_1.normalizeArticleContent)(input)).toBe(expected);
    });
    (0, globals_1.it)('Test 2 — Markdown asterisk list: should convert * to ● and ensure double newline separation', () => {
        const input = '* First item\n* Second item';
        const expected = '● First item\n\n● Second item';
        (0, globals_1.expect)((0, articleContentNormalizer_1.normalizeArticleContent)(input)).toBe(expected);
    });
    (0, globals_1.it)('Test 3 — Markdown hyphen and plus lists: should convert - and + to ● and ensure double newline separation', () => {
        const inputHyphen = '- First item\n- Second item';
        const expectedHyphen = '● First item\n\n● Second item';
        (0, globals_1.expect)((0, articleContentNormalizer_1.normalizeArticleContent)(inputHyphen)).toBe(expectedHyphen);
        const inputPlus = '+ First item\n+ Second item';
        const expectedPlus = '● First item\n\n● Second item';
        (0, globals_1.expect)((0, articleContentNormalizer_1.normalizeArticleContent)(inputPlus)).toBe(expectedPlus);
    });
    (0, globals_1.it)('Test 4 — ensures separation between preceding paragraph, list items, and following paragraph', () => {
        const input = 'Intro paragraph:\n* First item\n* Second item\nFollowing paragraph.';
        const expected = 'Intro paragraph:\n\n● First item\n\n● Second item\n\nFollowing paragraph.';
        (0, globals_1.expect)((0, articleContentNormalizer_1.normalizeArticleContent)(input)).toBe(expected);
    });
    (0, globals_1.it)('Test 5 — normal article content with no list issues: should remain exactly unchanged (same reference)', () => {
        const input = '## Heading\n\nThis is a normal paragraph.\n\nAnother paragraph.';
        (0, globals_1.expect)((0, articleContentNormalizer_1.normalizeArticleContent)(input)).toBe(input);
    });
    (0, globals_1.it)('Test 6 — code blocks and legitimate characters: should not modify code blocks or non-list characters', () => {
        const inputWithCode = '```markdown\n* code line 1\n* code line 2\n# FAQ inside code\n```';
        (0, globals_1.expect)((0, articleContentNormalizer_1.normalizeArticleContent)(inputWithCode)).toBe(inputWithCode);
        const inputWithPunctuation = 'This has \\*bold\\* text, an escaped price \\$100, and mid-sentence \\* marker.\n\\+123456789 (phone without space)\n\\-15 (temperature without space)';
        (0, globals_1.expect)((0, articleContentNormalizer_1.normalizeArticleContent)(inputWithPunctuation)).toBe(inputWithPunctuation);
    });
    (0, globals_1.it)('Test 7 — indented list items: preserves indentation with ● bullet', () => {
        const input = '  * Nested item 1\n    - Deeply nested item 2';
        const expected = '  ● Nested item 1\n\n    ● Deeply nested item 2';
        (0, globals_1.expect)((0, articleContentNormalizer_1.normalizeArticleContent)(input)).toBe(expected);
    });
    (0, globals_1.it)('Test 8 — null/undefined/empty input safety', () => {
        (0, globals_1.expect)((0, articleContentNormalizer_1.normalizeArticleContent)('')).toBe('');
        (0, globals_1.expect)((0, articleContentNormalizer_1.normalizeArticleContent)(undefined)).toBeUndefined();
        (0, globals_1.expect)((0, articleContentNormalizer_1.normalizeArticleContent)(null)).toBeNull();
    });
    (0, globals_1.it)('Test 9 — mid-article H1 headings: should normalize # FAQ and mid-article H1 to ## while preserving article title', () => {
        const input = '# Main Article Title\n\nParagraph text.\n\n# FAQ\n\n## Question 1\n\nAnswer 1.';
        const expected = '# Main Article Title\n\nParagraph text.\n\n## FAQ\n\n## Question 1\n\nAnswer 1.';
        (0, globals_1.expect)((0, articleContentNormalizer_1.normalizeArticleContent)(input)).toBe(expected);
        const inputFaqOnly = 'Some text.\n\n# FAQ\n\n## Question 1';
        const expectedFaqOnly = 'Some text.\n\n## FAQ\n\n## Question 1';
        (0, globals_1.expect)((0, articleContentNormalizer_1.normalizeArticleContent)(inputFaqOnly)).toBe(expectedFaqOnly);
    });
    (0, globals_1.it)('Test 10 — full affected article: verify "i-built-the-company-but-now-i-am-trapped-inside-it"', async () => {
        const slug = 'i-built-the-company-but-now-i-am-trapped-inside-it';
        const rawArticle = await articles_repository_1.articlesRepository.findArticleBySlug(slug, false);
        if (rawArticle) {
            const normalizedContent = (0, articleContentNormalizer_1.normalizeArticleContent)(rawArticle.content);
            // List items normalized
            (0, globals_1.expect)(normalizedContent).toContain('● Identity fusion:');
            (0, globals_1.expect)(normalizedContent).toContain('● Structural dependency:');
            (0, globals_1.expect)(normalizedContent).toMatch(/● Identity fusion:[^\n]+\n\n● Structural dependency:/);
            // # FAQ normalized to ## FAQ
            (0, globals_1.expect)(normalizedContent).toContain('## FAQ');
            (0, globals_1.expect)(normalizedContent).not.toMatch(/^#\s+FAQ\b/m);
            // Verify through actual API endpoints
            const resV1 = await (0, supertest_1.default)(app).get(`/api/v1/articles/${slug}`);
            (0, globals_1.expect)(resV1.status).toBe(200);
            (0, globals_1.expect)(resV1.body.article).toBeDefined();
            (0, globals_1.expect)(resV1.body.article.content).toContain('● Identity fusion:');
            (0, globals_1.expect)(resV1.body.article.content).toContain('● Structural dependency:');
            (0, globals_1.expect)(resV1.body.article.content).toContain('## FAQ');
            (0, globals_1.expect)(resV1.body.article.content).not.toMatch(/^#\s+FAQ\b/m);
            (0, globals_1.expect)(resV1.body.article.content).toBe(normalizedContent);
            const resLegacy = await (0, supertest_1.default)(app).get(`/api/articles/${slug}`);
            (0, globals_1.expect)(resLegacy.status).toBe(200);
            (0, globals_1.expect)(resLegacy.body.article.content).toBe(normalizedContent);
        }
    });
    (0, globals_1.it)('Test 11 — other articles: articles without formatting issues remain unchanged', async () => {
        const published = await articles_repository_1.articlesRepository.findPublishedArticles();
        for (const item of published.slice(0, 5)) {
            const article = await articles_repository_1.articlesRepository.findArticleBySlug(item.slug, false);
            if (article && !/^[ \t]*\\?[*\-+•●][ \t]+(?!\*|-|\+)\S/m.test(article.content) && !/\n#\s+/m.test(article.content)) {
                const normalized = (0, articleContentNormalizer_1.normalizeArticleContent)(article.content);
                (0, globals_1.expect)(normalized).toBe(article.content);
                const res = await (0, supertest_1.default)(app).get(`/api/v1/articles/${article.slug}`);
                if (res.status === 200) {
                    (0, globals_1.expect)(res.body.article.content).toBe(article.content);
                }
            }
        }
    });
});
