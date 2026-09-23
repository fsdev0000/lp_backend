"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.articlesRoutes = void 0;
const express_1 = require("express");
const articles_controller_1 = require("../controllers/articles.controller");
const router = (0, express_1.Router)();
/**
 * @openapi
 * /articles:
 *   get:
 *     summary: List published articles
 *     tags: [Articles]
 *     responses:
 *       200:
 *         description: Array of published articles
 *   post:
 *     summary: Create or update an article using slug
 *     tags: [Articles]
 *     parameters:
 *       - in: header
 *         name: x-api-key
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [slug, title, excerpt, pillar, content, meta_title, meta_description]
 *             properties:
 *               slug: { type: string }
 *               title: { type: string }
 *               excerpt: { type: string }
 *               pillar: { type: string }
 *               pillar_color: { type: string }
 *               keywords: { type: array, items: { type: string } }
 *               meta_title: { type: string }
 *               meta_description: { type: string }
 *               publish_date: { type: string }
 *               reading_time: { type: integer }
 *               author: { type: string }
 *               content: { type: string }
 *               published: { type: boolean }
 *     responses:
 *       200:
 *         description: Upserted successfully
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *
 * /articles/{slug}:
 *   get:
 *     summary: Get single published article by slug
 *     tags: [Articles]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Article found
 *       404:
 *         description: Article not found
 *   delete:
 *     summary: Delete article by slug
 *     tags: [Articles]
 *     parameters:
 *       - in: header
 *         name: x-api-key
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Deleted successfully
 *       401:
 *         description: Unauthorized
 */
// Public endpoints
router.get('/', articles_controller_1.articlesController.listArticles);
router.get('/:slug', articles_controller_1.articlesController.getArticleBySlug);
// Management endpoints (Authenticated via x-api-key)
router.post('/', articles_controller_1.articlesController.authenticate, articles_controller_1.articlesController.upsertArticle);
router.delete('/:slug', articles_controller_1.articlesController.authenticate, articles_controller_1.articlesController.deleteArticle);
router.delete('/', articles_controller_1.articlesController.authenticate, articles_controller_1.articlesController.deleteArticle);
exports.articlesRoutes = router;
