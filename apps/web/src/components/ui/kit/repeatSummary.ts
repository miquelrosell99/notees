/**
 * repeatSummary — the recurrence pins behind the RepeatControl kit
 * component: the human summary of a series and the draft validator.
 *
 * Pure, unit-pinned, @notees/domain-only (kit law: no feature imports).
 * `repeatSummaryOf` moved here from features/calendar/repeatProperty.ts
 * (Task 11 relocation) — the feature module re-exports it for
 * compatibility.
 */

import {
  RECURRENCE_MAX_INTERVAL,
  RECURRENCE_WEEKDAYS,
  parseIsoDate,
  weekdayOfIso,
  type RecurrenceRule,
  type RecurrenceWeekday,
} from "@notees/domain";

const WEEKDAY_SHORT: Record<RecurrenceWeekday, string> = {
  MO: "Mon",
  TU: "Tue",
  WE: "Wed",
  TH: "Thu",
  FR: "Fri",
  SA: "Sat",
  SU: "Sun",
};

const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * The human summary of a series (the repeat control's live summary line
 * and the calendar labels): "Every 2 weeks on Mon, Fri", "Monthly on day
 * 3", "Yearly on 29 Feb". The anchor supplies what the rule leaves
 * implicit (the weekly weekday, the monthly day-of-month, the yearly
 * month+day). The end rides as a suffix: " · ends after 10 occurrences" /
 * " · ends 31 Dec 2026"; an unbounded rule omits the suffix.
 */
export function repeatSummaryOf(rule: RecurrenceRule, anchorIso: string): string {
  const [, m, d] = anchorIso.split("-").map(Number);
  const anchorWeekday = weekdayOfIso(anchorIso);
  const every = (unit: string): string => `Every ${rule.interval} ${unit}s`;
  let base: string;
  switch (rule.freq) {
    case "daily":
      base = rule.interval === 1 ? "Daily" : every("day");
      break;
    case "weekly": {
      const days = (rule.byday ?? [anchorWeekday]).map((day) => WEEKDAY_SHORT[day]);
      base = `${rule.interval === 1 ? "Weekly" : every("week")} on ${days.join(", ")}`;
      break;
    }
    case "monthly": {
      const days = rule.bymonthday ?? [d!];
      base = `${rule.interval === 1 ? "Monthly" : every("month")} on day ${days.join(", ")}`;
      break;
    }
    case "yearly":
      base = `${rule.interval === 1 ? "Yearly" : every("year")} on ${d} ${MONTH_SHORT[m! - 1]}`;
      break;
  }
  if (rule.count !== undefined) {
    const plural = rule.count === 1 ? "occurrence" : "occurrences";
    return `${base} · ends after ${rule.count} ${plural}`;
  }
  if (rule.until !== undefined) {
    const [uy, um, ud] = rule.until.split("-").map(Number);
    return `${base} · ends ${ud} ${MONTH_SHORT[um! - 1]} ${uy}`;
  }
  return base;
}

/** Which field a repeat issue belongs to — the aria-invalid target. */
export type RepeatIssueField = "interval" | "byday" | "bymonthday" | "count" | "until";

export interface RepeatIssue {
  field: RepeatIssueField;
  message: string;
}

const ISSUE_INTERVAL: RepeatIssue = {
  field: "interval",
  message: "Interval must be a whole number from 1 to 999.",
};
const ISSUE_BYDAY: RepeatIssue = { field: "byday", message: "Pick at least one weekday." };
const ISSUE_BYMONTHDAY: RepeatIssue = {
  field: "bymonthday",
  message: "Day of month must be from 1 to 31.",
};
const ISSUE_ENDS_CONFLICT: RepeatIssue = {
  field: "count",
  message: "Set either an occurrence count or an end date, not both.",
};
const ISSUE_COUNT: RepeatIssue = {
  field: "count",
  message: "Occurrences must be at least 1.",
};
const ISSUE_UNTIL_SHAPE: RepeatIssue = {
  field: "until",
  message: "End date is not a valid day.",
};

function isValidIsoDay(iso: string): boolean {
  try {
    parseIsoDate(iso);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first issue with a recurrence draft, null when the draft commits.
 * The field names the offending input (the component sets aria-invalid
 * there); the message is the accessible, human-readable error string.
 * Rules: interval 1..999 (whole); byday non-empty when present;
 * bymonthday within 1..31; count ≥ 1; until a valid day ≥ anchor (when
 * the anchor is known); count+until not both set.
 */
export function repeatIssueOf(rule: RecurrenceRule, anchorIso: string | null): RepeatIssue | null {
  if (!Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > RECURRENCE_MAX_INTERVAL) {
    return ISSUE_INTERVAL;
  }
  if (rule.byday !== undefined && rule.byday.length === 0) return ISSUE_BYDAY;
  if (
    rule.bymonthday !== undefined &&
    rule.bymonthday.some((day) => !Number.isInteger(day) || day < 1 || day > 31)
  ) {
    return ISSUE_BYMONTHDAY;
  }
  if (rule.count !== undefined && rule.until !== undefined) return ISSUE_ENDS_CONFLICT;
  if (rule.count !== undefined && (!Number.isInteger(rule.count) || rule.count < 1)) {
    return ISSUE_COUNT;
  }
  if (rule.until !== undefined) {
    if (!isValidIsoDay(rule.until)) return ISSUE_UNTIL_SHAPE;
    if (anchorIso !== null && rule.until < anchorIso) {
      return {
        field: "until",
        message: `End date must be on or after ${anchorIso}.`,
      };
    }
  }
  return null;
}

/**
 * An accessible error string for a recurrence draft, null when the draft
 * commits. Thin message projection over {@link repeatIssueOf} — the
 * component uses the issue form to flag the offending input.
 */
export function validateRepeatDraft(rule: RecurrenceRule, anchorIso: string | null): string | null {
  return repeatIssueOf(rule, anchorIso)?.message ?? null;
}

/** Canonical weekday sort — the BYDAY display order. */
export function compareRecurrenceWeekdays(a: RecurrenceWeekday, b: RecurrenceWeekday): number {
  return RECURRENCE_WEEKDAYS.indexOf(a) - RECURRENCE_WEEKDAYS.indexOf(b);
}
