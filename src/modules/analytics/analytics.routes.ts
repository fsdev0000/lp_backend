import { Router } from 'express';
import { AnalyticsController } from './controllers/analytics.controller';

export const analyticsRoutes = Router();
const controller = new AnalyticsController();

/**
 * @route GET /api/v1/analytics/overview
 * @desc Get consolidated analytics overview (KPIs, traffic velocity, top campaigns)
 * @access Protected / Authenticated Executive Dashboard
 */
analyticsRoutes.get('/overview', controller.getOverview);

/**
 * @route GET /api/v1/analytics/channels
 * @desc Get cross-platform social intelligence matrix
 */
analyticsRoutes.get('/channels', controller.getChannels);

/**
 * @route GET /api/v1/analytics/keywords
 * @desc Get Google Search Console top queries and SERP positions
 */
analyticsRoutes.get('/keywords', controller.getKeywords);

/**
 * @route GET /api/v1/analytics/telemetry
 * @desc Get Microsoft Clarity UX and visitor telemetry
 */
analyticsRoutes.get('/telemetry', controller.getTelemetry);

/**
 * @route GET /api/v1/analytics/integrations/status
 * @desc Evaluates connection health of GA4, GSC, Clarity, and GHL
 */
analyticsRoutes.get('/integrations/status', controller.getIntegrationsStatus);

/**
 * @route POST /api/v1/analytics/integrations/ping/:id
 * @desc Probes a specific provider and returns exact round-trip ping latency
 */
analyticsRoutes.post('/integrations/ping/:id', controller.pingIntegration);

/**
 * @route GET /api/v1/analytics/realtime/stream
 * @desc Persistent Server-Sent Events (SSE) stream for live active visitor ticker
 */
analyticsRoutes.get('/realtime/stream', controller.streamRealtime);

/**
 * @route GET /api/v1/analytics/reports-snapshot
 * @desc Get Google Analytics 4 Reports Snapshot (Active Users, Top Pages, Sources, Cities)
 */
analyticsRoutes.get('/reports-snapshot', controller.getReportsSnapshot);

/**
 * @route GET /api/v1/analytics/clarity/sessions
 * @desc Get Clarity recorded sessions with direct playback URLs, dwell times, and lead attribution for frontend embed
 */
analyticsRoutes.get('/clarity/sessions', controller.getClaritySessions);
analyticsRoutes.get('/clarity/recordings', controller.getClarityRecordings);
analyticsRoutes.get('/clarity/analytics', controller.getClarityAnalytics);
analyticsRoutes.post('/clarity/refresh', controller.refreshClarityAnalytics);
analyticsRoutes.get('/clarity/status', controller.getClarityStatus);

/**
 * @route POST /api/v1/analytics/clarity/webhook
 * @desc Ingest Clarity session events, calculate UX friction, link leads, and trigger anomaly alerts
 */
analyticsRoutes.post('/clarity/webhook', controller.ingestClarityWebhook);


