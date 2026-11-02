import { Router } from 'express';
import { InstagramController } from './controllers/instagram.controller';

const router = Router();
const controller = new InstagramController();

// OAuth lifecycle
router.get('/auth-url', controller.getAuthUrl);
router.get('/callback', controller.handleCallback);
router.get('/status', controller.getStatus);
router.get('/ping', controller.ping);
router.post('/disconnect', controller.disconnect);

export default router;
