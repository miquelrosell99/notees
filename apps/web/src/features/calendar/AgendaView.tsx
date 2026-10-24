/**
 * AgendaView — the Calendar's Agenda zoom (owner 2026-10-24, the Google
 * agenda register): DAYS WITH EVENTS ONLY in one continuous column,
 * windowed infinite scroll around an anchor day (the JournalsView
 * pattern: a bounded slice + IntersectionObserver sentinels extending in
 * both directions; prepends compensate scrollTop so the viewport stays
 * put). The day list derives from the events themselves — every day in
 * the scanned window runs the same events read the grids ride
 * (calendarRows.eventRowsForDays), and a day renders only when the read
 * lists ≥1 event (Google skips eventless days). A direction stops
 * extending when its extension scan finds no event day (the honest
 * exhaustion register — no infinite window growth).
 *
 * A day group wears the big day number + the short month/weekday ("24
 * OCT, SAT"; today's number rides a filled circle) and the event rows:
 * the effective-color dot, the Google multi-day time label
 * (calendarRows.agendaTimeLabelOf — "15:00" / "All day" / "Until 18:00"
 * for a span, "09:00 – 10:00" for a same-day timed range), the title. The
 * red now-line rides under today's group header (the same once-a-minute
 * tick as the time grid). A row click opens the event.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { deriveDisplayName } from "@notees/domain";

import { displayNameFromClient } from "../../ui/dateDisplay.js";
import { untitledLabelOf } from "../../ui/renderStateLabel.js";
import { cssColorFor } from "../../components/ui/fleet/colorPresets.js";
import type { AnyClient } from "../../ui/app/Sidebar.js";
import {
  agendaTimeLabelOf,
  eventRowsForDays,
  type DatedRow,
  type RecurringRow,
  type SpannedRow,
} from "./calendarRows.js";
import { addDaysIso, todayIsoLocal } from "./calendarViewUtils.js";
import { MONTHS_SHORT, WEEKDAYS } from "./dayGrid.js";
import "./AgendaView.css";

/** Days scanned around the anchor before the sentinels take over. */
const INITIAL_RADIUS = 30;
/** Days added per sentinel crossing. */
const PAGE = 30;

export interface AgendaViewProps {
  client: AnyClient;
  /** The window's anchor day (local YYYY-MM-DD) — today on entry, stepped
      by the navigator; the window slices around it. */
  anchorIso: string;
  /** The recurring series scan (the caller's memo — the read model input). */
  recurringRows: readonly RecurringRow[];
  /** The multi-day span scan (same register). */
  spannedRows: readonly SpannedRow[];
  /** Row click: open the event node. */
  onOpenEvent: (nodeId: string) => void;
}

