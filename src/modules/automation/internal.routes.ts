import { Router } from 'express';
import { requireInternalKey } from '../../middleware/internalKeyAuth';
import { jobRunController } from './controllers/jobRun.controller';
import { ingestController } from './controllers/ingest.controller';
import { internalReviewController } from './controllers/internalReview.controller';
import { publisherController } from './controllers/publisher.controller';
import { hardeningController } from './controllers/hardening.controller';
import { notificationSettingsController } from './controllers/notificationSettings.controller';
import { analyticsReportGeneratorService } from '../analytics/services/analyticsReportGenerator.service';

export const internalAutomationRouter = Router();

// All /internal/* endpoints require X-Internal-Key
internalAutomationRouter.use(requireInternalKey);

// Step 1 Foundation: JobRun start & finish logging
internalAutomationRouter.post('/job-runs/start', jobRunController.startJobRun);
internalAutomationRouter.post('/job-runs/finish', jobRunController.finishJobRun);
internalAutomationRouter.post('/job-runs/error-alert', hardeningController.reportWorkflowCrash);

// Step 2 Ingest (Flow 1): Calendar rows, Drive folder listings & Media completion
internalAutomationRouter.post('/ingest/rows', ingestController.ingestRows);
internalAutomationRouter.post('/ingest/folder-listing', ingestController.processFolderListing);
internalAutomationRouter.post('/media/:id/complete', ingestController.completeMediaUpload);
internalAutomationRouter.post('/ingest/dump-from-drive', ingestController.dumpFromDrive);

// Step 3 Review Loop: Gemini draft & Email Notification Outbox
internalAutomationRouter.post('/posts/:id/draft', internalReviewController.saveDraft);
internalAutomationRouter.get('/notifications', internalReviewController.listNotifications);
internalAutomationRouter.post('/notifications/:id/sent', internalReviewController.markNotificationSent);
internalAutomationRouter.post('/notifications/:id/failed', internalReviewController.markNotificationFailed);

// Step 4 Publishing (Flow 2): Publisher run
internalAutomationRouter.post('/publisher/run', publisherController.runPublisher);

// Step 5 Hardening: Daily Digest, Maintenance, Flow 3 Inventory Check, and Flow 4 Calendar Verification
internalAutomationRouter.get('/digest', hardeningController.getDailyDigest);
internalAutomationRouter.post('/maintenance/run', hardeningController.runMaintenance);
internalAutomationRouter.post('/inventory/check', hardeningController.checkInventory);
internalAutomationRouter.get('/inventory', hardeningController.getInventory);
internalAutomationRouter.post('/calendar/verify', hardeningController.verifyCalendar);

// Scheduled Reminder Processing (Called by n8n cron or background worker)
internalAutomationRouter.post('/reminders/process', notificationSettingsController.processReminders);

// Automated Weekly & Monthly Analytics Report Dispatch (Triggered by n8n cron: Mon 8 AM / 1st of month)
internalAutomationRouter.post('/reports/analytics', async (req, res) => {
  try {
    const frequency = ((req.body?.frequency || req.query.frequency || 'WEEKLY') as string).toUpperCase() as any;
    const domain = (req.body?.domain || req.query.domain || 'leadersperformance.ae') as string;
    const result = await analyticsReportGeneratorService.dispatchExecutiveAnalyticsReport({ frequency, domain });
    res.status(200).json({ success: true, data: result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Report dispatch failed' });
  }
});

export default internalAutomationRouter;
