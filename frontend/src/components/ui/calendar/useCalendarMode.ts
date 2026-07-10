/**
 * useCalendarMode — shared drill-down state for the calendar popups.
 *
 * Both the top-bar `CalendarPopup` and the slash/property `DatePickerPopup`
 * use this hook so their days ↔ months ↔ years navigation stays identical.
 *
 * - `days`   : month grid of days.
 * - `months` : 12-month grid for `currentYear`.
 * - `years`  : 12-year window starting at `yearWindowStart`.
 *
 * `selectYear`/`selectMonth` drill down (years→months→days); `drillUp` goes the
 * other way. `goPrev`/`goNext` step within the current level; `goToday` jumps
 * back to the current day in the `days` view.
 */
import { useCallback, useState } from 'react';

export type CalendarMode = 'days' | 'months' | 'years';

const YEAR_WINDOW = 12;

function alignYearWindow(year: number): number {
  return Math.floor(year / YEAR_WINDOW) * YEAR_WINDOW;
}

export interface UseCalendarModeOptions {
  initialMode?: CalendarMode;
  initialYear: number;
  /** 0-indexed month */
  initialMonth: number;
}

export interface UseCalendarModeResult {
  mode: CalendarMode;
  currentYear: number;
  currentMonth: number;
  yearWindowStart: number;
  selectYear: (year: number) => void;
  selectMonth: (month: number) => void;
  drillUp: () => void;
  goPrev: () => void;
  goNext: () => void;
  goToday: () => void;
}

export function useCalendarMode({
  initialMode = 'days',
  initialYear,
  initialMonth,
}: UseCalendarModeOptions): UseCalendarModeResult {
  const [mode, setMode] = useState<CalendarMode>(initialMode);
  const [currentYear, setCurrentYear] = useState(initialYear);
  const [currentMonth, setCurrentMonth] = useState(initialMonth);
  const [yearWindowStart, setYearWindowStart] = useState(() => alignYearWindow(initialYear));

  const selectYear = useCallback((year: number) => {
    setCurrentYear(year);
    setMode('months');
  }, []);

  const selectMonth = useCallback((month: number) => {
    setCurrentMonth(month);
    setMode('days');
  }, []);

  const drillUp = useCallback(() => {
    setMode((m) => (m === 'days' ? 'months' : m === 'months' ? 'years' : 'years'));
  }, []);

  const goPrev = useCallback(() => {
    setMode((m) => {
      if (m === 'days') {
        setCurrentMonth((cm) => {
          if (cm === 0) {
            setCurrentYear((y) => y - 1);
            return 11;
          }
          return cm - 1;
        });
      } else if (m === 'months') {
        setCurrentYear((y) => y - 1);
      } else {
        setYearWindowStart((s) => s - YEAR_WINDOW);
      }
      return m;
    });
  }, []);

  const goNext = useCallback(() => {
    setMode((m) => {
      if (m === 'days') {
        setCurrentMonth((cm) => {
          if (cm === 11) {
            setCurrentYear((y) => y + 1);
            return 0;
          }
          return cm + 1;
        });
      } else if (m === 'months') {
        setCurrentYear((y) => y + 1);
      } else {
        setYearWindowStart((s) => s + YEAR_WINDOW);
      }
      return m;
    });
  }, []);

  const goToday = useCallback(() => {
    const t = new Date();
    setCurrentYear(t.getFullYear());
    setCurrentMonth(t.getMonth());
    setYearWindowStart(alignYearWindow(t.getFullYear()));
    setMode('days');
  }, []);

  return {
    mode,
    currentYear,
    currentMonth,
    yearWindowStart,
    selectYear,
    selectMonth,
    drillUp,
    goPrev,
    goNext,
    goToday,
  };
}
