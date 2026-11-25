/**
 * OpenAPI definitions for the Social CRM Content Automation module
 * (n8n -> /internal/*, CRM frontend -> /social-crm/*).
 * Merged into the main spec in `swagger.ts`.
 */

const TAG_INTERNAL = 'Social CRM Automation - Internal (n8n)';
const TAG_CRM = 'Social CRM Automation - Review & Publishing';
const TAG_ADMIN = 'Social CRM Automation - Accounts & Settings';

export const automationSwaggerTags = [
  {
    name: TAG_INTERNAL,
    description:
      'Endpoints called ONLY by n8n workflows (Flow 1 Content Dump, Flow 2 Publisher, Flow 3 Inventory Check, Error Alert). Protected by the X-Internal-Key header. Mounted at /internal and /api/v1/internal. n8n only orchestrates; all business logic, status changes and platform calls live in the backend.',
  },
  {
    name: TAG_CRM,
    description:
      'Social CRM review loop used by the CRM frontend: list/edit posts, replace media, submit, approve, request changes, reject, comment, retry and publish-now. Requires a CRM session token (Authorization: Bearer). Roles: approver (Mr. Lionel), editor (Sarath, Asad), admin (Asif).',
  },
  {
    name: TAG_ADMIN,
    description:
      'Connected social accounts (tokens encrypted at rest and never returned), channel aliases, folder rules, recent job runs, read-only settings, and manual run-now triggers for n8n flows.',
  },
];

export const automationSwaggerSecuritySchemes = {
  internalKeyAuth: {
    type: 'apiKey',
    in: 'header',
    name: 'X-Internal-Key',
    description:
      'Shared secret between n8n and lp_backend (env INTERNAL_API_KEY). Required on every /internal/* endpoint.',
  },
};

// ---------- reusable fragments ----------
const idParam = (name = 'id', description = 'Resource UUID') => ({
  name,
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
  description,
});

const jsonBody = (schema: any, required = true) => ({
  required,
  content: { 'application/json': { schema } },
});

const okEnvelope = (dataSchema: any = { type: 'object' }, description = 'Success') => ({
  description,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          data: dataSchema,
        },
      },
    },
  },
});

const errorResponse = (description: string) => ({
  description,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          code: { type: 'string', example: 'VALIDATION_ERROR' },
          error: { type: 'string', example: 'Human readable message' },
        },
      },
    },
  },
});

const internalSecurity = [{ internalKeyAuth: [] }];
const crmSecurity = [{ bearerAuth: [] }];

const postStatusEnum = [
  'BLOCKED',
  'PENDING_REVIEW',
  'CHANGES_REQUESTED',
  'APPROVED',
  'PUBLISHING',
  'PROCESSING',
  'PUBLISHED',
  'FAILED',
  'MISSED',
  'REJECTED',
  'SKIPPED',
  'CANCELLED',
  'MANUAL_DONE',
];

const platformEnum = ['LINKEDIN', 'LINKEDIN_NEWSLETTER', 'INSTAGRAM', 'YOUTUBE', 'TIKTOK'];

const commentBody = (required: boolean, description: string) =>
  jsonBody(
    {
      type: 'object',
      required: required ? ['comment'] : [],
      properties: { comment: { type: 'string', description, example: 'Please shorten the hook.' } },
    },
    required
  );

const driveFile = {
  type: 'object',
  properties: {
    id: { type: 'string', example: '1AbC...' },
    name: { type: 'string', example: 'caption.docx' },
    mimeType: { type: 'string', example: 'video/mp4' },
    md5Checksum: { type: 'string' },
    size: { type: 'string', example: '1048576' },
    modifiedTime: { type: 'string', format: 'date-time' },
  },
};

const calendarRow = {
  type: 'object',
  properties: {
    dateYmd: { type: 'string', example: '2026-11-12', description: 'Publish date (YYYY-MM-DD)' },
    timeHhMm: { type: 'string', example: '09:00' },
    channelRaw: { type: 'string', example: 'LinkedIn, Instagram' },
    contentType: { type: 'string', nullable: true, example: 'Video' },
    subject: { type: 'string', nullable: true, example: 'Founder Pressure' },
  },
};

