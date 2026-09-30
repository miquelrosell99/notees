/**
 * CalendarPopup — the top-bar calendar: a days/months/years picker that
 * opens date pages. Faithful port of the archived calendar popup, rewired
 * to this app's primitives (Button, SelectionButton, useViewportFlip) and
 * to a callback existence check: a day cell is marked "has-note" when the
 * parent resolves its deterministic date-node id in the local store.
 *
 * Picking a day/month/year is navigation: the parent ensures the date
 * chain and opens the page (get-or-create, exactly like the archived
 * behavior), then closes this popup.
 */

import { useMemo, useRef, type CSSProperties, type RefObject } from "react";

import { Button } from "./Button.js";
import { SelectionButton } from "./SelectionButton.js";
import {
  useClickOutside,
  useOverlaySurface,
  useViewportFlip,
} from "./overlay-hooks.js";
import { useCalendarMode } from "./calendar/useCalendarMode.js";
import "./CalendarPopup.css";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Local `YYYY-MM-DD` for a year/month(0-indexed)/day triple. */
function isoLocal(year: number, month0: number, day: number): string {
  return `${year}-${String(month0 + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export interface CalendarPopupProps {
  isOpen: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  /** First day of the week (0 = Sunday, 1 = Monday, …). */
  firstDayOfWeek?: number;
  /** Whether the day page for a local `YYYY-MM-DD` exists in the workspace. */
  hasNote: (isoDate: string) => boolean;
  /** Open the day page for a local `YYYY-MM-DD` (ensure-chain + navigate). */
  onSelectDay: (isoDate: string) => void;
  /** Open the month page (month is 1-indexed). */
  onSelectMonth: (year: number, month: number) => void;
  onSelectYear: (year: number) => void;
}

export function CalendarPopup({
  isOpen,
  onClose,
  anchorRef,
  firstDayOfWeek = 1,
  hasNote,
  onSelectDay,
  onSelectMonth,
  onSelectYear,
}: CalendarPopupProps) {
  const popupRef = useRef<HTMLDivElement>(null);
  const { mode, currentYear, currentMonth, yearWindowStart, setMode, goPrev, goNext } =
    useCalendarMode({});
  const position = useViewportFlip(anchorRef, isOpen, {
    popupRef,
    popupHeight: 350,
    fixed: true,
  });

  useClickOutside([popupRef, anchorRef], onClose, isOpen);
  useOverlaySurface({ type: "popup", enabled: isOpen, onClose });

  const today = new Date();
  const isToday = (day: number) =>
    day === today.getDate() &&
    currentMonth === today.getMonth() &&
    currentYear === today.getFullYear();

  /** Day cells of the visible month: null = padding slot. */
  const days = useMemo(() => {
    const firstDayOfMonth = new Date(currentYear, currentMonth, 1).getDay();
    const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
    const lead = (firstDayOfMonth - firstDayOfWeek + 7) % 7;
    const cells: Array<number | null> = Array.from({ length: lead }, () => null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(d);
    return cells;
  }, [currentYear, currentMonth, firstDayOfWeek]);

  const weekdayHeader = useMemo(
    () => Array.from({ length: 7 }, (_, i) => WEEKDAYS[(firstDayOfWeek + i) % 7]),
    [firstDayOfWeek],
  );

  if (!isOpen) return null;

  const style: CSSProperties = position
    ? { top: position.top, left: position.left, visibility: "visible" }
    : { visibility: "hidden" };

  return (
    <div className="calendar-popup" role="dialog" aria-label="Calendar" ref={popupRef} style={style}>
      <div className="calendar-header">
        <div className="calendar-nav-row">
          <button type="button" className="calendar-nav-btn" aria-label="Previous period" onClick={goPrev}>
            <span className="mdi mdi-chevron-left" aria-hidden="true" />
          </button>
          <div className="calendar-title">
            {mode === "days" && (
              <>
                <button
                  type="button"
                  className="calendar-title-btn calendar-title-btn--month"
                  title="Open monthly page"
                  onClick={() => onSelectMonth(currentYear, currentMonth + 1)}
                >
                  {MONTHS_SHORT[currentMonth]}
                </button>
                <button
                  type="button"
                  className="calendar-title-btn"
                  title="Open yearly page"
                  onClick={() => onSelectYear(currentYear)}
                >
                  {currentYear}
                </button>
              </>
            )}
            {mode === "months" && (
              <button
                type="button"
                className="calendar-title-btn"
                title="Open yearly page"
                onClick={() => onSelectYear(currentYear)}
              >
                {currentYear}
              </button>
            )}
            {mode === "years" && (
              <span className="calendar-year-range">
                {yearWindowStart}–{yearWindowStart + 11}
              </span>
            )}
          </div>
          <button type="button" className="calendar-nav-btn" aria-label="Next period" onClick={goNext}>
            <span className="mdi mdi-chevron-right" aria-hidden="true" />
          </button>
        </div>
        <div className="calendar-zoom">
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
        </div>
      </div>

      {mode === "days" && (
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
                    aria-label={new Date(currentYear, currentMonth, day).toLocaleDateString(
                      undefined,
                      { weekday: "long", year: "numeric", month: "long", day: "numeric" },
                    )}
                    className={`calendar-day${isToday(day) ? " today" : ""}${
                      hasNote(isoLocal(currentYear, currentMonth, day)) ? " has-note" : ""
                    }`}
                    onClick={() => onSelectDay(isoLocal(currentYear, currentMonth, day))}
                  >
                    {day}
                  </Button>
                </span>
              ),
            )}
          </div>
        </>
      )}

      {mode === "months" && (
        <div className="calendar-months">
          {MONTHS_SHORT.map((name, month0) => (
            <Button
              key={name}
              variant="ghost"
              size="sm"
              aria-label={name}
              className="calendar-month"
              onClick={() => onSelectMonth(currentYear, month0 + 1)}
            >
              {name}
            </Button>
          ))}
        </div>
      )}

      {mode === "years" && (
        <div className="calendar-years">
          {Array.from({ length: 12 }, (_, i) => yearWindowStart + i).map((year) => (
            <Button
              key={year}
              variant="ghost"
              size="sm"
              aria-label={String(year)}
              className="calendar-year-pick"
              onClick={() => onSelectYear(year)}
            >
              {year}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
