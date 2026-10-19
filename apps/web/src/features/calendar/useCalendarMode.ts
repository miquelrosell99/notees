/**
 * useCalendarMode — navigation state for the calendar popup: a zoom mode
 * (days / months / years) plus the visible period, with prev/next stepping
 * and go-today. Faithful port of the archived calendar hook.
 *
 * updater discipline: state updates go through single-object pure updaters —
 * never nest setState inside an updater (a StrictMode double-invoke
 * previously skipped months).
 */

import { useState } from "react";

export type CalendarMode = "days" | "months" | "years";

export interface CalendarModeState {
  mode: CalendarMode;
  currentYear: number;
  currentMonth: number;
  yearWindowStart: number;
}

export interface UseCalendarModeResult extends CalendarModeState {
  setMode: (mode: CalendarMode) => void;
  goPrev: () => void;
  goNext: () => void;
  goToday: () => void;
  /** Jump the visible period (the days zoom follows the month). */
  goTo: (year: number, month: number) => void;
}

export function useCalendarMode(options: {
  initialMode?: CalendarMode;
  initialYear?: number;
  initialMonth?: number;
}): UseCalendarModeResult {
  const today = new Date();
  const [state, setState] = useState<CalendarModeState>(() => {
    const year = options.initialYear ?? today.getFullYear();
    return {
      mode: options.initialMode ?? "days",
      currentYear: year,
      currentMonth: options.initialMonth ?? today.getMonth(),
      yearWindowStart: Math.floor(year / 12) * 12,
    };
  });

  const setMode = (mode: CalendarMode): void => {
    setState((prev) => {
      const now = new Date();
      // Re-align the year window whenever the years zoom opens.
      const yearWindowStart =
        mode === "years" ? Math.floor(now.getFullYear() / 12) * 12 : prev.yearWindowStart;
      return { ...prev, mode, yearWindowStart };
    });
  };

  const step = (direction: 1 | -1): void => {
    setState((prev) => {
      switch (prev.mode) {
        case "days": {
          // Single-object math: month ±1 with year rollover, no nested sets.
          const month = prev.currentMonth + direction;
          const year = prev.currentYear + Math.floor(month / 12);
          const wrapped = ((month % 12) + 12) % 12;
          return { ...prev, currentMonth: wrapped, currentYear: year };
        }
        case "months":
          return { ...prev, currentYear: prev.currentYear + direction };
        case "years":
          return { ...prev, yearWindowStart: prev.yearWindowStart + direction * 12 };
      }
    });
  };

  const goPrev = () => step(-1);
  const goNext = () => step(1);

  const goToday = (): void => {
    setState((prev) => ({
      ...prev,
      mode: "days",
      currentYear: new Date().getFullYear(),
      currentMonth: new Date().getMonth(),
    }));
  };

  const goTo = (year: number, month: number): void => {
    setState((prev) => ({ ...prev, currentYear: year, currentMonth: month }));
  };

  return { ...state, setMode, goPrev, goNext, goToday, goTo };
}
