/**
 * DatePickerPopup — the canonical datetime value editor (the unified
 * datetime type, proposal slice 2): a month day-grid with a
 * month ⌄ / year ⌄ dropdown header and ‹ › navigation (the days ↔ months ↔
 * years zoom grids stay; day zoom is the default landing view), plus a
 * natural-language text field ("today", "Feb 14", "next week" — and, at day
 * precision, a wall-clock time: "tomorrow 14:30"), and a right-hand column:
 *
 *  - Suggestions — Yesterday / Today / Tomorrow / In 1 week / In 2 weeks,
 *    computed from the local clock; the row matching the edited slot's
 *    current date carries a ✓; a click commits the relative date, preserving
 *    the slot's time/all-day state.
 *  - All-day — ON by default (full-day = no `time`, the default for every
 *    new value); turning it OFF reveals a 24h HH:MM time input per slot and
 *    commits a default time; turning it back ON drops the times.
 *  - Range — OFF by default; ON reveals the end slot (one date button per
 *    end, the shared grid editing the focused end) and commits
 *    { start, end }; turning it back OFF collapses the value to the point
 *    (start kept, end dropped — silently, no confirm).
 *  - Repeat — the recurrence picker (metadata.repeat) rides here when the
 *    caller passes onRepeatChange (day precision only).
 *  - Remove — clears the value (single-value → unset; multi → the element
 *    being edited); the caller decides the write.
 *
 * The popup edits ONE value element and commits the full union through a
 * single `onCommit` — a point `{ iso, time? }` or a range
 * `{ start: { iso, time? } | null, end: { iso, time? } | null }`. The schema
 * precision stays the commit ceiling: at year/month precision the popup
 * lands on the year/month grid and the all-day/time/range/repeat chrome
 * stays hidden (a day has no wall-clock time at a coarser ceiling).
 * `allowRange`/`allowTime` reduce the chrome for surfaces whose write is a
 * bare day (link qualifiers); every commit still flows through onCommit.
 *
 * This base component is domain-agnostic about the write: it accepts ISO
 * days in and hands ISO days out — callers map the commit onto their model
 * (ensureDateChain + the property write, or a bare ISO qualifier).
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { isValidTimeOfDay, type DatePrecision } from "@notees/domain";

import { Icon } from "../../Icon.js";
import { parseDate } from "./dateParser.js";
import { useViewportPosition } from "./useViewportPosition.js";
import { usePopupDismissal } from "../ui/usePopupDismissal.js";
import { BooleanToggle } from "../ui/BooleanToggle.js";
import { useCalendarMode } from "./calendar/useCalendarMode.js";
import { DaysGrid, MonthsGrid, YearsGrid } from "./calendar/CalendarGrids.js";
import { RepeatPicker } from "./RepeatPicker.js";
import "./CalendarPopup.css"; // reuse grid styles from CalendarPopup
import "./DatePickerPopup.css"; // own additions

// ── value model ──────────────────────────────────────────

/** One anchored endpoint as the popup edits it: an ISO day + optional time. */
export interface DatetimePickerSlot {
  /** YYYY-MM-DD — the write path applies the schema precision ceiling. */
  iso: string;
  /** "HH:MM", 24h — absent = full-day (the default). */
  time?: string;
}

/** The popup's working copy of one stored value (the full union). */
export interface DatetimePickerValue {
  /** A stored range edits both slots; a point edits start only. */
  isRange: boolean;
  start: DatetimePickerSlot | null;
  end: DatetimePickerSlot | null;
}

/** The committed union: a point or a range of slots, either side open. */
export type DatetimeCommitValue =
  | { iso: string; time?: string }
  | { start: DatetimePickerSlot | null; end: DatetimePickerSlot | null };

// ── helpers ──────────────────────────────────────────────

function toIso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseIso(iso: string): { year: number; month: number; day: number } | null {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return { year: parseInt(m[1]!, 10), month: parseInt(m[2]!, 10), day: parseInt(m[3]!, 10) };
}

