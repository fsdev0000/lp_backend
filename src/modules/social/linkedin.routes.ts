import { Router } from 'express';
import { LinkedInController } from './controllers/linkedin.controller';
import { requireApiKey } from '../../middleware/apiKeyAuth';
import { requireCrmAuth, requireCrmRoles } from '../../middleware/crmRoleAuth';

const router = Router();
const controller = new LinkedInController();

// OAuth callback (browser redirect from LinkedIn; protected by single-use OAuth state & redirect allowlist)
router.get('/callback', controller.handleCallback);
router.get('/page/callback', controller.handleCallback);

// Authenticated OAuth & Connection Management
router.get('/auth-url', requireApiKey, controller.getAuthUrl);
router.get('/page/auth-url', requireApiKey, controller.getAuthUrl);
router.get('/status', requireApiKey, controller.getStatus);
router.get('/page/status', requireApiKey, controller.getStatus);
router.get('/profile', requireApiKey, controller.getProfile);
router.get('/page/profile', requireApiKey, controller.getProfile);
router.post('/disconnect', requireApiKey, requireCrmRoles('super_admin', 'admin'), controller.disconnect);
router.post('/page/disconnect', requireApiKey, requireCrmRoles('super_admin', 'admin'), controller.disconnect);

// Direct Publishing, Posts & Internal DB Synchronization (Protected by super_admin auth + kill switch)
router.post('/share', requireApiKey, requireCrmRoles('super_admin'), controller.publishDirect);
router.get('/posts', requireApiKey, controller.getPosts);
router.post('/sync', requireApiKey, controller.syncAll);
router.get('/ping', requireApiKey, controller.ping);

export default router;
