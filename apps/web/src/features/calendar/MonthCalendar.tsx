/**
 * MonthCalendar — the Calendar view's right-column month panel (and the
 * reusable month-grid primitive, exported through the ui barrel). Built
 * INSIDE the first calendar family: it drives the same
 * useCalendarMode navigation as the top-bar CalendarPopup and renders days
 * through the shared CalendarDayGrid — the popup and this panel share one
 * day-grid implementation, and the pickers/ family stays untouched.
 *
 * Chrome: prev/next period stepping, a days/months/years zoom
 * (SelectionButton, the popup's control), the month + year title rendered
 * as two separate elements like the popup's (owner 2026-10-23), and the
 * Mo–Su weekday header honoring the first-day-of-week device setting.
 * Clicking a day selects it (the host owns what selection means); the
 * visible month follows the selected date across month boundaries. The
 * panel's own Today button retired (owner 2026-10-23): the view's top bar
 * already jumps to today.
 */

import { useEffect } from "react";

import { Button } from "../../components/ui/fleet/Button.js";
import { SelectionButton } from "../../components/ui/fleet/SelectionButton.js";
import { CalendarDayGrid, MONTHS_SHORT, type CalendarDayExtraMarks } from "./dayGrid.js";
import { useCalendarMode } from "./useCalendarMode.js";
import "./MonthCalendar.css";

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

  return (
    <section className="month-calendar" aria-label="Month calendar">
      <div className="month-calendar__header">
        <Button
          variant="ghost"
          size="sm"
          icon="mdi-chevron-left"
          aria-label="Previous period"
          onClick={goPrev}
        />
        <span className="month-calendar__title">
          {mode === "days" && (
            <>
              <span className="month-calendar__title-month">{MONTHS_SHORT[currentMonth]}</span>
              <span className="month-calendar__title-year">{currentYear}</span>
            </>
          )}
          {mode === "months" && (
            <span className="month-calendar__title-year">{currentYear}</span>
          )}
          {mode === "years" && (
            <span className="month-calendar__title-year">
              {yearWindowStart}–{yearWindowStart + 11}
            </span>
          )}
        </span>
        <Button
          variant="ghost"
          size="sm"
          icon="mdi-chevron-right"
          aria-label="Next period"
          onClick={goNext}
        />
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
