/**
 * DatePickerPopup — controlled calendar drill-down + text input for picking dates.
 *
 * Renders the same days/months/years drill-down as CalendarPopup plus a text
 * field that accepts typed dates and natural-language literals (today, tomorrow,
 * next week, next month, Feb 14, 2026-02-14, etc.). Picking a month or year
 * resolves to a canonical ISO (`YYYY-MM-01` / `YYYY-01-01`).
 *
 * This base component is domain-agnostic: it accepts `firstDayOfWeek` and
 * `markedDates` as props — callers wire it to the workspace data and map the
 * picked ISO date onto their model (the schema precision is the commit
 * ceiling at the data layer).
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { parseDate } from "./dateParser.js";
import { useViewportPosition } from "./useViewportPosition.js";
import { usePopupDismissal } from "../ui/usePopupDismissal.js";
import { useCalendarMode, type CalendarMode } from "./calendar/useCalendarMode.js";
import { CalendarHeader, DaysGrid, MonthsGrid, YearsGrid } from "./calendar/CalendarGrids.js";
import "./CalendarPopup.css"; // reuse grid styles from CalendarPopup
import "./DatePickerPopup.css"; // own additions

// ── helpers ──────────────────────────────────────────────

function toIso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseIso(iso: string): { year: number; month: number; day: number } | null {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return { year: parseInt(m[1]!, 10), month: parseInt(m[2]!, 10), day: parseInt(m[3]!, 10) };
}

// ── props ────────────────────────────────────────────────

export interface DatePickerPopupProps {
  /** Currently selected ISO date (YYYY-MM-DD) or empty */
  value?: string;
  /** Called when the user picks a date — receives YYYY-MM-DD. May be async; the popup waits for it to settle before closing so a slow or failing insert is not hidden by an early close. */
  onSelect: (isoDate: string) => void | Promise<void>;
  /** Called when the popup should close */
  onClose: () => void;
  /** Ref to the anchor element for positioning */
  anchorRef?: React.RefObject<HTMLElement | null>;
  /** Initial drill-down level (defaults to the day grid) */
  initialMode?: CalendarMode;
  /** Extra class on the popup root (e.g. to raise z-index when layered over a modal) */
  className?: string;
  /** Index of the first day of the week (0 = Sunday, 1 = Monday, ...) */
  firstDayOfWeek: number;
  /** Day keys (`y-m0-d`, 0-indexed month) already backed by a daily page */
  markedDates?: ReadonlySet<string>;
}

// ── component ────────────────────────────────────────────

export function DatePickerPopup({
  value,
  onSelect,
  onClose,
  anchorRef,
  initialMode,
  className,
  firstDayOfWeek,
  markedDates,
}: DatePickerPopupProps) {
  const today = new Date();

  // Derive initial month/year from value or today
  const initial = value ? parseIso(value) : null;
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
    initialMode,
    initialYear: initial?.year ?? today.getFullYear(),
    initialMonth: initial ? initial.month - 1 : today.getMonth(),
  });
  const [textInput, setTextInput] = useState("");
  const [parsedPreview, setParsedPreview] = useState<string | null>(null);
  const [parsedValid, setParsedValid] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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

  // Dismissal (§34.67): the document-level Escape half of the convention —
  // the text input and the popup root below still own Escape while focus is
  // inside (a pick must not be interrupted by a stray close), this hook
  // closes when focus never entered or left the popup.
  usePopupDismissal({ popupRef, isOpen: true, onClose });

  // ── text input parsing ─────────────────────────────────

  const handleTextChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setTextInput(val);

    if (!val.trim()) {
      setParsedPreview(null);
      setParsedValid(true);
      return;
    }

    const parsed = parseDate(val);
    if (parsed && parsed.type === "day" && parsed.month && parsed.day) {
      setParsedPreview(parsed.label);
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

  // Run onSelect and only close once it settles. onSelect may be async (e.g.
  // creating a date chain before linking its node); closing first would tear
  // the host down mid-insert and strand the insertion. On failure the popup
  // stays open and shows the error so the user can retry.
  const selectDate = async (iso: string) => {
    setErrorMessage(null);
    try {
      await onSelect(iso);
      onClose();
    } catch (err) {
      console.error("Date selection failed:", err);
      const message =
        err instanceof Error && err.message ? err.message : "Failed to insert date link";
      setErrorMessage(message);
    }
  };

  const handleTextKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const parsed = parseDate(textInput);
      if (parsed && parsed.type === "day" && parsed.month && parsed.day) {
        void selectDate(toIso(parsed.year, parsed.month, parsed.day));
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  // ── leaf selection ─────────────────────────────────────

  const handleDayClick = (day: number) => {
    void selectDate(toIso(currentYear, currentMonth + 1, day));
  };

  const handleMonthPick = (month: number) => {
    void selectDate(toIso(currentYear, month + 1, 1));
  };

  const handleYearPick = (year: number) => {
    void selectDate(toIso(year, 1, 1));
  };

  const isToday = (day: number) =>
    day === today.getDate() &&
    currentMonth === today.getMonth() &&
    currentYear === today.getFullYear();

  const isSelected = (day: number) => {
    if (!value) return false;
    const sel = parseIso(value);
    if (!sel) return false;
    return sel.year === currentYear && sel.month - 1 === currentMonth && sel.day === day;
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
      {/* Text input */}
      <div className="date-picker-input-row">
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

      {/* Parsed preview */}
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

      {/* Drill-down header (shared with CalendarPopup) */}
      <CalendarHeader
        mode={mode}
        currentYear={currentYear}
        currentMonth={currentMonth}
        yearWindowStart={yearWindowStart}
        onPrev={goPrev}
        onNext={goNext}
        onModeChange={setMode}
        prevLabel="Previous"
        nextLabel="Next"
      />

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

      {/* Footer: Today button */}
      <div className="calendar-footer">
        <button className="calendar-today-btn" type="button" onClick={goToday} aria-label="Go to today">
          Today
        </button>
      </div>
    </div>
  );

  return createPortal(popup, document.body);
}
