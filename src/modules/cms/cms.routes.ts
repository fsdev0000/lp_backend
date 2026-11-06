import { Router } from 'express';
import { cmsPublicController } from './controllers/cmsPublic.controller';
import { cmsAdminController } from './controllers/cmsAdmin.controller';
import { createCmsCacheMiddleware } from './cache/cacheMiddleware';
import { requireCmsAdmin } from '../../middleware/cmsAuth';

export const cmsRouter = Router();

// ============================================================================
// PUBLIC READ ENDPOINTS (Ultra-fast cached with stale-while-revalidate & ETag)
// ============================================================================

// High-speed bootstrap config for frontend boot (navigation + settings + testimonials)
cmsRouter.get(
  '/bootstrap',
  createCmsCacheMiddleware({ ttlSeconds: 600, tags: ['navigation', 'settings', 'testimonials'] }),
  cmsPublicController.getBootstrap
);

// Public CMS texts (published strings dictionary with version; no-cache with ETag validation)
cmsRouter.get(
  '/texts',
  createCmsCacheMiddleware({ cacheControl: 'no-cache', tags: ['texts'] }),
  cmsPublicController.getTexts
);

// Individual page document with ordered sections & SEO properties
cmsRouter.get(
  '/pages/:slug',
  createCmsCacheMiddleware({
    ttlSeconds: 300,
    tags: (req) => [`page:${req.params.slug}`, 'pages'],
  }),
  cmsPublicController.getPage
);

// Isolated section query
cmsRouter.get(
  '/sections/:slug/:sectionKey',
  createCmsCacheMiddleware({
    ttlSeconds: 300,
    tags: (req) => [`page:${req.params.slug}`],
  }),
  cmsPublicController.getSection
);

// Navigation menus (all or by location)
cmsRouter.get(
  '/navigation/:location',
  createCmsCacheMiddleware({ ttlSeconds: 600, tags: ['navigation'] }),
  cmsPublicController.getNavigation
);
cmsRouter.get(
  '/navigation',
  createCmsCacheMiddleware({ ttlSeconds: 600, tags: ['navigation'] }),
  cmsPublicController.getAllNavigation
);

// Testimonials & Social Proof
cmsRouter.get(
  '/testimonials',
  createCmsCacheMiddleware({ ttlSeconds: 600, tags: ['testimonials'] }),
  cmsPublicController.getTestimonials
);

// FAQs
cmsRouter.get(
  '/faqs',
  createCmsCacheMiddleware({ ttlSeconds: 600, tags: ['faqs'] }),
  cmsPublicController.getFaqs
);

// Global site settings
cmsRouter.get(
  '/settings',
  createCmsCacheMiddleware({ ttlSeconds: 600, tags: ['settings'] }),
  cmsPublicController.getSettings
);

// ============================================================================
// ADMIN CMS CRUD ENDPOINTS (Strictly protected by Admin Role / JWT / lp_sess)
// ============================================================================

const adminRouter = Router();
adminRouter.use(requireCmsAdmin);

// Page management
adminRouter.get('/pages', cmsAdminController.listPages);
adminRouter.post('/pages', cmsAdminController.savePage);
adminRouter.put('/pages/:slug', cmsAdminController.savePage);
adminRouter.put('/pages/:slug/sections/:sectionKey', cmsAdminController.saveSection);
adminRouter.post('/pages/:slug/publish', cmsAdminController.publishPage);
adminRouter.delete('/pages/:slug', cmsAdminController.deletePage);

// Text management (Inline Editor)
adminRouter.get('/texts', cmsAdminController.listTexts);
adminRouter.put('/texts', cmsAdminController.saveText);
adminRouter.post('/texts/discard', cmsAdminController.discardTexts);
adminRouter.post('/texts/publish', cmsAdminController.publishTexts);
adminRouter.get('/texts/history', cmsAdminController.getTextHistory);

// Testimonials
adminRouter.post('/testimonials', cmsAdminController.saveTestimonial);
adminRouter.put('/testimonials/:id', cmsAdminController.saveTestimonial);
adminRouter.delete('/testimonials/:id', cmsAdminController.deleteTestimonial);

// FAQs
adminRouter.post('/faqs', cmsAdminController.saveFaq);
adminRouter.put('/faqs/:id', cmsAdminController.saveFaq);
adminRouter.delete('/faqs/:id', cmsAdminController.deleteFaq);

// Navigation & Settings
adminRouter.put('/navigation', cmsAdminController.saveNavigation);
adminRouter.put('/settings', cmsAdminController.saveSiteSetting);

// Cache operations
adminRouter.post('/cache/purge', cmsAdminController.purgeCache);
adminRouter.get('/cache/stats', cmsAdminController.getCacheStats);

// Mount admin router under /admin
cmsRouter.use('/admin', adminRouter);

export default cmsRouter;

