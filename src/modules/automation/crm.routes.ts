import { Router } from 'express';
import multer from 'multer';
import { requireCrmAuth, requireCrmRoles, optionalCrmAuth } from '../../middleware/crmRoleAuth';
import { crmPostsController } from './controllers/crmPosts.controller';
import { hardeningController } from './controllers/hardening.controller';
import { notificationSettingsController } from './controllers/notificationSettings.controller';
import { crmHealthService } from './monitoring/crmHealth.service';

export const crmAutomationRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

// Caption/document file content preview (accessible to reviewer/approver with optional auth)
crmAutomationRouter.get('/posts/:id/caption-file-content', optionalCrmAuth, crmPostsController.getCaptionFileContent);

// All CRM automation write routes and admin management require a valid logged-in CRM session token
crmAutomationRouter.use(requireCrmAuth);

// Read endpoints (accessible to approver, editor, admin)
crmAutomationRouter.get('/posts', crmPostsController.listPosts);
crmAutomationRouter.get('/posts/:id', crmPostsController.getPostDetail);

// Editor & Admin actions (edit, replace media, resubmit, manual-done)
crmAutomationRouter.patch(
  '/posts/:id',
  requireCrmRoles('editor', 'admin'),
  crmPostsController.updatePost
);
crmAutomationRouter.post(
  '/posts/:id/media',
  requireCrmRoles('editor', 'admin'),
  upload.single('file'),
  crmPostsController.uploadMedia
);
crmAutomationRouter.post(
  '/posts/:id/submit',
  requireCrmRoles('editor', 'admin'),
  crmPostsController.submitPost
);
crmAutomationRouter.post(
  '/posts/:id/manual-done',
  requireCrmRoles('editor', 'admin'),
  crmPostsController.manualDone
);

// Approver (Mr. Lionel) & Admin actions (approve, request changes, reject)
crmAutomationRouter.post(
  '/posts/:id/approve',
  requireCrmRoles('approver', 'admin'),
  crmPostsController.approvePost
);
crmAutomationRouter.post(
  '/posts/:id/request-changes',
  requireCrmRoles('approver', 'admin'),
  crmPostsController.requestChanges
);
crmAutomationRouter.post(
  '/posts/:id/reject',
  requireCrmRoles('approver', 'admin'),
  crmPostsController.rejectPost
);

// Comment thread (accessible to approver, editor, admin)
crmAutomationRouter.post(
  '/posts/:id/comments',
  requireCrmRoles('approver', 'editor', 'admin'),
  crmPostsController.addComment
);

// Admin actions (retry FAILED post)
crmAutomationRouter.post(
  '/posts/:id/retry',
  requireCrmRoles('admin'),
  crmPostsController.retryPost
);

// Approver & Admin action: Publish now (only allowed for APPROVED posts)
crmAutomationRouter.post(
  '/posts/:id/publish-now',
  requireCrmRoles('approver', 'admin'),
  crmPostsController.publishNow
);

// Step 5 Hardening: Screen 5 (Accounts & Settings) & Manual Run-Now Triggers
crmAutomationRouter.get(
  '/accounts',
  requireCrmRoles('admin', 'approver', 'editor'),
  hardeningController.listAccountsAndSettings
);
crmAutomationRouter.post(
  '/accounts',
  requireCrmRoles('admin'),
  hardeningController.upsertAccountOrAlias
);
crmAutomationRouter.post(
  '/ingest/run-now',
  requireCrmRoles('admin'),
  hardeningController.triggerWebhookRunNow
);

// Notification Settings & SLA Reminders
crmAutomationRouter.get(
  '/settings/notifications',
  requireCrmRoles('admin', 'approver', 'editor'),
  notificationSettingsController.getSettings
);
crmAutomationRouter.put(
  '/settings/notifications',
  requireCrmRoles('admin', 'approver'),
  notificationSettingsController.updateSettings
);
crmAutomationRouter.post(
  '/reminders/process',
  requireCrmRoles('admin'),
  notificationSettingsController.processReminders
);
crmAutomationRouter.get(
  '/posts/:id/reminders',
  requireCrmRoles('admin', 'approver', 'editor'),
  notificationSettingsController.getReminderStatus
);
crmAutomationRouter.get(
  '/reminders/status',
  requireCrmRoles('admin', 'approver', 'editor'),
  notificationSettingsController.getReminderStatus
);

// Two-Tier Inventory Model (Task 7): available_stock = raw_unscheduled + date_scheduled
crmAutomationRouter.get(
  '/inventory',
  requireCrmRoles('admin', 'approver', 'editor'),
  hardeningController.getInventory
);

// System Health Status (Task 13)
crmAutomationRouter.get(
  ['/health', '/crm/health'],
  requireCrmRoles('admin', 'approver', 'editor'),
  async (_req, res) => {
    try {
      const report = await crmHealthService.getHealthStatus();
      const code = report.status === 'UNHEALTHY' ? 503 : 200;
      res.status(code).json({ success: true, data: report });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message });
    }
  }
);

// Per-platform Auto-Publishing Feature Flags (Task 14)
crmAutomationRouter.get(
  ['/settings/publishing-flags', '/crm/settings/publishing-flags'],
  requireCrmRoles('admin', 'approver', 'editor'),
  async (_req, res) => {
    try {
      const flags = await crmHealthService.getPublishingFlags();
      res.json({ success: true, data: flags });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message });
    }
  }
);

crmAutomationRouter.put(
  ['/settings/publishing-flags', '/crm/settings/publishing-flags'],
  requireCrmRoles('admin', 'approver'),
  async (req, res) => {
    try {
      const updated = await crmHealthService.updatePublishingFlags(req.body);
      res.json({ success: true, data: updated });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message });
    }
  }
);

export default crmAutomationRouter;

