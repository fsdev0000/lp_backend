# LEADERS PERFORMANCE — ARTICLES API DEVELOPER GUIDE
**Component:** Backend Middleware (`lp_backend`) & Supabase Database  
**Author:** Engineering Team  
**Date:** 23 September 2026  
**Status:** Production Ready (Replaced Supabase Edge Function)

---

## 1. Executive Summary & Architecture Overview

The previous Lovable/Supabase Deno Edge Function (`manage-articles`) has been replaced with a native **Node.js Express API** integrated directly into the core `lp_backend` service.

### Key Objectives Achieved:
- **Direct Database Connectivity:** Uses connection-pooled PostgreSQL to communicate directly with Supabase, eliminating external REST latency.
- **n8n Automation Ready:** Provides authenticated upsert/delete operations for n8n workflows.
- **Public Website Consumption:** High-speed public endpoints for article listing and detail retrieval with zero pre-consent or auth hurdles.
- **Layered Clean Architecture:** Built following strict Separation of Concerns:
  - `routes/articles.routes.ts`: Express routing & OpenAPI Swagger annotations.
  - `controllers/articles.controller.ts`: Request parsing, status codes & auth middleware.
  - `services/articles.service.ts`: Business logic & Vault/Env API key verification.
  - `repositories/articles.repository.ts`: Parameterized queries against Supabase.
  - `validation/articles.validation.ts`: Field validation, date normalization & YAML frontmatter parser.

---

## 2. Supabase Database Schema

The articles table is deployed in the `public` schema of the Supabase PostgreSQL database:

```sql
-- 1. Table Definition
CREATE TABLE public.articles (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  pillar TEXT NOT NULL,
  pillar_color TEXT DEFAULT 'hsl(122,31%,42%)',
  keywords TEXT[] DEFAULT '{}',
  meta_title TEXT NOT NULL,
  meta_description TEXT NOT NULL,
  publish_date DATE DEFAULT CURRENT_DATE,
  reading_time INTEGER DEFAULT 5,
  author TEXT DEFAULT 'Lionel Eersteling',
  content TEXT NOT NULL,
  published BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Row Level Security (RLS)
ALTER TABLE public.articles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public can read published articles"
ON public.articles
FOR SELECT
TO anon, authenticated
USING (published = true);

-- 3. Automatic Updated-At Trigger
CREATE OR REPLACE FUNCTION public.update_articles_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER articles_updated_at
  BEFORE UPDATE ON public.articles
  FOR EACH ROW
  EXECUTE FUNCTION public.update_articles_updated_at();
```

---

## 3. Environment & Security Configuration

### Required `.env` Variables (Backend & VPS)
```env
# Articles CMS & Supabase Configuration
ARTICLES_API_KEY="b8f9c1a2d4e7465b90a3f8c2e1d5b"
SUPABASE_URL="https://tpyudbsbzrhhngulxyxp.supabase.co"
DATABASE_URL="postgresql://postgres.tpyudbsbzrhhngulxyxp:wR9!Xq7%23Lm2%24Pv8%40Ka4%25Nz1%26Hu6*Tc3Y@aws-1-eu-north-1.pooler.supabase.com:6543/postgres?pgbouncer=true"
```

### Authentication Logic
- Management operations (`POST`, `DELETE`) require the `x-api-key` header (or `Authorization: Bearer <key>`).
- The backend checks `process.env.ARTICLES_API_KEY` first. If missing, it falls back to querying the Supabase Vault (`vault.decrypted_secrets`), caching the key in memory.
- Public read operations (`GET`) require **no** authentication.

---

## 4. Endpoints Specification

### 4.1. List Published Articles
- **Endpoint:** `GET /api/articles` (or `/api/v1/articles`)
- **Access:** Public (No API key required)
- **Description:** Returns all published articles ordered by `created_at DESC`.
- **Response `200 OK`:**
```json
{
  "articles": [
    {
      "id": "e4a664f5-abc8-4f52-ba04-d8a80d11ddf5",
      "slug": "ambition-creates-pressure",
      "title": "Ambition Creates Pressure. Preparation Turns It into Performance.",
      "excerpt": "Greater ambition increases responsibility...",
      "pillar": "Leadership Performance",
      "pillar_color": "hsl(122,31%,42%)",
      "keywords": ["leadership", "pressure", "performance"],
      "meta_title": "Ambition Creates Pressure | Leaders Performance",
      "meta_description": "Executive briefing on pressure and performance...",
      "publish_date": "2026-09-20",
      "reading_time": 6,
      "author": "Lionel Eersteling",
      "published": true,
      "created_at": "2026-09-23T04:42:10.123Z"
    }
  ]
}
```

---

### 4.2. Get Single Article by Slug
- **Endpoint:** `GET /api/articles/:slug` (or `/api/v1/articles/:slug`)
- **Access:** Public (No API key required)
- **Description:** Returns the complete article including Markdown `content`.
- **Response `200 OK`:**
```json
{
  "article": {
    "id": "e4a664f5-abc8-4f52-ba04-d8a80d11ddf5",
    "slug": "ambition-creates-pressure",
    "title": "Ambition Creates Pressure. Preparation Turns It into Performance.",
    "excerpt": "Greater ambition increases responsibility...",
    "pillar": "Leadership Performance",
    "pillar_color": "hsl(122,31%,42%)",
    "keywords": ["leadership", "pressure", "performance"],
    "meta_title": "Ambition Creates Pressure | Leaders Performance",
    "meta_description": "Executive briefing on pressure...",
    "publish_date": "2026-09-20",
    "reading_time": 6,
    "author": "Lionel Eersteling",
    "content": "# Ambition Creates Pressure...\n\nFull markdown text...",
    "published": true,
    "created_at": "2026-09-23T04:42:10.123Z",
    "updated_at": "2026-09-23T04:42:10.123Z"
  }
}
```
- **Response `404 Not Found`:**
```json
{ "error": "Article not found" }
```

