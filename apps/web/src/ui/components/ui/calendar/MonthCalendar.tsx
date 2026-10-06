/**
 * MonthCalendar — the Calendar view's right-column month panel (and the
 * reusable month-grid primitive, exported through the ui barrel). Built
 * INSIDE the first calendar family: it drives the same
 * useCalendarMode navigation as the top-bar CalendarPopup and renders days
 * through the shared CalendarDayGrid — the popup and this panel share one
 * day-grid implementation, and the pickers/ family stays untouched.
 *
 * Chrome: prev/next period stepping, a days/months/years zoom
 * (SelectionButton, the popup's control), a Today button, and the Mo–Su
 * weekday header honoring the first-day-of-week device setting. Clicking a
 * day selects it (the host owns what selection means); the visible month
 * follows the selected date across month boundaries.
 */

import { useEffect } from "react";

import { Button } from "../Button.js";
import { SelectionButton } from "../SelectionButton.js";
import { CalendarDayGrid, MONTHS_SHORT, isoLocal, type CalendarDayExtraMarks } from "./dayGrid.js";
import { useCalendarMode } from "./useCalendarMode.js";
import "./MonthCalendar.css";

function todayLocal(): { year: number; month: number; iso: string } {
  const now = new Date();
  return {
    year: now.getFullYear(),
    month: now.getMonth(),
    iso: isoLocal(now.getFullYear(), now.getMonth(), now.getDate()),
  };
}

export interface MonthCalendarProps {
  /** The selected day (local YYYY-MM-DD); the grid outlines it. */
  selectedDate: string;
  /** Day pick: the host updates its selection. */
  onSelectDate: (isoDate: string) => void;
  /** First day of the week (0 = Sunday, 1 = Monday, …). */
  firstDayOfWeek?: number;
  /** Whether the day page for a local YYYY-MM-DD exists in the workspace. */
  hasNote: (isoDate: string) => boolean;
  /** Secondary marks beyond has-note (range-aware dots, reviewed). */
  extraMarks?: ((isoDate: string) => CalendarDayExtraMarks) | undefined;
}

export function MonthCalendar({
  selectedDate,
  onSelectDate,
  firstDayOfWeek = 1,
  hasNote,
  extraMarks,
}: MonthCalendarProps) {
  const [year, month] = (() => {
    const [y, m] = selectedDate.split("-").map(Number);
    return [y!, m! - 1];
  })();
  const { mode, currentYear, currentMonth, yearWindowStart, setMode, goPrev, goNext, goTo } =
    useCalendarMode({ initialYear: year, initialMonth: month });

  // The visible period follows the selected date across month boundaries
  // (prev/next day, quick-create from another surface, a deep link).
  useEffect(() => {
    if (currentYear !== year || currentMonth !== month) goTo(year, month);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follow selection only
  }, [selectedDate]);

  const today = todayLocal();
  const goToday = () => {
    onSelectDate(today.iso);
    goTo(today.year, today.month);
    setMode("days");
  };

  const title =
    mode === "days"
      ? `${MONTHS_SHORT[currentMonth]} ${currentYear}`
      : mode === "months"
        ? String(currentYear)
        : `${yearWindowStart}–${yearWindowStart + 11}`;

  return (
    <section className="month-calendar" aria-label="Month calendar">
      <div className="month-calendar__header">
        <button
          type="button"
          className="month-calendar__nav"
          aria-label="Previous period"
          onClick={goPrev}
        >
          <span className="mdi mdi-chevron-left" aria-hidden="true" />
        </button>
        <span className="month-calendar__title">{title}</span>
        <button
          type="button"
          className="month-calendar__nav"
          aria-label="Next period"
          onClick={goNext}
        >
          <span className="mdi mdi-chevron-right" aria-hidden="true" />
        </button>
        <span className="month-calendar__zoom">
          <SelectionButton
            size="sm"
            options={[
              { value: "days", icon: "mdi-calendar", label: "Days" },
              { value: "months", icon: "mdi-calendar-month", label: "Months" },
              { value: "years", icon: "mdi-calendar-range", label: "Years" },
            ]}
            value={mode}
            onChange={(value) => setMode(value as "days" | "months" | "years")}
          />
        </span>
        <Button variant="ghost" size="sm" className="month-calendar__today" onClick={goToday}>
          Today
        </Button>
      </div>

      {mode === "days" && (
        <CalendarDayGrid
          year={currentYear}
          month={currentMonth}
          firstDayOfWeek={firstDayOfWeek}
          hasNote={hasNote}
          extraMarks={extraMarks}
          selectedDate={selectedDate}
          onSelectDay={onSelectDate}
        />
      )}

      {mode === "months" && (
        <div className="month-calendar__grid month-calendar__grid--months">
          {MONTHS_SHORT.map((name, month0) => (
            <Button
              key={name}
              variant="ghost"
              size="sm"
              aria-label={name}
              className={`month-calendar__pick${
                month0 === currentMonth && currentYear === year ? " current" : ""
              }`}
              onClick={() => {
                goTo(currentYear, month0);
                setMode("days");
              }}
            >
              {name}
            </Button>
          ))}
        </div>
      )}

      {mode === "years" && (
        <div className="month-calendar__grid month-calendar__grid--years">
          {Array.from({ length: 12 }, (_, i) => yearWindowStart + i).map((pickYear) => (
            <Button
              key={pickYear}
              variant="ghost"
              size="sm"
              aria-label={String(pickYear)}
              className={`month-calendar__pick${pickYear === year ? " current" : ""}`}
              onClick={() => {
                goTo(pickYear, currentMonth);
                setMode("days");
              }}
            >
              {pickYear}
            </Button>
          ))}
        </div>
      )}
    </section>
  );
}
