/**
 * Calendar popup component (controlled)
 *
 * Renders a month grid for navigating daily pages. This base component is
 * domain-agnostic: it accepts `firstDayOfWeek`, `dailyPages`, and selection
 * callbacks as props. Feature code should use the wrapper in
 * `features/content/components/CalendarPopup.tsx` to wire stores/hooks.
 */
import { useState, useRef, useEffect, useMemo } from 'react';
import { useViewportFlip } from '@/hooks/useViewportFlip';
import { Button } from './Button';
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
  /** Index of the first day of the week (0 = Sunday, 1 = Monday, ...) */
  firstDayOfWeek: number;
  /** Existing daily pages used to mark days that already have notes */
  dailyPages: Array<{ uuid: string }>;
  /** Called when the user selects a day */
  onSelectDay: (date: Date) => void;
  /** Called when the user clicks the month header */
  onSelectMonth: (year: number, month: number) => void;
  /** Called when the user clicks the year header */
  onSelectYear: (year: number) => void;
}

const ALL_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
}

export function CalendarPopup({
  isOpen,
  onClose,
  anchorRef,
  goToTodaySignal,
  firstDayOfWeek,
  dailyPages,
  onSelectDay,
  onSelectMonth,
  onSelectYear,
}: CalendarPopupProps) {
  const today = new Date();
  const [currentMonth, setCurrentMonth] = useState(today.getMonth());
  const [currentYear, setCurrentYear] = useState(today.getFullYear());
  const [todayAccent, setTodayAccent] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);

  // Position popup with viewport flip
  const position = useViewportFlip(
    anchorRef as React.RefObject<HTMLElement>,
    isOpen,
    { popupWidth: 280, popupHeight: 350, fixed: true },
  );

  // Rotate weekday labels so the configured first day appears first
  const WEEKDAYS = [
    ...ALL_WEEKDAYS.slice(firstDayOfWeek),
    ...ALL_WEEKDAYS.slice(0, firstDayOfWeek),
  ];

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
      setCurrentMonth(today.getMonth());
      setCurrentYear(today.getFullYear());
      setTodayAccent(true);
      setTimeout(() => setTodayAccent(false), 1200);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goToTodaySignal]);

  if (!isOpen) return null;

  const daysInMonth = getDaysInMonth(currentYear, currentMonth);
  const rawFirstDay = getFirstDayOfMonth(currentYear, currentMonth);
  // Shift offset so it's relative to the configured first day of week
  const firstDayOfMonth = (rawFirstDay - firstDayOfWeek + 7) % 7;

  const days: (number | null)[] = [];
  // Add empty slots for days before the first day of the month
  for (let i = 0; i < firstDayOfMonth; i++) {
    days.push(null);
  }
  // Add the days of the month
  for (let i = 1; i <= daysInMonth; i++) {
    days.push(i);
  }

  const goToPreviousMonth = () => {
    if (currentMonth === 0) {
      setCurrentMonth(11);
      setCurrentYear(currentYear - 1);
    } else {
      setCurrentMonth(currentMonth - 1);
    }
  };

  const goToNextMonth = () => {
    if (currentMonth === 11) {
      setCurrentMonth(0);
      setCurrentYear(currentYear + 1);
    } else {
      setCurrentMonth(currentMonth + 1);
    }
  };

  const handleDayClick = (day: number) => {
    onSelectDay(new Date(currentYear, currentMonth, day));
  };

  const isToday = (day: number) => {
    return (
      day === today.getDate() &&
      currentMonth === today.getMonth() &&
      currentYear === today.getFullYear()
    );
  };

  const hasNote = (day: number) => {
    return existingDates.has(`${currentYear}-${currentMonth}-${day}`);
  };

  const handleMonthClick = () => {
    onSelectMonth(currentYear, currentMonth);
  };

  const handleYearClick = () => {
    onSelectYear(currentYear);
  };

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
      } : undefined}
    >
      <div className="calendar-header">
        <Button variant="ghost" size="sm" icon="mdi mdi-chevron-left" aria-label="Previous month" className="calendar-nav-btn" onClick={goToPreviousMonth} />
        <div className="calendar-title">
          <Button
            variant="ghost"
            size="xs"
            className="calendar-month-btn"
            onClick={handleMonthClick}
            title={`Go to ${MONTHS[currentMonth]} ${currentYear} page`}
          >
            {MONTHS[currentMonth]}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            className="calendar-year-btn"
            onClick={handleYearClick}
            title={`Go to ${currentYear} page`}
          >
            {currentYear}
          </Button>
        </div>
        <Button variant="ghost" size="sm" icon="mdi mdi-chevron-right" aria-label="Next month" className="calendar-nav-btn" onClick={goToNextMonth} />
      </div>

      <div className="calendar-weekdays">
        {WEEKDAYS.map((day) => (
          <div key={day} className="calendar-weekday">
            {day}
          </div>
        ))}
      </div>

      <div className="calendar-days">
        {days.map((day, index) => (
          <div key={day !== null ? `day-${currentYear}-${currentMonth}-${day}` : `empty-${currentYear}-${currentMonth}-${index}`} className="calendar-day-cell">
            {day && (
              <Button
                variant="ghost"
                size="xs"
                className={`calendar-day ${isToday(day) ? `today${todayAccent ? ' accent-pulse' : ''}` : ''} ${hasNote(day) ? 'has-note' : ''}`}
                onClick={() => handleDayClick(day)}
                aria-selected={false}
                aria-label={formatDayLabel(day)}
              >
                {day}
              </Button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
