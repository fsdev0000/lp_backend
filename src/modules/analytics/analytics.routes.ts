import { Router } from 'express';
import { AnalyticsController } from './controllers/analytics.controller';
import { requireCrmAuth } from '../../middleware/crmRoleAuth';

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

/**
 * @route GET /api/v1/analytics/social/youtube
 * @desc Retrieve live YouTube Data API channel metrics, subscribers, engagement rate, and recent videos
 */
analyticsRoutes.get('/social/youtube', controller.getYouTubeAnalytics);
analyticsRoutes.get('/youtube', controller.getYouTubeAnalytics);

/**
 * @route GET /api/v1/analytics/social/youtube/videos
 * @desc Retrieve YouTube video list for videos or shorts tab (lifetime counts, newest first)
 */
analyticsRoutes.get('/social/youtube/videos', controller.getYouTubeVideos);

/**
 * @route GET /api/v1/analytics/social/youtube/playlists
 * @desc Retrieve YouTube playlists with public item counts and last updated timestamp
 */
analyticsRoutes.get('/social/youtube/playlists', controller.getYouTubePlaylists);

/**
 * @route GET /api/v1/analytics/social/linkedin
 * @desc Retrieve LinkedIn Organization analytics, followers, impressions, clicks, engagement, and website visitors
 */
analyticsRoutes.get('/social/linkedin', controller.getLinkedInAnalytics);
analyticsRoutes.get('/linkedin', controller.getLinkedInAnalytics);

/**
 * @route GET /api/v1/analytics/social/linkedin/posts
 * @desc Retrieve recent posts of the LinkedIn company page with engagement metrics, newest first
 */
analyticsRoutes.get('/social/linkedin/posts', controller.getLinkedInPosts);
analyticsRoutes.get('/linkedin/posts', controller.getLinkedInPosts);

/**
 * @route GET /api/v1/analytics/social/instagram
 * @desc Retrieve Instagram Professional analytics, followers, reach, impressions, profile views, and GA4 attribution
 */
analyticsRoutes.get('/social/instagram', controller.getInstagramAnalytics);
analyticsRoutes.get('/instagram', controller.getInstagramAnalytics);

/**
 * @route GET /api/v1/analytics/social/instagram/posts
 * @desc Retrieve recent posts/reels of the Instagram Professional account with metrics, newest first
 */
analyticsRoutes.get('/social/instagram/posts', controller.getInstagramPosts);
analyticsRoutes.get('/instagram/posts', controller.getInstagramPosts);

/**
 * @route GET /api/v1/analytics/reports/export
 * @desc On-demand export of executive analytics & CRM report (format: pdf, csv, json)
 */
analyticsRoutes.get('/reports/export', requireCrmAuth, controller.exportReport);

/**
 * @route POST /api/v1/analytics/reports/dispatch
 * @desc Triggers weekly or monthly executive analytics email dispatch with PDF and CSV attachments
 */
analyticsRoutes.post('/reports/dispatch', requireCrmAuth, controller.dispatchReport);
analyticsRoutes.post('/reports/trigger', requireCrmAuth, controller.dispatchReport);




