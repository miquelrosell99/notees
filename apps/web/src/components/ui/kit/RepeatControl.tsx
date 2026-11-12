/**
 * RepeatControl Component
 *
 * The deliberate, Google-Tasks-style recurrence authoring surface: an
 * off-state toggle row; switching on reveals the panel — every N
 * days/weeks/months/years (an interval input + a unit Dropdown), weekday
 * chips (weekly), a day-of-month input (monthly), an Ends radio group
 * (never / after N occurrences / on a date), a live summary line, and a
 * "Does not repeat" escape hatch.
 *
 * Controlled: the panel's visibility and content derive from `value`.
 * Every field edit converts the internal draft to a RecurrenceRule and
 * runs repeatIssueOf — a valid draft commits through onChange; an invalid
 * one stays local, flags its offending input (aria-invalid) and announces
 * the error in the aria-live summary line instead of committing. The
 * draft re-syncs from `value` whenever the parent changes it, so external
 * writes win.
 *
 * The series anchor (the driving date value's day) is the caller's to
 * supply: it preselects the weekly weekday, prefills the monthly
 * day-of-month and the end date, and floors the until validation. When
 * absent the panel still works — the summary falls back to a fixed
 * epoch day and the until floor check is skipped.
 *
 * Composition (kit law): BooleanToggle, Dropdown, Chip, Radio/RadioGroup
 * and Button are the kit primitives; repeatSummaryOf/repeatIssueOf are
 * the sibling pure pins; @notees/domain supplies the rule types. CSS
 * idiom follows the retired date-pickers RepeatPicker (nt-repeat-*).
 */

import { useEffect, useId, useState, type JSX } from "react";
import {
  RECURRENCE_WEEKDAYS,
  weekdayOfIso,
  type RecurrenceFreq,
  type RecurrenceRule,
  type RecurrenceWeekday,
} from "@notees/domain";

import { BooleanToggle } from "./BooleanToggle.js";
import { Button } from "./Button.js";
import { Chip } from "./Chip.js";
import { Dropdown } from "./Dropdown.js";
import { Radio, RadioGroup } from "./Radio.js";
import { compareRecurrenceWeekdays, repeatIssueOf, repeatSummaryOf } from "./repeatSummary.js";
import { cn } from "./cn.js";
import "./RepeatControl.css";

export interface RepeatControlProps {
  /** The committed rule; null renders the off-state toggle row only. */
  value: RecurrenceRule | null;
  /** The series anchor day (ISO YYYY-MM-DD) — prefill + validation floor. */
  anchorIso: string | null;
  /** Disables the whole control; no onChange fires while disabled. */
  disabled?: boolean;
  /** Muted explanation shown next to the toggle while disabled. */
  disabledHint?: string | undefined;
  /** Every valid draft commit (and the toggle/clear transitions). */
  onChange: (rule: RecurrenceRule | null) => void;
  /** ID for the root container. */
  id?: string | undefined;
}

type RepeatEnd = "never" | "count" | "until";

/** The editing buffer — field text stays local until the draft commits. */
interface RepeatDraft {
  freq: RecurrenceFreq;
  interval: string;
  byday: RecurrenceWeekday[];
  bymonthday: string;
  end: RepeatEnd;
  count: string;
  until: string;
}

const WEEKDAY_LABEL: Record<RecurrenceWeekday, string> = {
  MO: "Mon",
  TU: "Tue",
  WE: "Wed",
  TH: "Thu",
  FR: "Fri",
  SA: "Sat",
  SU: "Sun",
};

const UNIT_OPTIONS: { value: RecurrenceFreq; label: string }[] = [
  { value: "daily", label: "days" },
  { value: "weekly", label: "weeks" },
  { value: "monthly", label: "months" },
  { value: "yearly", label: "years" },
];

/** Summary anchor when none is known — deterministic, never rendered as a date. */
const FALLBACK_ANCHOR = "1970-01-01";

/** The rule a just-switched-on control starts from. */
const DEFAULT_RULE: RecurrenceRule = { freq: "daily", interval: 1 };

