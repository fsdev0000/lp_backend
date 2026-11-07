import { Request, Response } from 'express';
import { Platform, PublishMode } from '@prisma/client';
import { automationPrisma } from '../state/transition';
import { encryptToken } from '../crypto/tokenCrypto';
import { digestService } from '../hardening/digest.service';
import { maintenanceService } from '../hardening/maintenance.service';
import { inventoryService } from '../hardening/inventory.service';
import { notificationService } from '../notifications/notification.service';

export class HardeningController {
  /**
   * GET /internal/digest
   * Generates the Daily Digest at the end of Flow 1 and queues the DAILY_DIGEST email if non-empty.
   */
  public getDailyDigest = async (req: Request, res: Response): Promise<void> => {
    try {
      const now = req.query.now ? new Date(String(req.query.now)) : new Date();
      const queueEmail = req.query.queueEmail !== 'false';
      const result = await digestService.generateDigest({ now, queueEmail });

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      console.error(`[HardeningController] postId=none getDailyDigest error:`, err?.message);
      res.status(500).json({
        success: false,
        code: 'DIGEST_ERROR',
        error: err?.message || 'Failed to generate daily digest',
      });
    }
  };

  /**
   * POST /internal/maintenance/run
   * Runs the 4 daily maintenance tasks at the end of Flow 1.
   */
  public runMaintenance = async (req: Request, res: Response): Promise<void> => {
    try {
      const now = req.body?.now ? new Date(req.body.now) : new Date();
      const summary = await maintenanceService.run({ now });

      res.status(200).json({
        success: true,
        data: summary,
      });
    } catch (err: any) {
      console.error(`[HardeningController] postId=none runMaintenance error:`, err?.message);
      res.status(500).json({
        success: false,
        code: 'MAINTENANCE_ERROR',
        error: err?.message || 'Failed to run maintenance',
      });
    }
  };

  /**
   * POST /internal/inventory/check
   * Read-only 30-day inventory check (Flow 3).
   */
  public checkInventory = async (req: Request, res: Response): Promise<void> => {
    try {
      const result = await inventoryService.checkInventory({
        rows: Array.isArray(req.body?.rows) ? req.body.rows : [],
        folderListings: Array.isArray(req.body?.folderListings)
          ? req.body.folderListings
          : [],
        calendarGaps: Array.isArray(req.body?.calendarGaps)
          ? req.body.calendarGaps
          : [],
        now: req.body?.now ? new Date(req.body.now) : new Date(),
        daysAhead: req.body?.daysAhead ? Number(req.body.daysAhead) : undefined,
        isManualRun: Boolean(req.body?.isManualRun),
      });

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      console.error(`[HardeningController] postId=none checkInventory error:`, err?.message);
      res.status(500).json({
        success: false,
        code: 'INVENTORY_CHECK_ERROR',
        error: err?.message || 'Failed to run inventory check',
      });
    }
  };

  /**
   * POST /internal/job-runs/error-alert
   * Called by the n8n Error Trigger workflow when Flow 1, Flow 2, or Flow 3 crashes.
   */
  public reportWorkflowCrash = async (req: Request, res: Response): Promise<void> => {
    try {
      const workflowName = String(req.body?.workflowName || 'unknown-workflow').trim();
      const failedNode = req.body?.failedNode ? String(req.body.failedNode).trim() : undefined;
      const errorMessage = String(req.body?.errorMessage || req.body?.error || 'Workflow execution failed');
      const executionId = req.body?.executionId ? String(req.body.executionId) : undefined;

      const jobRun = await automationPrisma.jobRun.create({
        data: {
          workflow: workflowName,
          startedAt: new Date(),
          finishedAt: new Date(),
          error: failedNode ? `[${failedNode}] ${errorMessage}` : errorMessage,
          stats: { executionId: executionId || null, failedNode: failedNode || null },
        },
      });

      const queued = await notificationService.queueJobFailed({
        workflowName,
        failedNode,
        errorMessage,
        executionId,
      });

      res.status(200).json({
        success: true,
        data: {
          jobRun,
          notification: queued.notification,
        },
      });
    } catch (err: any) {
      console.error(`[HardeningController] postId=none reportWorkflowCrash error:`, err?.message);
      res.status(500).json({
        success: false,
        code: 'ERROR_ALERT_FAILURE',
        error: err?.message || 'Failed to record workflow crash alert',
      });
    }
  };

