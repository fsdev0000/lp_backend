import { createHash } from 'crypto';
import { normalizeFileNameNfc } from '../storage/storage.service';

export const DEFAULT_CALENDAR_TZ = 'Europe/Amsterdam';

// TODO (Plan Section 12 Open Question #3): Confirm exact default post times per channel with the team.
// Can be overridden via env var DEFAULT_POST_TIME_BY_PLATFORM (JSON or "LINKEDIN=09:00,INSTAGRAM=12:00,...").
export const DEFAULT_POST_TIMES_BY_CHANNEL: Record<string, string> = {
  LINKEDIN: '09:00',
  LINKEDIN_NEWSLETTER: '09:00',
  INSTAGRAM: '12:00',
  YOUTUBE: '15:00',
  TIKTOK: '18:00',
  MEDIUM: '10:00',
  INSPO: '11:00',
  WEBSITE: '09:00',
  X: '10:00',
  DEFAULT: '09:00',
};

export function getDefaultPostTimeForChannel(channelKey: string): string {
  const upperKey = (channelKey || '').trim().toUpperCase();
  const rawEnv = (process.env.DEFAULT_POST_TIME_BY_PLATFORM || '').trim();
  if (rawEnv) {
    try {
      if (rawEnv.startsWith('{')) {
        const parsed = JSON.parse(rawEnv) as Record<string, string>;
        if (parsed[upperKey]) return String(parsed[upperKey]).trim();
        if (parsed.DEFAULT) return String(parsed.DEFAULT).trim();
      } else {
        for (const pair of rawEnv.split(',')) {
          const [k, v] = pair.split('=').map((s) => s.trim());
          if (k && v && k.toUpperCase() === upperKey) {
            return v;
          }
        }
      }
    } catch {
      // Fall back to DEFAULT_POST_TIMES_BY_CHANNEL if env format is invalid
    }
  }
  return DEFAULT_POST_TIMES_BY_CHANNEL[upperKey] || DEFAULT_POST_TIMES_BY_CHANNEL.DEFAULT;
}

const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

const SHORT_MONTH_MAP: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  mrt: 3,
  apr: 4,
  may: 5,
  mei: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  okt: 10,
  nov: 11,
  dec: 12,
};

/**
 * Normalises text for deterministic matching and hashing (Unicode NFC, collapsed spaces, lowercase).
 */
