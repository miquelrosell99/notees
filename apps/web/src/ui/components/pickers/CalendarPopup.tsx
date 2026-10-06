/**
 * Calendar popup component (controlled)
 *
 * Renders a days/months/years drill-down for navigating daily pages. This base
 * component is domain-agnostic: it accepts `firstDayOfWeek`, `markedDates`,
 * and selection callbacks as props — callers wire it to the workspace data.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { useViewportPosition } from "./useViewportPosition.js";
import { usePopupDismissal } from "../ui/usePopupDismissal.js";
import { useCalendarMode, type CalendarMode } from "./calendar/useCalendarMode.js";
import { CalendarHeader, DaysGrid, MonthsGrid, YearsGrid } from "./calendar/CalendarGrids.js";
import "./CalendarPopup.css";

export interface CalendarPopupProps {
  /** Whether the popup is visible */
  isOpen: boolean;
  /** Called when the popup should close */
  onClose: () => void;
  /** Ref to the anchor element used for positioning */
  anchorRef?: React.RefObject<HTMLElement | null>;
  /** When incremented, navigates the calendar to today's month with accent pulse */
  goToTodaySignal?: number;
  /** Initial drill-down level (defaults to the day grid) */
  initialMode?: CalendarMode;
  /** Index of the first day of the week (0 = Sunday, 1 = Monday, ...) */
  firstDayOfWeek: number;
  /** Day keys (`y-m0-d`, 0-indexed month) already backed by a daily page */
  markedDates?: ReadonlySet<string>;
  /** Called when the user selects a day */
  onSelectDay: (date: Date) => void;
  /** Called when the user selects a month (0-indexed month) */
  onSelectMonth: (year: number, month: number) => void;
  /** Called when the user selects a year */
  onSelectYear: (year: number) => void;
}

export function CalendarPopup({
  isOpen,
  onClose,
  anchorRef,
  goToTodaySignal,
  initialMode,
  firstDayOfWeek,
  markedDates,
  onSelectDay,
  onSelectMonth,
  onSelectYear,
}: CalendarPopupProps) {
  const today = new Date();
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
    initialYear: today.getFullYear(),
    initialMonth: today.getMonth(),
  });
  const [todayAccent, setTodayAccent] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const fallbackAnchorRef = useRef<HTMLElement | null>(null);
  const anchor = anchorRef ?? fallbackAnchorRef;

  // Position popup with viewport flip. The rendered popup is measured via
  // popupRef for exact flip/clamp decisions.
  const position = useViewportPosition(anchor, isOpen, {
    popupRef,
    edgePadding: 16,
  });

  // Dismissal: pointer-down outside (the anchor trigger counts as
  // inside) and Escape — the root handler below covers Escape while focus is
  // on a day/month/year button, the hook covers Escape from elsewhere.
  usePopupDismissal({
    popupRef,
    anchorRefs: [anchor],
    isOpen,
    onClose,
  });

  // Navigate to today when signal changes (shift+click from parent)
  useEffect(() => {
    if (goToTodaySignal && goToTodaySignal > 0) {
      goToday();
      setTodayAccent(true);
      const t = setTimeout(() => setTodayAccent(false), 1200);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [goToTodaySignal]); // eslint-disable-line react-hooks/exhaustive-deps -- goToday is a stable useCallback.

  if (!isOpen) return null;

  const isToday = (day: number) => {
    return (
      day === today.getDate() &&
      currentMonth === today.getMonth() &&
      currentYear === today.getFullYear()
    );
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

  return (
    <div
      className="calendar-popup"
      ref={popupRef}
      role="dialog"
      aria-label="Calendar"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
      style={
        position
          ? {
              position: "fixed",
              top: position.top,
              left: position.left,
            }
          : { position: "fixed", visibility: "hidden" }
      }
    >
      <CalendarHeader
        mode={mode}
        currentYear={currentYear}
        currentMonth={currentMonth}
        yearWindowStart={yearWindowStart}
        onPrev={goPrev}
        onNext={goNext}
        onModeChange={setMode}
        onOpenMonth={() => onSelectMonth(currentYear, currentMonth)}
        onOpenYear={() => onSelectYear(currentYear)}
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
          todayAccent={todayAccent}
          formatDayLabel={formatDayLabel}
          onSelectDay={(day) => onSelectDay(new Date(currentYear, currentMonth, day))}
        />
      )}

      {mode === "months" && (
        <MonthsGrid
          currentMonth={currentMonth}
          onSelectMonth={(month) => onSelectMonth(currentYear, month)}
        />
      )}

      {mode === "years" && (
        <YearsGrid
          yearWindowStart={yearWindowStart}
          currentYear={currentYear}
          onSelectYear={onSelectYear}
        />
      )}
    </div>
  );
}
