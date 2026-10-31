import { Router } from 'express';
import { ContentController } from './controllers/content.controller';

const router = Router();
const controller = new ContentController();

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
