import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import { automationPrisma } from '../state/transition';
import { getSupabaseClient } from '../../../services/supabaseStorageService';
import { DEFAULT_SOCIAL_MEDIA_BUCKET } from '../storage/storage.service';

export interface IntegrationCheckItem {
  status: 'OK' | 'ACTION_REQUIRED' | 'ERROR';
  message: string;
  details?: Record<string, any>;
  actionRequired?: string[];
}

export interface ConnectivityReport {
  timestamp: string;
  allReady: boolean;
  checks: {
    database: IntegrationCheckItem;
    supabaseStorage: IntegrationCheckItem;
    googleDrive: IntegrationCheckItem;
    contentCalendar: IntegrationCheckItem;
    localDriveFallback: IntegrationCheckItem;
    gemini: IntegrationCheckItem;
    n8n: IntegrationCheckItem;
  };
}

export class ConnectivityService {
  public async runAllChecks(): Promise<ConnectivityReport> {
    const [
      database,
      supabaseStorage,
      googleChecks,
      localDriveFallback,
      gemini,
      n8n,
    ] = await Promise.all([
      this.checkDatabase(),
      this.checkSupabaseStorage(),
      this.checkGoogleDriveAndCalendar(),
      this.checkLocalDriveFallback(),
      this.checkGemini(),
      this.checkN8n(),
    ]);

    const allReady =
      database.status === 'OK' &&
      supabaseStorage.status === 'OK' &&
      (googleChecks.googleDrive.status === 'OK' || localDriveFallback.status === 'OK') &&
      (googleChecks.contentCalendar.status === 'OK' || localDriveFallback.status === 'OK') &&
      gemini.status === 'OK';

    return {
      timestamp: new Date().toISOString(),
      allReady,
      checks: {
        database,
        supabaseStorage,
        googleDrive: googleChecks.googleDrive,
        contentCalendar: googleChecks.contentCalendar,
        localDriveFallback,
        gemini,
        n8n,
      },
    };
  }

  private async checkDatabase(): Promise<IntegrationCheckItem> {
    try {
      const [accounts, aliases, rules, posts] = await Promise.all([
        automationPrisma.socialAccount.count(),
        automationPrisma.channelAlias.count(),
        automationPrisma.folderRule.count(),
        automationPrisma.post.count(),
      ]);

      return {
        status: 'OK',
        message: 'Connected to Supabase PostgreSQL database.',
        details: {
          socialAccounts: accounts,
          channelAliases: aliases,
          folderRules: rules,
          posts,
        },
      };
    } catch (err: any) {
      return {
        status: 'ERROR',
        message: `Database connection failed: ${err?.message || 'Unknown error'}`,
        actionRequired: [
          'Verify DATABASE_URL and DIRECT_URL in lp_backend/.env and ensure network access to aws-1-eu-north-1.pooler.supabase.com:6543.',
        ],
      };
    }
  }

  private async checkSupabaseStorage(): Promise<IntegrationCheckItem> {
    const targetBucket = (process.env.STORAGE_BUCKET || DEFAULT_SOCIAL_MEDIA_BUCKET).trim();
    try {
      const supabase = await getSupabaseClient();
      const { data: buckets, error } = await supabase.storage.listBuckets();
      if (error) {
        return {
          status: 'ERROR',
          message: `Supabase Storage listBuckets failed: ${error.message}`,
        };
      }

      let exists = (buckets || []).some((b) => b.name === targetBucket);
      if (!exists) {
        const { error: createErr } = await supabase.storage.createBucket(targetBucket, {
          public: false,
        });
        if (!createErr) {
          exists = true;
        }
      }

      return {
        status: exists ? 'OK' : 'ERROR',
        message: exists
          ? `Bucket "${targetBucket}" exists and is ready (private).`
          : `Bucket "${targetBucket}" does not exist and could not be created.`,
        details: {
          targetBucket,
          existingBuckets: (buckets || []).map((b) => ({ name: b.name, public: b.public })),
        },
      };
    } catch (err: any) {
      return {
        status: 'ERROR',
        message: `Supabase Storage check failed: ${err?.message || 'Unknown error'}`,
      };
    }
  }

