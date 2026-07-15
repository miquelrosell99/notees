/**
 * Calendar popup component (controlled)
 *
 * Renders a days/months/years drill-down for navigating daily pages. This base
 * component is domain-agnostic: it accepts `firstDayOfWeek`, `dailyPages`, and
 * selection callbacks as props. Feature code should use the wrapper in
 * `features/content/components/CalendarPopup.tsx` to wire stores/hooks.
 */
import { useState, useRef, useEffect, useMemo } from 'react';
import { useViewportFlip } from '@/hooks/useViewportFlip';
import { useCalendarMode, type CalendarMode } from './calendar/useCalendarMode';
import { CalendarHeader, DaysGrid, MonthsGrid, YearsGrid } from './calendar/CalendarGrids';
import './CalendarPopup.css';

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
  /** Existing daily pages used to mark days that already have notes */
  dailyPages: Array<{ uuid: string }>;
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
  dailyPages,
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

  // Position popup with viewport flip. Floating UI measures the rendered popup
  // via popupRef for exact flip/clamp decisions.
  const position = useViewportFlip(
    anchorRef as React.RefObject<HTMLElement>,
    isOpen,
    { popupRef, popupHeight: 350, fixed: true },
  );

  // Create a set of dates that have daily pages for the current month
  const existingDates = useMemo(() => {
    const dates = new Set<string>();
    for (const page of dailyPages) {
      // UUID format is: 00000000-0000-0000-00dd-YYYYMMDD0000
      // Extract the date from the last segment
      if (page.uuid) {
        const match = page.uuid.match(/(\d{4})(\d{2})(\d{2})0000$/);
        if (match) {
          const year = parseInt(match[1]);
          const month = parseInt(match[2]) - 1; // 0-indexed
          const day = parseInt(match[3]);

          // Only include dates from the currently displayed month
          if (year === currentYear && month === currentMonth) {
            dates.add(`${year}-${month}-${day}`);
          }
        }
      }
    }
    return dates;
  }, [dailyPages, currentYear, currentMonth]);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;

    function handleClickOutside(e: MouseEvent) {
      if (
        popupRef.current &&
        !popupRef.current.contains(e.target as Node) &&
        anchorRef?.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose, anchorRef]);

  // Navigate to today when signal changes (shift+click from parent)
  useEffect(() => {
    if (goToTodaySignal && goToTodaySignal > 0) {
      goToday();
      setTodayAccent(true);
      setTimeout(() => setTodayAccent(false), 1200);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goToTodaySignal]);

  if (!isOpen) return null;

  const isToday = (day: number) => {
    return (
      day === today.getDate() &&
      currentMonth === today.getMonth() &&
      currentYear === today.getFullYear()
    );
  };

  const hasNote = (day: number) => existingDates.has(`${currentYear}-${currentMonth}-${day}`);

  const formatDayLabel = (day: number) => {
    return new Date(currentYear, currentMonth, day).toLocaleDateString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  return (
    <div
      className="calendar-popup"
      ref={popupRef}
      style={position ? {
        position: 'fixed',
        top: position.top,
        left: position.left,
      } : { position: 'fixed', visibility: 'hidden' }}
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

      {mode === 'days' && (
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

      {mode === 'months' && (
        <MonthsGrid
          currentMonth={currentMonth}
          onSelectMonth={(month) => onSelectMonth(currentYear, month)}
        />
      )}

      {mode === 'years' && (
        <YearsGrid
          yearWindowStart={yearWindowStart}
          currentYear={currentYear}
          onSelectYear={onSelectYear}
        />
      )}
    </div>
  );
}
