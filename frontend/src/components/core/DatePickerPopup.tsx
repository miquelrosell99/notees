/**
 * DatePickerPopup — Calendar grid + text input for picking dates.
 *
 * Renders the same month-grid UI as CalendarPopup (daily page navigation)
 * plus a text field that accepts typed dates and natural-language literals
 * (today, tomorrow, next week, next month, Feb 14, 2026-02-14, etc.)
 *
 * Unlike CalendarPopup this component does NOT navigate — it reports the
 * selected ISO date (YYYY-MM-DD) back to the caller via `onSelect`.
 */
import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useExistingDailyPages } from '@/hooks';
import { parseDate } from '@/utils/dateParser';
import { Button } from './Button';
import './CalendarPopup.css';   // reuse grid styles from CalendarPopup
import './DatePickerPopup.css'; // own additions

// ── helpers ──────────────────────────────────────────────

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
}

function toIso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseIso(iso: string): { year: number; month: number; day: number } | null {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return { year: parseInt(m[1]), month: parseInt(m[2]), day: parseInt(m[3]) };
}

// ── props ────────────────────────────────────────────────

export interface DatePickerPopupProps {
  /** Currently selected ISO date (YYYY-MM-DD) or empty */
  value?: string;
  /** Called when the user picks a date — receives YYYY-MM-DD */
  onSelect: (isoDate: string) => void;
  /** Called when the popup should close */
  onClose: () => void;
  /** Ref to the anchor element for positioning */
  anchorRef?: React.RefObject<HTMLElement | null>;
}

// ── component ────────────────────────────────────────────

