/**
 * Calendar popup component for navigating to daily pages
 */
import { useState, useRef, useEffect, useMemo } from 'react';
import { useDailyNote, useMonthlyNote, useYearlyNote, useExistingDailyPages } from '@/hooks';
import { useViewportFlip } from '@/hooks/useViewportFlip';
import { useNavigationStore, useSettingsStore } from '@/stores';
import { Button } from './Button';
import './CalendarPopup.css';

interface CalendarPopupProps {
  isOpen: boolean;
  onClose: () => void;
  anchorRef?: React.RefObject<HTMLElement>;
  /** When incremented, navigates the calendar to today's month with accent pulse */
  goToTodaySignal?: number;
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

export function CalendarPopup({ isOpen, onClose, anchorRef, goToTodaySignal }: CalendarPopupProps) {
  const today = new Date();
  const [currentMonth, setCurrentMonth] = useState(today.getMonth());
  const [currentYear, setCurrentYear] = useState(today.getFullYear());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [navigateToMonth, setNavigateToMonth] = useState<{ year: number; month: number } | null>(null);
  const [navigateToYear, setNavigateToYear] = useState<number | null>(null);
  const [todayAccent, setTodayAccent] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  
  // Position popup with viewport flip
  const position = useViewportFlip(
    anchorRef as React.RefObject<HTMLElement>,
    isOpen,
    { popupWidth: 280, popupHeight: 350, fixed: true },
  );
  
  const { openNode } = useNavigationStore();
  const { firstDayOfWeek } = useSettingsStore();

  // Rotate weekday labels so the configured first day appears first
  const WEEKDAYS = [
    ...ALL_WEEKDAYS.slice(firstDayOfWeek),
    ...ALL_WEEKDAYS.slice(0, firstDayOfWeek),
  ];
  
  // Fetch list of existing daily pages
  const { data: dailyPages } = useExistingDailyPages();
  
  // Create a set of dates that have daily pages for the current month
  const existingDates = useMemo(() => {
    if (!dailyPages) return new Set<string>();
    
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
  
  // Fetch daily note when a date is selected
  const { data: dailyNote } = useDailyNote(selectedDate ?? undefined);
  
  // Fetch monthly note when month is clicked
  const { data: monthlyNote } = useMonthlyNote(
    navigateToMonth?.year ?? 0,
    navigateToMonth ? navigateToMonth.month + 1 : 0 // API expects 1-12
  );
  
  // Fetch yearly note when year is clicked
  const { data: yearlyNote } = useYearlyNote(navigateToYear ?? 0);
  
  // Navigate to monthly page when loaded
  useEffect(() => {
    if (monthlyNote && navigateToMonth) {
      openNode(monthlyNote.id);
      onClose();
       
      setNavigateToMonth(null);
    }
  }, [monthlyNote, navigateToMonth, openNode, onClose]);
  
  // Navigate to yearly page when loaded
  useEffect(() => {
    if (yearlyNote && navigateToYear) {
      openNode(yearlyNote.id);
      onClose();
       
      setNavigateToYear(null);
    }
  }, [yearlyNote, navigateToYear, openNode, onClose]);
  
  // Navigate to daily page when loaded
  useEffect(() => {
    if (dailyNote && selectedDate) {
      openNode(dailyNote.id);
      onClose();
       
      setSelectedDate(null);
    }
  }, [dailyNote, selectedDate, openNode, onClose]);
  
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
        setTodayAccent(true);;
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
    const selected = new Date(currentYear, currentMonth, day);
    setSelectedDate(selected);
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
    setNavigateToMonth({ year: currentYear, month: currentMonth });
  };
  
  const handleYearClick = () => {
    setNavigateToYear(currentYear);
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
        <Button variant="ghost" size="sm" iconOnly icon="mdi mdi-chevron-left" aria-label="Previous month" className="calendar-nav-btn" onClick={goToPreviousMonth} />
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
        <Button variant="ghost" size="sm" iconOnly icon="mdi mdi-chevron-right" aria-label="Next month" className="calendar-nav-btn" onClick={goToNextMonth} />
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

