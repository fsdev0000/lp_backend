import path from 'path';
import fs from 'fs';
import { google, drive_v3 } from 'googleapis';
import { parseXlsxBuffer, ParsedXlsxSheet } from './fileParsers';
import { parseCalendarDateToYmd, parseCalendarTimeToHhMm } from './calendarParser';
import { DriveFileInput, DriveSubfolderInput } from './folderMatcher';

export interface CalendarRowItem {
  dateYmd: string;
  timeHhMm?: string;
  channelRaw: string;
  contentType?: string | null;
  subject?: string | null;
  tab?: string;
  rowNumber?: number;
}

export interface DriveFolderListing {
  drivePath: string;
  folderFound: boolean;
  files: DriveFileInput[];
  subfolders?: DriveSubfolderInput[];
}

export interface GoogleDriveContext {
  drive: drive_v3.Drive;
  saPath: string;
}

/**
 * Resolves the Google service account JSON and initializes the Google Drive API client.
 */
export function getGoogleDriveClient(): GoogleDriveContext | null {
  const candidatePaths = [
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    path.resolve(process.cwd(), process.env.GOOGLE_APPLICATION_CREDENTIALS || './private/service_account.json'),
    path.resolve(process.cwd(), 'lp_backend', process.env.GOOGLE_APPLICATION_CREDENTIALS || './private/service_account.json'),
    path.resolve(__dirname, '../../../../private/service_account.json'),
    path.resolve(__dirname, '../../../../../private/service_account.json'),
    '/opt/leadersperformance/lp_backend/private/service_account.json',
  ].filter(Boolean) as string[];

  const saPath = candidatePaths.find((p) => fs.existsSync(p));
  if (!saPath) {
    console.warn('[GoogleDriveClient] Service account file not found in candidate paths:', candidatePaths);
    return null;
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: saPath,
    scopes: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/spreadsheets.readonly',
    ],
  });

  const drive = google.drive({ version: 'v3', auth });
  return { drive, saPath };
}

/**
 * Downloads the calendar XLSX from Google Drive as a Buffer.
 */
export async function fetchCalendarSpreadsheetBuffer(
  drive: drive_v3.Drive,
  fileId: string = process.env.CALENDAR_FILE_ID || '1eb9XK1hvhX-ABd4nHjpmMBdtTH6cmMgL'
): Promise<Buffer> {
  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(res.data as ArrayBuffer);
}

/**
 * Parses all weekly sections of the Content Calendar spreadsheet top-to-down,
 * propagating dates from merged cells and ignoring noise headers.
 */
export function parseAllCalendarSections(
  sheets: ParsedXlsxSheet[],
  options?: { fromDate?: string; toDate?: string }
): CalendarRowItem[] {
  const rows: CalendarRowItem[] = [];

  for (const sheet of sheets) {
    if (!sheet.name.toLowerCase().includes('calendar')) continue;
    let lastKnownDateYmd: string | null = null;

    for (const r of sheet.rows) {
      if (!r.cells || r.cells.length === 0) continue;
      const c0 = r.cells[0];
      const c0Str = String(c0 || '').trim();

      // 1. Detect weekly section header (e.g. "Content Calender 7-11-2026 till 13-11-2026")
      if (
        c0Str.toLowerCase().includes('content calender') ||
        c0Str.toLowerCase().includes('content calendar')
      ) {
        lastKnownDateYmd = null;
        continue;
      }

      // 2. Skip table column headers (e.g. "Date post", "Time post")
      if (c0Str.toLowerCase().includes('date post') || c0Str.toLowerCase() === 'date') {
        continue;
      }

      // 3. Resolve date: direct cell value OR inherited from merged cells within section
      let dateYmd = parseCalendarDateToYmd(c0);
      if (dateYmd) {
        lastKnownDateYmd = dateYmd;
      } else if (lastKnownDateYmd && (c0 === null || c0 === undefined || c0 === '')) {
        dateYmd = lastKnownDateYmd;
      }

      if (!dateYmd) continue;
      if (options?.fromDate && dateYmd < options.fromDate) continue;
      if (options?.toDate && dateYmd > options.toDate) continue;

      const timeRaw = r.cells[1];
      const timeHhMm = parseCalendarTimeToHhMm(timeRaw) || '09:00';
      const channelRaw = String(r.cells[2] ?? '').trim();
      const contentType = String(r.cells[3] ?? '').trim();
      const subject = String(r.cells[4] ?? '').trim();
      if (!channelRaw && !subject && !contentType) continue;

      rows.push({
        dateYmd,
        timeHhMm,
        channelRaw,
        contentType,
        subject,
        tab: sheet.name,
        rowNumber: r.rowNumber,
      });
    }
  }

  return rows;
}

/**
 * Scans the Google Drive 07_Social_media directory structure and returns folder listings with file details.
 */
