/**
 * Date page display formatting.
 *
 * Date page content is stored in compact numeric form (YYYYMMDD, YYYYMM00,
 * YYYY0000). This module formats that content according to the user's date
 * format preference for display in the UI.
 */

import { formatDate, formatMonth, formatYear, type DateFormat } from '@/stores';

/** If `content` is compact day/month/year content, return the formatted display string. */
export function formatDatePageContent(content: string, dateFormat: DateFormat): string | null {
  const trimmed = content.trim();

  // Day: YYYYMMDD
  const dayMatch = trimmed.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dayMatch) {
    const year = parseInt(dayMatch[1], 10);
    const month = parseInt(dayMatch[2], 10);
    const day = parseInt(dayMatch[3], 10);
    const date = new Date(year, month - 1, day);
    if (
      date.getFullYear() === year &&
      date.getMonth() === month - 1 &&
      date.getDate() === day
    ) {
      return formatDate(date, dateFormat);
    }
  }

  // Month: YYYYMM00
  const monthMatch = trimmed.match(/^(\d{4})(\d{2})00$/);
  if (monthMatch) {
    const year = parseInt(monthMatch[1], 10);
    const month = parseInt(monthMatch[2], 10);
    if (month >= 1 && month <= 12) {
      return formatMonth(year, month, dateFormat);
    }
  }

  // Year: YYYY0000
  const yearMatch = trimmed.match(/^(\d{4})0000$/);
  if (yearMatch) {
    const year = parseInt(yearMatch[1], 10);
    return formatYear(year);
  }

  return null;
}
