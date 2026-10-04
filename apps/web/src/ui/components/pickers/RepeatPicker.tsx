/**
 * RepeatPicker — the minimal recurrence authoring control (§34.63, the
 * §34.28 #6 engine): None / Daily / Weekly / Weekdays (Mon–Fri) / Monthly /
 * Yearly, writing the canonical RRULE-lite grammar string (packages/domain
 * recurrence) for the caller to persist as the date value's `metadata.repeat`
 * (the startDate/endDate precedent — additive metadata, no wire change).
 *
 * The picker is deliberately dumb about the write: `onChange` receives the
 * grammar string (null = does not repeat) and the caller decides how it
 * rides the value. The picker vocabulary covers interval-1 rules; an
 * interval-bearing stored value (e.g. "weekly/2", writable from the API)
 * renders its honest label and any pick repairs/overwrites it.
 */

import { parseRecurrenceRule, formatRecurrenceRule } from "@notees/domain";

import { Icon } from "../../Icon.js";
import { Dropdown, type DropdownOption } from "../ui/Dropdown.js";
import { repeatLabelOf } from "../calendarViewUtils.js";
import "./RepeatPicker.css";

const OPTIONS: DropdownOption<string>[] = [
  { value: "none", label: "Does not repeat" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "weekdays", label: "Weekdays (Mon–Fri)" },
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
];

/** The canonical grammar strings the picker can author (null = none). */
export const REPEAT_PICKER_VALUES: readonly string[] = OPTIONS.filter(
  (option) => option.value !== "none",
).map((option) => option.value);

/** The stored grammar string for a pick ("none" → null). */
export function repeatValueOfPick(pick: string): string | null {
  if (pick === "none") return null;
  return formatRecurrenceRule(parseRecurrenceRule(pick));
}

/** The honest trigger label for a stored value; the raw string when corrupt. */
export function repeatLabelOfValue(value: string | null): string {
  if (value === null) return "Does not repeat";
  try {
    return repeatLabelOf(parseRecurrenceRule(value));
  } catch {
    return value;
  }
}

export interface RepeatPickerProps {
  /** The stored grammar string; null = does not repeat. */
  value: string | null;
  /** The write: the grammar string, or null when cleared to "none". */
  onChange: (rule: string | null) => void;
  ariaLabel?: string;
  /** Icon-only trigger (a per-pill affordance); default renders the label. */
  iconOnly?: boolean;
}

export function RepeatPicker({
  value,
  onChange,
  ariaLabel = "Repeat",
  iconOnly = false,
}: RepeatPickerProps) {
  const current = value ?? "none";
  const active = value !== null;
  return (
    <Dropdown
      options={OPTIONS}
      value={current}
      onChange={(pick) => onChange(pick === null ? null : repeatValueOfPick(pick))}
      size="sm"
      renderTrigger={() =>
        iconOnly ? (
          <span
            className={`nt-repeat-trigger nt-repeat-trigger--icon${active ? " nt-repeat-trigger--active" : ""}`}
            title={active ? `Repeats ${repeatLabelOfValue(value).toLowerCase()}` : ariaLabel}
          >
            <Icon path="mdi-repeat" size={0.9} />
            {/* Dropdown owns the wrapper button — the hidden text names it. */}
            <span className="sr-only">{ariaLabel}</span>
          </span>
        ) : (
          <span className="nt-repeat-trigger">
            <Icon path="mdi-repeat" size={0.9} />
            <span className="nt-repeat-trigger-label">{repeatLabelOfValue(value)}</span>
          </span>
        )
      }
    />
  );
}