export function DatePickerPopup({
  value,
  onSelect,
  onClose,
  anchorRef,
}: DatePickerPopupProps) {
  const today = new Date();

  // Derive initial month/year from value or today
  const initial = value ? parseIso(value) : null;
  const [currentMonth, setCurrentMonth] = useState(initial?.month ? initial.month - 1 : today.getMonth());
  const [currentYear, setCurrentYear] = useState(initial?.year ?? today.getFullYear());
  const [textInput, setTextInput] = useState('');
  const [parsedPreview, setParsedPreview] = useState<string | null>(null);
  const [parsedValid, setParsedValid] = useState(true);

  const popupRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Compute position once synchronously after first paint, using actual popup size
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchorRef?.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const popupEl = popupRef.current;
    const popupHeight = popupEl ? popupEl.offsetHeight : 420;
    const popupWidth = popupEl ? popupEl.offsetWidth : 280;
    let top = rect.bottom + 4;
    let left = rect.left;

    // Flip vertically if not enough space below
    if (top + popupHeight > window.innerHeight) {
      top = rect.top - popupHeight - 4;
    }
    // Clamp horizontally
    if (left + popupWidth > window.innerWidth) {
      left = window.innerWidth - popupWidth - 8;
    }
    setPosition({ top, left });
  }, [anchorRef]);

  // Auto-focus input on mount (preventScroll avoids viewport shift)
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 50);
    return () => clearTimeout(t);
  }, []);

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        popupRef.current &&
        !popupRef.current.contains(e.target as Node) &&
        (!anchorRef?.current || !anchorRef.current.contains(e.target as Node))
      ) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose, anchorRef]);

  // Existing daily pages for "has-note" styling
  const { data: dailyPages } = useExistingDailyPages();
  const existingDates = useMemo(() => {
    if (!dailyPages) return new Set<string>();
    const dates = new Set<string>();
    for (const page of dailyPages) {
      if (page.uuid) {
        const match = page.uuid.match(/(\d{4})(\d{2})(\d{2})0000$/);
        if (match) {
          const y = parseInt(match[1]);
          const m = parseInt(match[2]) - 1;
          const d = parseInt(match[3]);
          if (y === currentYear && m === currentMonth) {
            dates.add(`${y}-${m}-${d}`);
          }
        }
      }
    }
    return dates;
  }, [dailyPages, currentYear, currentMonth]);

  // ── text input parsing ─────────────────────────────────

  const handleTextChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setTextInput(val);

    if (!val.trim()) {
      setParsedPreview(null);
      setParsedValid(true);
      return;
    }

    const parsed = parseDate(val);
    if (parsed && parsed.type === 'day' && parsed.month && parsed.day) {
      setParsedPreview(parsed.label);
      setParsedValid(true);
    } else if (parsed) {
      // Month/year only — show but mark as needing more precision
      setParsedPreview(`${parsed.label} (need a specific day)`);
      setParsedValid(false);
    } else {
      setParsedPreview('Unrecognized date');
      setParsedValid(false);
    }
  }, []);

  const handleTextKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const parsed = parseDate(textInput);
      if (parsed && parsed.type === 'day' && parsed.month && parsed.day) {
        onSelect(toIso(parsed.year, parsed.month, parsed.day));
        onClose();
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }, [textInput, onSelect, onClose]);

  // ── calendar grid ──────────────────────────────────────

  const daysInMonth = getDaysInMonth(currentYear, currentMonth);
  const firstDayOfMonth = getFirstDayOfMonth(currentYear, currentMonth);

  const days: (number | null)[] = [];
  for (let i = 0; i < firstDayOfMonth; i++) days.push(null);
  for (let i = 1; i <= daysInMonth; i++) days.push(i);

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
    const iso = toIso(currentYear, currentMonth + 1, day);
    onSelect(iso);
    onClose();
  };

  const isToday = (day: number) =>
    day === today.getDate() &&
    currentMonth === today.getMonth() &&
    currentYear === today.getFullYear();

  const isSelected = (day: number) => {
    if (!value) return false;
    const sel = parseIso(value);
    if (!sel) return false;
    return sel.year === currentYear && sel.month - 1 === currentMonth && sel.day === day;
  };

  const hasNote = (day: number) => existingDates.has(`${currentYear}-${currentMonth}-${day}`);

  const handleGoToToday = () => {
    setCurrentMonth(today.getMonth());
    setCurrentYear(today.getFullYear());
  };

  // ── render ─────────────────────────────────────────────

  const popup = (
    <div
      className="date-picker-popup"
      ref={popupRef}
      style={
        position
          ? { top: position.top, left: position.left }
          : { visibility: 'hidden' }
      }
    >
      {/* Text input */}
      <div className="date-picker-input-row">
        <input
          ref={inputRef}
          className="date-picker-text-input"
          type="text"
          placeholder='Type a date… "today", "Feb 14", "next week"'
          value={textInput}
          onChange={handleTextChange}
          onKeyDown={handleTextKeyDown}
        />
      </div>

      {/* Parsed preview */}
      {parsedPreview && (
        <div className={`date-picker-preview ${parsedValid ? '' : 'date-picker-preview--invalid'}`}>
          {parsedValid ? `↵ ${parsedPreview}` : parsedPreview}
        </div>
      )}

      {/* Month nav header (same as CalendarPopup) */}
      <div className="calendar-header">
        <Button variant="ghost" size="xs" className="calendar-nav-btn" onClick={goToPreviousMonth}>
          ‹
        </Button>
        <div className="calendar-title">
          <span className="calendar-month-btn" style={{ cursor: 'default' }}>
            {MONTHS[currentMonth]}
          </span>
          <span className="calendar-year-btn" style={{ cursor: 'default' }}>
            {currentYear}
          </span>
        </div>
        <Button variant="ghost" size="xs" className="calendar-nav-btn" onClick={goToNextMonth}>
          ›
        </Button>
      </div>

      {/* Weekday labels */}
      <div className="calendar-weekdays">
        {WEEKDAYS.map((d) => (
          <div key={d} className="calendar-weekday">{d}</div>
        ))}
      </div>

      {/* Day cells */}
      <div className="calendar-days">
        {days.map((day, index) => (
          <div
            key={day !== null ? `d-${currentYear}-${currentMonth}-${day}` : `e-${index}`}
            className="calendar-day-cell"
          >
            {day && (
              <Button
                variant="ghost"
                size="xs"
                className={`calendar-day ${isToday(day) ? 'today' : ''} ${hasNote(day) ? 'has-note' : ''} ${isSelected(day) ? 'selected' : ''}`}
                onClick={() => handleDayClick(day)}
              >
                {day}
              </Button>
            )}
          </div>
        ))}
      </div>

      {/* Footer: Today button */}
      <div className="calendar-footer">
        <button className="calendar-today-btn" type="button" onClick={handleGoToToday}>
          Today
        </button>
      </div>
    </div>
  );

  return createPortal(popup, document.body);
}

export default DatePickerPopup;
