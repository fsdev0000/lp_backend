import { Router } from 'express';
import { InstagramController } from './controllers/instagram.controller';
import { requireApiKey } from '../../middleware/apiKeyAuth';

const router = Router();
const controller = new InstagramController();

// OAuth callback (browser redirect from Meta OAuth; protected by state verification)
router.get('/callback', controller.handleCallback);

// Authenticated Instagram Integration Endpoints (Item 2a)
router.get('/auth-url', requireApiKey, controller.getAuthUrl);
router.get('/status', requireApiKey, controller.getStatus);
router.get('/ping', requireApiKey, controller.ping);
router.post('/disconnect', requireApiKey, controller.disconnect);

export default router;