export function normalizeTextForKey(val: string | null | undefined): string {
  return normalizeFileNameNfc(String(val || ''))
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Checks if a cell in Column A is a known noise row (blank, header, week banner, day-of-week header)
 * rather than a broken date (Edge Case #1 & #2).
 */
export function isCalendarNoiseValue(rawVal: unknown): boolean {
  if (rawVal === null || rawVal === undefined) return true;
  const s = String(rawVal).trim();
  if (!s) return true;
  const lower = s.toLowerCase();
  if (
    lower === 'date' ||
    lower === 'datum' ||
    lower === 'day' ||
    lower === 'publish date' ||
    lower.startsWith('week ') ||
    lower.startsWith('wk ') ||
    lower.startsWith('month') ||
    lower.startsWith('content calendar') ||
    lower.startsWith('master content') ||
    lower.startsWith('total') ||
    lower.startsWith('notes') ||
    /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(lower)
  ) {
    return true;
  }
  return false;
}

/**
 * Parses an Excel serial date number or string date into a `YYYY-MM-DD` string in local calendar date terms.
 * Returns null if unparseable (Edge Case #2).
 */
export function parseCalendarDateToYmd(rawDate: unknown): string | null {
  if (rawDate === null || rawDate === undefined) return null;

  // 1. Excel serial number (e.g. 46328 -> 2026-11-02)
  // Excel epoch is 1899-12-30 UTC (accounting for the 1900 leap year bug).
  if (typeof rawDate === 'number' && Number.isFinite(rawDate)) {
    if (rawDate < 30000 || rawDate > 80000) return null;
    const wholeDays = Math.floor(rawDate + 1e-6);
    const excelEpochMs = Date.UTC(1899, 11, 30);
    const d = new Date(excelEpochMs + wholeDays * 86400 * 1000);
    return d.toISOString().slice(0, 10);
  }

  const s = String(rawDate).trim();
  if (!s) return null;

  // Numeric string representing Excel serial
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const num = Number(s);
    if (num >= 30000 && num <= 80000) {
      const wholeDays = Math.floor(num + 1e-6);
      const excelEpochMs = Date.UTC(1899, 11, 30);
      const d = new Date(excelEpochMs + wholeDays * 86400 * 1000);
      return d.toISOString().slice(0, 10);
    }
  }

  // 2. ISO YYYY-MM-DD or YYYY/MM/DD (with optional timestamp suffix)
  const isoMatch = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s].*)?$/);
  if (isoMatch) {
    const yyyy = Number(isoMatch[1]);
    const mm = Number(isoMatch[2]);
    const dd = Number(isoMatch[3]);
    if (isValidYmd(yyyy, mm, dd)) {
      return formatYmd(yyyy, mm, dd);
    }
    return null;
  }

  // 3. DD-MM-YYYY or DD/MM/YYYY fallback (Edge Case #2)
  const dmyMatch = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (dmyMatch) {
    const dd = Number(dmyMatch[1]);
    const mm = Number(dmyMatch[2]);
    const yyyy = Number(dmyMatch[3]);
    if (isValidYmd(yyyy, mm, dd)) {
      return formatYmd(yyyy, mm, dd);
    }
    return null;
  }

  // 4. Text with month name: "2 Nov 2026", "Nov 2, 2026", "Monday 2 November 2026"
  const cleaned = s.replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*[,\s]+/i, '').trim();
  const dMonY = cleaned.match(/^(\d{1,2})[\s-]+([a-zA-Z]+)[\s,.-]+(\d{4})$/);
  if (dMonY) {
    const dd = Number(dMonY[1]);
    const monKey = dMonY[2].toLowerCase().slice(0, 3);
    const mm = SHORT_MONTH_MAP[monKey];
    const yyyy = Number(dMonY[3]);
    if (mm && isValidYmd(yyyy, mm, dd)) {
      return formatYmd(yyyy, mm, dd);
    }
  }

  const monDY = cleaned.match(/^([a-zA-Z]+)[\s-]+(\d{1,2})[\s,.-]+(\d{4})$/);
  if (monDY) {
    const monKey = monDY[1].toLowerCase().slice(0, 3);
    const mm = SHORT_MONTH_MAP[monKey];
    const dd = Number(monDY[2]);
    const yyyy = Number(monDY[3]);
    if (mm && isValidYmd(yyyy, mm, dd)) {
      return formatYmd(yyyy, mm, dd);
    }
  }

  return null;
}

function isValidYmd(yyyy: number, mm: number, dd: number): boolean {
  if (yyyy < 2020 || yyyy > 2100 || mm < 1 || mm > 12 || dd < 1 || dd > 31) return false;
  const d = new Date(Date.UTC(yyyy, mm - 1, dd));
  return (
    d.getUTCFullYear() === yyyy &&
    d.getUTCMonth() === mm - 1 &&
    d.getUTCDate() === dd
  );
}

