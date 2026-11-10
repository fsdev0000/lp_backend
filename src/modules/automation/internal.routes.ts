import { Router } from 'express';
import { requireInternalKey } from '../../middleware/internalKeyAuth';
import { jobRunController } from './controllers/jobRun.controller';
import { ingestController } from './controllers/ingest.controller';
import { internalReviewController } from './controllers/internalReview.controller';
import { publisherController } from './controllers/publisher.controller';
import { hardeningController } from './controllers/hardening.controller';

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
internalAutomationRouter.post('/calendar/verify', hardeningController.verifyCalendar);

export default internalAutomationRouter;
