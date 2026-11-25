import { Router } from 'express';
import { TikTokController } from './controllers/tiktok.controller';
import { requireApiKey } from '../../middleware/apiKeyAuth';

const router = Router();
const controller = new TikTokController();

// OAuth callback (protected by single-use state + PKCE + redirect allowlist)
// Also accepts POST so TikTok Webhook "Send test event" succeeds if /callback is used as Webhook URL
router.get('/callback', controller.handleCallback);
router.post('/callback', controller.handleWebhook);

// TikTok Webhook receiver (for post status notifications & Test URL check)
router.get('/webhook', controller.handleWebhook);
router.post('/webhook', controller.handleWebhook);

// Authenticated TikTok endpoints (Item 9: requireApiKey on /auth-url)
router.get('/auth-url', requireApiKey, controller.getAuthUrl);
router.get('/status', requireApiKey, controller.getStatus);
router.get('/analytics', requireApiKey, controller.getAnalytics);
router.post('/publish', requireApiKey, controller.publishDirect);
router.post('/disconnect', requireApiKey, controller.disconnect);

export default router;
