import { Router } from 'express';
import { LinkedInController } from './controllers/linkedin.controller';

const router = Router();
const controller = new LinkedInController();

// OAuth & Connection
router.get('/auth-url', controller.getAuthUrl);
router.get('/callback', controller.handleCallback);
router.get('/status', controller.getStatus);
router.post('/disconnect', controller.disconnect);

// Direct Publishing & Diagnostics
router.post('/share', controller.publishDirect);
router.get('/ping', controller.ping);

export default router;
