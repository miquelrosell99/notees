/**
 * Natural Language Date Parser
 *
 * Lightweight parser (no external deps) supporting:
 * - "tomorrow", "today", "next week", "next monday", "in 3 days", "friday"
 *
 * Returns { date: Date, matchedText: string, remainingText: string } | null
 */

import { parseDate, generateDateUuid } from './dateParser';

export interface NlpDateResult {
  date: Date;
  matchedText: string;
  remainingText: string;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function nextWeekday(dayName: string): Date {
  const target = WEEKDAYS.indexOf(dayName.toLowerCase());
  if (target === -1) return new Date();
  const d = new Date();
  const current = d.getDay();
  let daysUntil = target - current;
  if (daysUntil <= 0) daysUntil += 7;
  d.setDate(d.getDate() + daysUntil);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Parse a natural language date expression from the start of a string.
 */
export function nlpDateParser(input: string): NlpDateResult | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();

  // "today"
  if (lower.startsWith('today')) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return { date: d, matchedText: 'today', remainingText: trimmed.slice(5).trimStart() };
  }

  // "tomorrow"
  if (lower.startsWith('tomorrow')) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(0, 0, 0, 0);
    return { date: d, matchedText: 'tomorrow', remainingText: trimmed.slice(8).trimStart() };
  }

  // "next week"
  if (lower.startsWith('next week')) {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    d.setHours(0, 0, 0, 0);
    return { date: d, matchedText: 'next week', remainingText: trimmed.slice(9).trimStart() };
  }

  // "next <weekday>"
  const nextWeekdayMatch = lower.match(/^next\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/);
  if (nextWeekdayMatch) {
    const dayName = nextWeekdayMatch[1];
    const d = nextWeekday(dayName);
    const fullMatch = nextWeekdayMatch[0];
    return { date: d, matchedText: fullMatch, remainingText: trimmed.slice(fullMatch.length).trimStart() };
  }

  // "in N days"
  const inDaysMatch = lower.match(/^in\s+(\d+)\s+day(s?)/);
  if (inDaysMatch) {
    const n = parseInt(inDaysMatch[1], 10);
    const d = new Date();
    d.setDate(d.getDate() + n);
    d.setHours(0, 0, 0, 0);
    const fullMatch = inDaysMatch[0];
    return { date: d, matchedText: fullMatch, remainingText: trimmed.slice(fullMatch.length).trimStart() };
  }

  // "<weekday>" (this week's day, or next if already passed)
  const weekdayMatch = lower.match(/^(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/);
  if (weekdayMatch) {
    const dayName = weekdayMatch[1];
    const d = nextWeekday(dayName);
    // If today is that day, use today instead of next week
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (d.getTime() === today.getTime() + 7 * 24 * 60 * 60 * 1000) {
      // It's next week's same day; check if today is that day
      if (today.getDay() === WEEKDAYS.indexOf(dayName)) {
        d.setDate(d.getDate() - 7);
      }
    }
    const fullMatch = weekdayMatch[0];
    return { date: d, matchedText: fullMatch, remainingText: trimmed.slice(fullMatch.length).trimStart() };
  }

  // Fallback to existing parseDate for absolute expressions
  const parsed = parseDate(trimmed);
  if (parsed && parsed.type === 'day' && parsed.day != null) {
    const d = new Date(parsed.year, parsed.month! - 1, parsed.day);
    // Find how much text was consumed — heuristic: use the label
    const consumed = trimmed.match(/^[^,]+/);
    const matchText = consumed ? consumed[0] : trimmed;
    return { date: d, matchedText: matchText, remainingText: trimmed.slice(matchText.length).trimStart() };
  }

  return null;
}

export { parseDate, generateDateUuid };