// ---------- paths ----------
export const automationSwaggerPaths: Record<string, any> = {
  // ===== Internal: job runs =====
  '/internal/job-runs/start': {
    post: {
      summary: 'Start a JobRun log entry',
      description: 'Called at the start of every n8n flow. Returns the JobRun id to pass to /job-runs/finish.',
      tags: [TAG_INTERNAL],
      security: internalSecurity,
      requestBody: jsonBody({
        type: 'object',
        required: ['workflow'],
        properties: {
          workflow: { type: 'string', example: 'flow1-content-dump' },
          stats: { type: 'object', nullable: true },
        },
      }),
      responses: {
        201: okEnvelope({ type: 'object' }, 'JobRun created'),
        400: errorResponse('workflow is required'),
        401: { description: 'Missing or invalid X-Internal-Key' },
      },
    },
  },
  '/internal/job-runs/finish': {
    post: {
      summary: 'Finish a JobRun log entry',
      tags: [TAG_INTERNAL],
      security: internalSecurity,
      requestBody: jsonBody({
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid', description: 'JobRun id (jobRunId also accepted)' },
          stats: { type: 'object', description: 'Counters / warnings (e.g. { warnings: [] })' },
          error: { type: 'string', nullable: true },
        },
      }),
      responses: {
        200: okEnvelope({ type: 'object' }, 'JobRun updated'),
        400: errorResponse('id is required'),
        404: errorResponse('JobRun not found'),
        401: { description: 'Missing or invalid X-Internal-Key' },
      },
    },
  },
  '/internal/job-runs/error-alert': {
    post: {
      summary: 'Record a crashed workflow and queue JOB_FAILED email to Asif',
      description: 'Called by the n8n Error Trigger workflow.',
      tags: [TAG_INTERNAL],
      security: internalSecurity,
      requestBody: jsonBody({
        type: 'object',
        properties: {
          workflowName: { type: 'string', example: 'Social CRM - Flow 1: Content Dump' },
          failedNode: { type: 'string', example: 'POST /internal/ingest/rows' },
          errorMessage: { type: 'string' },
          executionId: { type: 'string' },
        },
      }),
      responses: {
        200: okEnvelope({
          type: 'object',
          properties: { jobRun: { type: 'object' }, notification: { type: 'object' } },
        }),
        401: { description: 'Missing or invalid X-Internal-Key' },
      },
    },
  },

  // ===== Internal: Flow 1 ingest =====
  '/internal/ingest/rows': {
    post: {
      summary: 'Flow 1 - Stage calendar rows (14-day window)',
      description:
        'Accepts parsed calendar rows (or a base64 .xlsx) and creates/updates ContentItems and Posts for rows inside the DUMP_DAYS_BEFORE window. Idempotent: running twice changes nothing. Unknown channels/types become BLOCKED; "No video posted" rows become SKIPPED.',
      tags: [TAG_INTERNAL],
      security: internalSecurity,
      requestBody: jsonBody({
        type: 'object',
        description: 'Provide either "rows" or "xlsxBase64".',
        properties: {
          sheetId: { type: 'string' },
          tab: { type: 'string', example: 'Nov 2026' },
          rows: { type: 'array', items: { type: 'object', description: 'Raw calendar row (unformatted cell values)' } },
          xlsxBase64: { type: 'string', description: 'Base64 of the calendar .xlsx' },
          referenceDate: { type: 'string', format: 'date-time' },
          dumpDaysBefore: { type: 'integer', example: 14 },
          windowStartYmd: { type: 'string', example: '2026-11-07' },
          windowEndYmd: { type: 'string', example: '2026-11-21' },
          timeZone: { type: 'string', example: 'Europe/Amsterdam' },
          markUnseenRows: { type: 'boolean', description: 'Increment unseenRuns for rows missing from the calendar' },
        },
      }),
      responses: {
        200: okEnvelope({ type: 'object' }, 'Staging summary (created / updated / skipped / blocked)'),
        400: errorResponse('rows or xlsxBase64 required'),
        500: errorResponse('Ingest failed'),
      },
    },
  },
  '/internal/ingest/folder-listing': {
    post: {
      summary: 'Flow 1 - Apply folder matching rules to a Drive date-folder listing',
      description:
        'Applies the 11 folder matching rules (plan section 4), de-duplicates by MD5, creates MediaAsset rows and returns signed upload URLs, or marks the post BLOCKED with a reason. Send one listing, or a batch via "listings".',
      tags: [TAG_INTERNAL],
      security: internalSecurity,
      requestBody: jsonBody({
        type: 'object',
        properties: {
          postId: { type: 'string', format: 'uuid' },
          drivePath: { type: 'string', example: '07_Social_media/03_Youtube/2026-11-12' },
          folderFound: { type: 'boolean' },
          files: { type: 'array', items: driveFile },
          subfolders: { type: 'array', items: { type: 'object' } },
          listings: {
            type: 'array',
            description: 'Batch mode - array of the single-listing object above',
            items: { type: 'object' },
          },
          allDateFoldersInDrive: { type: 'array', items: { type: 'string' }, description: 'Used to report orphan folders' },
        },
      }),
      responses: {
        200: okEnvelope({ type: 'object' }, 'Matched assets / BLOCKED reason / orphan folders'),
        400: errorResponse('listings or postId required'),
        404: errorResponse('Post not found'),
      },
    },
  },
  '/internal/media/{id}/complete': {
    post: {
      summary: 'Flow 1 - Mark a media asset as uploaded and validate it',
      description:
        'Probes dimensions/duration (or extracts .docx caption text), validates against the platform spec and moves the post to PENDING_REVIEW when all assets are READY.',
      tags: [TAG_INTERNAL],
      security: internalSecurity,
      parameters: [idParam('id', 'MediaAsset id')],
      requestBody: jsonBody(
        {
          type: 'object',
          properties: {
            base64Data: { type: 'string', description: 'Optional file bytes (small files / .docx)' },
            width: { type: 'integer' },
            height: { type: 'integer' },
            durationSec: { type: 'number' },
            sizeBytes: { type: 'integer' },
            skipStoragePut: { type: 'boolean' },
          },
        },
        false
      ),
      responses: {
        200: okEnvelope({ type: 'object' }, 'Validation result and post status'),
        404: errorResponse('MediaAsset not found'),
      },
    },
  },
  '/internal/posts/{id}/draft': {
    post: {
      summary: 'Flow 1 - Save the Gemini-formatted caption draft',
      description: 'Stores the validated Gemini output (title, caption, hashtags) as the post draft.',
      tags: [TAG_INTERNAL],
      security: internalSecurity,
      parameters: [idParam('id', 'Post id')],
      requestBody: jsonBody({
        type: 'object',
        properties: {
          title: { type: 'string', example: 'Why founders burn out' },
          caption: { type: 'string' },
          hashtags: { type: 'array', items: { type: 'string' } },
          category: { type: 'string', example: 'Founder Pressure' },
          useBackendGemini: { type: 'boolean', description: 'Let the backend call Gemini instead of n8n' },
          channelToneReference: { type: 'string' },
        },
      }),
      responses: {
        200: okEnvelope({ type: 'object' }, 'Draft saved'),
        400: errorResponse('Invalid post id or invalid Gemini output'),
      },
    },
  },

  // ===== Internal: notifications outbox =====
  '/internal/notifications': {
    get: {
      summary: 'Flow 2 - List queued emails (Notification outbox)',
      tags: [TAG_INTERNAL],
      security: internalSecurity,
      parameters: [
        {
          name: 'status',
          in: 'query',
          schema: { type: 'string', enum: ['PENDING', 'SENT', 'FAILED'], default: 'PENDING' },
        },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
        { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
      ],
      responses: {
        200: okEnvelope(
          {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                type: { type: 'string', example: 'SUBMITTED_FOR_REVIEW' },
                postId: { type: 'string', nullable: true },
                recipients: { type: 'array', items: { type: 'string' } },
                cc: { type: 'array', items: { type: 'string' } },
                subject: { type: 'string' },
                body: { type: 'string' },
                dedupeKey: { type: 'string' },
                status: { type: 'string' },
              },
            },
          },
          'Notifications to send via the n8n SMTP node'
        ),
      },
    },
  },
  '/internal/notifications/{id}/sent': {
    post: {
      summary: 'Flow 2 - Mark an email as SENT',
      tags: [TAG_INTERNAL],
      security: internalSecurity,
      parameters: [idParam('id', 'Notification id')],
      responses: { 200: okEnvelope({ type: 'object' }, 'Notification marked SENT') },
    },
  },
  '/internal/notifications/{id}/failed': {
    post: {
      summary: 'Flow 2 - Mark an email send attempt as FAILED',
      tags: [TAG_INTERNAL],
      security: internalSecurity,
      parameters: [idParam('id', 'Notification id')],
      requestBody: jsonBody(
        { type: 'object', properties: { error: { type: 'string', example: 'SMTP 550 mailbox unavailable' } } },
        false
      ),
      responses: { 200: okEnvelope({ type: 'object' }, 'Attempt recorded') },
    },
  },

  // ===== Internal: Flow 2 publisher =====
  '/internal/publisher/run': {
    post: {
      summary: 'Flow 2 - Run the publisher tick (every 5 minutes)',
      description:
        'Publishes due APPROVED posts (idempotent, writes PublishAttempt rows), polls PROCESSING posts, retries retryable errors, refreshes 401 tokens, marks posts MISSED after slot + grace period, and queues approval reminders. Never publishes a post that is not APPROVED.',
      tags: [TAG_INTERNAL],
      security: internalSecurity,
      requestBody: jsonBody(
        {
          type: 'object',
          properties: { now: { type: 'string', format: 'date-time', description: 'Testing override' } },
        },
        false
      ),
      responses: {
        200: okEnvelope({ type: 'object' }, 'Counts: published, processing, retried, failed, missed, reminders'),
        500: errorResponse('Publisher run failed'),
      },
    },
  },

  // ===== Internal: hardening =====
  '/internal/digest': {
    get: {
      summary: 'Flow 1 - Daily digest',
      description:
        'Aggregates BLOCKED posts (URGENT when < 7 days away), PENDING_REVIEW < 48h, FAILED/MISSED in the last 24h, tokens expiring < 7 days and ingest warnings. Queues one DAILY_DIGEST email only when there is something to report.',
      tags: [TAG_INTERNAL],
      security: internalSecurity,
      parameters: [
        { name: 'queueEmail', in: 'query', schema: { type: 'boolean', default: true } },
        { name: 'now', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'Testing override' },
      ],
      responses: { 200: okEnvelope({ type: 'object' }, 'Digest sections and emailQueued flag') },
    },
  },
  '/internal/maintenance/run': {
    post: {
      summary: 'Flow 1 - Run maintenance',
      description:
        'Refreshes tokens expiring within 10 days, deletes storage objects past deleteAfter, cancels posts whose calendar row was unseen for 2+ runs, and deletes JobRuns older than 90 days.',
      tags: [TAG_INTERNAL],
      security: internalSecurity,
      requestBody: jsonBody(
        { type: 'object', properties: { now: { type: 'string', format: 'date-time' } } },
        false
      ),
      responses: { 200: okEnvelope({ type: 'object' }, 'Maintenance summary') },
    },
  },
  '/internal/inventory/check': {
    post: {
      summary: 'Flow 3 - 30-day inventory check (read-only)',
      description:
        'Compares planned calendar rows with Drive folder listings for the next INVENTORY_DAYS_AHEAD days. Never downloads or changes posts. Queues one INVENTORY_LOW email per ISO week to info@, Sarath, Asad and Asif when content is missing; streams ready for < 14 days are flagged URGENT. Sends nothing when everything is ready.',
      tags: [TAG_INTERNAL],
      security: internalSecurity,
      requestBody: jsonBody({
        type: 'object',
        properties: {
          rows: { type: 'array', items: calendarRow },
          folderListings: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                drivePath: { type: 'string', example: '07_Social_media/03_Youtube/2026-11-12' },
                folderFound: { type: 'boolean' },
                files: { type: 'array', items: driveFile },
                subfolders: { type: 'array', items: { type: 'object' } },
              },
            },
          },
          calendarGaps: { type: 'array', items: { type: 'string' } },
          daysAhead: { type: 'integer', example: 30 },
          isManualRun: { type: 'boolean', description: 'Manual runs always send (no weekly de-duplication)' },
          now: { type: 'string', format: 'date-time' },
        },
      }),
      responses: {
        200: okEnvelope(
          {
            type: 'object',
            properties: {
              totalPlannedPosts: { type: 'integer' },
              totalReadyPosts: { type: 'integer' },
              missingContent: { type: 'array', items: { type: 'object' } },
              coveragePerStream: { type: 'array', items: { type: 'object' } },
              calendarGaps: { type: 'array', items: { type: 'string' } },
              emailQueued: { type: 'boolean' },
            },
          },
          'Inventory result'
        ),
      },
    },
  },

  // ===== CRM: posts =====
  '/social-crm/posts': {
    get: {
      summary: 'List posts (review queue, calendar, blocked & failed)',
      tags: [TAG_CRM],
      security: crmSecurity,
      parameters: [
        { name: 'status', in: 'query', schema: { type: 'string', enum: postStatusEnum } },
        { name: 'platform', in: 'query', schema: { type: 'string', enum: platformEnum } },
        { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
        { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
        { name: 'search', in: 'query', schema: { type: 'string' } },
        { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 25 } },
      ],
      responses: { 200: okEnvelope({ type: 'object' }, 'Paginated posts'), 401: { description: 'Not logged in' } },
    },
  },
  '/social-crm/posts/{id}': {
    get: {
      summary: 'Post detail (media, revisions, review events, publish attempts)',
      tags: [TAG_CRM],
      security: crmSecurity,
      parameters: [idParam('id', 'Post id')],
      responses: { 200: okEnvelope({ type: 'object' }), 404: errorResponse('Post not found') },
    },
    patch: {
      summary: 'Edit a post (editor, admin)',
      description:
        'Any edit after approval sends the post back to PENDING_REVIEW. Resubmits create a new revision.',
      tags: [TAG_CRM],
      security: crmSecurity,
      parameters: [idParam('id', 'Post id')],
      requestBody: jsonBody({
        type: 'object',
        properties: {
          title: { type: 'string' },
          caption: { type: 'string' },
          hashtags: { type: 'array', items: { type: 'string' } },
          options: { type: 'object', description: 'playlistId, privacy, TikTok flags, IG mediaType' },
          scheduledAt: { type: 'string', format: 'date-time', description: 'UTC' },
        },
      }),
      responses: { 200: okEnvelope({ type: 'object' }), 403: { description: 'Role not allowed' } },
    },
  },
  '/social-crm/posts/{id}/media': {
    post: {
      summary: 'Replace / add media (editor, admin)',
      description: 'Multipart upload (field "file", max 100 MB) or JSON with base64Data. Stored via StorageService (bucket + object key only).',
      tags: [TAG_CRM],
      security: crmSecurity,
      parameters: [idParam('id', 'Post id')],
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              properties: {
                file: { type: 'string', format: 'binary' },
                role: { type: 'string', example: 'PRIMARY' },
                position: { type: 'integer', default: 0 },
              },
            },
          },
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                fileName: { type: 'string' },
                mimeType: { type: 'string' },
                base64Data: { type: 'string' },
                role: { type: 'string' },
                position: { type: 'integer' },
              },
            },
          },
        },
      },
      responses: { 200: okEnvelope({ type: 'object' }), 400: errorResponse('File missing') },
    },
  },
  '/social-crm/posts/{id}/submit': {
    post: {
      summary: 'Resubmit for review (editor, admin)',
      tags: [TAG_CRM],
      security: crmSecurity,
      parameters: [idParam('id', 'Post id')],
      requestBody: commentBody(false, 'Optional note for Mr. Lionel'),
      responses: { 200: okEnvelope({ type: 'object' }, 'Post is PENDING_REVIEW (new revision)') },
    },
  },
  '/social-crm/posts/{id}/approve': {
    post: {
      summary: 'Approve (approver, admin)',
      tags: [TAG_CRM],
      security: crmSecurity,
      parameters: [idParam('id', 'Post id')],
      requestBody: commentBody(false, 'Optional comment'),
      responses: {
        200: okEnvelope({ type: 'object' }, 'Post is APPROVED (publisher picks it up at its slot)'),
        403: { description: 'Role not allowed' },
        409: errorResponse('Invalid status transition'),
      },
    },
  },
  '/social-crm/posts/{id}/request-changes': {
    post: {
      summary: 'Request changes (approver, admin)',
      tags: [TAG_CRM],
      security: crmSecurity,
      parameters: [idParam('id', 'Post id')],
      requestBody: commentBody(true, 'Required: what must change'),
      responses: { 200: okEnvelope({ type: 'object' }), 400: errorResponse('Comment required') },
    },
  },
  '/social-crm/posts/{id}/reject': {
    post: {
      summary: 'Reject (approver, admin)',
      tags: [TAG_CRM],
      security: crmSecurity,
      parameters: [idParam('id', 'Post id')],
      requestBody: commentBody(true, 'Required: reason for rejection'),
      responses: { 200: okEnvelope({ type: 'object' }), 400: errorResponse('Comment required') },
    },
  },
  '/social-crm/posts/{id}/comments': {
    post: {
      summary: 'Add a comment (approver, editor, admin)',
      tags: [TAG_CRM],
      security: crmSecurity,
      parameters: [idParam('id', 'Post id')],
      requestBody: commentBody(true, 'Comment text'),
      responses: { 201: okEnvelope({ type: 'object' }, 'Comment created') },
    },
  },
  '/social-crm/posts/{id}/manual-done': {
    post: {
      summary: 'Confirm a MANUAL channel post was published (editor, admin)',
      tags: [TAG_CRM],
      security: crmSecurity,
      parameters: [idParam('id', 'Post id')],
      requestBody: jsonBody({
        type: 'object',
        properties: {
          url: { type: 'string', example: 'https://www.linkedin.com/pulse/...' },
          comment: { type: 'string' },
        },
      }),
      responses: { 200: okEnvelope({ type: 'object' }, 'Post is MANUAL_DONE'), 400: errorResponse('url required') },
    },
  },
  '/social-crm/posts/{id}/retry': {
    post: {
      summary: 'Retry a FAILED post (admin)',
      tags: [TAG_CRM],
      security: crmSecurity,
      parameters: [idParam('id', 'Post id')],
      requestBody: commentBody(false, 'Optional note'),
      responses: { 200: okEnvelope({ type: 'object' }), 403: { description: 'Admin only' } },
    },
  },
  '/social-crm/posts/{id}/publish-now': {
    post: {
      summary: 'Publish now (approver, admin) - APPROVED posts only',
      description: 'Immediately runs the publisher for this post. Rejected for any status other than APPROVED.',
      tags: [TAG_CRM],
      security: crmSecurity,
      parameters: [idParam('id', 'Post id')],
      responses: { 200: okEnvelope({ type: 'object' }), 409: errorResponse('Post is not APPROVED') },
    },
  },

  // ===== CRM: accounts & settings =====
  '/social-crm/accounts': {
    get: {
      summary: 'Accounts & settings screen data',
      description: 'Connected accounts (tokens never returned), channel aliases, folder rules, last 20 job runs and read-only settings.',
      tags: [TAG_ADMIN],
      security: crmSecurity,
      parameters: [
        { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 100 } },
      ],
      responses: {
        200: okEnvelope({
          type: 'object',
          properties: {
            accounts: { type: 'array', items: { type: 'object' } },
            channelAliases: { type: 'array', items: { type: 'object' } },
            folderRules: { type: 'array', items: { type: 'object' } },
            recentJobRuns: { type: 'array', items: { type: 'object' } },
            settings: { type: 'object' },
          },
        }),
      },
    },
    post: {
      summary: 'Create/update a social account or add a channel alias (admin)',
      description:
        'Send "alias" (+ platform, mode, accountId) to upsert a ChannelAlias. Otherwise send platform, label, externalId and optional accessToken / refreshToken (AES-256-GCM encrypted at rest). Include "id" to update.',
      tags: [TAG_ADMIN],
      security: crmSecurity,
      requestBody: jsonBody({
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          platform: { type: 'string', enum: platformEnum },
          label: { type: 'string', example: 'LinkedIn Company Page' },
          externalId: { type: 'string', example: 'urn:li:organization:18948042' },
          accessToken: { type: 'string', writeOnly: true },
          refreshToken: { type: 'string', writeOnly: true },
          tokenExpiresAt: { type: 'string', format: 'date-time' },
          isActive: { type: 'boolean' },
          alias: { type: 'string', example: 'linkedin company' },
          mode: { type: 'string', enum: ['AUTO', 'MANUAL'] },
          accountId: { type: 'string', format: 'uuid', nullable: true },
        },
      }),
      responses: {
        200: okEnvelope({ type: 'object' }, 'Saved (account without tokens, or channelAlias)'),
        400: errorResponse('platform, label and externalId required'),
        403: { description: 'Admin only' },
      },
    },
  },
  '/social-crm/ingest/run-now': {
    post: {
      summary: 'Trigger an n8n flow now (admin)',
      description: 'Calls the configured N8N_FLOW1_WEBHOOK_URL or N8N_FLOW3_WEBHOOK_URL.',
      tags: [TAG_ADMIN],
      security: crmSecurity,
      requestBody: jsonBody(
        {
          type: 'object',
          properties: {
            workflow: {
              type: 'string',
              enum: ['flow1-content-dump', 'flow3-inventory-check'],
              default: 'flow1-content-dump',
            },
          },
        },
        false
      ),
      responses: {
        200: okEnvelope({
          type: 'object',
          properties: {
            workflow: { type: 'string' },
            triggered: { type: 'boolean' },
            webhookConfigured: { type: 'boolean' },
          },
        }),
      },
    },
  },
};

