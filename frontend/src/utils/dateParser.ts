/**
 * Date Parser Utility
 * 
 * Parses various date string formats into structured date info.
 * Used by CommandPalette and SuggestionPopup to recognize when a user
 * types a date and offer to navigate to or create the corresponding
 * day/month/year page.
 * 
 * Supported formats:
 * - ISO: 20260804, 202604, 2026-02-09, 2026/02/09
 * - US: 02/09/2026, 02-09-2026
 * - EU: 09.02.2026
 * - Named months: Feb 9, 2026 / February 9 2026 / 9 Feb 2026 / Feb 2026
 * - Month only: February 2026 / Feb 2026
 * - Year only: 2026
 * - Relative: today, tomorrow, yesterday
 */

export interface ParsedDate {
  type: 'day' | 'month' | 'year';
  year: number;
  month?: number; // 1-12
  day?: number;   // 1-31
  /** Display label for the parsed date */
  label: string;
}

const MONTH_NAMES: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

const MONTH_DISPLAY = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Check if a year/month/day combination is a valid date
 */
function isValidDate(year: number, month?: number, day?: number): boolean {
  if (year < 1900 || year > 2200) return false;
  if (month !== undefined && (month < 1 || month > 12)) return false;
  if (day !== undefined && month !== undefined) {
    if (day < 1 || day > 31) return false;
    // Check actual days in month
    const daysInMonth = new Date(year, month, 0).getDate();
    if (day > daysInMonth) return false;
  }
  return true;
}

function formatLabel(type: 'day' | 'month' | 'year', year: number, month?: number, day?: number): string {
  if (type === 'year') return `${year}`;
  if (type === 'month' && month) return `${MONTH_DISPLAY[month]} ${year}`;
  if (type === 'day' && month && day) return `${MONTH_DISPLAY[month]} ${day}, ${year}`;
  return '';
}

/**
 * Try to parse a month name from a string, returns month number (1-12) or null
 */
function parseMonthName(str: string): number | null {
  return MONTH_NAMES[str.toLowerCase()] ?? null;
}

/**
 * Parse a date string into structured date info.
 * Returns null if the string doesn't match any recognized date format.
 */
