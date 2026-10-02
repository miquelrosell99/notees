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
 *
 * The days grid renders through the shared CalendarDayGrid (§34.28 #3 —
 * one day-grid implementation for the popup and the Calendar view's
 * MonthCalendar panel).
 */

import { useRef, type CSSProperties, type RefObject } from "react";

import { Button } from "./Button.js";
import { SelectionButton } from "./SelectionButton.js";
import {
  useClickOutside,
  useOverlaySurface,
  useViewportFlip,
} from "./overlay-hooks.js";
import { CalendarDayGrid, MONTHS_SHORT } from "./calendar/dayGrid.js";
import { useCalendarMode } from "./calendar/useCalendarMode.js";
import "./CalendarPopup.css";

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
        <CalendarDayGrid
          year={currentYear}
          month={currentMonth}
          firstDayOfWeek={firstDayOfWeek}
          hasNote={hasNote}
          onSelectDay={onSelectDay}
        />
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
