/**
 * CalendarDayGrid — the one day-grid implementation behind every calendar
 * surface (§34.28 #3: the top-bar CalendarPopup and the Calendar view's
 * MonthCalendar panel share it — no third calendar family). Renders the
 * Mo–Su weekday header + the visible month's day cells, with the popup's
 * established token treatment: today filled (`calendar-day today`), a
 * has-note day on the primary container (`calendar-day has-note`), and the
 * panel's selected day outlined (`calendar-day selected`).
 */

import { useMemo } from "react";

import { Button } from "../Button.js";
import "./calendar-grid.css";

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Local `YYYY-MM-DD` for a year/month(0-indexed)/day triple. */
export function isoLocal(year: number, month0: number, day: number): string {
  return `${year}-${String(month0 + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Day cells of the visible month: null = padding slot. */
export function useMonthDays(
  year: number,
  month0: number,
  firstDayOfWeek: number,
): Array<number | null> {
  return useMemo(() => {
    const firstDayOfMonth = new Date(year, month0, 1).getDay();
    const daysInMonth = new Date(year, month0 + 1, 0).getDate();
    const lead = (firstDayOfMonth - firstDayOfWeek + 7) % 7;
    const cells: Array<number | null> = Array.from({ length: lead }, () => null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(d);
    return cells;
  }, [year, month0, firstDayOfWeek]);
}

/** Weekday initials honoring the first-day-of-week device setting. */
export function useWeekdayHeader(firstDayOfWeek: number): string[] {
  return useMemo(
    () => Array.from({ length: 7 }, (_, i) => WEEKDAYS[(firstDayOfWeek + i) % 7]!),
    [firstDayOfWeek],
  );
}

export interface CalendarDayGridProps {
  year: number;
  /** 0-indexed month. */
  month: number;
  /** First day of the week (0 = Sunday, 1 = Monday, …). */
  firstDayOfWeek?: number;
  /** A day cell is marked "has-note" when the day page exists locally. */
  hasNote?: ((isoDate: string) => boolean) | undefined;
  /** The panel's outlined day (local YYYY-MM-DD); null = no selection mark. */
  selectedDate?: string | null | undefined;
  onSelectDay: (isoDate: string) => void;
}

export function CalendarDayGrid({
  year,
  month,
  firstDayOfWeek = 1,
  hasNote,
  selectedDate = null,
  onSelectDay,
}: CalendarDayGridProps) {
  const days = useMonthDays(year, month, firstDayOfWeek);
  const weekdayHeader = useWeekdayHeader(firstDayOfWeek);

  const today = new Date();
  const isTodayMonth = month === today.getMonth() && year === today.getFullYear();

  return (
    <>
      <div className="calendar-weekdays">
        {weekdayHeader.map((name, i) => (
          <span key={`${name}-${i}`} className="calendar-weekday">
            {name}
          </span>
        ))}
      </div>
      <div className="calendar-days">
        {days.map((day, index) =>
          day === null ? (
            <span key={`pad-${index}`} className="calendar-day-cell" aria-hidden="true" />
          ) : (
            <span key={day} className="calendar-day-cell">
              <Button
                variant="ghost"
                size="sm"
                aria-label={new Date(year, month, day).toLocaleDateString(undefined, {
                  weekday: "long",
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                })}
                className={`calendar-day${isTodayMonth && day === today.getDate() ? " today" : ""}${
                  hasNote?.(isoLocal(year, month, day)) === true ? " has-note" : ""
                }${selectedDate === isoLocal(year, month, day) ? " selected" : ""}`}
                onClick={() => onSelectDay(isoLocal(year, month, day))}
              >
                {day}
              </Button>
            </span>
          ),
        )}
      </div>
    </>
  );
}
