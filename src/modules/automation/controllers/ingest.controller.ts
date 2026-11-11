import { Request, Response } from 'express';
import { ingestService } from '../ingest/ingest.service';

export class IngestController {
  /**
   * POST /internal/ingest/rows
   * Accepts calendar rows (or xlsxBase64) and stages ContentItems + Posts in the 14-day window.
   */
  public ingestRows = async (req: Request, res: Response): Promise<void> => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.rows) && !body.xlsxBase64) {
        res.status(400).json({
          success: false,
          code: 'VALIDATION_ERROR',
          error: 'Either "rows" (array) or "xlsxBase64" is required.',
        });
        return;
      }

      const result = await ingestService.ingestRows({
        sheetId: body.sheetId,
        tab: body.tab,
        rows: body.rows,
        xlsxBase64: body.xlsxBase64,
        referenceDate: body.referenceDate,
        dumpDaysBefore: body.dumpDaysBefore,
        windowStartYmd: body.windowStartYmd,
        windowEndYmd: body.windowEndYmd,
        timeZone: body.timeZone,
        markUnseenRows: body.markUnseenRows,
      });

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      console.error(`[IngestController] postId=none ingestRows error:`, err?.message);
      res.status(500).json({
        success: false,
        code: 'INGEST_ROWS_ERROR',
        error: err?.message || 'Failed to ingest calendar rows',
      });
    }
  };

  /**
   * POST /internal/ingest/folder-listing
   * Applies Section 4 folder matching rules, deduplicates by MD5, and returns signed upload URLs or BLOCKED reasons.
   * Supports both single `{ postId, drivePath, folderFound, files, subfolders }` and batch `{ listings: [...] }`.
   */
  public processFolderListing = async (req: Request, res: Response): Promise<void> => {
    try {
      const body = req.body || {};
      const listings = Array.isArray(body.listings)
        ? body.listings
        : body.postId
        ? [
            {
              postId: body.postId,
              drivePath: body.drivePath,
              folderFound: Boolean(body.folderFound ?? (Array.isArray(body.files) && body.files.length > 0)),
              files: body.files || [],
              subfolders: body.subfolders || [],
            },
          ]
        : [];

      if (listings.length === 0) {
        res.status(400).json({
          success: false,
          code: 'VALIDATION_ERROR',
          error: 'Provide "listings" array or single "{ postId, drivePath, folderFound, files }".',
        });
        return;
      }

      const result = await ingestService.processFolderListings({
        listings,
        allDateFoldersInDrive: body.allDateFoldersInDrive,
      });

      res.status(200).json({
        success: true,
        data: Array.isArray(body.listings)
          ? result
          : { ...result.results[0], orphanFolders: result.orphanFolders },
      });
    } catch (err: any) {
      const status = err?.message?.includes('not found') ? 404 : 500;
      console.error(`[IngestController] postId=${req.body?.postId || 'batch'} processFolderListing error:`, err?.message);
      res.status(status).json({
        success: false,
        code: status === 404 ? 'NOT_FOUND' : 'FOLDER_LISTING_ERROR',
        error: err?.message || 'Failed to process folder listing',
      });
    }
  };

  /**
   * POST /internal/media/:id/complete
   * Probes media dimensions/duration or extracts .docx caption text, validates against platform specs,
   * and transitions linked posts to PENDING_REVIEW when all assets are READY.
   */
  public completeMediaUpload = async (req: Request, res: Response): Promise<void> => {
    try {
      const mediaId = String(req.params.id || '').trim();
      if (!mediaId) {
        res.status(400).json({
          success: false,
          code: 'VALIDATION_ERROR',
          error: 'Media asset ID is required in URL path.',
        });
        return;
      }

      const result = await ingestService.completeMediaUpload(mediaId, {
        base64Data: req.body?.base64Data,
        width: req.body?.width,
        height: req.body?.height,
        durationSec: req.body?.durationSec,
        sizeBytes: req.body?.sizeBytes,
        skipStoragePut: req.body?.skipStoragePut,
      });

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      const status = err?.message?.includes('not found') ? 404 : 500;
      console.error(`[IngestController] postId=none mediaId=${req.params.id} completeMediaUpload error:`, err?.message);
      res.status(status).json({
        success: false,
        code: status === 404 ? 'NOT_FOUND' : 'MEDIA_COMPLETE_ERROR',
        error: err?.message || 'Failed to complete media upload',
      });
    }
  };

  /**
   * POST /internal/ingest/dump-from-drive
   * Autonomous Flow 1 endpoint:
   * 1. Fetches Content Calendar from Google Drive using Service Account
   * 2. Upserts ContentItems & Posts in the window
   * 3. Scans 07_Social_media date folders for ready assets
   * 4. Downloads media & captions directly into DB/Storage
   * 5. Transitions posts with complete assets to PENDING_REVIEW
   * 6. Dispatches approval notification email to configured approvers
   */
  public dumpFromDrive = async (req: Request, res: Response): Promise<void> => {
    try {
      const body = req.body || {};
      const result = await ingestService.dumpFromDrive({
        sheetId: body.sheetId,
        referenceDate: body.referenceDate,
        daysAhead: body.daysAhead,
        windowStartYmd: body.windowStartYmd,
        windowEndYmd: body.windowEndYmd,
        timeZone: body.timeZone,
        sendNotification: body.sendNotification,
        async: body.async === true || body.isAsync === true,
        jobRunId: body.jobRunId,
        concurrency: typeof body.concurrency === 'number' ? body.concurrency : 4,
      });

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      console.error('[IngestController] dumpFromDrive error:', err?.message);
      res.status(500).json({
        success: false,
        code: 'DUMP_FROM_DRIVE_ERROR',
        error: err?.message || 'Failed to dump content from Google Drive',
      });
    }
  };
}

export const ingestController = new IngestController();