  private async checkGoogleDriveAndCalendar(): Promise<{
    googleDrive: IntegrationCheckItem;
    contentCalendar: IntegrationCheckItem;
  }> {
    const credRel = (
      process.env.GOOGLE_APPLICATION_CREDENTIALS || './private/service_account.json'
    ).trim();
    const saPath = path.isAbsolute(credRel)
      ? credRel
      : path.resolve(process.cwd(), credRel);

    const rootFolderId = (
      process.env.DRIVE_ROOT_FOLDER_ID || '177ptcsSWKiBveriapQmPo1KQwFhsi44C'
    ).trim();
    const calendarFileId = (
      process.env.CALENDAR_FILE_ID ||
      process.env.CALENDAR_SHEET_ID ||
      '1eb9XK1hvhX-ABd4nHjpmMBdtTH6cmMgL'
    ).trim();

    if (!fs.existsSync(saPath)) {
      const missingItem: IntegrationCheckItem = {
        status: 'ACTION_REQUIRED',
        message: `Service account key file not found at ${saPath}`,
        actionRequired: [
          `Place your Google Service Account JSON at ${saPath} or update GOOGLE_APPLICATION_CREDENTIALS in lp_backend/.env.`,
        ],
      };
      return { googleDrive: missingItem, contentCalendar: missingItem };
    }

    let clientEmail = 'service-account';
    let projectId = 'unknown';
    try {
      const rawSa = JSON.parse(fs.readFileSync(saPath, 'utf8'));
      clientEmail = rawSa.client_email || clientEmail;
      projectId = rawSa.project_id || projectId;
    } catch {
      // ignore JSON read error here; GoogleAuth will surface it
    }

    const auth = new google.auth.GoogleAuth({
      keyFile: saPath,
      scopes: [
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/spreadsheets.readonly',
      ],
    });
    const drive = google.drive({ version: 'v3', auth });

    let googleDriveResult: IntegrationCheckItem;
    try {
      const folderMeta = await drive.files.get({
        fileId: rootFolderId,
        fields: 'id, name, mimeType',
        supportsAllDrives: true,
      });
      const childrenRes = await drive.files.list({
        q: `'${rootFolderId}' in parents and trashed = false`,
        fields: 'files(id, name, mimeType)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      googleDriveResult = {
        status: 'OK',
        message: `Connected to Google Drive root folder "${folderMeta.data.name}" (${rootFolderId}).`,
        details: {
          serviceAccountEmail: clientEmail,
          projectId,
          rootFolder: folderMeta.data,
          subfolders: (childrenRes.data.files || []).map((f) => f.name),
        },
      };
    } catch (err: any) {
      const msg = String(err?.message || '');
      const isApiDisabled =
        msg.includes('has not been used in project') || msg.includes(' is disabled');
      const isNotFound = err?.code === 404 || msg.includes('File not found');

      const actions: string[] = [];
      if (isApiDisabled) {
        const projNumMatch = msg.match(/project\s+(\d+)/i);
        const projNum = projNumMatch ? projNumMatch[1] : '744412655267';
        actions.push(
          `1. Enable Google Drive API in GCP project ${projNum} (${projectId}): https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=${projNum}`,
          `2. Enable Google Sheets API in GCP project ${projNum} (${projectId}): https://console.developers.google.com/apis/api/sheets.googleapis.com/overview?project=${projNum}`
        );
      }
      if (isNotFound || isApiDisabled) {
        actions.push(
          `Share the Drive root folder (${rootFolderId}) as "Viewer" with Service Account email: ${clientEmail}`
        );
      }

      googleDriveResult = {
        status: 'ACTION_REQUIRED',
        message: msg,
        details: {
          serviceAccountEmail: clientEmail,
          projectId,
          rootFolderId,
        },
        actionRequired: actions,
      };
    }

    let contentCalendarResult: IntegrationCheckItem;
    try {
      const calMeta = await drive.files.get({
        fileId: calendarFileId,
        fields: 'id, name, mimeType, size, modifiedTime',
        supportsAllDrives: true,
      });

      contentCalendarResult = {
        status: 'OK',
        message: `Connected to Content Calendar file "${calMeta.data.name}" (${calMeta.data.mimeType}).`,
        details: {
          serviceAccountEmail: clientEmail,
          calendarFile: calMeta.data,
        },
      };
    } catch (err: any) {
      const msg = String(err?.message || '');
      contentCalendarResult = {
        status: 'ACTION_REQUIRED',
        message: msg,
        details: {
          serviceAccountEmail: clientEmail,
          calendarFileId,
        },
        actionRequired: [
          `Ensure Google Drive & Sheets APIs are enabled on project ${projectId}, and share Calendar file (${calendarFileId}) as "Viewer" with ${clientEmail}.`,
        ],
      };
    }

    return {
      googleDrive: googleDriveResult,
      contentCalendar: contentCalendarResult,
    };
  }

  private async checkLocalDriveFallback(): Promise<IntegrationCheckItem> {
    const candidatePath = (
      process.env.LOCAL_DRIVE_ROOT_PATH ||
      'C:\\Users\\DELL\\Downloads\\Social-CRM-Automation-20261107T105237Z-1-001\\Social-CRM-Automation'
    ).trim();

    if (!fs.existsSync(candidatePath)) {
      return {
        status: 'ACTION_REQUIRED',
        message: `Local Drive mirror folder not found at ${candidatePath}`,
        actionRequired: [
          'Optional for offline/localhost testing: set LOCAL_DRIVE_ROOT_PATH in lp_backend/.env to your local Social-CRM-Automation folder.',
        ],
      };
    }

    const entries = fs.readdirSync(candidatePath);
    const socialFolder = process.env.SOCIAL_FOLDER_NAME || '07_Social_media';
    const hasSocialFolder = entries.includes(socialFolder);

    return {
      status: hasSocialFolder ? 'OK' : 'ACTION_REQUIRED',
      message: hasSocialFolder
        ? `Local Drive mirror found at "${candidatePath}" with "${socialFolder}". Ready for localhost testing.`
        : `Folder "${candidatePath}" exists, but "${socialFolder}" was not found inside it.`,
      details: {
        localPath: candidatePath,
        topLevelEntries: entries,
      },
    };
  }

  private async checkGemini(): Promise<IntegrationCheckItem> {
    const key = (process.env.GEMINI_API_KEY || '').trim();
    if (!key) {
      return {
        status: 'ACTION_REQUIRED',
        message: 'GEMINI_API_KEY is not set in lp_backend/.env.',
      };
    }
    return {
      status: 'OK',
      message: 'GEMINI_API_KEY is configured.',
      details: {
        model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
        keyConfigured: true,
      },
    };
  }

  private async checkN8n(): Promise<IntegrationCheckItem> {
    const flow1Webhook = (process.env.N8N_FLOW1_WEBHOOK_URL || '').trim();
    const flow3Webhook = (process.env.N8N_FLOW3_WEBHOOK_URL || '').trim();
    const n8nBaseUrl = (process.env.N8N_BASE_URL || 'http://localhost:5678').replace(/\/+$/, '');

    let localN8nReachable = false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      const res = await fetch(`${n8nBaseUrl}/healthz`, { signal: controller.signal });
      clearTimeout(timer);
      localN8nReachable = res.ok;
    } catch {
      localN8nReachable = false;
    }

    if (localN8nReachable || (flow1Webhook && flow3Webhook)) {
      return {
        status: 'OK',
        message: localN8nReachable
          ? `n8n instance is reachable at ${n8nBaseUrl}.`
          : 'n8n webhook URLs are configured.',
        details: {
          n8nBaseUrl,
          localN8nReachable,
          flow1WebhookConfigured: Boolean(flow1Webhook),
          flow3WebhookConfigured: Boolean(flow3Webhook),
        },
      };
    }

    return {
      status: 'ACTION_REQUIRED',
      message: `n8n is not running at ${n8nBaseUrl} and N8N_FLOW1_WEBHOOK_URL is not set yet.`,
      details: {
        n8nBaseUrl,
        localN8nReachable: false,
        flow1WebhookConfigured: Boolean(flow1Webhook),
        flow3WebhookConfigured: Boolean(flow3Webhook),
      },
      actionRequired: [
        'Start n8n locally (`npx n8n` or Docker on port 5678) and import the 4 JSON files from /n8n/workflows.',
        'Set LP_BACKEND_URL=http://localhost:4000 and INTERNAL_API_KEY in n8n environment.',
      ],
    };
  }
}

export const connectivityService = new ConnectivityService();