---

### 4.3. Create or Update Article (Upsert)
- **Endpoint:** `POST /api/articles` (or `/api/v1/articles`)
- **Access:** Protected (`x-api-key: <ARTICLES_API_KEY>`)
- **Behavior:** Atomic upsert on `slug`. If the slug exists, it updates all fields; if not, it creates a new record.
- **Headers:**
  - `Content-Type: application/json`
  - `x-api-key: b8f9c1a2d4e7465b90a3f8c2e1d5b`
- **Request Body (JSON):**
```json
{
  "slug": "decision-architecture-under-pressure",
  "title": "Decision Architecture: Why Smart Founders Make Costly Choices at Scale",
  "excerpt": "At high velocity, bad decisions are rarely caused by a lack of intelligence...",
  "pillar": "Decision Architecture",
  "pillar_color": "hsl(215,28%,38%)",
  "keywords": ["decision-making", "governance", "scale"],
  "meta_title": "Decision Architecture Under Pressure | Leaders Performance",
  "meta_description": "How high-growth founders eliminate decision fatigue...",
  "publish_date": "2026-09-18",
  "reading_time": 6,
  "author": "Lionel Eersteling",
  "content": "# Decision Architecture\n\nFull markdown content here...",
  "published": true
}
```
- **Validation Rules:**
  - **Required:** `slug`, `title`, `excerpt`, `pillar`, `content`, `meta_title`, `meta_description`.
  - **Date Normalization:** Accepts `YYYY-MM-DD` or `DD-MM-YYYY` (automatically stored as `YYYY-MM-DD`). Defaults to current date if omitted.
  - **Keywords:** Accepts an array of strings `["tag1", "tag2"]` or a comma-separated string `"tag1, tag2"`.
- **Response `200 OK`:**
```json
{
  "article": {
    "id": "e4a664f5-abc8-4f52-ba04-d8a80d11ddf5",
    "slug": "decision-architecture-under-pressure",
    "title": "Decision Architecture: Why Smart Founders Make Costly Choices at Scale"
  },
  "message": "Upserted successfully"
}
```
- **Error Responses:**
  - `401 Unauthorized`: `{ "error": "Unauthorized" }`
  - `400 Bad Request`: `{ "error": "Missing required fields...", "received": { ... } }`

#### Backward-Compatibility: Raw Markdown + YAML Frontmatter
The `POST` endpoint also supports raw text/markdown with YAML frontmatter headers:
```markdown
---
slug: my-article-slug
title: Article Title
excerpt: Brief summary
pillar: Founder Performance
meta_title: SEO Title
meta_description: SEO Description
reading_time: 7
author: Lionel Eersteling
---

# Article Content
Body text goes here...
```

---

### 4.4. Delete Article
- **Endpoint:** `DELETE /api/articles/:slug` (or `DELETE /api/articles` with `{ "slug": "..." }` in body)
- **Access:** Protected (`x-api-key: <ARTICLES_API_KEY>`)
- **Headers:** `x-api-key: b8f9c1a2d4e7465b90a3f8c2e1d5b`
- **Response `200 OK`:**
```json
{
  "message": "Deleted decision-architecture-under-pressure",
  "deleted": true
}
```

---

## 5. n8n Automation Setup Guide

To automate publishing from **n8n**:

1. Add an **HTTP Request** node to your n8n canvas.
2. Configure parameters:
   - **Method:** `POST`
   - **URL:** `https://api.leadersperformance.ae/api/articles` (or `http://srv826934.hstgr.cloud/api/articles`)
   - **Authentication:** `None`
   - **Headers:**
     | Key | Value |
     | :--- | :--- |
     | `Content-Type` | `application/json` |
     | `x-api-key` | `b8f9c1a2d4e7465b90a3f8c2e1d5b` |
   - **Body Content Type:** `JSON`
   - **Specify Body:** Using fields / expressions mapping to the required JSON schema.
3. If an article with the same `slug` is sent multiple times, n8n will update the existing article cleanly without throwing a duplicate key error.

---

## 6. Frontend Integration Details

In `lp_frontend`, API requests are routed as follows:
- **Development:** Proxied via Vite (`vite.config.ts`) from `http://localhost:5173/api/*` to `http://localhost:4000/api/*`.
- **Production:** Configured in `lp_frontend/src/lib/api-config.ts` via `apiUrl('/api/articles')`.

---

## 7. Testing & Quality Assurance

A dedicated Jest integration suite is committed at [`src/__tests__/articles.test.ts`](file:///c:/Users/DELL/Downloads/fig-react-boost-main%20(1)/lp_backend/src/__tests__/articles.test.ts):

```bash
# Run backend test suite
cd lp_backend
npm test -- src/__tests__/articles.test.ts
```

### Verified Test Cases:
1. `POST` without `x-api-key` -> `401 Unauthorized`
2. `POST` with wrong API key -> `401 Unauthorized`
3. `POST` missing required fields -> `400 Bad Request` with field diagnostics
4. `POST` invalid date format -> `400 Bad Request`
5. `POST` upsert & `DD-MM-YYYY` normalization -> `200 OK`
6. `GET /:slug` public single article retrieval -> `200 OK`
7. `GET /` public list retrieval -> `200 OK`
8. `DELETE /:slug` authorized deletion -> `200 OK`
9. `published: false` status -> properly excluded from public listing & returns `404`