function draftOfRule(rule: RecurrenceRule): RepeatDraft {
  return {
    freq: rule.freq,
    interval: String(rule.interval),
    byday: rule.byday !== undefined ? [...rule.byday] : [],
    bymonthday: rule.bymonthday !== undefined ? rule.bymonthday.join(",") : "",
    end: rule.count !== undefined ? "count" : rule.until !== undefined ? "until" : "never",
    count: rule.count !== undefined ? String(rule.count) : "10",
    until: rule.until ?? "",
  };
}

function ruleOfDraft(draft: RepeatDraft): RecurrenceRule {
  const rule: RecurrenceRule = { freq: draft.freq, interval: Number(draft.interval) };
  if (draft.freq === "weekly") rule.byday = [...draft.byday];
  if (draft.freq === "monthly") {
    const days = draft.bymonthday
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .map(Number);
    if (days.length > 0) rule.bymonthday = days;
  }
  if (draft.end === "count") rule.count = Number(draft.count);
  if (draft.end === "until") rule.until = draft.until;
  return rule;
}

/** The anchor's day-of-month ("6"), null when no anchor is known. */
function anchorDayOf(anchorIso: string | null): string | null {
  if (anchorIso === null) return null;
  const day = Number(anchorIso.split("-")[2]);
  return Number.isInteger(day) && day >= 1 ? String(day) : null;
}

/**
 * RepeatControl — the recurrence authoring surface (see file header for
 * the contract).
 */
