/**
 * DatePicker — the one date-selection component (SCHEMA.md "Dates"): a
 * year grid → month grid → day grid with free zooming between levels and
 * back/up navigation. The schema's precision is the COMMIT CEILING: cells
 * at or below the precision commit (a year-precision picker zooms into
 * months/days only for context — the selection rolls up to the year); cells
 * above the precision zoom in. The committed value is always a full ISO
 * date; the caller maps it to the node id at the precision it knows.
 *
 * Keyboard basics: every cell is a real focusable button; Arrow keys move
 * focus across the grid, Home/End jump to the first/last cell, Escape closes.
 * Plain sober styling (`.nt-datepicker-*` in app.css).
 */

import { useRef, useState } from "react";

import type { DatePrecision } from "@notees/domain";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** Monday-first weekday headers. */
const WEEKDAY_NAMES = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as const;

/** Years per grid window (navigable with ‹ ›). */
const YEAR_WINDOW = 12;

const LEVEL_RANK: Record<DatePrecision, number> = { year: 0, month: 1, day: 2 };
const RANK_LEVEL: Record<number, DatePrecision> = { 0: "year", 1: "month", 2: "day" };

interface DateParts {
  year: number;
  month: number;
  day: number;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function isoAt(parts: DateParts, level: DatePrecision): string {
  if (level === "year") return `${parts.year}-01-01`;
  if (level === "month") return `${parts.year}-${pad(parts.month)}-01`;
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function todayParts(): DateParts {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

function parseParts(iso: string | null | undefined): DateParts | null {
  if (typeof iso !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (match === null) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** Day grid for one month: 6 Monday-first week rows including muted spillover days. */
function monthCells(cursor: DateParts): { parts: DateParts; inMonth: boolean }[] {
  const firstWeekday = (new Date(Date.UTC(cursor.year, cursor.month - 1, 1)).getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(cursor.year, cursor.month, 0)).getUTCDate();
  const start = new Date(Date.UTC(cursor.year, cursor.month - 1, 1 - firstWeekday));
  const cells: { parts: DateParts; inMonth: boolean }[] = [];
  for (let i = 0; i < 42; i += 1) {
    const d = new Date(start.getTime() + i * 86_400_000);
    cells.push({
      parts: { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() },
      inMonth: d.getUTCMonth() + 1 === cursor.month,
    });
  }
  return cells;
}

export function DatePicker({
  precision,
  selectedIso,
  onCommit,
  onClose,
}: {
  precision: DatePrecision;
  selectedIso?: string | null;
  /** Receives the full ISO date of the selection (ceiling already applied). */
  onCommit: (isoDate: string) => void;
  onClose?: (() => void) | undefined;
}) {
  const selected = parseParts(selectedIso);
  const [level, setLevel] = useState<DatePrecision>(precision);
  const [cursor, setCursor] = useState<DateParts>(selected ?? todayParts());
  const gridRef = useRef<HTMLDivElement>(null);

  const precisionRank = LEVEL_RANK[precision]!;

  const commit = (parts: DateParts, cellLevel: DatePrecision): void => {
    const cellRank = LEVEL_RANK[cellLevel]!;
    if (cellRank < precisionRank) {
      // Coarser than the ceiling: this cell is navigation, not a value.
      setCursor(parts);
      setLevel(RANK_LEVEL[cellRank + 1]!);
      return;
    }
    // At or below the ceiling: roll up to the precision and commit.
    onCommit(isoAt(parts, precision));
  };

  const zoomOut = (): void => {
    if (level === "year") return;
    setLevel(RANK_LEVEL[LEVEL_RANK[level]! - 1]!);
  };

  const shift = (delta: number): void => {
    if (level === "year") {
      setCursor({ ...cursor, year: cursor.year + delta * YEAR_WINDOW });
    } else if (level === "month") {
      const monthIndex = cursor.month - 1 + delta;
      setCursor({
        ...cursor,
        year: cursor.year + Math.floor(monthIndex / 12),
        month: ((monthIndex % 12) + 12) % 12 + 1,
      });
    } else {
      const base = new Date(Date.UTC(cursor.year, cursor.month - 1 + delta, 1));
      setCursor({ year: base.getUTCFullYear(), month: base.getUTCMonth() + 1, day: cursor.day });
    }
  };

  const moveFocus = (from: HTMLElement, delta: number): void => {
    const cells = Array.from(gridRef.current?.querySelectorAll<HTMLElement>(".nt-datepicker-cell") ?? []);
    const index = cells.indexOf(from);
    const next = cells[index + delta];
    if (next !== undefined) next.focus();
  };

  const onGridKeyDown = (event: React.KeyboardEvent): void => {
    const target = event.target as HTMLElement;
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose?.();
      return;
    }
    if (!target.classList.contains("nt-datepicker-cell")) return;
    const cols = level === "day" ? 7 : 4;
    if (event.key === "ArrowRight") moveFocus(target, 1);
    else if (event.key === "ArrowLeft") moveFocus(target, -1);
    else if (event.key === "ArrowDown") moveFocus(target, cols);
    else if (event.key === "ArrowUp") moveFocus(target, -cols);
    else if (event.key === "Home") moveFocus(target, -Number.MAX_SAFE_INTEGER);
    else if (event.key === "End") moveFocus(target, Number.MAX_SAFE_INTEGER);
    else return;
    event.preventDefault();
  };

  /** A cell is selected when its period (at cell granularity) holds the value. */
  const isSelected = (parts: DateParts, cellLevel: DatePrecision): boolean => {
    if (selected === null) return false;
    if (selected.year !== parts.year) return false;
    if (cellLevel === "year") return true;
    if (selected.month !== parts.month) return false;
    return cellLevel !== "month" && selected.day === parts.day;
  };

  const drill = (parts: DateParts, cellLevel: DatePrecision): void => {
    setCursor(parts);
    setLevel(RANK_LEVEL[LEVEL_RANK[cellLevel]! + 1]!);
  };

  const cell = (parts: DateParts, cellLevel: DatePrecision, text: string, label: string, muted = false) => {
    const selectedCell = isSelected(parts, cellLevel);
    return (
      <span
        key={label}
        className={muted ? "nt-datepicker-cellbox nt-datepicker-cell-muted" : "nt-datepicker-cellbox"}
      >
        <button
          type="button"
          className={selectedCell ? "nt-datepicker-cell nt-datepicker-cell-selected" : "nt-datepicker-cell"}
          aria-label={label}
          aria-pressed={selectedCell}
          onClick={() => commit(parts, cellLevel)}
        >
          {text}
        </button>
        {cellLevel !== "day" && (
          <button
            type="button"
            className="nt-datepicker-cell-drill"
            aria-label={`Zoom into ${label}`}
            onClick={() => drill(parts, cellLevel)}
          >
            ▾
          </button>
        )}
      </span>
    );
  };

  const breadcrumb =
    level === "year"
      ? `${Math.floor(cursor.year / YEAR_WINDOW) * YEAR_WINDOW} – ${
          Math.floor(cursor.year / YEAR_WINDOW) * YEAR_WINDOW + YEAR_WINDOW - 1
        }`
      : level === "month"
        ? String(cursor.year)
        : `${MONTH_NAMES[cursor.month - 1]} ${cursor.year}`;

  return (
    <div className="nt-datepicker" role="dialog" aria-label="Date picker">
      <div className="nt-datepicker-header">
        <button type="button" className="nt-datepicker-nav" aria-label="Previous" onClick={() => shift(-1)}>
          ‹
        </button>
        <span className="nt-datepicker-breadcrumb">
          {level !== "year" ? (
            <button type="button" className="nt-datepicker-crumb" onClick={zoomOut}>
              {breadcrumb}
            </button>
          ) : (
            <span>{breadcrumb}</span>
          )}
        </span>
        <button type="button" className="nt-datepicker-nav" aria-label="Next" onClick={() => shift(1)}>
          ›
        </button>
        {onClose !== undefined && (
          <button type="button" className="nt-datepicker-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        )}
      </div>
      <div
        ref={gridRef}
        className={level === "day" ? "nt-datepicker-grid nt-datepicker-grid-days" : "nt-datepicker-grid"}
        role="grid"
        onKeyDown={onGridKeyDown}
      >
        {level === "year" &&
          Array.from({ length: YEAR_WINDOW }, (_, i) => {
            const year = Math.floor(cursor.year / YEAR_WINDOW) * YEAR_WINDOW + i;
            return cell({ year, month: 1, day: 1 }, "year", String(year), `${year}`);
          })}
        {level === "month" &&
          MONTH_NAMES.map((name, i) =>
            cell({ year: cursor.year, month: i + 1, day: 1 }, "month", name.slice(0, 3), `${name} ${cursor.year}`),
          )}
        {level === "day" && (
          <>
            {WEEKDAY_NAMES.map((name) => (
              <span key={name} className="nt-datepicker-weekday" aria-hidden="true">
                {name}
              </span>
            ))}
            {monthCells(cursor).map(({ parts, inMonth }) =>
              cell(parts, "day", String(parts.day), isoAt(parts, "day"), !inMonth),
            )}
          </>
        )}
      </div>
    </div>
  );
}
