# Social CRM Content Automation – Implementation Plan

Nov 7, 2026 · @Leaders Performance

## 1. Goal, scope and roles

Replace Lieke's manual GHL scheduling with one pipeline: Content Calendar (Google Sheet) + Google Drive → n8n → lp\_backend (Supabase Postgres + Storage) → Mr. Lionel approves in Social CRM → auto-publish. This document is the build brief for the implementing AI agent. Build exactly this; anything marked Phase 2/3 is out of scope for v1.

**In scope (v1)**

- Daily ingest of the current + next month calendar tabs, with a look-ahead window so approval happens before the post date.
- Matching each calendar row to its file(s) in Drive, copying media to Supabase Storage, AI caption formatting with Gemini.
- Approval and revision loop inside Social CRM, with email notifications.
- Auto-publishing to LinkedIn, Instagram, YouTube and TikTok every 5 minutes, with retries and success/failure emails.
- Reminder tasks for channels that cannot be published by API (see the reality check below).

**Out of scope (v1):** X/Twitter (Phase 2), weekly analytics report (Phase 3), Lark tasks, content-stock alerts (Phase 3), Dutch TikTok video editing in CapCut (stays manual).

**Roles (from the brief — do not invent others)**

| Person | Role in system | Can do |
| --- | --- | --- |
| Mr. Lionel | Approver | Approve, request changes, reject, comment |
| Sarath | Content manager (editor) | Edit post, replace media, resubmit, fix blocked posts |
| Asad | Content manager (editor) | Same as Sarath |
| Asif | Admin (Senior AI & Data engineer) | Everything + connect accounts, retry/replay, settings |

**Platform reality check** — what can and cannot be automated (checked Nov 2026):