export function AgendaView({
  client,
  anchorIso,
  recurringRows,
  spannedRows,
  onOpenEvent,
}: AgendaViewProps) {
  const todayIso = todayIsoLocal();
  const listRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);
  /** scrollHeight − scrollTop captured before a prepend, restored after. */
  const keepVisualRef = useRef<number | null>(null);
  const [extraBefore, setExtraBefore] = useState(0);
  const [extraAfter, setExtraAfter] = useState(0);
  /** A direction whose extension scan found no event day stops growing. */
  const [exhaustedBefore, setExhaustedBefore] = useState(false);
  const [exhaustedAfter, setExhaustedAfter] = useState(false);

  // The red now-line: one re-render per minute, cleaned up with the view.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  // A new anchor (the navigator's step, the Today jump) or a changed event
  // scan re-opens both directions and re-slices the window.
  useEffect(() => {
    setExtraBefore(0);
    setExtraAfter(0);
    setExhaustedBefore(false);
    setExhaustedAfter(false);
  }, [anchorIso, recurringRows, spannedRows, client]);

  const windowStart = addDaysIso(anchorIso, -(INITIAL_RADIUS + extraBefore));
  const windowEnd = addDaysIso(anchorIso, INITIAL_RADIUS + extraAfter);

  /**
   * The candidate days: every day in the scanned window that carries ≥1
   * event, ascending — eventless days never render (the Google register).
   */
  const groups = useMemo(() => {
    const out: Array<{ iso: string; rows: DatedRow[] }> = [];
    for (let iso = windowStart; iso <= windowEnd; iso = addDaysIso(iso, 1)) {
      const rows = eventRowsForDays(client, [iso], recurringRows, spannedRows);
      if (rows.length > 0) out.push({ iso, rows });
    }
    return out;
  }, [client, windowStart, windowEnd, recurringRows, spannedRows]);

  // --- windowing ------------------------------------------------------------

  /** Scan the next `PAGE` days past the edge: any event day re-opens the
      direction; none exhausts it (the sentinel then stops asking). */
  const scanEdge = (edgeIso: string, direction: 1 | -1): boolean => {
    for (let step = 1; step <= PAGE; step += 1) {
      const iso = addDaysIso(edgeIso, direction * step);
      if (eventRowsForDays(client, [iso], recurringRows, spannedRows).length > 0) return true;
    }
    return false;
  };

  const extendBefore = () => {
    if (exhaustedBefore) return;
    setExhaustedBefore(!scanEdge(windowStart, -1));
    const el = listRef.current;
    keepVisualRef.current = el !== null ? el.scrollHeight - el.scrollTop : null;
    setExtraBefore((n) => n + PAGE);
  };
  const extendAfter = () => {
    if (exhaustedAfter) return;
    setExhaustedAfter(!scanEdge(windowEnd, 1));
    setExtraAfter((n) => n + PAGE);
  };

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const top = topSentinelRef.current;
    const bottom = bottomSentinelRef.current;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          if (entry.target === top) extendBefore();
          else extendAfter();
        }
      },
      { root: listRef.current, rootMargin: "600px" },
    );
    if (top) observer.observe(top);
    if (bottom) observer.observe(bottom);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sentinel wiring follows the visible window
  }, [windowStart, windowEnd, exhaustedBefore, exhaustedAfter, groups.length]);

  /** After a prepend, hold the viewport at the same content. */
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el === null || keepVisualRef.current === null) return;
    el.scrollTop = el.scrollHeight - keepVisualRef.current;
    keepVisualRef.current = null;
  }, [extraBefore]);

  /** The anchor group sits at the top of the list: the first event day at
      or after the anchor (an eventless anchor day shows its nearest
      upcoming day, the Google register). */
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el === null) return;
    const target = groups.find((group) => group.iso >= anchorIso);
    if (target === undefined) return;
    const node = el.querySelector(`.cal-agenda__day[data-day="${target.iso}"]`);
    if (!(node instanceof HTMLElement)) return;
    el.scrollTop = node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
  }, [anchorIso, groups]);

  if (groups.length === 0) {
    return (
      <section className="cal-agenda" aria-label="Calendar agenda view">
        <p className="cal-agenda__empty">No events.</p>
      </section>
    );
  }

  return (
    <section className="cal-agenda" aria-label="Calendar agenda view" ref={listRef}>
      {!exhaustedBefore && (
        <div ref={topSentinelRef} className="cal-agenda__sentinel" aria-hidden="true" />
      )}
      <ol className="cal-agenda__days">
        {groups.map(({ iso, rows }) => {
          const date = new Date(`${iso}T12:00:00`);
          const isToday = iso === todayIso;
          const meta = `${MONTHS_SHORT[date.getMonth()]}, ${WEEKDAYS[date.getDay()]}`.toUpperCase();
          return (
            <li
              key={iso}
              className="cal-agenda__day"
              data-day={iso}
              data-anchor={iso === anchorIso ? "true" : undefined}
            >
              <div className="cal-agenda__day-header">
                <span
                  className={`cal-agenda__daynum${
                    isToday ? " cal-agenda__daynum--today" : ""
                  }`}
                >
                  {Number(iso.slice(8))}
                </span>
                <span className="cal-agenda__day-meta">{meta}</span>
              </div>
              {isToday && (
                <div className="cal-agenda__now" data-minutes={nowMinutes} />
              )}
              <ol className="cal-agenda__rows">
                {rows.map((row) => (
                  <li key={row.node.id}>
                    <AgendaRow
                      client={client}
                      row={row}
                      iso={iso}
                      spannedRows={spannedRows}
                      onOpen={() => onOpenEvent(row.node.id)}
                    />
                  </li>
                ))}
              </ol>
            </li>
          );
        })}
      </ol>
      {!exhaustedAfter && (
        <div ref={bottomSentinelRef} className="cal-agenda__sentinel" aria-hidden="true" />
      )}
    </section>
  );
}

/** One event row: the effective-color dot, the Google time label, the title. */
function AgendaRow({
  client,
  row,
  iso,
  spannedRows,
  onOpen,
}: {
  client: AnyClient;
  row: DatedRow;
  iso: string;
  spannedRows: readonly SpannedRow[];
  onOpen: () => void;
}) {
  const label =
    deriveDisplayName(row.node, (classId) => displayNameFromClient(client, classId)) ||
    untitledLabelOf(row.node);
  const color = client.effectiveNodeColor(row.node);
  const timeLabel = agendaTimeLabelOf(client, row, iso, spannedRows);
  return (
    /* The colored-card register (owner 2026-10-24): the row IS the event's
       card — effective color fill, contrast text — the same look the grid
       blocks and agenda everywhere else wear. */
    <button
      type="button"
      className="cal-agenda__row"
      style={color !== null ? { background: color, color: cssColorFor(color) } : undefined}
      onClick={onOpen}
    >
      <span className="cal-agenda__time">{timeLabel}</span>
      <span className="cal-agenda__title">{label}</span>
    </button>
  );
}
