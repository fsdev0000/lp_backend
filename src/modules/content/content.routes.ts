import { Router } from 'express';
import multer from 'multer';
import { ContentController } from './controllers/content.controller';
import { requireApiKey } from '../../middleware/apiKeyAuth';

const router = Router();
const controller = new ContentController();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 210 * 1024 * 1024, // 210MB threshold, handler checks 10MB image / 200MB video
  },
});

// Media Upload endpoint (multipart/form-data, field "file")
router.post('/media', requireApiKey, upload.single('file'), controller.uploadMedia);

// Approval Desk views & aggregations
router.get('/approvals/stats', controller.getApprovalStats);
router.get('/approvals', controller.getApprovalDesk);
router.get('/audit-logs', controller.getAuditLogs);

// Posts CRUD
router.get('/posts', controller.listPosts);
router.post('/posts', controller.createPost);
router.get('/posts/:id', controller.getPost);
router.put('/posts/:id', controller.updatePost);
router.delete('/posts/:id', controller.deletePost);

// Approval & Publishing Workflow
router.post('/posts/:id/request-approval', controller.requestApproval);
router.post('/posts/:id/approve', controller.approvePost);
router.post('/posts/:id/reject', controller.rejectPost);
router.post('/posts/:id/publish-now', controller.publishNow);

export default router;