| Channel | Automatable? | Key constraint the build must handle |
| --- | --- | --- |
| LinkedIn (personal + company page) | Yes — Posts API | Text, image, multi-image, video and link posts work. Articles and newsletters have **no API** ([source](https://postproxy.dev/blog/linkedin-api-automate-company-page-publishing/)). Company page posting needs Community Management API approval. Tokens expire (\~60 days) → refresh + expiry alert. |
| Instagram | Yes — Content Publishing API | Business account linked to a Facebook Page. Media must be at a public URL; video goes through a container that must reach FINISHED before publish; containers expire after 24h; per-account daily publish cap — read it from `content_publishing_limit`, never hardcode ([Meta docs](https://developers.facebook.com/docs/instagram-platform/content-publishing)). |
| YouTube | Yes — Data API `videos.insert` | Native scheduling via `privacyStatus=private` + `publishAt`; playlist via `playlistItems.insert` (solves Lieke's playlist problem). Uploads are quota-heavy. An unverified Google Cloud project's uploads are locked private until the API audit passes. |
| TikTok (Dutch account) | Yes, **after audit** | Until the TikTok app passes the Content Posting API audit, every post is forced private (SELF\_ONLY) and public accounts are blocked ([TikTok docs](https://developers.tiktok.com/doc/content-posting-api-reference-photo-post)). Pull-from-URL needs a verified domain → use FILE\_UPLOAD from the backend. Must call `creator_info` before posting. |
| LinkedIn newsletter | No API | Manual task + reminder email. |
| Medium | No API for new integrations ([source](https://github.com/Medium/medium-api-docs)) | Manual task + reminder email. |
| INSPO account | Manual (per brief) | Manual task + reminder email. |
| Website / CMS articles | Existing CMS automation | Out of scope; listed as manual task only if it appears in the calendar. |

**Action before coding:** Asif starts the TikTok audit, YouTube API audit and LinkedIn Community Management API application on day 1 — these take days to weeks and block go-live, not development.

## 2. Architecture

&#91;embedded content: system architecture · who does what\]

n8n reads Google and calls Gemini; it never decides a status. lp\_backend owns state, validation, platform API calls and the email outbox, so the same code serves the 5-minute job and the CRM's Retry / Publish now buttons. Platform calls live in the backend (not in n8n nodes) because token refresh, chunked video uploads and async status polling are fragile in n8n.

**Difference from Asif's flow diagram (deliberate simplifications):** daily ingest instead of every 15 min (plus a Run now button); one daily digest instead of separate 14-day / 7-day alert flows; no Drive folder moves (01\_Raw → 04\_Published\_Archive) because status lives in the DB and moving files breaks matching; no write-back to Excel column G in v1 (optional later, one-way, status only); revisions are uploaded in the CRM, not Drive.

## 3. Storage decision

**Decision: Google Drive stays the team's intake folder; Supabase Storage holds every publish-ready file; Supabase Postgres holds all metadata and state.** Platforms never read from Drive.

| Store | Holds | Why |
| --- | --- | --- |
| Google Drive (existing folders) | Originals uploaded by Sarath/Asad | Team already works there. Read-only for the system. |
| Supabase Storage, private bucket `social-media` | One copy of each asset used by a post, plus revision uploads from the CRM | Stable, fast, S3-compatible; signed URLs for Instagram; bytes for TikTok/YouTube/LinkedIn uploads. |
| Supabase Postgres (lp\_backend, Prisma) | Posts, revisions, approvals, attempts, notifications, metrics | Single source of truth for status. |

**Why not publish from Drive:** large-file downloads hit Drive's virus-scan page, Drive links are not stable public URLs, files get renamed or moved (breaking matches), and Drive has its own rate limits.

**Migration-ready rules (mandatory):**

1. Store only `storage_provider`, `bucket` and `object_key` in the DB — never a full URL. URLs are generated at runtime.
2. All file access goes through one `StorageService` interface in lp\_backend (`put`, `get`, `signedUrl`, `delete`). Supabase is the first implementation; any S3 (AWS, Cloudflare R2, Wasabi) is a drop-in second one.
3. Object key format: `media/{yyyy}/{mm}/{asset_uuid}/{sanitised_original_name}`. No user names, no dates that can change.
4. Keep `drive_file_id` and `checksum_md5` on every asset so any file can be traced back to its Drive original.
5. Moving later = `rclone sync` of the bucket + `pg_dump` of the DB + change two env vars. No data rewrite.

**Retention:** keep media 90 days after the last linked post is published, then a nightly job deletes the Storage object (Drive keeps the original). Configurable via `MEDIA_RETENTION_DAYS`; set to 0 to keep forever.

**n8n binary data:** set `N8N_DEFAULT_BINARY_DATA_MODE=filesystem` so large videos do not live in n8n memory.

## 4. Drive folder structure and file matching

The automation reads only `07_Social_media`, and finds a post's files by path: platform folder → type folder → date folder (`YYYY-MM-DD` = publish date). It never matches on file names alone and never moves, renames or deletes anything in Drive.

**Sources**

| Source | Link | ID |
| --- | --- | --- |
| Drive root `Social-CRM-Automation` | [open](https://drive.google.com/drive/folders/177ptcsSWKiBveriapQmPo1KQwFhsi44C) | `177ptcsSWKiBveriapQmPo1KQwFhsi44C` |
| Content calendar | [open](https://docs.google.com/spreadsheets/d/1eb9XK1hvhX-ABd4nHjpmMBdtTH6cmMgL/edit?gid=100004992#gid=100004992) | `1eb9XK1hvhX-ABd4nHjpmMBdtTH6cmMgL` |

**Calendar file format — check first.** The governance folder holds `Master_Content_Calendar_Social_Grid.xlsx`. If the link above is that Excel file opened in Sheets (not a native Google Sheet), the Sheets API cannot read it. Recommended: convert it once (File → Save as Google Sheets) and let the team work in the native sheet. Support both anyway via `CALENDAR_SOURCE=gsheet|xlsx`: for `xlsx`, n8n downloads the file with the Drive API and parses it with the Extract From File node.

**Access:** share the root folder and the calendar with the n8n Google service account as Viewer. Nothing needs write access.

**Folder tree the automation scans** (files shown are real examples):

```text
07_Social_media/
├── 01_Linkedin/
│   ├── 01_Quotes/{date}/              Founder Reality.jpg + Captions.docx
│   ├── 02_Poster/{date}/              The Busy Company.jpg + Post 15 – The Busy Company.docx
│   ├── 03_Video/{date}/               Video Discipline 4.mp4 + Captions.docx
│   └── 04_Newsletter_Article/{date}/  15.The Busy Company.docx (article) + The Busy Company.jpg (cover)
├── 02_Instagram/
│   ├── 01_Video/{date}/               Video Mindset 4.mp4 + Captions.docx
│   └── 02_Photo/{date}/               10.jpg + Captions.docx
│                                      or 01_Carousels/01.jpg … 06.jpg + Captions.docx
├── 03_Youtube/{date}/                 Video Mindset 4.mp4 + Thumbnail.png + Captions.docx
└── 04_Tiktok/{date}/                  Dutch TikToks 2026-169 (Patronen 17).mov + Caption.docx
```

The automation does not scan the other top-level folders (`00_` to `06_`, `_Needs_Revision`, `_Published_Archive`). One exception: `00_Governance_And_Schedules/Channel_Tone_And_System_Prompts_Reference.docx` is read once a day and used as the Gemini system prompt per channel. Revisions happen in the CRM, so `_Needs_Revision` and `_Published_Archive` are not needed by the system. The team can keep using them by hand.

**Folder → post mapping** (store it as a `FolderRule` config table so new folders need no code change):

| Drive path under `07_Social_media` | Platform | Post kind | Mode | Expected files |
| --- | --- | --- | --- | --- |
| `01_Linkedin/01_Quotes/{date}` | LinkedIn | Image | AUTO | 1 image + caption |
| `01_Linkedin/02_Poster/{date}` | LinkedIn | Image | AUTO | 1 image + caption |
| `01_Linkedin/03_Video/{date}` | LinkedIn | Video | AUTO | 1 video + caption |
| `01_Linkedin/04_Newsletter_Article/{date}` | LinkedIn newsletter | Article | MANUAL | article .docx + cover image, both attached to the reminder |
| `02_Instagram/01_Video/{date}` | Instagram | Reel | AUTO | 1 video + caption |
| `02_Instagram/02_Photo/{date}` | Instagram | Image, or Carousel if a subfolder of images exists (e.g. `01_Carousels`) | AUTO | 1 image, or 2–10 images sorted by file name |
| `03_Youtube/{date}` | YouTube | Video | AUTO | 1 video + caption + optional `Thumbnail.png/.jpg` |
| `04_Tiktok/{date}` | TikTok (Dutch account) | Video | AUTO | 1 video (.mov/.mp4) + caption |

**Matching rules (run in lp\_backend; n8n only sends the folder listing):**

1. Calendar row → `date` (in `CALENDAR_TZ`, formatted `YYYY-MM-DD`) + channel → platform folder + column D type → type folder (via an alias table, e.g. "Quote" → `01_Quotes`, "Poster" → `02_Poster`, "Reel" → `01_Video`). YouTube and TikTok have no type level.
2. Date folder missing → BLOCKED "folder missing". Re-checked every ingest.
3. Classify files by MIME type, not by name. Video = `video/*` (mp4, mov). Image = `image/*` (jpg, png). Caption = `.docx` or Google Doc. Thumbnail = name starts with "thumbnail" (YouTube only). A subfolder full of images = carousel.
4. Exactly one video or image, or one carousel subfolder → use it. Several media files in one date folder → pick the one whose normalised name contains column E's subject. Still more than one → BLOCKED "ambiguous" with candidates, and the editor picks one in the CRM.
5. Caption file: exactly one .docx → it is the caption, whatever its name (`Caption.docx`, `Captions.docx`, `POSTER 02.docx`, `Post 15 – The Busy Company.docx`). Several .docx → use the one whose name starts with "caption"; otherwise BLOCKED "ambiguous caption". No .docx → caption comes from the calendar/Gemini and is flagged for the editor.
6. Caption text is extracted in the backend (`mammoth` for .docx; Drive export to text for Google Docs). The .docx is uploaded and stored like media, with role `CAPTION_SOURCE`.
7. Normalise names to Unicode NFC (handles `–`, spaces, brackets). Storage object keys use a sanitised copy; the original name stays in the DB.
8. The same image is often a separate Drive file per platform (e.g. `Founder Reality.jpg` in LinkedIn `2026-11-02` and Instagram `2026-11-06`). Reuse the stored object when `checksumMd5` matches, so it is stored once.
9. Change detection: compare each file's `md5Checksum` and `modifiedTime` on every ingest. A changed or added file in the folder of an APPROVED post sends it back to PENDING\_REVIEW.
10. A date folder with no matching calendar row in the window → digest warning "folder without calendar row". It is never published on its own.
11. Video container: .mov is accepted by TikTok and Instagram. The LinkedIn and YouTube adapters validate .mov too. A platform rejection → INVALID with the reason. There is no auto-transcoding in v1 (see open questions).

## 5. Database schema and status machine

One calendar row = one `ContentItem`. One ContentItem × one channel = one `Post` ("LinkedIn & YouTube" becomes 2 posts). Media is stored once and shared via `PostMedia`. All times are stored in UTC. Adapt names to lp\_backend's existing conventions (e.g. reuse its `User` table).

```prisma
enum Platform { LINKEDIN INSTAGRAM YOUTUBE TIKTOK X MEDIUM LINKEDIN_NEWSLETTER INSPO WEBSITE }
enum PublishMode { AUTO MANUAL }
enum PostStatus {
  BLOCKED            // missing/ambiguous file, invalid spec, unknown channel
  PENDING_REVIEW     // waiting for Lionel
  CHANGES_REQUESTED  // Lionel asked for edits
  APPROVED           // ready; publisher picks it up at scheduledAt
  PUBLISHING         // locked by publisher
  PROCESSING         // platform still processing (IG container, TikTok, YouTube)
  PUBLISHED
  FAILED             // retries exhausted or non-retryable error
  MISSED             // approved too late (past grace window)
  REJECTED           // Lionel: do not publish
  SKIPPED            // calendar says "No video posted" etc.
  CANCELLED          // row removed/changed before publish
  MANUAL_DONE        // manual channel confirmed done in CRM
}
enum MediaStatus { PENDING_UPLOAD READY INVALID }
enum ReviewAction { SUBMITTED APPROVED CHANGES_REQUESTED REJECTED COMMENT RESUBMITTED }

model SocialAccount {
  id             String   @id @default(uuid())
  platform       Platform
  label          String   // "LinkedIn Lionel personal", "TikTok NL"
  externalId     String   // person URN, org URN, IG user id, channel id, open_id
  tokenEncrypted String?  // AES-GCM with key from env
  refreshEncrypted String?
  tokenExpiresAt DateTime?
  isActive       Boolean  @default(true)
  posts          Post[]
}

model ChannelAlias {      // maps calendar text -> account; editable by admin
  id        String @id @default(uuid())
  alias     String @unique  // normalised, e.g. "tiktok nl", "linkedin"
  platform  Platform
  accountId String?          // null for MANUAL channels
  mode      PublishMode
}

model ContentItem {
  id            String   @id @default(uuid())
  sheetId       String
  sheetTab      String
  rowNumber     Int
  rowKey        String   @unique // sha256(sheetId|tab|date|time|channelRaw|subjectNormalised)
  rowHash       String   // sha256 of all cell values; detects edits
  scheduledAt   DateTime // UTC, from calendar date+time in CALENDAR_TZ
  channelRaw    String
  contentType   String?
  subject       String?
  fileLocation  String?
  rawRow        Json
  category      String?  // Founder Pressure, Leadership, ... (for analytics)
  lastSeenAt    DateTime
  posts         Post[]
}

model Post {
  id              String     @id @default(uuid())
  contentItemId   String
  accountId       String?
  platform        Platform
  mode            PublishMode
  status          PostStatus
  blockedReason   String?
  scheduledAt     DateTime
  title           String?    // YouTube title
  caption         String?
  hashtags        String[]
  options         Json       // playlistId, privacy, tiktok flags, IG mediaType (REELS/CAROUSEL/IMAGE)
  captionSource   String?    // DRIVE_FILE | CALENDAR | GEMINI
  revision        Int        @default(1)
  approvedById    String?
  approvedAt      DateTime?
  attemptCount    Int        @default(0)
  nextAttemptAt   DateTime?
  lockedAt        DateTime?
  lockedBy        String?
  platformPostId  String?
  platformUrl     String?
  processingRef   String?    // IG container id / TikTok publish_id
  publishedAt     DateTime?
  lastError       String?
  idempotencyKey  String     @unique // contentItemId|platform|accountId
  createdAt       DateTime   @default(now())
  updatedAt       DateTime   @updatedAt
  @@index([status, scheduledAt])
}

model MediaAsset {
  id            String      @id @default(uuid())
  driveFileId   String
  checksumMd5   String
  fileName      String
  mimeType      String
  sizeBytes     BigInt
  durationSec   Float?
  width         Int?
  height        Int?
  storageProvider String    @default("supabase")
  bucket        String
  objectKey     String?
  status        MediaStatus
  invalidReason String?
  deleteAfter   DateTime?
  @@unique([driveFileId, checksumMd5])
}

model PostMedia {           // ordered; supports carousels + custom thumbnail
  postId    String
  assetId   String
  position  Int
  role      String  // MAIN | THUMBNAIL | COVER
  revision  Int
  @@id([postId, assetId, role, revision])
}

model PostRevision { id String @id @default(uuid()) postId String revision Int caption String? title String? mediaSnapshot Json createdById String? createdAt DateTime @default(now()) }
model ReviewEvent  { id String @id @default(uuid()) postId String revision Int action ReviewAction comment String? actorId String createdAt DateTime @default(now()) }
model PublishAttempt { id String @id @default(uuid()) postId String attemptNo Int startedAt DateTime finishedAt DateTime? httpStatus Int? errorCode String? response Json? }
model Notification { id String @id @default(uuid()) type String postId String? recipients String[] subject String body String dedupeKey String @unique status String @default("PENDING") sentAt DateTime? error String? createdAt DateTime @default(now()) }
model JobRun { id String @id @default(uuid()) workflow String startedAt DateTime finishedAt DateTime? stats Json? error String? }

// Phase 3, create table now (cheap) so history starts accumulating later:
model PostMetricSnapshot { id String @id @default(uuid()) postId String capturedAt DateTime views Int? reach Int? impressions Int? likes Int? comments Int? shares Int? saves Int? raw Json? }
```

**Status transitions (the only allowed ones — enforce in one `transition()` function):**

| From | Event | To |
| --- | --- | --- |
| (new) | Ingest, file found + valid | PENDING\_REVIEW |
| (new) | Ingest, file missing / ambiguous / invalid / unknown channel | BLOCKED |
| (new) | Calendar says "No video posted" / "Geen post online gegaan" / "No post scheduled" | SKIPPED |
| BLOCKED | Next ingest finds file, or editor fixes in CRM | PENDING\_REVIEW |
| PENDING\_REVIEW | Lionel approves | APPROVED |
| PENDING\_REVIEW | Lionel requests changes (comment required) | CHANGES\_REQUESTED |
| PENDING\_REVIEW | Lionel rejects (comment required) | REJECTED |
| CHANGES\_REQUESTED | Editor saves + resubmits (revision +1) | PENDING\_REVIEW |
| APPROVED | Editor edits caption/media | PENDING\_REVIEW (revision +1, approval cleared) |
| APPROVED | now ≥ scheduledAt and ≤ scheduledAt + grace | PUBLISHING |
| APPROVED / PENDING\_REVIEW | now > scheduledAt + grace | MISSED |
| MISSED | Editor sets a new time | PENDING\_REVIEW if content changed, else APPROVED |
| PUBLISHING | API accepted, async | PROCESSING |
| PUBLISHING / PROCESSING | Success | PUBLISHED |
| PUBLISHING / PROCESSING | Retryable error, attempts < 3 | APPROVED with nextAttemptAt (1m, 5m, 15m) |
| PUBLISHING / PROCESSING | Non-retryable or attempts = 3 | FAILED |
| FAILED | Admin clicks Retry | APPROVED |
| any non-final | Calendar row deleted | CANCELLED |
| APPROVED (MANUAL mode) | Reminder sent; editor ticks done + pastes URL | MANUAL\_DONE |

Final states: PUBLISHED, REJECTED, SKIPPED, CANCELLED, MANUAL\_DONE. Every transition writes a `ReviewEvent` or `PublishAttempt` row (audit trail).

## 6. n8n workflows

Five workflows. n8n is the clock and the Google/Gemini glue; every decision and every state change happens in lp\_backend through `/internal/*` endpoints (auth: `X-Internal-Key` header, IP-restricted). Each workflow starts by calling `POST /internal/job-runs/start` and ends with `/finish` so failures are visible.

### WF1 — Daily Ingest (every day 07:00 Europe/Amsterdam; also manual "Run now" button in CRM)

1. **Load the calendar.** `CALENDAR_SOURCE=gsheet`: list the tabs with the Sheets API. `xlsx`: download the file via the Drive API and parse every sheet with Extract From File. Select `Content calendar <Month> <Year>` for the current and next month (this covers boundary weeks). If the next-month tab is missing, continue and add a warning to the digest.
2. **Read rows** as unformatted values (dates come as serial numbers). Columns: A date, B time, C channel, D type, E subject/file name, F file location / note, G status.
3. **Filter noise:** skip rows where A is not a valid date (week banners, repeated headers, blank rows).
4. **Window:** keep rows where the date is between today and today + `LOOKAHEAD_DAYS` (default 14). Ignore rows already in the past unless the backend already knows them.
5. **Normalise:** convert the serial date + time in `CALENDAR_TZ` (Europe/Amsterdam, DST-aware) to UTC. Trim and lowercase the channel. Split multi-channel cells on `&`, `,`, `/`, `+`.
6. **Send rows** (no files yet) to `POST /internal/ingest/rows` with `sheetId, tab, rowNumber, cells, rowKey, rowHash`. The backend upserts ContentItems/Posts, applies channel and type aliases, and marks SKIPPED/CANCELLED rows. For each post that needs files, it returns the Drive path to look in, e.g. `07_Social_media/01_Linkedin/03_Video/2026-11-09`.
7. **List the folder in Drive.** Resolve the path from `DRIVE_ROOT_FOLDER_ID` one level at a time, caching folder IDs for the run. List the date folder and any subfolder one level down. Fields: `id, name, mimeType, md5Checksum, size, modifiedTime, parents`. Send the listing to `POST /internal/ingest/folder-listing` (path not found = empty listing). The backend applies the matching rules in section 4. It answers with the files to use, plus a signed upload URL for any file not yet stored (dedupe by md5), or a BLOCKED reason.
8. **Upload** only what the backend asked for (media, caption .docx, thumbnail, carousel images). Download from Drive (binary data in filesystem mode), PUT to the signed URL, then `POST /internal/media/{id}/complete`. The backend probes media with ffprobe (duration, width, height, codec) and validates it against platform rules → READY or INVALID. It extracts caption text from the .docx.
9. **Gemini**, for each post whose media is READY and has no approved caption yet. Send: platform, type, subject, the extracted caption text, and that channel's section of `Channel_Tone_And_System_Prompts_Reference.docx` as the system prompt. Ask for strict JSON `{title, caption, hashtags[], category}` using `responseSchema`. Prompt rules:
   - When a caption file exists, keep Lionel's wording. Only pick the right platform section, format it, and trim it to the platform limit.
   - Never add facts. Never use the word "coach".
   - Use Dutch for the TikTok account.
   - Category is one of: Founder Pressure, Leadership, Business, Vitality, Personal Development, Cases, Personal Stories.
10. **Save the draft** via `POST /internal/posts/{id}/draft`. The backend validates lengths again. If Gemini fails, it stores the caption-file text as-is with `captionSource=DRIVE_FILE`, or the calendar text with `CALENDAR`, and flags the post. Status becomes PENDING\_REVIEW and a REVIEW\_REQUEST notification is queued (one grouped email per run).

### WF2 — Publisher (every 5 minutes)

1. `POST /internal/publisher/run` — the backend does the work (below) and returns a summary. n8n only logs it.
2. Backend logic: release locks older than 15 min → select posts `status=APPROVED AND mode=AUTO AND scheduledAt <= now() AND (nextAttemptAt IS NULL OR nextAttemptAt <= now())` with `FOR UPDATE SKIP LOCKED LIMIT 10` → set PUBLISHING → call the platform adapter → PROCESSING / PUBLISHED / retry / FAILED.
3. Same run also polls every PROCESSING post (IG container status, TikTok `status/fetch`, YouTube `processingDetails`) and finalises it.
4. Same run moves overdue APPROVED/PENDING\_REVIEW posts to MISSED (grace `PUBLISH_GRACE_MINUTES`, default 120).
5. Same run sends MANUAL-mode posts' reminder at scheduledAt (queues MANUAL\_TASK\_DUE notification).

### WF3 — Notifier (every minute)

`GET /internal/notifications?status=PENDING&limit=50` → send each via the email node (SMTP/Gmail from `info@leadersperformance.ae` or a no-reply address) → `POST /internal/notifications/{id}/sent` or `/failed`. Retry failed sends 3 times. All emails come from this one workflow, so templates live in one place.

### WF4 — Daily Digest & Reminders (every day 08:00 Europe/Amsterdam)

`GET /internal/digest` returns: BLOCKED posts in the next 14 days (missing file, ambiguous match, invalid spec, unknown channel), posts still PENDING\_REVIEW within 48h of their slot, FAILED/MISSED posts, accounts whose token expires within 7 days, warnings from ingest. Send one digest email to Sarath, Asad and Asif. Posts BLOCKED with less than 7 days left are flagged "URGENT" at the top. Approval reminder to Lionel: one email listing posts pending within 24h; a second at 6h before the slot (`APPROVAL_SLA` notification, deduped per post).

### WF5 — Nightly Maintenance (every day 02:00)

`POST /internal/maintenance/run`: refresh tokens that expire within 10 days, delete Storage objects past `deleteAfter`, mark ContentItems not seen in the sheet for 2 ingests as removed (→ CANCELLED if not published), prune JobRun rows older than 90 days.

## 7. lp\_backend: APIs, publish adapters, CRM screens

**Internal endpoints (n8n only):**

| Method + path | Purpose |
| --- | --- |
| `POST /internal/job-runs/start`, `/finish` | Job logging |
| `POST /internal/ingest/rows` | Upsert ContentItems + Posts; return assets needed |
| `POST /internal/ingest/folder-listing` | Apply the folder rules (section 4), dedupe by md5, return files to use + signed upload URLs, or a BLOCKED reason |
| `POST /internal/media/{id}/complete` | Probe + validate → READY / INVALID; attach to posts |
| `POST /internal/posts/{id}/draft` | Save Gemini output, move to PENDING\_REVIEW |
| `POST /internal/publisher/run` | Publish due posts, poll PROCESSING, mark MISSED, manual reminders |
| `GET /internal/notifications`, `POST /internal/notifications/{id}/sent\|failed` | Email outbox |
| `GET /internal/digest` | Data for WF4 |
| `POST /internal/maintenance/run` | WF5 |

**CRM endpoints (logged-in users, role-checked):** `GET /posts` (filters: status, platform, date range), `GET /posts/{id}`, `PATCH /posts/{id}` (editor: caption, title, hashtags, options, scheduledAt), `POST /posts/{id}/media` (editor uploads replacement file straight to Storage), `POST /posts/{id}/submit`, `POST /posts/{id}/approve`, `POST /posts/{id}/request-changes` (comment required), `POST /posts/{id}/reject` (comment required), `POST /posts/{id}/comments`, `POST /posts/{id}/retry` (admin), `POST /posts/{id}/publish-now` (approver/admin), `POST /posts/{id}/manual-done` (url required), `GET/POST /accounts` + OAuth connect callbacks (admin), `POST /ingest/run-now` (admin; calls the n8n webhook).

**Publish adapters** — one class per platform implementing `publish(post) → {state: PUBLISHED|PROCESSING, platformPostId?, url?, processingRef?}`, `poll(post)`, `refreshToken(account)`. Errors are thrown as `RetryableError` (429, 5xx, timeouts, IG container IN\_PROGRESS too long) or `FatalError` (400 validation, 401 after refresh fails, 403 permission, spec rejected).

| Adapter | Flow |
| --- | --- |
| LinkedIn | Upload image(s) via Images API or video via chunked Videos API → wait for AVAILABLE → `POST /rest/posts` with `author` = person or organization URN. Send `Linkedin-Version` header. |
| Instagram | Check `content_publishing_limit` → create container(s) with a Storage signed URL valid 24h (REELS for video, CAROUSEL with children, IMAGE) → return PROCESSING → poll `status_code` until FINISHED → `media_publish` → fetch permalink. |
| YouTube | Resumable `videos.insert` with title, description, tags, `privacyStatus=private`, `publishAt` = scheduledAt (YouTube publishes at the exact time) → `playlistItems.insert` if `options.playlistId` → `thumbnails.set` if a THUMBNAIL asset exists. Upload may run early (as soon as APPROVED) because YouTube does the timing. |
| TikTok | `creator_info/query` (privacy options, max duration) → `video/init` with FILE\_UPLOAD, `privacy_level` from options (must be in the returned list) → chunked PUT → PROCESSING → poll `status/fetch` until PUBLISH\_COMPLETE. |

**Idempotency:** before calling any platform, check `platformPostId` is empty and write a `PublishAttempt` row. If a run crashes after the platform accepted the post, the poll step finds it by `processingRef`; never re-post a post that has a `processingRef` without checking its status first.

**Social CRM screens (keep to these five):**

1. **Review queue** — list of PENDING\_REVIEW posts by date, with platform badge and time left.
2. **Post detail** — platform-style preview (media player/carousel, caption with character count, scheduled time in Europe/Amsterdam and Asia/Dubai), revision history with diff, comment thread, and buttons by role: Approve / Request changes / Reject (Lionel); Edit / Replace media / Resubmit (editors); Retry / Publish now (admin).
3. **Calendar view** — month grid with status colours; click opens Post detail.
4. **Blocked & failed** — everything BLOCKED, FAILED, MISSED with the reason and a fix action (pick the right Drive file from candidates, re-time, retry).
5. **Accounts & settings** (admin) — connected accounts, token expiry, channel aliases, env-backed settings shown read-only.

Email links go to `CRM_BASE_URL/posts/{id}`. Not logged in → login → redirect back to the post. No approve-by-email-click (avoids accidental approvals from link scanners).

## 8. Approval and revision loop, emails

The loop repeats until Lionel approves or rejects; every round is a new revision, so nothing is overwritten.

1. Ingest stages a post → PENDING\_REVIEW → daily review email to Lionel (cc Sarath, Asad, Asif) with one link per post.
2. Lionel opens the link → Post detail in the CRM → Approve, Request changes, or Reject. Request changes and Reject need a comment.
3. Request changes → CHANGES\_REQUESTED → email to Sarath, Asad, Asif with Lionel's comment and the link.
4. Editor opens the link, edits caption/title/media, clicks Resubmit → revision +1 → PENDING\_REVIEW → "Revision ready" email to Lionel showing what changed.
5. Repeat from step 2. Approve → APPROVED → publisher posts it at the scheduled time.
6. Any edit to an APPROVED post sends it back to PENDING\_REVIEW (Lionel always approves the exact version that goes live).

**Email matrix** (all through the WF3 outbox; recipients configurable in env; deduped by `dedupeKey`):

| Event | To | Cc | When |
| --- | --- | --- | --- |
| REVIEW\_REQUEST (new posts to review) | Lionel | Sarath, Asad, Asif | Once per ingest run, grouped |
| REVISION\_READY | Lionel | Sarath, Asad, Asif | Immediately on resubmit |
| CHANGES\_REQUESTED / REJECTED | Sarath, Asad | Asif | Immediately |
| APPROVED | Sarath, Asad | Asif | Immediately |
| APPROVAL\_SLA (pending, slot in < 24h, then < 6h) | Lionel | Sarath, Asad | Max 2 per post |
| PUBLISHED | Sarath, Asad | Asif | Immediately, with live URL |
| PUBLISH\_FAILED (final) / MISSED | Sarath, Asad, Asif | — | Immediately, with reason + Retry link |
| MANUAL\_TASK\_DUE (Medium, newsletter, INSPO) | Sarath, Asad | Asif | At scheduled time, with content + checklist |
| DAILY\_DIGEST (blocked, urgent, expiring tokens) | Sarath, Asad, Asif | — | 08:00 daily, only if non-empty |
| TOKEN\_EXPIRING / ACCOUNT\_DISCONNECTED | Asif | — | 7 days before, and on 401 |
| JOB\_FAILED (n8n workflow error) | Asif | — | n8n Error Trigger workflow |

Each email: plain subject (`[Approval] LinkedIn · Tue 11 Nov 09:00 CET · Founder Bottleneck`), 3–5 lines, one button to the CRM. Times shown in Europe/Amsterdam and Asia/Dubai.

## 9. Edge cases (each needs a test)

| # | Case | Handling |
| --- | --- | --- |
| 1 | Week banner, repeated header, blank row | Skipped at filter step (A not a date) |
| 2 | Date as Excel serial vs text | Read UNFORMATTED\_VALUE; parse serial; text dates parsed with `dd-mm-yyyy` fallback; unparseable → digest warning |
| 3 | Time cell empty | Use `DEFAULT_POST_TIME` per platform (config); flag in post detail |
| 4 | Week spans two months (e.g. Nov 28–Dec 4) | Read current + next month tabs; `rowKey` excludes tab name's month so the same row in two tabs is one item |
| 5 | Same row ingested again tomorrow | `rowKey` unique → update, never duplicate |
| 6 | Row edited after staging (time, caption, file) | `rowHash` changed → if not published: update fields; if it was APPROVED → back to PENDING\_REVIEW + email |
| 7 | Row deleted from sheet | After 2 ingests unseen → CANCELLED (if not published) + email |
| 8 | "LinkedIn & YouTube", "Website " (trailing space), unknown channel | Split + trim; unknown → BLOCKED "unknown channel", admin adds a ChannelAlias |
| 9 | "No video posted", "Geen post online gegaan", "No post scheduled" | SKIPPED, no alert |
| 10 | File not yet in Drive | BLOCKED; re-checked every ingest; digest; URGENT when < 7 days |
| 11 | Several files match the name | BLOCKED "ambiguous" with candidates; editor picks one in CRM |
| 12 | Same file used by several rows/channels | One MediaAsset (`driveFileId+md5`), uploaded once |
| 13 | File replaced in Drive with same name | md5 changes → new asset; if post was APPROVED → back to review |
| 14 | Wrong aspect ratio / too long / too large / bad codec | INVALID with exact reason → BLOCKED; no auto-transcoding in v1 |
| 15 | Carousel with more images than platform allows | BLOCKED with reason (do not silently drop slides) |
| 16 | Gemini down, timeout, bad JSON, over-length | Retry once; then use calendar/caption-file text, `captionSource=CALENDAR`, flag for editor |
| 17 | Lionel approves after the slot | Within grace (120 min) → publish immediately; later → MISSED + email to pick a new time |
| 18 | Edit after approval | Back to PENDING\_REVIEW, new revision |
| 19 | Two publisher runs overlap | `FOR UPDATE SKIP LOCKED` + `lockedAt`; stale locks released after 15 min |
| 20 | Crash after platform accepted the post | Poll by `processingRef`; never re-post blindly |
| 21 | 429 / 5xx / timeout | Retry at 1, 5, 15 min; then FAILED + email |
| 22 | 401 token expired | Refresh once and retry; refresh fails → account inactive, all its due posts FAILED with "reconnect account", email Asif |
| 23 | Instagram daily cap reached | Check limit first; if reached → nextAttemptAt = +60 min, email if it causes MISSED |
| 24 | IG container stuck IN\_PROGRESS or EXPIRED | Poll up to 30 min; EXPIRED → recreate container once, then FAILED |
| 25 | TikTok app not yet audited | Adapter refuses public posting and marks FAILED "TikTok audit pending" (config flag `TIKTOK_AUDITED=false`) — never post private silently |
| 26 | YouTube quota exceeded | Retry next day window; email Asif |
| 27 | DST change (last Sunday of March/October) | Convert with IANA zone, never fixed offsets |
| 28 | Email send fails | Notification stays PENDING, retried 3 times, then FAILED and visible in admin |
| 29 | Duplicate emails | `dedupeKey` (type + postId + revision + window) unique |
| 30 | Manual channel not done | Second reminder 24h later; stays APPROVED until marked done |

## 10. Delivery plan, config, open questions

**Build order** (each step is shippable and testable on its own):

1. **Foundation** — Prisma schema + migration, `transition()` with unit tests, StorageService, internal-key auth, JobRun logging.
2. **Ingest** — WF1 steps 1–9 + backend ingest/media endpoints. Done when: a copy of the real calendar produces correct Posts, SKIPPED rows and BLOCKED reasons, and running it twice changes nothing.
3. **Review loop** — Gemini step, CRM screens 1, 2, 4, WF3 notifier, review emails. Done when: approve, request changes, resubmit and reject all work end to end with emails.
4. **Publishing** — adapters in this order: YouTube → LinkedIn → Instagram → TikTok; WF2. Done when: each adapter has published a real test post to a test/private account, and a forced 500 shows retry then FAILED email.
5. **Hardening** — WF4 digest, WF5 maintenance, calendar view, accounts screen, manual-channel reminders, n8n Error Trigger workflow.
6. **Parallel run** — one week with GHL still live; compare. Then switch GHL off.

Phase 2: X/Twitter adapter (paid API tier needed). Phase 3: daily `PostMetricSnapshot` collection to feed the Monday analytics report (the snapshots make the carry-over / long-tail analysis possible), plus content-stock alerts.

**Environment variables:**

| Variable | Example / default |
| --- | --- |
| `CALENDAR_SHEET_ID` | `1eb9XK1hvhX-ABd4nHjpmMBdtTH6cmMgL` (new ID if converted to a Google Sheet); plus `CALENDAR_SOURCE` = `gsheet` or `xlsx` |
| `CALENDAR_TZ` | `Europe/Amsterdam` |
| `DRIVE_ROOT_FOLDER_ID` | `177ptcsSWKiBveriapQmPo1KQwFhsi44C`; plus SOCIAL\_FOLDER\_NAME = 07\_Social\_media |
| `LOOKAHEAD_DAYS` | `14` |
| `PUBLISH_GRACE_MINUTES` | `120` |
| `MAX_PUBLISH_ATTEMPTS` | `3` |
| `MEDIA_RETENTION_DAYS` | `90` |
| `STORAGE_PROVIDER`, `STORAGE_BUCKET` | `supabase`, `social-media` |
| `CRM_BASE_URL` | Social CRM URL |
| `INTERNAL_API_KEY`, `TOKEN_ENCRYPTION_KEY` | secrets |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | model name kept in env |
| `EMAIL_APPROVER`, `EMAIL_EDITORS`, `EMAIL_ADMIN` | Lionel; Sarath, Asad; Asif |
| `TIKTOK_AUDITED` | `false` until audit passes |

**Rules for the implementing agent:** no secrets in code or n8n workflow JSON (use n8n credentials + env); every external call has a timeout; every list endpoint is paginated; log `postId` on every line; export n8n workflows as JSON into the repo.

**Open questions (answer before step 2):**

- [ ] Folder structure is settled (section 4). Still open: which exact values does calendar column D (type) use, so each one maps to a type folder (Quote, Poster, Video, Newsletter, Reel, Photo, Carousel)?
- [ ] Captions come from the .docx in each date folder. Still open: does one Captions.docx ever hold several platform versions, and may Gemini only format and trim, never rewrite?
- [ ] Which LinkedIn targets: Lionel's personal profile, the company page (org 18948042), or both per row?
- [ ] Which YouTube playlist goes with which content type (mapping table)?
- [ ] Default post time per platform when the calendar has no time.
- [ ] Is the X/Twitter twice-daily posting needed in v1 or Phase 2?
- [ ] Is the calendar link a native Google Sheet or the .xlsx file? Convert it to a Google Sheet (recommended)?
- [ ] Add ffmpeg transcoding (.mov → .mp4, wrong aspect ratio) in v1, or block invalid files and let Sarath re-export?
