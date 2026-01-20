/**
 * Calendar popup component for navigating to daily pages
 */
import { useState, useRef, useEffect } from 'react';
import { useDailyNote, useMonthlyNote, useYearlyNote } from '@/hooks';
import { useNodesStore } from '@/stores';
import './CalendarPopup.css';

interface CalendarPopupProps {
  isOpen: boolean;
  onClose: () => void;
  anchorRef?: React.RefObject<HTMLElement>;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
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

export function CalendarPopup({ isOpen, onClose, anchorRef }: CalendarPopupProps) {
  const today = new Date();
  const [currentMonth, setCurrentMonth] = useState(today.getMonth());
  const [currentYear, setCurrentYear] = useState(today.getFullYear());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [navigateToMonth, setNavigateToMonth] = useState<{ year: number; month: number } | null>(null);
  const [navigateToYear, setNavigateToYear] = useState<number | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  
  const { openNode } = useNodesStore();
  
  // Calculate popup position based on anchor
  useEffect(() => {
    if (!isOpen || !anchorRef?.current) return;
    
    const anchorRect = anchorRef.current.getBoundingClientRect();
    const popupWidth = 280; // min-width from CSS
    const popupHeight = 350; // approximate height
    
    let top = anchorRect.bottom + 4;
    let left = anchorRect.left;
    
    // Ensure popup doesn't go off-screen to the right
    if (left + popupWidth > window.innerWidth - 16) {
      left = window.innerWidth - popupWidth - 16;
    }
    
    // Ensure popup doesn't go off-screen to the bottom
    if (top + popupHeight > window.innerHeight - 16) {
      top = anchorRect.top - popupHeight - 4;
    }
    
    setPosition({ top, left });
  }, [isOpen, anchorRef]);
  
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
      openNode(monthlyNote.id, 'page');
      onClose();
      setNavigateToMonth(null);
    }
  }, [monthlyNote, navigateToMonth, openNode, onClose]);
  
  // Navigate to yearly page when loaded
  useEffect(() => {
    if (yearlyNote && navigateToYear) {
      openNode(yearlyNote.id, 'page');
      onClose();
      setNavigateToYear(null);
    }
  }, [yearlyNote, navigateToYear, openNode, onClose]);
  
  // Navigate to daily page when loaded
  useEffect(() => {
    if (dailyNote && selectedDate) {
      openNode(dailyNote.id, 'page');
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
  
  if (!isOpen) return null;
  
  const daysInMonth = getDaysInMonth(currentYear, currentMonth);
  const firstDayOfMonth = getFirstDayOfMonth(currentYear, currentMonth);
  
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
        <button className="calendar-nav-btn" onClick={goToPreviousMonth}>
          ‹
        </button>
        <div className="calendar-title">
          <button 
            className="calendar-month-btn" 
            onClick={handleMonthClick}
            title={`Go to ${MONTHS[currentMonth]} ${currentYear} page`}
          >
            {MONTHS[currentMonth]}
          </button>
          <button 
            className="calendar-year-btn" 
            onClick={handleYearClick}
            title={`Go to ${currentYear} page`}
          >
            {currentYear}
          </button>
        </div>
        <button className="calendar-nav-btn" onClick={goToNextMonth}>
          ›
        </button>
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
          <div key={index} className="calendar-day-cell">
            {day && (
              <button
                className={`calendar-day ${isToday(day) ? 'today' : ''}`}
                onClick={() => handleDayClick(day)}
              >
                {day}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default CalendarPopup;
