/**
 * useCalendarMode — shared zoom + navigation state for the calendar popups.
 *
 * Both the top-bar `CalendarPopup` and the slash/property `DatePickerPopup`
 * use this hook so their days ↔ months ↔ years navigation stays identical.
 *
 * - `days`   : month grid of days.
 * - `months` : 12-month grid for `currentYear`.
 * - `years`  : 12-year window starting at `yearWindowStart`.
 *
 * Zoom level and the displayed date are independent: `setMode` switches the
 * zoom level without touching the date, and `navigateTo` moves the displayed
 * month/year without changing the zoom level. `goPrev`/`goNext` step within
 * the current level; `goToday` jumps back to the current day in `days` zoom.
 *
 * All state lives in a single object updated through pure updaters — never
 * nest a `setState` call inside another setter's updater, as StrictMode
 * double-invokes updaters and the nested update would fire twice (this used
 * to make the prev/next arrows skip a month).
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
  /** 0-indexed month */
  currentMonth: number;
  yearWindowStart: number;
  /** Switch zoom level without changing the displayed date */
  setMode: (mode: CalendarMode) => void;
  /** Move the displayed month/year without changing the zoom level */
  navigateTo: (year: number, month: number) => void;
  goPrev: () => void;
  goNext: () => void;
  goToday: () => void;
}

interface CalendarState {
  mode: CalendarMode;
  currentYear: number;
  currentMonth: number;
  yearWindowStart: number;
}

export function useCalendarMode({
  initialMode = 'days',
  initialYear,
  initialMonth,
}: UseCalendarModeOptions): UseCalendarModeResult {
  const [state, setState] = useState<CalendarState>(() => ({
    mode: initialMode,
    currentYear: initialYear,
    currentMonth: initialMonth,
    yearWindowStart: alignYearWindow(initialYear),
  }));

  const setMode = useCallback((mode: CalendarMode) => {
    setState((s) => ({
      ...s,
      mode,
      // Make sure the current year is visible when entering the years grid
      yearWindowStart: mode === 'years' ? alignYearWindow(s.currentYear) : s.yearWindowStart,
    }));
  }, []);

  const navigateTo = useCallback((year: number, month: number) => {
    setState((s) => ({ ...s, currentYear: year, currentMonth: month }));
  }, []);

  const goPrev = useCallback(() => {
    setState((s) => {
      if (s.mode === 'days') {
        return s.currentMonth === 0
          ? { ...s, currentYear: s.currentYear - 1, currentMonth: 11 }
          : { ...s, currentMonth: s.currentMonth - 1 };
      }
      if (s.mode === 'months') {
        return { ...s, currentYear: s.currentYear - 1 };
      }
      return { ...s, yearWindowStart: s.yearWindowStart - YEAR_WINDOW };
    });
  }, []);

  const goNext = useCallback(() => {
    setState((s) => {
      if (s.mode === 'days') {
        return s.currentMonth === 11
          ? { ...s, currentYear: s.currentYear + 1, currentMonth: 0 }
          : { ...s, currentMonth: s.currentMonth + 1 };
      }
      if (s.mode === 'months') {
        return { ...s, currentYear: s.currentYear + 1 };
      }
      return { ...s, yearWindowStart: s.yearWindowStart + YEAR_WINDOW };
    });
  }, []);

  const goToday = useCallback(() => {
    const t = new Date();
    setState({
      mode: 'days',
      currentYear: t.getFullYear(),
      currentMonth: t.getMonth(),
      yearWindowStart: alignYearWindow(t.getFullYear()),
    });
  }, []);

  return {
    mode: state.mode,
    currentYear: state.currentYear,
    currentMonth: state.currentMonth,
    yearWindowStart: state.yearWindowStart,
    setMode,
    navigateTo,
    goPrev,
    goNext,
    goToday,
  };
}
