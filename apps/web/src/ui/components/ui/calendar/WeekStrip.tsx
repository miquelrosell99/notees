/**
 * WeekStrip — the 7-day week row (§34.28 #11 calendar breadth): the visible
 * week containing the selected day (first-day-of-week aware via the caller's
 * weekDaysOfIso input), each cell a compact weekday-initial + day-number
 * button carrying the same day marks as the month grid (today fill,
 * has-note fill, the range-aware dated dot, the reviewed tint). Clicking a
 * day selects it — the host owns what selection means.
 */

import { Button } from "../Button.js";
import type { CalendarDayExtraMarks } from "./dayGrid.js";
import "./WeekStrip.css";

/** Local `YYYY-MM-DD` for today (the §34.28 #1 rule: local midnight, never UTC). */
function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;
}

function parts(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split("-").map(Number);
  return { y: y!, m: m!, d: d! };
}

export interface WeekStripProps {
  /** The 7 local ISO dates of the visible week (weekDaysOfIso output). */
  days: string[];
  /** The outlined/selected day (local YYYY-MM-DD). */
  selectedDate: string;
  /** A day cell is marked "has-note" when the day page exists locally. */
  hasNote?: ((isoDate: string) => boolean) | undefined;
  /** Secondary marks (range-aware dots, the reviewed tint). */
  extraMarks?: ((isoDate: string) => CalendarDayExtraMarks) | undefined;
  onSelectDay: (isoDate: string) => void;
}

export function WeekStrip({
  days,
  selectedDate,
  hasNote,
  extraMarks,
  onSelectDay,
}: WeekStripProps) {
  const today = todayIso();
  return (
    <div className="week-strip" role="group" aria-label="Week days">
      {days.map((iso) => {
        const { y, m, d } = parts(iso);
        const date = new Date(y, m - 1, d, 12);
        const extra = extraMarks?.(iso) ?? {};
        return (
          <Button
            key={iso}
            variant="ghost"
            size="sm"
            aria-label={date.toLocaleDateString(undefined, {
              weekday: "long",
              year: "numeric",
              month: "long",
              day: "numeric",
            })}
            className={`week-strip__day${iso === today ? " today" : ""}${
              hasNote?.(iso) === true ? " has-note" : ""
            }${extra.dated === true ? " dated" : ""}${
              extra.reviewed === true ? " reviewed" : ""
            }${iso === selectedDate ? " selected" : ""}`}
            onClick={() => onSelectDay(iso)}
          >
            <span className="week-strip__weekday">
              {date.toLocaleDateString(undefined, { weekday: "narrow" })}
            </span>
            <span className="week-strip__num">{d}</span>
          </Button>
        );
      })}
    </div>
  );
}