export function RepeatControl({
  value,
  anchorIso,
  disabled = false,
  disabledHint,
  onChange,
  id,
}: RepeatControlProps): JSX.Element {
  const [draft, setDraft] = useState<RepeatDraft | null>(() =>
    value === null ? null : draftOfRule(value),
  );
  const endsLabelId = useId();

  // External value writes re-sync the draft; closing the control drops it.
  useEffect(() => {
    setDraft(value === null ? null : draftOfRule(value));
  }, [value]);

  const open = value !== null;

  /** Edit a field: keep the draft local, commit only when it validates. */
  const commit = (next: RepeatDraft): void => {
    setDraft(next);
    const issue = repeatIssueOf(ruleOfDraft(next), anchorIso);
    if (issue === null) onChange(ruleOfDraft(next));
  };

  const handleToggle = (on: boolean): void => {
    if (on) {
      const next = draftOfRule(value ?? DEFAULT_RULE);
      setDraft(next);
      const issue = repeatIssueOf(ruleOfDraft(next), anchorIso);
      if (issue === null) onChange(ruleOfDraft(next));
    } else {
      setDraft(null);
      onChange(null);
    }
  };

  const handleClear = (): void => {
    setDraft(null);
    onChange(null);
  };

  const handleFreq = (freq: RecurrenceFreq): void => {
    if (draft === null) return;
    const next: RepeatDraft = { ...draft, freq };
    if (freq === "weekly" && next.byday.length === 0 && anchorIso !== null) {
      next.byday = [weekdayOfIso(anchorIso)];
    }
    if (freq === "monthly" && next.bymonthday.trim() === "") {
      next.bymonthday = anchorDayOf(anchorIso) ?? "";
    }
    commit(next);
  };

  const handleDayToggle = (day: RecurrenceWeekday): void => {
    if (draft === null) return;
    const byday = draft.byday.includes(day)
      ? draft.byday.filter((d) => d !== day)
      : [...draft.byday, day].sort(compareRecurrenceWeekdays);
    commit({ ...draft, byday });
  };

  const handleEnd = (end: RepeatEnd): void => {
    if (draft === null) return;
    const next: RepeatDraft = { ...draft, end };
    if (end === "until" && next.until.trim() === "" && anchorIso !== null) next.until = anchorIso;
    commit(next);
  };

  const hint =
    disabled && disabledHint !== undefined && disabledHint !== "" ? (
      <p className="nt-repeat-hint">{disabledHint}</p>
    ) : null;

  const toggleRow = (
    <div className="nt-repeat-toggle-row">
      <BooleanToggle
        checked={open}
        onChange={handleToggle}
        disabled={disabled}
        label="Repeat"
        labelPosition="left"
        size="sm"
      />
      {hint}
    </div>
  );

  if (!open || draft === null) {
    return (
      <div id={id} className="nt-repeat-control">
        {toggleRow}
      </div>
    );
  }

  const issue = repeatIssueOf(ruleOfDraft(draft), anchorIso);
  const summaryAnchor = anchorIso ?? FALLBACK_ANCHOR;

  return (
    <div id={id} className="nt-repeat-control nt-repeat-control--on">
      {toggleRow}

      <div className="nt-repeat-panel">
        <div className="nt-repeat-row">
          <input
            type="number"
            className="nt-repeat-number"
            aria-label="Repeat interval"
            min={1}
            max={999}
            value={draft.interval}
            disabled={disabled}
            aria-invalid={issue?.field === "interval" || undefined}
            onChange={(event) => commit({ ...draft, interval: event.target.value })}
          />
          <Dropdown
            options={UNIT_OPTIONS}
            value={draft.freq}
            onChange={(freq) => {
              if (freq !== null) handleFreq(freq);
            }}
            disabled={disabled}
            size="sm"
            ariaLabel="Repeat unit"
          />
        </div>

        {draft.freq === "weekly" && (
          <div
            className="nt-repeat-chips"
            role="group"
            aria-label="Weekdays"
            aria-invalid={issue?.field === "byday" || undefined}
          >
            {RECURRENCE_WEEKDAYS.map((day) => (
              <Chip
                key={day}
                active={draft.byday.includes(day)}
                disabled={disabled}
                onClick={() => handleDayToggle(day)}
              >
                {WEEKDAY_LABEL[day]}
              </Chip>
            ))}
          </div>
        )}

        {draft.freq === "monthly" && (
          <div className="nt-repeat-row">
            <span className="nt-repeat-label">On day</span>
            <input
              type="number"
              className="nt-repeat-number"
              aria-label="Day of month"
              min={1}
              max={31}
              value={draft.bymonthday}
              disabled={disabled}
              aria-invalid={issue?.field === "bymonthday" || undefined}
              onChange={(event) => commit({ ...draft, bymonthday: event.target.value })}
            />
          </div>
        )}

        <div className="nt-repeat-ends">
          <span className="nt-repeat-label" id={endsLabelId}>
            Ends
          </span>
          <RadioGroup
            aria-labelledby={endsLabelId}
            value={draft.end}
            disabled={disabled}
            onValueChange={(end) => handleEnd(end as RepeatEnd)}
          >
            <div className="nt-repeat-end-row">
              <Radio value="never" label="Never" size="sm" />
            </div>
            <div className="nt-repeat-end-row">
              <Radio value="count" label="After" size="sm" />
              {draft.end === "count" && (
                <>
                  <input
                    type="number"
                    className="nt-repeat-number"
                    aria-label="Occurrences"
                    min={1}
                    value={draft.count}
                    disabled={disabled}
                    aria-invalid={issue?.field === "count" || undefined}
                    onChange={(event) => commit({ ...draft, count: event.target.value })}
                  />
                  <span className="nt-repeat-label">occurrences</span>
                </>
              )}
            </div>
            <div className="nt-repeat-end-row">
              <Radio value="until" label="On" size="sm" />
              {draft.end === "until" && (
                <input
                  type="date"
                  className="nt-repeat-date"
                  aria-label="End date"
                  value={draft.until}
                  disabled={disabled}
                  aria-invalid={issue?.field === "until" || undefined}
                  onChange={(event) => commit({ ...draft, until: event.target.value })}
                />
              )}
            </div>
          </RadioGroup>
        </div>

        <p
          className={cn("nt-repeat-summary", issue !== null && "nt-repeat-summary--error")}
          aria-live="polite"
        >
          {issue !== null ? issue.message : repeatSummaryOf(ruleOfDraft(draft), summaryAnchor)}
        </p>

        <Button variant="ghost" size="sm" disabled={disabled} onClick={handleClear}>
          Does not repeat
        </Button>
      </div>
    </div>
  );
}