export function parseDate(input: string): ParsedDate | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // --- Relative dates ---
  const lower = trimmed.toLowerCase();
  if (lower === 'today') {
    const d = new Date();
    return { type: 'day', year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), label: formatLabel('day', d.getFullYear(), d.getMonth() + 1, d.getDate()) };
  }
  if (lower === 'tomorrow') {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return { type: 'day', year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), label: formatLabel('day', d.getFullYear(), d.getMonth() + 1, d.getDate()) };
  }
  if (lower === 'yesterday') {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return { type: 'day', year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), label: formatLabel('day', d.getFullYear(), d.getMonth() + 1, d.getDate()) };
  }

  // --- Relative expressions ---
  // "next week" / "last week" / "in N days" / "N days ago"
  if (lower === 'next week') {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return { type: 'day', year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), label: formatLabel('day', d.getFullYear(), d.getMonth() + 1, d.getDate()) };
  }
  if (lower === 'last week') {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return { type: 'day', year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), label: formatLabel('day', d.getFullYear(), d.getMonth() + 1, d.getDate()) };
  }
  if (lower === 'next month') {
    const d = new Date();
    d.setMonth(d.getMonth() + 1);
    return { type: 'day', year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), label: formatLabel('day', d.getFullYear(), d.getMonth() + 1, d.getDate()) };
  }
  if (lower === 'last month') {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return { type: 'day', year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), label: formatLabel('day', d.getFullYear(), d.getMonth() + 1, d.getDate()) };
  }
  if (lower === 'next year') {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 1);
    return { type: 'day', year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), label: formatLabel('day', d.getFullYear(), d.getMonth() + 1, d.getDate()) };
  }
  if (lower === 'last year') {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 1);
    return { type: 'day', year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), label: formatLabel('day', d.getFullYear(), d.getMonth() + 1, d.getDate()) };
  }
  // "in N days/weeks/months"
  const inNMatch = lower.match(/^in\s+(\d+)\s+(days?|weeks?|months?|years?)$/);
  if (inNMatch) {
    const n = parseInt(inNMatch[1], 10);
    const unit = inNMatch[2].replace(/s$/, '');
    const d = new Date();
    if (unit === 'day') d.setDate(d.getDate() + n);
    else if (unit === 'week') d.setDate(d.getDate() + n * 7);
    else if (unit === 'month') d.setMonth(d.getMonth() + n);
    else if (unit === 'year') d.setFullYear(d.getFullYear() + n);
    return { type: 'day', year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), label: formatLabel('day', d.getFullYear(), d.getMonth() + 1, d.getDate()) };
  }
  // "N days/weeks/months ago"
  const agoMatch = lower.match(/^(\d+)\s+(days?|weeks?|months?|years?)\s+ago$/);
  if (agoMatch) {
    const n = parseInt(agoMatch[1], 10);
    const unit = agoMatch[2].replace(/s$/, '');
    const d = new Date();
    if (unit === 'day') d.setDate(d.getDate() - n);
    else if (unit === 'week') d.setDate(d.getDate() - n * 7);
    else if (unit === 'month') d.setMonth(d.getMonth() - n);
    else if (unit === 'year') d.setFullYear(d.getFullYear() - n);
    return { type: 'day', year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), label: formatLabel('day', d.getFullYear(), d.getMonth() + 1, d.getDate()) };
  }

  // --- ISO basic format: YYYYMMDD ---
  const isoBasicMatch = trimmed.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (isoBasicMatch) {
    const year = parseInt(isoBasicMatch[1], 10);
    const month = parseInt(isoBasicMatch[2], 10);
    const day = parseInt(isoBasicMatch[3], 10);
    if (isValidDate(year, month, day)) {
      return { type: 'day', year, month, day, label: formatLabel('day', year, month, day) };
    }
  }

  // --- ISO basic month: YYYYMM ---
  const isoBasicMonthMatch = trimmed.match(/^(\d{4})(\d{2})$/);
  if (isoBasicMonthMatch) {
    const year = parseInt(isoBasicMonthMatch[1], 10);
    const month = parseInt(isoBasicMonthMatch[2], 10);
    if (isValidDate(year, month)) {
      return { type: 'month', year, month, label: formatLabel('month', year, month) };
    }
  }

  // --- ISO format: YYYY-MM-DD or YYYY/MM/DD ---
  const isoMatch = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (isoMatch) {
    const year = parseInt(isoMatch[1], 10);
    const month = parseInt(isoMatch[2], 10);
    const day = parseInt(isoMatch[3], 10);
    if (isValidDate(year, month, day)) {
      return { type: 'day', year, month, day, label: formatLabel('day', year, month, day) };
    }
  }

  // --- ISO month: YYYY-MM ---
  const isoMonthMatch = trimmed.match(/^(\d{4})[-/](\d{1,2})$/);
  if (isoMonthMatch) {
    const year = parseInt(isoMonthMatch[1], 10);
    const month = parseInt(isoMonthMatch[2], 10);
    if (isValidDate(year, month)) {
      return { type: 'month', year, month, label: formatLabel('month', year, month) };
    }
  }

  // --- US format: MM/DD/YYYY or MM-DD-YYYY ---
  const usMatch = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (usMatch) {
    const month = parseInt(usMatch[1], 10);
    const day = parseInt(usMatch[2], 10);
    const year = parseInt(usMatch[3], 10);
    if (isValidDate(year, month, day)) {
      return { type: 'day', year, month, day, label: formatLabel('day', year, month, day) };
    }
  }

  // --- EU dot format: DD.MM.YYYY ---
  const euMatch = trimmed.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (euMatch) {
    const day = parseInt(euMatch[1], 10);
    const month = parseInt(euMatch[2], 10);
    const year = parseInt(euMatch[3], 10);
    if (isValidDate(year, month, day)) {
      return { type: 'day', year, month, day, label: formatLabel('day', year, month, day) };
    }
  }

  // --- Named month formats ---
  // "Month Day, Year" or "Month Day Year" — e.g., "February 9, 2026", "Feb 9 2026"
  const namedMDY = trimmed.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (namedMDY) {
    const month = parseMonthName(namedMDY[1]);
    const day = parseInt(namedMDY[2], 10);
    const year = parseInt(namedMDY[3], 10);
    if (month && isValidDate(year, month, day)) {
      return { type: 'day', year, month, day, label: formatLabel('day', year, month, day) };
    }
  }

  // "Day Month Year" — e.g., "9 February 2026", "9 Feb 2026"
  const namedDMY = trimmed.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (namedDMY) {
    const day = parseInt(namedDMY[1], 10);
    const month = parseMonthName(namedDMY[2]);
    const year = parseInt(namedDMY[3], 10);
    if (month && isValidDate(year, month, day)) {
      return { type: 'day', year, month, day, label: formatLabel('day', year, month, day) };
    }
  }

  // "Day Month" (no year, use current year) — e.g., "9 February", "9 Feb"
  const namedDMNoYear = trimmed.match(/^(\d{1,2})\s+([A-Za-z]+)$/);
  if (namedDMNoYear) {
    const day = parseInt(namedDMNoYear[1], 10);
    const month = parseMonthName(namedDMNoYear[2]);
    if (month) {
      const year = new Date().getFullYear();
      if (isValidDate(year, month, day)) {
        return { type: 'day', year, month, day, label: formatLabel('day', year, month, day) };
      }
    }
  }

  // "Month Day" (no year, use current year) — e.g., "February 9", "Feb 9"
  const namedMDNoYear = trimmed.match(/^([A-Za-z]+)\s+(\d{1,2})$/);
  if (namedMDNoYear) {
    const month = parseMonthName(namedMDNoYear[1]);
    const day = parseInt(namedMDNoYear[2], 10);
    if (month) {
      const year = new Date().getFullYear();
      if (isValidDate(year, month, day)) {
        return { type: 'day', year, month, day, label: formatLabel('day', year, month, day) };
      }
    }
  }

  // "Month Year" — e.g., "February 2026", "Feb 2026"
  const namedMY = trimmed.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (namedMY) {
    const month = parseMonthName(namedMY[1]);
    const year = parseInt(namedMY[2], 10);
    if (month && isValidDate(year, month)) {
      return { type: 'month', year, month, label: formatLabel('month', year, month) };
    }
  }

  // "Month" only (use current year) — e.g., "February", "Feb"
  // Only match if it's purely a month name
  const monthOnly = parseMonthName(trimmed);
  if (monthOnly) {
    const year = new Date().getFullYear();
    return { type: 'month', year, month: monthOnly, label: formatLabel('month', year, monthOnly) };
  }

  // --- Year only: 4-digit year ---
  const yearMatch = trimmed.match(/^(\d{4})$/);
  if (yearMatch) {
    const year = parseInt(yearMatch[1], 10);
    if (isValidDate(year)) {
      return { type: 'year', year, label: formatLabel('year', year) };
    }
  }

  return null;
}

/**
 * Generate the deterministic date UUID for a parsed date.
 * Matches the backend UUID format exactly:
 * - Day:   00000000-0000-0000-00dd-YYYYMMDD0000
 * - Month: 00000000-0000-0000-00aa-YYYYMM000000
 * - Year:  00000000-0000-0000-00bb-YYYY00000000
 */
export function generateDateUuid(parsed: ParsedDate): string {
  const y = String(parsed.year).padStart(4, '0');
  if (parsed.type === 'day' && parsed.month && parsed.day) {
    const m = String(parsed.month).padStart(2, '0');
    const d = String(parsed.day).padStart(2, '0');
    return `00000000-0000-0000-00dd-${y}${m}${d}0000`;
  }
  if (parsed.type === 'month' && parsed.month) {
    const m = String(parsed.month).padStart(2, '0');
    return `00000000-0000-0000-00aa-${y}${m}000000`;
  }
  // year
  return `00000000-0000-0000-00bb-${y}00000000`;
}
