/**
 * CalendarGrids — presentational days/months/years grids + shared header.
 *
 * Styled by `CalendarPopup.css`. Both calendar popups render these so the
 * days ↔ months ↔ years drill-down looks and behaves identically everywhere.
 *
 * Note: this file exports only components (plus the `CalendarMode` type) so it
 * plays nicely with React Fast Refresh. Shared constants/helpers stay private.
 */
import { Button } from '../Button';
import { SelectionButton } from '../SelectionButton';
import type { CalendarMode } from './useCalendarMode';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const ALL_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
}

// ── Header ──────────────────────────────────────────────────

/** Years offered by the year dropdown, centered on the displayed year so the
 * current value is always present no matter how far the user navigates. */
const YEAR_SELECT_RANGE = 30;

const ZOOM_OPTIONS = [
  { value: 'days', icon: 'mdi mdi-calendar', label: 'Show days' },
  { value: 'months', icon: 'mdi mdi-calendar-month', label: 'Show months' },
  { value: 'years', icon: 'mdi mdi-calendar-range', label: 'Show years' },
];

function getYearOptions(currentYear: number): number[] {
  return Array.from(
    { length: YEAR_SELECT_RANGE * 2 + 1 },
    (_, i) => currentYear - YEAR_SELECT_RANGE + i,
  );
}

export interface CalendarHeaderProps {
  mode: CalendarMode;
  currentYear: number;
  currentMonth: number;
  yearWindowStart: number;
  onPrev: () => void;
  onNext: () => void;
  /** Switch zoom level (days/months/years) without changing the date */
  onModeChange: (mode: CalendarMode) => void;
  /** Navigate to a month/year without changing the zoom level */
  onNavigate: (year: number, month: number) => void;
  prevLabel: string;
  nextLabel: string;
}

export function CalendarHeader({
  mode,
  currentYear,
  currentMonth,
  yearWindowStart,
  onPrev,
  onNext,
  onModeChange,
  onNavigate,
  prevLabel,
  nextLabel,
}: CalendarHeaderProps) {
  const yearOptions = getYearOptions(currentYear);

  return (
    <div className="calendar-header">
      <div className="calendar-header-row">
        <Button variant="ghost" size="sm" icon="mdi mdi-chevron-left" aria-label={prevLabel} className="calendar-nav-btn" onClick={onPrev} />
        <div className="calendar-title">
          {(mode === 'days' || mode === 'months') && (
            <>
              {mode === 'days' && (
                <select
                  className="calendar-select calendar-month-select"
                  value={currentMonth}
                  onChange={(e) => onNavigate(currentYear, Number(e.target.value))}
                  aria-label="Select month"
                >
                  {MONTHS.map((name, index) => (
                    <option key={name} value={index}>{name}</option>
                  ))}
                </select>
              )}
              <select
                className="calendar-select calendar-year-select"
                value={currentYear}
                onChange={(e) => onNavigate(Number(e.target.value), currentMonth)}
                aria-label="Select year"
              >
                {yearOptions.map((year) => (
                  <option key={year} value={year}>{year}</option>
                ))}
              </select>
            </>
          )}
          {mode === 'years' && (
            <span className="calendar-year-range">
              {yearWindowStart}–{yearWindowStart + 11}
            </span>
          )}
        </div>
        <Button variant="ghost" size="sm" icon="mdi mdi-chevron-right" aria-label={nextLabel} className="calendar-nav-btn" onClick={onNext} />
      </div>
      <div className="calendar-zoom">
        <SelectionButton
          size="sm"
          options={ZOOM_OPTIONS}
          value={mode}
          onChange={(value) => onModeChange(value as CalendarMode)}
        />
      </div>
    </div>
  );
}

// ── Days grid ───────────────────────────────────────────────

export interface DaysGridProps {
  currentYear: number;
  currentMonth: number;
  firstDayOfWeek: number;
  isToday: (day: number) => boolean;
  hasNote: (day: number) => boolean;
  isSelected?: (day: number) => boolean;
  todayAccent?: boolean;
  formatDayLabel: (day: number) => string;
  onSelectDay: (day: number) => void;
}

export function DaysGrid({
  currentYear,
  currentMonth,
  firstDayOfWeek,
  isToday,
  hasNote,
  isSelected,
  todayAccent,
  formatDayLabel,
  onSelectDay,
}: DaysGridProps) {
  const weekdays = [
    ...ALL_WEEKDAYS.slice(firstDayOfWeek),
    ...ALL_WEEKDAYS.slice(0, firstDayOfWeek),
  ];

  const daysInMonth = getDaysInMonth(currentYear, currentMonth);
  const rawFirstDay = getFirstDayOfMonth(currentYear, currentMonth);
  const firstDayOfMonth = (rawFirstDay - firstDayOfWeek + 7) % 7;

  const days: (number | null)[] = [];
  for (let i = 0; i < firstDayOfMonth; i++) days.push(null);
  for (let i = 1; i <= daysInMonth; i++) days.push(i);

  return (
    <>
      <div className="calendar-weekdays">
        {weekdays.map((day) => (
          <div key={day} className="calendar-weekday">
            {day}
          </div>
        ))}
      </div>

      <div className="calendar-days">
        {days.map((day, index) => (
          <div
            key={day !== null ? `day-${currentYear}-${currentMonth}-${day}` : `empty-${currentYear}-${currentMonth}-${index}`}
            className="calendar-day-cell"
          >
            {day && (
              <Button
                variant="ghost"
                size="xs"
                className={`calendar-day ${isToday(day) ? `today${todayAccent ? ' accent-pulse' : ''}` : ''} ${hasNote(day) ? 'has-note' : ''} ${isSelected?.(day) ? 'selected' : ''}`}
                onClick={() => onSelectDay(day)}
                aria-selected={isSelected?.(day) ?? false}
                aria-label={formatDayLabel(day)}
              >
                {day}
              </Button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

// ── Months grid ─────────────────────────────────────────────

export interface MonthsGridProps {
  onSelectMonth: (month: number) => void;
  currentMonth?: number;
}

export function MonthsGrid({ onSelectMonth, currentMonth }: MonthsGridProps) {
  return (
    <div className="calendar-months">
      {MONTHS_SHORT.map((name, index) => (
        <Button
          key={name}
          variant="ghost"
          size="xs"
          className={`calendar-month ${currentMonth === index ? 'selected' : ''}`}
          onClick={() => onSelectMonth(index)}
          aria-selected={currentMonth === index}
          aria-label={MONTHS[index]}
        >
          {name}
        </Button>
      ))}
    </div>
  );
}

// ── Years grid ──────────────────────────────────────────────

export interface YearsGridProps {
  yearWindowStart: number;
  onSelectYear: (year: number) => void;
  currentYear?: number;
}

export function YearsGrid({ yearWindowStart, onSelectYear, currentYear }: YearsGridProps) {
  const years = Array.from({ length: 12 }, (_, i) => yearWindowStart + i);
  return (
    <div className="calendar-years">
      {years.map((year) => (
        <Button
          key={year}
          variant="ghost"
          size="xs"
          className={`calendar-year-pick ${currentYear === year ? 'selected' : ''}`}
          onClick={() => onSelectYear(year)}
          aria-selected={currentYear === year}
          aria-label={String(year)}
        >
          {year}
        </Button>
      ))}
    </div>
  );
}
