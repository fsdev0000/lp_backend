export interface DateWindow {
  range: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  prevStartDate: string | null; // YYYY-MM-DD (null for range='all')
  prevEndDate: string | null; // YYYY-MM-DD (null for range='all')
  days: number | null; // null for range='all'
}

/**
 * Returns current date string (YYYY-MM-DD) in Asia/Dubai (UTC+4) timezone.
 */
export function getDubaiTodayString(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(new Date());
}

/**
 * Resolves date window in Asia/Dubai timezone.
 * lagDays = 1 for GA4 (yesterday is latest complete day)
 * lagDays = 2 for Google Search Console (2 days ago is latest complete day)
 */
export function resolveWindow(
  range = '30d',
  lagDays = 1,
  customStartDate?: string,
  customEndDate?: string
): DateWindow {
  if (customStartDate && customEndDate) {
    const startObj = new Date(customStartDate);
    const endObj = new Date(customEndDate);
    const diffTime = Math.abs(endObj.getTime() - startObj.getTime());
    const days = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;

    const prevEndObj = new Date(startObj.getTime() - 1 * 24 * 60 * 60 * 1000);
    const prevStartObj = new Date(prevEndObj.getTime() - (days - 1) * 24 * 60 * 60 * 1000);

    return {
      range: `${days}d`,
      startDate: customStartDate,
      endDate: customEndDate,
      prevStartDate: prevStartObj.toISOString().slice(0, 10),
      prevEndDate: prevEndObj.toISOString().slice(0, 10),
      days,
    };
  }

  const dubaiToday = getDubaiTodayString();
  const [y, m, d] = dubaiToday.split('-').map(Number);
  const todayDubai = new Date(Date.UTC(y, m - 1, d));

  const endObj = new Date(todayDubai.getTime() - lagDays * 24 * 60 * 60 * 1000);
  const endDate = endObj.toISOString().slice(0, 10);

  const norm = (range || '30d').toLowerCase().trim();
  if (norm === 'all') {
    return {
      range: 'all',
      startDate: '2015-08-14', // GA4 earliest date
      endDate,
      prevStartDate: null,
      prevEndDate: null,
      days: null,
    };
  }

  let days = 30;
  if (norm === '7d' || norm === '7') days = 7;
  else if (norm === '14d' || norm === '14') days = 14;
  else if (norm === '28d' || norm === '28') days = 28;
  else if (norm === '30d' || norm === '30') days = 30;
  else if (norm === '90d' || norm === '90') days = 90;
  else {
    const parsed = parseInt(norm.replace(/\D/g, ''), 10);
    if (!isNaN(parsed) && parsed > 0) days = parsed;
  }

  const startObj = new Date(endObj.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  const startDate = startObj.toISOString().slice(0, 10);

  const prevEndObj = new Date(startObj.getTime() - 1 * 24 * 60 * 60 * 1000);
  const prevStartObj = new Date(prevEndObj.getTime() - (days - 1) * 24 * 60 * 60 * 1000);

  return {
    range: `${days}d`,
    startDate,
    endDate,
    prevStartDate: prevStartObj.toISOString().slice(0, 10),
    prevEndDate: prevEndObj.toISOString().slice(0, 10),
    days,
  };
}

/**
 * Calculates percentage growth vs previous window.
 * Returns null if range is 'all' (no previous window) or previous is null/undefined.
 */
export function calcGrowth(current: number, previous: number | null | undefined): number | null {
  if (previous === null || previous === undefined) return null;
  if (previous === 0) {
    return current > 0 ? 100.0 : 0.0;
  }
  const growth = ((current - previous) / previous) * 100;
  return parseFloat(growth.toFixed(1));
}

/**
 * Formats trend as formatted string (+X.X% or -X.X% or null for range=all).
 */
export function calcTrend(current: number, previous: number | null | undefined): string | null {
  if (previous === null || previous === undefined) return null;
  const growth = calcGrowth(current, previous);
  if (growth === null) return null;
  const sign = growth > 0 ? '+' : '';
  return `${sign}${growth.toFixed(1)}%`;
}

/**
 * Normalizes date string into ISO YYYY-MM-DD format.
 */
export function normalizeIsoDate(dateStr: string): string {
  if (!dateStr) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  if (/^\d{8}$/.test(dateStr)) {
    return `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
  }
  const d = new Date(dateStr);
  if (!isNaN(d.getTime())) {
    return d.toISOString().slice(0, 10);
  }
  return dateStr;
}