  /**
   * GET /api/v1/social-crm/accounts
   * Screen 5 (Accounts & Settings): Returns connected accounts (without exposing raw tokens),
   * token expiry, channel aliases, folder rules, recent JobRuns, and read-only env settings.
   */
  public listAccountsAndSettings = async (req: Request, res: Response): Promise<void> => {
    try {
      const page = Math.max(Number(req.query.page) || 1, 1);
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
      const skip = (page - 1) * limit;

      const accounts = await automationPrisma.socialAccount.findMany({
        orderBy: { createdAt: 'asc' },
        take: limit,
        skip,
        select: {
          id: true,
          platform: true,
          label: true,
          externalId: true,
          tokenExpiresAt: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      const channelAliases = await automationPrisma.channelAlias.findMany({
        orderBy: { alias: 'asc' },
      });

      const folderRules = await automationPrisma.folderRule.findMany({
        orderBy: { drivePath: 'asc' },
      });

      const recentJobRuns = await automationPrisma.jobRun.findMany({
        orderBy: { startedAt: 'desc' },
        take: 20,
      });

      const settings = {
        CALENDAR_SHEET_ID: process.env.CALENDAR_SHEET_ID || '1eb9XK1hvhX-ABd4nHjpmMBdtTH6cmMgL',
        CALENDAR_SOURCE: process.env.CALENDAR_SOURCE || 'xlsx',
        CALENDAR_TZ: process.env.CALENDAR_TZ || 'Europe/Amsterdam',
        DRIVE_ROOT_FOLDER_ID: process.env.DRIVE_ROOT_FOLDER_ID || '177ptcsSWKiBveriapQmPo1KQwFhsi44C',
        SOCIAL_FOLDER_NAME: process.env.SOCIAL_FOLDER_NAME || '07_Social_media',
        DUMP_DAYS_BEFORE: Number(process.env.DUMP_DAYS_BEFORE) || 14,
        INVENTORY_DAYS_AHEAD: Number(process.env.INVENTORY_DAYS_AHEAD) || 30,
        PUBLISH_GRACE_MINUTES: Number(process.env.PUBLISH_GRACE_MINUTES) || 120,
        MAX_PUBLISH_ATTEMPTS: Number(process.env.MAX_PUBLISH_ATTEMPTS) || 3,
        MEDIA_RETENTION_DAYS: Number(process.env.MEDIA_RETENTION_DAYS) || 90,
        STORAGE_PROVIDER: process.env.STORAGE_PROVIDER || 'supabase',
        STORAGE_BUCKET: process.env.STORAGE_BUCKET || 'social-media',
        TIKTOK_AUDITED: (process.env.TIKTOK_AUDITED || 'false').toLowerCase() === 'true',
        EMAIL_APPROVER: process.env.EMAIL_APPROVER || 'lionel@leadersperformance.ae',
        EMAIL_EDITORS:
          process.env.EMAIL_EDITORS ||
          'sarath@leadersperformance.ae,asad@leadersperformance.ae',
        EMAIL_ADMIN: process.env.EMAIL_ADMIN || 'asif@leadersperformance.ae',
        EMAIL_INFO: process.env.EMAIL_INFO || 'info@leadersperformance.ae',
      };

      res.status(200).json({
        success: true,
        data: {
          accounts,
          channelAliases,
          folderRules,
          recentJobRuns,
          settings,
        },
      });
    } catch (err: any) {
      console.error(`[HardeningController] postId=none listAccountsAndSettings error:`, err?.message);
      res.status(500).json({
        success: false,
        code: 'LIST_ACCOUNTS_ERROR',
        error: err?.message || 'Failed to list accounts and settings',
      });
    }
  };

  /**
   * POST /api/v1/social-crm/accounts
   * Admin creates or updates a connected SocialAccount (encrypting tokens with AES-256-GCM) or adds a ChannelAlias.
   */
  public upsertAccountOrAlias = async (req: Request, res: Response): Promise<void> => {
    try {
      if (req.body?.alias) {
        const cleanAlias = String(req.body.alias).toLowerCase().trim();
        const platform = String(req.body.platform || 'LINKEDIN').toUpperCase() as Platform;
        const mode = String(req.body.mode || 'AUTO').toUpperCase() as PublishMode;
        const accountId = req.body.accountId ? String(req.body.accountId) : null;

        const aliasRow = await automationPrisma.channelAlias.upsert({
          where: { alias: cleanAlias },
          update: { platform, mode, accountId },
          create: { alias: cleanAlias, platform, mode, accountId },
        });

        res.status(200).json({
          success: true,
          data: { channelAlias: aliasRow },
        });
        return;
      }

      const platform = String(req.body?.platform || '').toUpperCase() as Platform;
      const label = String(req.body?.label || '').trim();
      const externalId = String(req.body?.externalId || '').trim();

      if (!platform || !label || !externalId) {
        res.status(400).json({
          success: false,
          code: 'VALIDATION_ERROR',
          error: 'platform, label, and externalId are required.',
        });
        return;
      }

      const tokenEncrypted = req.body?.accessToken
        ? encryptToken(String(req.body.accessToken))
        : undefined;
      const refreshEncrypted = req.body?.refreshToken
        ? encryptToken(String(req.body.refreshToken))
        : undefined;
      const tokenExpiresAt = req.body?.tokenExpiresAt
        ? new Date(req.body.tokenExpiresAt)
        : undefined;

      let account;
      if (req.body?.id) {
        account = await automationPrisma.socialAccount.update({
          where: { id: String(req.body.id) },
          data: {
            platform,
            label,
            externalId,
            ...(tokenEncrypted !== undefined ? { tokenEncrypted } : {}),
            ...(refreshEncrypted !== undefined ? { refreshEncrypted } : {}),
            ...(tokenExpiresAt !== undefined ? { tokenExpiresAt } : {}),
            isActive: req.body?.isActive !== undefined ? Boolean(req.body.isActive) : true,
          },
          select: {
            id: true,
            platform: true,
            label: true,
            externalId: true,
            tokenExpiresAt: true,
            isActive: true,
            createdAt: true,
            updatedAt: true,
          },
        });
      } else {
        account = await automationPrisma.socialAccount.create({
          data: {
            platform,
            label,
            externalId,
            tokenEncrypted: tokenEncrypted ?? null,
            refreshEncrypted: refreshEncrypted ?? null,
            tokenExpiresAt: tokenExpiresAt ?? null,
            isActive: true,
          },
          select: {
            id: true,
            platform: true,
            label: true,
            externalId: true,
            tokenExpiresAt: true,
            isActive: true,
            createdAt: true,
            updatedAt: true,
          },
        });
      }

      res.status(200).json({
        success: true,
        data: { account },
      });
    } catch (err: any) {
      console.error(`[HardeningController] postId=none upsertAccountOrAlias error:`, err?.message);
      res.status(500).json({
        success: false,
        code: 'UPSERT_ACCOUNT_ERROR',
        error: err?.message || 'Failed to save account or alias',
      });
    }
  };

  /**
   * POST /api/v1/social-crm/ingest/run-now
   * Admin triggers an immediate n8n Flow 1 or Flow 3 webhook run.
   */
  public triggerWebhookRunNow = async (req: Request, res: Response): Promise<void> => {
    try {
      const workflow = String(req.body?.workflow || 'flow1-content-dump').trim();
      const webhookUrl =
        workflow === 'flow3-inventory-check'
          ? (process.env.N8N_FLOW3_WEBHOOK_URL || '').trim()
          : (process.env.N8N_FLOW1_WEBHOOK_URL || '').trim();

      if (webhookUrl && process.env.NODE_ENV !== 'test') {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              triggeredBy: req.crmUser?.email || 'admin',
              isManualRun: true,
            }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      }

      res.status(200).json({
        success: true,
        data: {
          workflow,
          triggered: true,
          triggeredBy: req.crmUser?.email || 'admin',
          webhookConfigured: Boolean(webhookUrl),
        },
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        code: 'RUN_NOW_ERROR',
        error: err?.message || 'Failed to trigger n8n webhook',
      });
    }
  };
}

export const hardeningController = new HardeningController();
