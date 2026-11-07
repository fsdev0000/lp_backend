import { Request, Response, NextFunction } from 'express';
import { cmsCache } from './cmsCache.service';

export interface CacheOptions {
  ttlSeconds?: number;
  tags?: string[] | ((req: Request) => string[]);
  cacheControl?: string; // Optional custom Cache-Control header (e.g. 'no-cache')
}

export function createCmsCacheMiddleware(options: CacheOptions = {}) {
  const defaultTtl = options.ttlSeconds || 300; // 5 minutes
  const customCacheControl = options.cacheControl;

  return (req: Request, res: Response, next: NextFunction): void => {
    // Only cache GET or HEAD requests
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }

    // Fix 2a: NEVER cache draft/preview responses, and bypass cache completely when previewing
    const isPreview = req.query.preview === 'true';
    if (isPreview) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      res.setHeader('X-Cache', 'BYPASS');
      next();
      return;
    }

    // Bypass cache if request specifically contains no-cache directive
    const cacheControlHeader = req.headers['cache-control'] || '';
    const bypassCache = cacheControlHeader.includes('no-cache') || req.query.fresh === 'true';

    // Construct deterministic, locale-aware cache key
    const queryMap: Record<string, any> = { ...req.query };
    if (req.path.startsWith('/texts') && queryMap.locale === undefined) {
      queryMap.locale = 'en';
    }
    const sortedQuery = Object.keys(queryMap)
      .filter((k) => k !== 'fresh')
      .sort()
      .map((k) => `${k}=${queryMap[k]}`)
      .join('&');
    const cacheKey = `cms:${req.baseUrl}${req.path}${sortedQuery ? `?${sortedQuery}` : ''}`;

    const effectiveCacheControl =
      customCacheControl || 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400';

    if (!bypassCache) {
      const cached = cmsCache.get<any>(cacheKey);
      if (cached) {
        res.setHeader('ETag', cached.etag);
        res.setHeader('Cache-Control', effectiveCacheControl);
        res.setHeader('X-Cache', 'HIT');

        // Check conditional request (If-None-Match)
        const clientETag = req.headers['if-none-match'];
        if (clientETag && (clientETag === cached.etag || clientETag === `W/${cached.etag}`)) {
          res.status(304).end();
          return;
        }

        res.status(200).json(cached.data);
        return;
      }
    }

    // Response interception to populate cache
    res.setHeader('X-Cache', 'MISS');
    const originalJson = res.json.bind(res);

    res.json = (body: any): Response => {
      // Only cache successful 200 responses
      if (res.statusCode === 200 && body && body.success !== false) {
        let tags: string[] = [];
        if (typeof options.tags === 'function') {
          tags = options.tags(req);
        } else if (Array.isArray(options.tags)) {
          tags = options.tags;
        } else {
          // Automatic tag extraction from path
          if (req.path.startsWith('/pages/')) {
            const slug = req.params.slug || req.path.split('/')[2];
            tags = [`page:${slug}`, 'pages'];
          } else if (req.path.startsWith('/texts')) {
            tags = ['texts', `texts:${req.query.locale || 'en'}`];
          } else if (req.path.startsWith('/navigation')) {
            tags = ['navigation'];
          } else if (req.path.startsWith('/testimonials')) {
            tags = ['testimonials'];
          } else if (req.path.startsWith('/faqs')) {
            tags = ['faqs'];
          } else if (req.path.startsWith('/settings')) {
            tags = ['settings'];
          }
        }

        const etag = cmsCache.set(cacheKey, body, defaultTtl, tags);
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', effectiveCacheControl);

        const clientETag = req.headers['if-none-match'];
        if (clientETag && (clientETag === etag || clientETag === `W/${etag}`)) {
          res.status(304).end();
          return res;
        }
      }
      return originalJson(body);
    };

    next();
  };
}