/** "9:15" / "09:15" → the canonical "HH:MM"; null when not a valid time. */
function normalizeTime(text: string): string | null {
  const m = text.match(/^(\d{1,2}):([0-5]\d)$/);
  if (m === null) return null;
  const hour = parseInt(m[1]!, 10);
  if (hour > 23) return null;
  return `${String(hour).padStart(2, "0")}:${m[2]}`;
}

const MONTHS_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** The suggestion rows, offsets in days from the local today. */
const SUGGESTIONS = [
  { label: "Yesterday", offset: -1 },
  { label: "Today", offset: 0 },
  { label: "Tomorrow", offset: 1 },
  { label: "In 1 week", offset: 7 },
  { label: "In 2 weeks", offset: 14 },
] as const;

function suggestionIso(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return toIso(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function slotLabel(slot: DatetimePickerSlot | null): string {
  if (slot === null) return "";
  const parsed = parseIso(slot.iso);
  if (parsed === null) return slot.iso;
  return `${MONTHS_FULL[parsed.month - 1]} ${parsed.day}, ${parsed.year}`;
}

// ── props ────────────────────────────────────────────────

export interface DatePickerPopupProps {
  /** The value being edited (the full union as slots). */
  value: DatetimePickerValue;
  /**
   * Commit the full union — a point `{ iso, time? }` or a range
   * `{ start, end }`. May be async; terminal commits (grid/suggestion/text)
   * wait for it to settle before closing so a slow or failing write is not
   * hidden by an early close.
   */
  onCommit: (value: DatetimeCommitValue) => void | Promise<void>;
  /** The Remove row's write (unset the value / drop the edited element). */
  onRemove?: (() => void | Promise<void>) | undefined;
  /** Called when the popup should close */
  onClose: () => void;
  /** Ref to the anchor element for positioning */
  anchorRef?: React.RefObject<HTMLElement | null>;
  /** Extra class on the popup root (e.g. to raise z-index when layered over a modal) */
  className?: string;
  /** Index of the first day of the week (0 = Sunday, 1 = Monday, ...) */
  firstDayOfWeek: number;
  /** Day keys (`y-m0-d`, 0-indexed month) already backed by a daily page */
  markedDates?: ReadonlySet<string>;
  /**
   * The schema's commit ceiling (day when unspecified) — the popup lands on
   * the matching zoom grid and the all-day/time/range/repeat chrome stays
   * hidden at year/month precision.
   */
  precision?: DatePrecision;
  /** The Range switch + end slot (default true; off for day-only surfaces). */
  allowRange?: boolean;
  /**
   * The All-day switch + time inputs — day precision only (default true;
   * off for surfaces whose write is a bare day, e.g. link qualifiers).
   */
  allowTime?: boolean;
  /** The stored recurrence grammar string (null = does not repeat). */
  repeat?: string | null;
  /** With this, the Repeat row rides the popup; the caller writes. */
  onRepeatChange?: ((rule: string | null) => void) | undefined;
}

// ── component ────────────────────────────────────────────

export function DatePickerPopup({
  value,
  onCommit,
  onRemove,
  onClose,
  anchorRef,
  className,
  firstDayOfWeek,
  markedDates,
  precision = "day",
  allowRange = true,
  allowTime = true,
  repeat = null,
  onRepeatChange,
}: DatePickerPopupProps) {
  const today = new Date();
  const dayPrecision = precision === "day";
  const showTime = allowTime && dayPrecision;

  // The working copy — every mutation commits the full union, so the draft
  // and the stored value stay in lockstep while the popup is open.
  const [draft, setDraft] = useState<DatetimePickerValue>(() => ({ ...value }));
  /** Which range end the grid/text/suggestions edit. */
  const [target, setTarget] = useState<"start" | "end">("start");
  const [textInput, setTextInput] = useState("");
  const [parsedPreview, setParsedPreview] = useState<string | null>(null);
  const [parsedValid, setParsedValid] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  /** The time fields' text (controlled; commits when a valid HH:MM lands). */
  const [timeTexts, setTimeTexts] = useState<Record<"start" | "end", string>>({
    start: value.start?.time ?? "09:00",
    end: value.end?.time ?? value.start?.time ?? "09:00",
  });

  // Derive the initial grid view from the edited value or today.
  const initial = draft.start !== null ? parseIso(draft.start.iso) : null;
  const {
    mode,
    currentYear,
    currentMonth,
    yearWindowStart,
    setMode,
    goPrev,
    goNext,
    goToday,
  } = useCalendarMode({
    initialMode: precision === "year" ? "years" : precision === "month" ? "months" : "days",
    initialYear: initial?.year ?? today.getFullYear(),
    initialMonth: initial ? initial.month - 1 : today.getMonth(),
  });

  const popupRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Stable fallback so the hook always receives a ref object with a stable
  // identity, even when a caller omits `anchorRef`.
  const fallbackAnchorRef = useRef<HTMLElement | null>(null);
  const anchor = anchorRef ?? fallbackAnchorRef;

  // Anchor to the trigger and flip/clamp to stay inside the viewport — same
  // behavior as the sibling CalendarPopup. The popup is `position: fixed`, so
  // viewport coordinates are used directly.
  const position = useViewportPosition(anchor, true, { popupRef, edgePadding: 8 });

  // Auto-focus input on mount (preventScroll avoids viewport shift)
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 50);
    return () => clearTimeout(t);
  }, []);

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        popupRef.current &&
        !popupRef.current.contains(e.target as Node) &&
        (!anchor.current || !anchor.current.contains(e.target as Node))
      ) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose, anchor]);

  // Dismissal: the document-level Escape half of the convention —
  // the text input and the popup root below still own Escape while focus is
  // inside (a pick must not be interrupted by a stray close), this hook
  // closes when focus never entered or left the popup.
  usePopupDismissal({ popupRef, isOpen: true, onClose });

  // ── the commit funnel ──────────────────────────────────

  // Run onCommit; on success the draft advances. Terminal commits close
  // only after the write settles — closing first would tear the host down
  // mid-insert and strand the insertion. On failure the popup stays open
  // and shows the error so the user can retry.
  const commitDraft = async (next: DatetimePickerValue): Promise<boolean> => {
    setErrorMessage(null);
    try {
      if (next.isRange) {
        await onCommit({ start: next.start, end: next.end });
      } else {
        const slot = next.start;
        if (slot === null) return false;
        await onCommit(slot.time !== undefined ? { iso: slot.iso, time: slot.time } : { iso: slot.iso });
      }
      setDraft(next);
      return true;
    } catch (err) {
      console.error("Date selection failed:", err);
      const message =
        err instanceof Error && err.message ? err.message : "Failed to insert date link";
      setErrorMessage(message);
      return false;
    }
  };

  /** A commit that finishes the edit: day/month/year/suggestion/text. */
  const commitAndClose = (next: DatetimePickerValue) => {
    void commitDraft(next).then((ok) => {
      if (ok) onClose();
    });
  };

  /**
   * The next draft with `iso` (and the given precision-truncated shape)
   * written into the target slot. The slot's time rides through when the
   * value is timed (all-day OFF ⇒ both slots carry a time — the switch is
   * the one place times appear/disappear).
   */
  const withPickedIso = (iso: string): DatetimePickerValue => {
    const current = draft[target];
    const slot: DatetimePickerSlot =
      current !== null && current.time !== undefined ? { iso, time: current.time } : { iso };
    return { ...draft, [target]: slot };
  };

  // ── text input parsing ─────────────────────────────────

  const previewOf = (slot: DatetimePickerSlot | null): string => {
    const label = slotLabel(slot);
    return slot !== null && slot.time !== undefined ? `${label} ${slot.time}` : label;
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setTextInput(val);

    if (!val.trim()) {
      // Empty: preview the edited slot's current value (the reference shows
      // the selected date in the field's preview line).
      setParsedPreview(draft[target] !== null ? previewOf(draft[target]) : null);
      setParsedValid(true);
      return;
    }

    const parsed = parseDate(val);
    if (parsed && parsed.type === "day" && parsed.month && parsed.day) {
      setParsedPreview(parsed.time !== undefined ? `${parsed.label} ${parsed.time}` : parsed.label);
      setParsedValid(true);
    } else if (parsed) {
      // Month/year only — show but mark as needing more precision
      setParsedPreview(`${parsed.label} (need a specific day)`);
      setParsedValid(false);
    } else {
      setParsedPreview("Unrecognized date");
      setParsedValid(false);
    }
  };

  const handleTextKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const parsed = parseDate(textInput);
      if (parsed && parsed.type === "day" && parsed.month && parsed.day) {
        const iso = toIso(parsed.year, parsed.month, parsed.day);
        // A parsed time applies when the surface allows times (all-day turns
        // itself OFF — a timed value is not a full-day value).
        const time = showTime ? parsed.time : undefined;
        const current = draft[target];
        const slot: DatetimePickerSlot =
          time !== undefined ? { iso, time } : current?.time !== undefined ? { iso, time: current.time } : { iso };
        if (time !== undefined) {
          setTimeTexts((cur) => ({ ...cur, [target]: time }));
        }
        commitAndClose({ ...draft, [target]: slot });
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  // ── leaf selection ─────────────────────────────────────

  const handleDayClick = (day: number) => {
    commitAndClose(withPickedIso(toIso(currentYear, currentMonth + 1, day)));
  };

  const handleMonthPick = (month: number) => {
    commitAndClose(withPickedIso(toIso(currentYear, month + 1, 1)));
  };

  const handleYearPick = (year: number) => {
    commitAndClose(withPickedIso(toIso(year, 1, 1)));
  };

  const handleSuggestion = (offset: number) => {
    commitAndClose(withPickedIso(suggestionIso(offset)));
  };

  // ── all-day / range switches ───────────────────────────

  /** All-day ⇔ neither slot carries a time (one switch governs both). */
  const allDay = draft.start?.time === undefined;

  const toggleAllDay = (checked: boolean) => {
    if (checked === allDay) return;
    const mapSlot = (slot: DatetimePickerSlot | null): DatetimePickerSlot | null => {
      if (slot === null) return null;
      // All-day ON drops the time; OFF gives the slot a time (its own, else
      // the field's current text, else the 09:00 default).
      if (checked) return { iso: slot.iso };
      const time = slot.time ?? normalizeTime(timeTexts[target]) ?? "09:00";
      return { ...slot, time };
    };
    const next: DatetimePickerValue = {
      isRange: draft.isRange,
      start: mapSlot(draft.start),
      end: draft.isRange ? mapSlot(draft.end) : null,
    };
    // Synchronize the time fields with the (un)timed slots.
    setTimeTexts({
      start: next.start?.time ?? "09:00",
      end: next.end?.time ?? next.start?.time ?? "09:00",
    });
    void commitDraft(next);
  };

  const toggleRange = (checked: boolean) => {
    if (checked === draft.isRange) return;
    if (checked) {
      // Notion behavior: the end starts as a copy of the start.
      const end: DatetimePickerSlot | null =
        draft.start !== null ? { ...draft.start } : draft.end;
      const next: DatetimePickerValue = { isRange: true, start: draft.start, end };
      void commitDraft(next).then(() => setTarget("start"));
      return;
    }
    // Collapse to the point — start kept, end dropped, silently.
    const next: DatetimePickerValue = { isRange: false, start: draft.start, end: null };
    void commitDraft(next).then(() => setTarget("start"));
  };

  // ── time inputs ────────────────────────────────────────

  const handleTimeChange = (side: "start" | "end") => (e: React.ChangeEvent<HTMLInputElement>) => {
    const text = e.target.value;
    setTimeTexts((cur) => ({ ...cur, [side]: text }));
    const time = normalizeTime(text);
    if (time !== null && isValidTimeOfDay(time)) {
      const slot = draft[side];
      if (slot !== null && slot.time !== time) {
        void commitDraft({ ...draft, [side]: { ...slot, time } });
      }
    }
  };

  // ── remove ─────────────────────────────────────────────

  const handleRemove = () => {
    if (onRemove === undefined) return;
    void Promise.resolve(onRemove()).then(() => onClose());
  };

  // ── grid decorations ───────────────────────────────────

  const isToday = (day: number) =>
    day === today.getDate() &&
    currentMonth === today.getMonth() &&
    currentYear === today.getFullYear();

  const isSelected = (day: number) => {
    const sel = draft[target];
    if (sel === null) return false;
    const parsed = parseIso(sel.iso);
    if (parsed === null) return false;
    return parsed.year === currentYear && parsed.month - 1 === currentMonth && parsed.day === day;
  };

  const hasNote = (day: number) => markedDates?.has(`${currentYear}-${currentMonth}-${day}`) ?? false;

  const formatDayLabel = (day: number) => {
    return new Date(currentYear, currentMonth, day).toLocaleDateString(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  };

  const targetSlot = draft[target];

  /** The time field for one slot (rendered when all-day is OFF). */
  const timeInput = (side: "start" | "end", label: string) => (
    <input
      type="text"
      inputMode="numeric"
      className="date-picker-time-input"
      aria-label={label}
      placeholder="HH:MM"
      value={timeTexts[side]}
      onChange={handleTimeChange(side)}
    />
  );

  const popup = (
    <div
      className={`date-picker-popup${className ? ` ${className}` : ""}`}
      ref={popupRef}
      role="dialog"
      aria-label="Date picker"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
      style={
        position
          ? { top: position.top, left: position.left }
          : { visibility: "hidden" }
      }
    >
      <div className="date-picker-body">
        {/* ── left: the text field + the zoom grids ── */}
        <div className="date-picker-calendar">
          {/* Text input (natural language + optional time) */}
          <div className="date-picker-input-row">
            <span className="date-picker-input-icon" aria-hidden="true">
              <Icon path="mdi-calendar" size={0.8} />
            </span>
            <input
              ref={inputRef}
              className="date-picker-text-input"
              type="text"
              placeholder='Type a date… "today", "Feb 14", "next week"'
              aria-label="Type a date"
              value={textInput}
              onChange={handleTextChange}
              onKeyDown={handleTextKeyDown}
            />
          </div>

          {/* Parsed preview (or the edited slot's current value) */}
          {parsedPreview && (
            <div className={`date-picker-preview ${parsedValid ? "" : "date-picker-preview--invalid"}`}>
              {parsedValid ? `↵ ${parsedPreview}` : parsedPreview}
            </div>
          )}

          {/* Insert error (kept visible so a failed selection doesn't close silently) */}
          {errorMessage && (
            <div className="date-picker-error" role="alert">
              {errorMessage}
            </div>
          )}

          {/* month ⌄ / year ⌄ dropdown header + ‹ › navigation */}
          <div className="calendar-header date-picker-header">
            <div className="calendar-nav-row">
              <button
                type="button"
                aria-label="Previous"
                className="calendar-nav-btn"
                onClick={goPrev}
              >
                <Icon path="mdi-chevron-left" size={0.7} />
              </button>
              <div className="calendar-title">
                {mode === "days" && (
                  <>
                    <button
                      type="button"
                      className="calendar-title-btn calendar-title-btn--month"
                      onClick={() => setMode("months")}
                      aria-label="Choose month"
                    >
                      {MONTHS_FULL[currentMonth]}
                      <Icon path="mdi-chevron-down" size={0.6} />
                    </button>
                    <button
                      type="button"
                      className="calendar-title-btn"
                      onClick={() => setMode("years")}
                      aria-label="Choose year"
                    >
                      {currentYear}
                      <Icon path="mdi-chevron-down" size={0.6} />
                    </button>
                  </>
                )}
                {mode === "months" && (
                  <button
                    type="button"
                    className="calendar-title-btn"
                    onClick={() => setMode("years")}
                    aria-label="Choose year"
                  >
                    {currentYear}
                    <Icon path="mdi-chevron-down" size={0.6} />
                  </button>
                )}
                {mode === "years" && (
                  <span className="calendar-year-range">
                    {yearWindowStart}–{yearWindowStart + 11}
                  </span>
                )}
              </div>
              <button
                type="button"
                aria-label="Next"
                className="calendar-nav-btn"
                onClick={goNext}
              >
                <Icon path="mdi-chevron-right" size={0.7} />
              </button>
            </div>
          </div>

          {mode === "days" && (
            <DaysGrid
              currentYear={currentYear}
              currentMonth={currentMonth}
              firstDayOfWeek={firstDayOfWeek}
              isToday={isToday}
              hasNote={hasNote}
              isSelected={isSelected}
              formatDayLabel={formatDayLabel}
              onSelectDay={handleDayClick}
            />
          )}

          {mode === "months" && <MonthsGrid onSelectMonth={handleMonthPick} />}

          {mode === "years" && (
            <YearsGrid yearWindowStart={yearWindowStart} onSelectYear={handleYearPick} />
          )}

          {/* Footer: Today shortcut (view navigation) */}
          <div className="calendar-footer">
            <button className="calendar-today-btn" type="button" onClick={goToday} aria-label="Go to today">
              Today
            </button>
          </div>
        </div>

        {/* ── right: Suggestions / All-day / Range / Repeat / Remove ── */}
        <div className="date-picker-side">
          <div className="date-picker-side-title">Suggestions</div>
          <ul className="date-picker-suggestions">
            {SUGGESTIONS.map((s) => {
              const iso = suggestionIso(s.offset);
              const active = targetSlot !== null && targetSlot.iso === iso;
              return (
                <li key={s.label}>
                  <button
                    type="button"
                    className={`date-picker-suggestion${active ? " date-picker-suggestion--active" : ""}`}
                    onClick={() => handleSuggestion(s.offset)}
                  >
                    <span>{s.label}</span>
                    {active && <Icon path="mdi-check" size={0.7} />}
                  </button>
                </li>
              );
            })}
          </ul>

          {showTime && (
            <div className="date-picker-row">
              <BooleanToggle
                size="sm"
                label="All-day"
                labelPosition="left"
                checked={allDay}
                onChange={(e) => toggleAllDay(e.target.checked)}
              />
            </div>
          )}

          {showTime && !allDay && !draft.isRange && (
            <div className="date-picker-row date-picker-time-row">
              <span className="date-picker-row-label">Time</span>
              {timeInput("start", "Time")}
            </div>
          )}

          {allowRange && (
            <div className="date-picker-row">
              <BooleanToggle
                size="sm"
                label="Range"
                labelPosition="left"
                checked={draft.isRange}
                onChange={(e) => toggleRange(e.target.checked)}
              />
            </div>
          )}

          {allowRange && draft.isRange && (
            <div className="date-picker-slots">
              {(["start", "end"] as const).map((side) => (
                <div className="date-picker-slot-row" key={side}>
                  <span className="date-picker-row-label">
                    {side === "start" ? "Start" : "End"}
                  </span>
                  <button
                    type="button"
                    className={`date-picker-slot-btn${target === side ? " date-picker-slot-btn--target" : ""}`}
                    aria-label={`${side === "start" ? "Start" : "End"} date`}
                    aria-pressed={target === side}
                    onClick={() => setTarget(side)}
                  >
                    {draft[side] !== null ? draft[side]!.iso : "Select"}
                  </button>
                  {showTime && !allDay && timeInput(side, `${side === "start" ? "Start" : "End"} time`)}
                </div>
              ))}
            </div>
          )}

          {onRepeatChange !== undefined && dayPrecision && (
            <div className="date-picker-row date-picker-repeat-row">
              <span className="date-picker-row-label">Repeat</span>
              <RepeatPicker
                value={repeat}
                onChange={onRepeatChange}
                ariaLabel="Repeat"
              />
            </div>
          )}

          {onRemove !== undefined && (
            <button type="button" className="date-picker-remove" onClick={handleRemove}>
              <Icon path="mdi-delete-outline" size={0.8} />
              <span>Remove</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(popup, document.body);
}
