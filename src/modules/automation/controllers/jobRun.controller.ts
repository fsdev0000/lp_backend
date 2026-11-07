import { Request, Response } from 'express';
import { automationPrisma } from '../state/transition';

export class JobRunController {
  /**
   * POST /internal/job-runs/start
   * Body: { workflow: string, stats?: object }
   */
  public startJobRun = async (req: Request, res: Response): Promise<void> => {
    try {
      const workflow = String(req.body?.workflow || '').trim();
      if (!workflow) {
        res.status(400).json({
          success: false,
          code: 'VALIDATION_ERROR',
          error: 'Field "workflow" is required to start a job run.',
        });
        return;
      }

      const jobRun = await automationPrisma.jobRun.create({
        data: {
          workflow,
          startedAt: new Date(),
          stats: req.body?.stats ?? null,
        },
      });

      console.log(`[JobRun] postId=none jobRunId=${jobRun.id} workflow=${workflow} status=STARTED`);
      res.status(201).json({
        success: true,
        data: jobRun,
      });
    } catch (err: any) {
      console.error(`[JobRun] postId=none startJobRun error:`, err?.message);
      res.status(500).json({
        success: false,
        error: err?.message || 'Failed to record job run start',
      });
    }
  };

  /**
   * POST /internal/job-runs/finish
   * Body: { id?: string, jobRunId?: string, stats?: object, error?: string }
   */
  public finishJobRun = async (req: Request, res: Response): Promise<void> => {
    try {
      const id = String(req.body?.id || req.body?.jobRunId || '').trim();
      if (!id) {
        res.status(400).json({
          success: false,
          code: 'VALIDATION_ERROR',
          error: 'Field "id" (or "jobRunId") is required to finish a job run.',
        });
        return;
      }

      const existing = await automationPrisma.jobRun.findUnique({ where: { id } });
      if (!existing) {
        res.status(404).json({
          success: false,
          code: 'NOT_FOUND',
          error: `JobRun ${id} not found.`,
        });
        return;
      }

      const updated = await automationPrisma.jobRun.update({
        where: { id },
        data: {
          finishedAt: new Date(),
          ...(req.body?.stats !== undefined ? { stats: req.body.stats } : {}),
          ...(req.body?.error !== undefined ? { error: req.body.error ? String(req.body.error) : null } : {}),
        },
      });

      console.log(
        `[JobRun] postId=none jobRunId=${updated.id} workflow=${updated.workflow} status=${
          updated.error ? 'FAILED' : 'FINISHED'
        }`
      );
      res.status(200).json({
        success: true,
        data: updated,
      });
    } catch (err: any) {
      console.error(`[JobRun] postId=none finishJobRun error:`, err?.message);
      res.status(500).json({
        success: false,
        error: err?.message || 'Failed to record job run finish',
      });
    }
  };
}

export const jobRunController = new JobRunController();

