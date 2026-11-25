import { Router } from 'express';
import { AnalyticsController } from './controllers/analytics.controller';
import { requireCrmAuth, requireWorkspaceAuth } from '../../middleware/crmRoleAuth';

export const clarityRoutes = Router();
const controller = new AnalyticsController();

/**
 * @route POST /api/v1/clarity/webhook
 * @desc Ingest external session payload or client telemetry event
 * @access Public Webhook
 */
clarityRoutes.post('/webhook', controller.ingestClarityWebhook);

/**
 * Issue 4.1: Protect Clarity recording, session, and analytics endpoints
 */
clarityRoutes.use(requireCrmAuth);
clarityRoutes.use(requireWorkspaceAuth);

/**
 * @route GET /api/v1/clarity/analytics
 * @desc Retrieve cached analytics for an authorized website (leaders_performance | lionel_eersteling)
 */
clarityRoutes.get('/analytics', controller.getClarityAnalytics);

/**
 * @route POST /api/v1/clarity/refresh
 * @desc Request a controlled refresh for an authorized website
 */
clarityRoutes.post('/refresh', controller.refreshClarityAnalytics);

/**
 * @route GET /api/v1/clarity/recordings
 * @desc Retrieve available recording metadata and verified playback links
 */
clarityRoutes.get('/recordings', controller.getClarityRecordings);

/**
 * @route GET /api/v1/clarity/sessions
 * @desc Alias for recordings with lead attribution for Social CRM embed
 */
clarityRoutes.get('/sessions', controller.getClaritySessions);

/**
 * @route GET /api/v1/clarity/status
 * @desc Retrieve website-specific integration, refresh status, and quota
 */
clarityRoutes.get('/status', controller.getClarityStatus);
