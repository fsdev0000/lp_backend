"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const globals_1 = require("@jest/globals");
const supertest_1 = __importDefault(require("supertest"));
const express_1 = __importDefault(require("express"));
const articles_routes_1 = require("../api/routes/articles.routes");
const client_1 = require("@prisma/client");
const app = (0, express_1.default)();
app.use(express_1.default.json());
app.use(express_1.default.text({ type: ['text/*', 'application/x-yaml', 'text/markdown'] }));
app.use('/api/articles', articles_routes_1.articlesRoutes);
const prisma = new client_1.PrismaClient();
const API_KEY = process.env.ARTICLES_API_KEY || 'b8f9c1a2d4e7465b90a3f8c2e1d5b';
const TEST_SLUG = 'jest-founder-scale-test';
(0, globals_1.describe)('Articles API Endpoints', () => {
    globals_1.jest.setTimeout(30000);
    (0, globals_1.beforeAll)(async () => {
        await prisma.$executeRawUnsafe(`DELETE FROM public.articles WHERE slug LIKE 'jest-%';`).catch(() => { });
    });
    (0, globals_1.afterAll)(async () => {
        await prisma.$executeRawUnsafe(`DELETE FROM public.articles WHERE slug LIKE 'jest-%';`).catch(() => { });
        await prisma.$disconnect();
    });
    (0, globals_1.it)('POST /api/articles should return 401 without x-api-key', async () => {
        const res = await (0, supertest_1.default)(app)
            .post('/api/articles')
            .send({ slug: TEST_SLUG, title: 'Unauthorized Test' });
        (0, globals_1.expect)(res.status).toBe(401);
        (0, globals_1.expect)(res.body.error).toBe('Unauthorized');
    });
    (0, globals_1.it)('POST /api/articles should return 401 with invalid x-api-key', async () => {
        const res = await (0, supertest_1.default)(app)
            .post('/api/articles')
            .set('x-api-key', 'invalid-key')
            .send({ slug: TEST_SLUG, title: 'Unauthorized Test' });
        (0, globals_1.expect)(res.status).toBe(401);
        (0, globals_1.expect)(res.body.error).toBe('Unauthorized');
    });
    (0, globals_1.it)('POST /api/articles should return 400 when missing required fields', async () => {
        const res = await (0, supertest_1.default)(app)
            .post('/api/articles')
            .set('x-api-key', API_KEY)
            .send({ slug: TEST_SLUG, title: 'Only title' });
        (0, globals_1.expect)(res.status).toBe(400);
        (0, globals_1.expect)(res.body.error).toContain('Missing required fields');
    });
    (0, globals_1.it)('POST /api/articles should return 400 with invalid date format', async () => {
        const res = await (0, supertest_1.default)(app)
            .post('/api/articles')
            .set('x-api-key', API_KEY)
            .send({
            slug: TEST_SLUG,
            title: 'Title',
            excerpt: 'Excerpt',
            pillar: 'Leadership',
            content: 'Content',
            meta_title: 'Meta Title',
            meta_description: 'Meta Desc',
            publish_date: '2026.09.23',
        });
        (0, globals_1.expect)(res.status).toBe(400);
        (0, globals_1.expect)(res.body.error).toContain('Invalid publish_date format');
    });
    (0, globals_1.it)('POST /api/articles should upsert article and normalize DD-MM-YYYY date', async () => {
        const res = await (0, supertest_1.default)(app)
            .post('/api/articles')
            .set('x-api-key', API_KEY)
            .send({
            slug: TEST_SLUG,
            title: 'Scaling Under Pressure',
            excerpt: 'Executive mastery guide for venture founders.',
            pillar: 'Leadership Architecture',
            keywords: ['executive', 'scaling', 'founders'],
            meta_title: 'Scaling Under Pressure | Leaders Performance',
            meta_description: 'Operational protocols for executive leadership.',
            publish_date: '23-09-2026',
            reading_time: 7,
            author: 'Lionel Eersteling',
            content: '# Strategic Friction\n\nHigh-stakes decisions require structured cognitive framing...',
            published: true,
        });
        (0, globals_1.expect)(res.status).toBe(200);
        (0, globals_1.expect)(res.body.message).toBe('Upserted successfully');
        (0, globals_1.expect)(res.body.article.slug).toBe(TEST_SLUG);
    });
    (0, globals_1.it)('GET /api/articles/:slug should return the published article', async () => {
        const res = await (0, supertest_1.default)(app).get(`/api/articles/${TEST_SLUG}`);
        (0, globals_1.expect)(res.status).toBe(200);
        (0, globals_1.expect)(res.body.article.slug).toBe(TEST_SLUG);
        (0, globals_1.expect)(res.body.article.publish_date).toBe('2026-09-23');
        (0, globals_1.expect)(res.body.article.reading_time).toBe(7);
    });
    (0, globals_1.it)('GET /api/articles should list all published articles', async () => {
        const res = await (0, supertest_1.default)(app).get('/api/articles');
        (0, globals_1.expect)(res.status).toBe(200);
        (0, globals_1.expect)(Array.isArray(res.body.articles)).toBe(true);
        const found = res.body.articles.find((a) => a.slug === TEST_SLUG);
        (0, globals_1.expect)(found).toBeDefined();
    });
    (0, globals_1.it)('DELETE /api/articles/:slug should delete article when authorized', async () => {
        const unauth = await (0, supertest_1.default)(app).delete(`/api/articles/${TEST_SLUG}`);
        (0, globals_1.expect)(unauth.status).toBe(401);
        const res = await (0, supertest_1.default)(app)
            .delete(`/api/articles/${TEST_SLUG}`)
            .set('x-api-key', API_KEY);
        (0, globals_1.expect)(res.status).toBe(200);
        (0, globals_1.expect)(res.body.message).toBe(`Deleted ${TEST_SLUG}`);
        const verify = await (0, supertest_1.default)(app).get(`/api/articles/${TEST_SLUG}`);
        (0, globals_1.expect)(verify.status).toBe(404);
    });
});