export async function scanSocialMediaDriveFolders(
  drive: drive_v3.Drive,
  rootFolderId: string = process.env.DRIVE_ROOT_FOLDER_ID || '177ptcsSWKiBveriapQmPo1KQwFhsi44C',
  options?: { fromDate?: string; toDate?: string }
): Promise<DriveFolderListing[]> {
  const folderListings: DriveFolderListing[] = [];

  const rootChildren = await drive.files.list({
    q: `'${rootFolderId}' in parents and trashed = false`,
    fields: 'files(id, name, mimeType)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  const socialFolder = (rootChildren.data.files || []).find(
    (f) => f.name && (f.name.includes('07_Social_media') || f.name.includes('Social'))
  );

  if (!socialFolder || !socialFolder.id) {
    console.warn(`[GoogleDriveClient] Root social folder not found under ${rootFolderId}`);
    return folderListings;
  }

  const platformFolders = await drive.files.list({
    q: `'${socialFolder.id}' in parents and trashed = false`,
    fields: 'files(id, name, mimeType)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  for (const plat of platformFolders.data.files || []) {
    if (!plat.id || !plat.name) continue;

    const subList = await drive.files.list({
      q: `'${plat.id}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageSize: 50,
    });

    for (const item of subList.data.files || []) {
      if (!item.id || !item.name) continue;

      if (/^\d{4}-\d{2}-\d{2}$/.test(item.name)) {
        if (options?.fromDate && item.name < options.fromDate) continue;
        if (options?.toDate && item.name > options.toDate) continue;

        // Direct date folder (e.g. 03_Youtube/2026-11-05 or 04_Tiktok/2026-11-05)
        const { files, subfolders } = await listDateFolderContents(drive, item.id);

        folderListings.push({
          drivePath: `${plat.name}/${item.name}`,
          folderFound: true,
          files,
          subfolders,
        });
        folderListings.push({
          drivePath: `${socialFolder.name}/${plat.name}/${item.name}`,
          folderFound: true,
          files,
          subfolders,
        });
      } else {
        // Category subfolder (e.g. 01_Linkedin/01_Quotes, 02_Instagram/02_Photo)
        const dateFolders = await drive.files.list({
          q: `'${item.id}' in parents and trashed = false`,
          fields: 'files(id, name, mimeType)',
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          pageSize: 50,
        });

        for (const df of dateFolders.data.files || []) {
          if (df.id && df.name && /^\d{4}-\d{2}-\d{2}$/.test(df.name)) {
            if (options?.fromDate && df.name < options.fromDate) continue;
            if (options?.toDate && df.name > options.toDate) continue;

            const { files, subfolders } = await listDateFolderContents(drive, df.id);

            folderListings.push({
              drivePath: `${plat.name}/${item.name}/${df.name}`,
              folderFound: true,
              files,
              subfolders,
            });
            folderListings.push({
              drivePath: `${socialFolder.name}/${plat.name}/${item.name}/${df.name}`,
              folderFound: true,
              files,
              subfolders,
            });
          }
        }
      }
    }
  }

  return folderListings;
}

/**
 * Lists all files and any carousel subfolders inside a specific date folder.
 */
async function listDateFolderContents(
  drive: drive_v3.Drive,
  folderId: string
): Promise<{ files: DriveFileInput[]; subfolders: DriveSubfolderInput[] }> {
  const files: DriveFileInput[] = [];
  const subfolders: DriveSubfolderInput[] = [];

  try {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType, size, md5Checksum, modifiedTime)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageSize: 100,
    });

    for (const f of res.data.files || []) {
      if (!f.id || !f.name) continue;

      if (f.mimeType === 'application/vnd.google-apps.folder') {
        // Subfolder (e.g. Carousel subfolder)
        try {
          const subRes = await drive.files.list({
            q: `'${f.id}' in parents and trashed = false`,
            fields: 'files(id, name, mimeType, size, md5Checksum, modifiedTime)',
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
            pageSize: 50,
          });
          const subFiles: DriveFileInput[] = (subRes.data.files || []).map((sf) => ({
            id: sf.id || 'drive_file',
            name: sf.name || '',
            mimeType: sf.mimeType || 'application/octet-stream',
            size: Number(sf.size || 0),
            md5Checksum: sf.md5Checksum || undefined,
            modifiedTime: sf.modifiedTime || undefined,
          }));
          subfolders.push({
            id: f.id,
            name: f.name,
            files: subFiles,
          });
        } catch (subErr: any) {
          console.warn(`[GoogleDriveClient] Failed to list carousel subfolder ${f.name}:`, subErr?.message);
        }
      } else {
        files.push({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType || 'application/octet-stream',
          size: Number(f.size || 0),
          md5Checksum: f.md5Checksum || undefined,
          modifiedTime: f.modifiedTime || undefined,
        });
      }
    }
  } catch (err: any) {
    console.warn(`[GoogleDriveClient] Failed to list date folder contents for ${folderId}:`, err?.message);
  }

  return { files, subfolders };
}

/**
 * Downloads a file buffer from Google Drive.
 * Handles binary files and exports Google Docs to DOCX format.
 */
export async function downloadDriveFileBuffer(
  drive: drive_v3.Drive,
  fileId: string,
  mimeType?: string
): Promise<Buffer> {
  if (mimeType === 'application/vnd.google-apps.document') {
    const exportRes = await drive.files.export(
      {
        fileId,
        mimeType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
      { responseType: 'arraybuffer' }
    );
    return Buffer.from(exportRes.data as ArrayBuffer);
  }

  const getRes = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(getRes.data as ArrayBuffer);
}

