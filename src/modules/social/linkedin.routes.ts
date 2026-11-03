import { Router } from 'express';
import { LinkedInController } from './controllers/linkedin.controller';
import { requireApiKey } from '../../middleware/apiKeyAuth';

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
router.post('/disconnect', requireApiKey, controller.disconnect);
router.post('/page/disconnect', requireApiKey, controller.disconnect);

// Direct Publishing & Diagnostics (Protected by auth + kill switch)
router.post('/share', requireApiKey, controller.publishDirect);
router.get('/ping', requireApiKey, controller.ping);

export default router;
