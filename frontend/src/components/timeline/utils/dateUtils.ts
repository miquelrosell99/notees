/**
 * Date utility functions for timeline
 */

export function formatDateUuid(date: Date, type: 'day' | 'month' | 'year'): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  
  if (type === 'day') return `${year}${month}${day}`;
  if (type === 'month') return `${year}${month}00`;
  return `${year}0000`;
}

export function getDateRange(dates: Date[], padding: number = 0.1): { start: Date; end: Date } {
  if (dates.length === 0) {
    const now = new Date();
    const start = new Date(now);
    start.setMonth(now.getMonth() - 6);
    const end = new Date(now);
    end.setMonth(now.getMonth() + 1);
    return { start, end };
  }
  
  const timestamps = dates.map(d => d.getTime()).sort((a, b) => a - b);
  const minTime = timestamps[0];
  const maxTime = timestamps[timestamps.length - 1];
  const range = maxTime - minTime;
  const paddingMs = range * padding || 30 * 24 * 60 * 60 * 1000; // Default 30 days if zero range
  
  return {
    start: new Date(minTime - paddingMs),
    end: new Date(maxTime + paddingMs)
  };
}

export function normalizeDate(date: Date, start: Date, end: Date): number {
  const totalMs = end.getTime() - start.getTime();
  if (totalMs === 0) return 0.5;
  return (date.getTime() - start.getTime()) / totalMs;
}

export function formatDateLabel(date: Date, precision: 'decade' | 'year' | 'quarter' | 'month' | 'week' | 'day' | 'hour'): string {
  const year = date.getFullYear();
  const month = date.toLocaleDateString('default', { month: 'short' });
  const day = date.getDate();
  const hour = date.getHours();
  
  switch (precision) {
    case 'decade':
      const decade = Math.floor(year / 10) * 10;
      return `${decade}s`;
    case 'year':
      return String(year);
    case 'quarter':
      const q = Math.floor(date.getMonth() / 3) + 1;
      return `Q${q} ${year}`;
    case 'month':
      return `${month} ${year}`;
    case 'week':
    case 'day':
      return `${month} ${day}`;
    case 'hour':
      const ampm = hour >= 12 ? 'PM' : 'AM';
      const hour12 = hour % 12 || 12;
      return `${hour12}${ampm}`;
    default:
      return date.toLocaleDateString();
  }
}

export function getNextInterval(date: Date, precision: 'decade' | 'year' | 'quarter' | 'month' | 'week' | 'day' | 'hour'): Date {
  const next = new Date(date);
  
  switch (precision) {
    case 'decade':
      next.setFullYear(next.getFullYear() + 10);
      break;
    case 'year':
      next.setFullYear(next.getFullYear() + 1);
      break;
    case 'quarter':
      next.setMonth(next.getMonth() + 3);
      break;
    case 'month':
      next.setMonth(next.getMonth() + 1);
      break;
    case 'week':
      next.setDate(next.getDate() + 7);
      break;
    case 'day':
      next.setDate(next.getDate() + 1);
      break;
    case 'hour':
      next.setHours(next.getHours() + 1);
      break;
  }
  
  return next;
}

export function alignToInterval(date: Date, precision: 'decade' | 'year' | 'quarter' | 'month' | 'week' | 'day' | 'hour'): Date {
  const aligned = new Date(date);
  
  switch (precision) {
    case 'decade':
      aligned.setFullYear(Math.floor(aligned.getFullYear() / 10) * 10, 0, 1);
      aligned.setHours(0, 0, 0, 0);
      break;
    case 'year':
      aligned.setMonth(0, 1);
      aligned.setHours(0, 0, 0, 0);
      break;
    case 'quarter':
      aligned.setMonth(Math.floor(aligned.getMonth() / 3) * 3, 1);
      aligned.setHours(0, 0, 0, 0);
      break;
    case 'month':
      aligned.setDate(1);
      aligned.setHours(0, 0, 0, 0);
      break;
    case 'week':
      // Align to Monday
      const day = aligned.getDay();
      const diff = day === 0 ? -6 : 1 - day;
      aligned.setDate(aligned.getDate() + diff);
      aligned.setHours(0, 0, 0, 0);
      break;
    case 'day':
      aligned.setHours(0, 0, 0, 0);
      break;
    case 'hour':
      aligned.setMinutes(0, 0, 0);
      break;
  }
  
  return aligned;
}
