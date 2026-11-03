import { Router, Request, Response, NextFunction } from 'express';
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

// Protect all /api/v1/content/* endpoints with authentication
router.use(requireApiKey);

// Media Upload endpoint (multipart/form-data, field "file")
router.post(
  '/media',
  (req: Request, res: Response, next: NextFunction) => {
    upload.single('file')(req, res, (err: any) => {
      if (err) {
        res.status(400).json({
          success: false,
          error: err.message || 'Invalid multipart file upload request',
        });
        return;
      }
      next();
    });
  },
  controller.uploadMedia
);

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
