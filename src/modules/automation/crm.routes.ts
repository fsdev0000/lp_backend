import { Router } from 'express';
import multer from 'multer';
import { requireCrmAuth, requireCrmRoles } from '../../middleware/crmRoleAuth';
import { crmPostsController } from './controllers/crmPosts.controller';
import { hardeningController } from './controllers/hardening.controller';

export const crmAutomationRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

// All CRM automation routes require a valid logged-in CRM session token
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

export default crmAutomationRouter;

