import { describe, it, expect, afterAll, beforeAll, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { articlesRoutes } from '../api/routes/articles.routes';
import { PrismaClient } from '@prisma/client';

const app = express();
app.use(express.json());
app.use(express.text({ type: ['text/*', 'application/x-yaml', 'text/markdown'] }));
app.use('/api/articles', articlesRoutes);

const prisma = new PrismaClient();
const API_KEY = process.env.ARTICLES_API_KEY || 'b8f9c1a2d4e7465b90a3f8c2e1d5b';
const TEST_SLUG = 'jest-founder-scale-test';

describe('Articles API Endpoints', () => {
  jest.setTimeout(30000);

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM public.articles WHERE slug LIKE 'jest-%';`
    ).catch(() => {});
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM public.articles WHERE slug LIKE 'jest-%';`
    ).catch(() => {});
    await prisma.$disconnect();
  });

  it('POST /api/articles should return 401 without x-api-key', async () => {
    const res = await request(app)
      .post('/api/articles')
      .send({ slug: TEST_SLUG, title: 'Unauthorized Test' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('POST /api/articles should return 401 with invalid x-api-key', async () => {
    const res = await request(app)
      .post('/api/articles')
      .set('x-api-key', 'invalid-key')
      .send({ slug: TEST_SLUG, title: 'Unauthorized Test' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('POST /api/articles should return 400 when missing required fields', async () => {
    const res = await request(app)
      .post('/api/articles')
      .set('x-api-key', API_KEY)
      .send({ slug: TEST_SLUG, title: 'Only title' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing required fields');
  });

  it('POST /api/articles should return 400 with invalid date format', async () => {
    const res = await request(app)
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

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid publish_date format');
  });

  it('POST /api/articles should upsert article and normalize DD-MM-YYYY date', async () => {
    const res = await request(app)
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

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Upserted successfully');
    expect(res.body.article.slug).toBe(TEST_SLUG);
  });

  it('GET /api/articles/:slug should return the published article', async () => {
    const res = await request(app).get(`/api/articles/${TEST_SLUG}`);

    expect(res.status).toBe(200);
    expect(res.body.article.slug).toBe(TEST_SLUG);
    expect(res.body.article.publish_date).toBe('2026-09-23');
    expect(res.body.article.reading_time).toBe(7);
  });

  it('GET /api/articles should list all published articles', async () => {
    const res = await request(app).get('/api/articles');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.articles)).toBe(true);
    const found = res.body.articles.find((a: any) => a.slug === TEST_SLUG);
    expect(found).toBeDefined();
  });

  it('DELETE /api/articles/:slug should delete article when authorized', async () => {
    const unauth = await request(app).delete(`/api/articles/${TEST_SLUG}`);
    expect(unauth.status).toBe(401);

    const res = await request(app)
      .delete(`/api/articles/${TEST_SLUG}`)
      .set('x-api-key', API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe(`Deleted ${TEST_SLUG}`);

    const verify = await request(app).get(`/api/articles/${TEST_SLUG}`);
    expect(verify.status).toBe(404);
  });
});
