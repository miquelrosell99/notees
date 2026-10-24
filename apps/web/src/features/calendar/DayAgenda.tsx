/**
 * DayAgenda — the Calendar Day zoom's body (owner 2026-10-24, the Google
 * day-cards register): the selected day's events as one full-width column
 * of large colored cards — NOT the day note (the journal/day page owns the
 * note; the day zoom is the agenda). The rows ride the same events read
 * model as the grid blocks (calendarRows.eventRowsForDays — event-family
 * nodes dated into the day or embedded in its page, timed first by start
 * time); each card wears the effectiveNodeColor register and the driving
 * value's clock prefix ("14:30 Title"; "14:30–16:00 Title" for a same-day
 * timed range), and a click opens the event. An empty day renders one
 * honest line — no sections, no filters, no note chrome.
 */

import { deriveDisplayName } from "@notees/domain";

import { cssColorFor } from "../../components/ui/fleet/colorPresets.js";
import { displayNameFromClient } from "../../ui/dateDisplay.js";
import { untitledLabelOf } from "../../ui/renderStateLabel.js";
import type { AnyClient } from "../../ui/app/Sidebar.js";
import { drivingDateRowOf, type DatedRow } from "./calendarRows.js";
import { timePrefixOfValue } from "./calendarViewUtils.js";
import "./DayAgenda.css";

export function DayAgenda({
  client,
  iso,
  rows,
  onOpenEvent,
}: {
  client: AnyClient;
  /** The selected day (local YYYY-MM-DD) — the driving-value lookup's key. */
  iso: string;
  /** The day's event rows (the host's eventRowsForDays memo). */
  rows: readonly DatedRow[];
  /** Card click: open the event node. */
  onOpenEvent: (nodeId: string) => void;
}) {
  if (rows.length === 0) {
    return <p className="cal-agenda__empty">No events this day.</p>;
  }
  return (
    <div className="cal-agenda" aria-label="Day agenda">
      {rows.map((row) => {
        // The card register mirrors the grid block: the node's own content
        // names it (title-is-content; a genuinely empty flatten reads
        // Untitled), the color is the effective one, the prefix is the
        // driving value's clock time on THIS day.
        const label =
          deriveDisplayName(row.node, (classId) => displayNameFromClient(client, classId)) ||
          untitledLabelOf(row.node);
        const color = client.effectiveNodeColor(row.node);
        const drivingRow = drivingDateRowOf(client, row.node.id, iso);
        const prefix = drivingRow === undefined ? null : timePrefixOfValue(drivingRow.value);
        return (
          <button
            key={row.node.id}
            type="button"
            className="cal-agenda__card"
            style={color !== null ? { background: color, color: cssColorFor(color) } : undefined}
            onClick={() => onOpenEvent(row.node.id)}
          >
            <span className="cal-agenda__card-title">
              {prefix !== null ? `${prefix} ${label}` : label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