function formatYmd(yyyy: number, mm: number, dd: number): string {
  return `${String(yyyy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

/**
 * Parses an Excel time fraction (0.0..1.0) or string time into `HH:mm` (24-hour).
 * Returns null if empty or unparseable.
 */
export function parseCalendarTimeToHhMm(rawTime: unknown): string | null {
  if (rawTime === null || rawTime === undefined) return null;

  if (typeof rawTime === 'number' && Number.isFinite(rawTime)) {
    const frac = rawTime >= 1 ? rawTime - Math.floor(rawTime) : rawTime;
    if (frac >= 0 && frac < 1) {
      const totalMinutes = Math.round(frac * 24 * 60);
      const hh = Math.floor(totalMinutes / 60) % 24;
      const mm = totalMinutes % 60;
      return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    }
  }

  const s = String(rawTime).trim();
  if (!s) return null;

  // Numeric fraction string like "0.375"
  if (/^0\.\d+$/.test(s)) {
    const frac = Number(s);
    const totalMinutes = Math.round(frac * 24 * 60);
    const hh = Math.floor(totalMinutes / 60) % 24;
    const mm = totalMinutes % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  // "09:00", "9:30", "14.00", "09u00", "9:00:00", "9:00 AM", "2:30 PM"
  const m = s.match(/^(\d{1,2})[:.u](\d{2})(?::\d{2})?\s*(am|pm)?$/i);
  if (m) {
    let hh = Number(m[1]);
    const mm = Number(m[2]);
    const ampm = m[3]?.toLowerCase();
    if (mm < 0 || mm > 59) return null;
    if (ampm === 'pm' && hh < 12) hh += 12;
    if (ampm === 'am' && hh === 12) hh = 0;
    if (hh < 0 || hh > 23) return null;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  return null;
}

/**
 * Converts a local `YYYY-MM-DD` and `HH:mm` in an IANA timezone (e.g. `Europe/Amsterdam`)
 * into a UTC `Date` object, accurately handling CET/CEST DST transitions (Edge Case #27).
 */
export function localDateTimeToUtc(
  dateYmd: string,
  timeHhMm: string,
  timeZone: string = DEFAULT_CALENDAR_TZ
): Date {
  const [yyyy, mm, dd] = dateYmd.split('-').map(Number);
  const [hh, min] = timeHhMm.split(':').map(Number);

  // Start with a UTC guess at the same wall-clock components
  const utcGuessMs = Date.UTC(yyyy, mm - 1, dd, hh, min, 0, 0);

  const getWallClockInTz = (epochMs: number) => {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    const parts = dtf.formatToParts(new Date(epochMs));
    const map: Record<string, number> = {};
    for (const p of parts) {
      if (p.type !== 'literal') map[p.type] = Number(p.value);
    }
    return Date.UTC(map.year, map.month - 1, map.day, map.hour, map.minute, map.second || 0);
  };

  // First pass offset adjustment
  const offset1 = getWallClockInTz(utcGuessMs) - utcGuessMs;
  const adjusted1 = utcGuessMs - offset1;
  // Second pass handles exact DST boundary hours cleanly
  const offset2 = getWallClockInTz(adjusted1) - adjusted1;
  return new Date(utcGuessMs - offset2);
}

/**
 * Formats a UTC Date as `YYYY-MM-DD` in the target IANA timezone (`Europe/Amsterdam`).
 */
export function formatDateInCalendarTz(
  date: Date,
  timeZone: string = DEFAULT_CALENDAR_TZ
): string {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return dtf.format(date);
}

/**
 * Adds `days` to a `YYYY-MM-DD` calendar date string.
 */
export function addDaysToYmd(dateYmd: string, days: number): string {
  const [yyyy, mm, dd] = dateYmd.split('-').map(Number);
  const d = new Date(Date.UTC(yyyy, mm - 1, dd + days));
  return d.toISOString().slice(0, 10);
}

/**
 * Computes the expected current and next month tab names (`Content calendar <Month> <Year>`),
 * and matches available tab names case-insensitively (Plan Section 6 Flow 1 Step 1).
 */
export function selectCurrentAndNextMonthTabs(
  availableTabs: string[],
  referenceDate: Date = new Date(),
  timeZone: string = DEFAULT_CALENDAR_TZ
): {
  selectedTabs: string[];
  expectedCurrentTab: string;
  expectedNextTab: string;
  warnings: string[];
} {
  const todayYmd = formatDateInCalendarTz(referenceDate, timeZone);
  const [yyyy, mm] = todayYmd.split('-').map(Number);
  const curMonthName = MONTH_NAMES[mm - 1];
  const nextYear = mm === 12 ? yyyy + 1 : yyyy;
  const nextMonthIdx = mm === 12 ? 0 : mm;
  const nextMonthName = MONTH_NAMES[nextMonthIdx];

  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const expectedCurrentTab = `Content calendar ${capitalize(curMonthName)} ${yyyy}`;
  const expectedNextTab = `Content calendar ${capitalize(nextMonthName)} ${nextYear}`;

  const findTab = (monthName: string, year: number): string | null => {
    const exactLower = `content calendar ${monthName} ${year}`;
    const exact = availableTabs.find((t) => t.trim().toLowerCase() === exactLower);
    if (exact) return exact;
    const partial = availableTabs.find(
      (t) =>
        t.toLowerCase().includes(monthName) && t.toLowerCase().includes(String(year))
    );
    return partial || null;
  };

  const selectedTabs: string[] = [];
  const warnings: string[] = [];

  const curMatch = findTab(curMonthName, yyyy);
  if (curMatch) {
    selectedTabs.push(curMatch);
  } else if (availableTabs.length === 1) {
    // Fallback for single-sheet workbooks
    selectedTabs.push(availableTabs[0]);
  } else {
    warnings.push(`CURRENT_MONTH_TAB_MISSING: Expected "${expectedCurrentTab}"`);
  }

  const nextMatch = findTab(nextMonthName, nextYear);
  if (nextMatch && !selectedTabs.includes(nextMatch)) {
    selectedTabs.push(nextMatch);
  } else if (!nextMatch) {
    warnings.push(`NEXT_MONTH_TAB_MISSING: Expected "${expectedNextTab}"`);
  }

  return { selectedTabs, expectedCurrentTab, expectedNextTab, warnings };
}

/**
 * Splits a multi-channel cell like `"LinkedIn & YouTube"`, `"Instagram / LinkedIn"`,
 * `"LinkedIn, YouTube"`, or `"LinkedIn + TikTok"` into trimmed channel tokens (Edge Case #8).
 */
export function splitChannelsCell(channelRaw: string): string[] {
  const raw = String(channelRaw || '').trim();
  if (!raw) return [];
  return raw
    .split(/\s*(?:&|\/|\+|,|\band\b)\s*/i)
    .map((c) => c.trim())
    .filter(Boolean);
}

/**
 * Checks whether a calendar row is explicitly marked as "No video posted",
 * "Geen post online gegaan", or "No post scheduled" (Edge Case #9).
 */
export function isRowMarkedSkipped(fields: {
  contentType?: string | null;
  subject?: string | null;
  fileLocation?: string | null;
  statusCell?: string | null;
  channelRaw?: string | null;
}): { skipped: boolean; reason?: string } {
  const combined = [
    fields.contentType,
    fields.subject,
    fields.fileLocation,
    fields.statusCell,
  ]
    .map((v) => String(v || '').trim())
    .join(' | ');

  const lower = combined.toLowerCase();
  const patterns = [
    'no video posted',
    'geen post online gegaan',
    'no post scheduled',
    'geen video geplaatst',
    'no post online',
  ];
  for (const pat of patterns) {
    if (lower.includes(pat)) {
      return { skipped: true, reason: pat };
    }
  }
  return { skipped: false };
}

/**
 * Computes the deterministic `rowKey` and `rowHash` for a calendar row (Plan Section 5 & 9 Edge Case #4-6).
 * Note: `rowKey` intentionally excludes the tab name's month so boundary-week rows present in
 * both current and next month tabs map to one ContentItem.
 */
export function computeRowIdentity(params: {
  sheetId: string;
  dateYmd: string;
  timeHhMm: string;
  channelRaw: string;
  subject: string;
  allCells: Array<string | number | null>;
}): { rowKey: string; rowHash: string } {
  const normalizedChannel = normalizeTextForKey(params.channelRaw);
  const normalizedSubject = normalizeTextForKey(params.subject);

  const keyInput = [
    params.sheetId.trim(),
    params.dateYmd,
    params.timeHhMm,
    normalizedChannel,
    normalizedSubject,
  ].join('|');

  const rowKey = createHash('sha256').update(keyInput, 'utf8').digest('hex');

  const normalizedCells = params.allCells.map((c) =>
    c === null || c === undefined ? '' : normalizeFileNameNfc(String(c)).trim()
  );
  const rowHash = createHash('sha256')
    .update(JSON.stringify(normalizedCells), 'utf8')
    .digest('hex');

  return { rowKey, rowHash };
}

export interface RawCalendarRowInput {
  rowNumber: number;
  tab?: string;
  cells?: Array<string | number | null>;
  date?: string | number | null;
  time?: string | number | null;
  channel?: string | null;
  type?: string | null;
  subject?: string | null;
  fileLocation?: string | null;
  status?: string | null;
  category?: string | null;
}

export interface NormalizedCalendarRow {
  sheetId: string;
  sheetTab: string;
  rowNumber: number;
  dateYmd: string;
  timeHhMm: string;
  usedDefaultTime: boolean;
  scheduledAtUtc: Date;
  channelRaw: string;
  channels: string[];
  contentType: string | null;
  subject: string | null;
  fileLocation: string | null;
  statusCell: string | null;
  category: string | null;
  rawRow: Record<string, any>;
  rowKey: string;
  rowHash: string;
  isSkipped: boolean;
  skipReason?: string;
}

/**
 * Parses, filters, and normalises raw rows from a calendar sheet within the `[windowStartYmd, windowEndYmd]` window.
 */
export function parseAndFilterCalendarRows(params: {
  sheetId: string;
  defaultTab: string;
  rows: RawCalendarRowInput[];
  referenceDate?: Date;
  dumpDaysBefore?: number;
  windowStartYmd?: string;
  windowEndYmd?: string;
  timeZone?: string;
}): {
  stagedRows: NormalizedCalendarRow[];
  outOfWindowCount: number;
  skippedNoiseCount: number;
  warnings: string[];
} {
  const timeZone = params.timeZone || process.env.CALENDAR_TZ || DEFAULT_CALENDAR_TZ;
  const dumpDays =
    params.dumpDaysBefore ?? (Number(process.env.DUMP_DAYS_BEFORE) || 14);
  const refDate = params.referenceDate || new Date();

  const todayYmd = params.windowStartYmd || formatDateInCalendarTz(refDate, timeZone);
  const endYmd = params.windowEndYmd || addDaysToYmd(todayYmd, dumpDays);

  const stagedRows: NormalizedCalendarRow[] = [];
  const warnings: string[] = [];
  let outOfWindowCount = 0;
  let skippedNoiseCount = 0;

  for (const r of params.rows) {
    const tab = (r.tab || params.defaultTab || 'Master Content Calendar').trim();
    const cells = Array.isArray(r.cells)
      ? r.cells
      : [
          r.date ?? null,
          r.time ?? null,
          r.channel ?? null,
          r.type ?? null,
          r.subject ?? null,
          r.fileLocation ?? null,
          r.status ?? null,
        ];

    const colA = cells[0] ?? r.date ?? null;
    const colB = cells[1] ?? r.time ?? null;
    const colC = cells[2] ?? r.channel ?? null;
    const colD = cells[3] ?? r.type ?? null;
    const colE = cells[4] ?? r.subject ?? null;
    const colF = cells[5] ?? r.fileLocation ?? null;
    const colG = cells[6] ?? r.status ?? null;

    if (isCalendarNoiseValue(colA)) {
      skippedNoiseCount++;
      continue;
    }

    const dateYmd = parseCalendarDateToYmd(colA);
    if (!dateYmd) {
      warnings.push(
        `UNPARSEABLE_DATE: Tab "${tab}" row ${r.rowNumber} has unparseable date "${String(colA)}"`
      );
      skippedNoiseCount++;
      continue;
    }

    // Window filter: keep rows between todayYmd and endYmd inclusive (Plan Section 6 Flow 1 Step 4)
    if (dateYmd < todayYmd || dateYmd > endYmd) {
      outOfWindowCount++;
      continue;
    }

    const channelRaw = String(colC ?? '').trim();
    const contentType = colD != null && String(colD).trim() !== '' ? normalizeFileNameNfc(String(colD)).trim() : null;
    const subject = colE != null && String(colE).trim() !== '' ? normalizeFileNameNfc(String(colE)).trim() : null;
    const fileLocation = colF != null && String(colF).trim() !== '' ? normalizeFileNameNfc(String(colF)).trim() : null;
    const statusCell = colG != null && String(colG).trim() !== '' ? normalizeFileNameNfc(String(colG)).trim() : null;

    const skipCheck = isRowMarkedSkipped({
      contentType,
      subject,
      fileLocation,
      statusCell,
      channelRaw,
    });

    // If completely blank row apart from a date
    if (!channelRaw && !contentType && !subject && !skipCheck.skipped) {
      skippedNoiseCount++;
      continue;
    }

    const parsedTime = parseCalendarTimeToHhMm(colB);
    const usedDefaultTime = !parsedTime;
    const firstChannelUpper = (channelRaw.split(/[&/,+]/)[0] || '').trim().toUpperCase();
    const defaultTime = getDefaultPostTimeForChannel(firstChannelUpper);
    const timeHhMm = parsedTime || defaultTime;

    const scheduledAtUtc = localDateTimeToUtc(dateYmd, timeHhMm, timeZone);
    const channels = splitChannelsCell(channelRaw);

    const { rowKey, rowHash } = computeRowIdentity({
      sheetId: params.sheetId,
      dateYmd,
      timeHhMm,
      channelRaw: channelRaw || 'skipped',
      subject: subject || contentType || `row-${r.rowNumber}`,
      allCells: [colA, colB, colC, colD, colE, colF, colG],
    });

    stagedRows.push({
      sheetId: params.sheetId,
      sheetTab: tab,
      rowNumber: r.rowNumber,
      dateYmd,
      timeHhMm,
      usedDefaultTime,
      scheduledAtUtc,
      channelRaw: channelRaw || 'N/A',
      channels: channels.length > 0 ? channels : ['N/A'],
      contentType,
      subject,
      fileLocation,
      statusCell,
      category: r.category ?? null,
      rawRow: {
        A_date: colA,
        B_time: colB,
        C_channel: colC,
        D_type: colD,
        E_subject: colE,
        F_fileLocation: colF,
        G_status: colG,
      },
      rowKey,
      rowHash,
      isSkipped: skipCheck.skipped,
      skipReason: skipCheck.reason,
    });
  }

  return {
    stagedRows,
    outOfWindowCount,
    skippedNoiseCount,
    warnings,
  };
}

