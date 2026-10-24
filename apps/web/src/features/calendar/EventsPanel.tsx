/**
 * EventsPanel — the events element as a standalone component (owner
 * 2026-10-24): the day/week/month zoom over the event family, grouped by
 * containing page with breadcrumbs, riding the shared NodeCollection in
 * outline mode. Born in the calendar view's right panel; relocated to the
 * Journal's side panel — the journal is where the day-page context lives,
 * and the calendar view's grid blocks now cover the calendar proper
 * (the redundancy ruling). The read model is calendarRows.eventRowsForDays
 * — the same membership the grid blocks render.
 */

import { useEffect, useMemo, useState } from "react";

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { AnyClient } from "../../ui/app/Sidebar.js";

import { NodeCollection, groupByContainingPage } from "../collection/index.js";
import type { NodeCollectionItem } from "../collection/index.js";
import {
  containingPageIdOf,
  eventRowsForDays,
  recurringRowsOf,
  spannedRowsOf,
} from "./calendarRows.js";
import { weekDaysOfIso } from "./calendarViewUtils.js";
import { Button } from "../../components/ui/fleet/Button.js";
import "./EventsPanel.css";

/** The panel's zoom levels: the scope of days. */
export type EventsZoom = "day" | "week" | "month";

const EVENTS_ZOOMS: ReadonlyArray<{ value: EventsZoom; label: string }> = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];

export function EventsPanel({
  client,
  selectedIso,
  onOpenPage,
}: {
  client: AnyClient;
  /** The scope's anchor day (the panel host's selected day). */
  selectedIso: string;
  onOpenPage: (nodeId: string) => void;
}) {
  const [version, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  const [eventsZoom, setEventsZoom] = useState<EventsZoom>("week");

  const recurringEvents = useMemo(
    () =>
      recurringRowsOf(client).filter(
        (row) => !row.node.classIds.includes(SYSTEM_CLASS_UUIDS.task),
      ),
    [client, version],
  );
  const spannedEvents = useMemo(() => spannedRowsOf(client), [client, version]);

  const eventsIsos = useMemo(() => {
    if (eventsZoom === "day") return [selectedIso];
    if (eventsZoom === "week") return weekDaysOfIso(selectedIso, 1);
    const [y, m] = selectedIso.split("-").map(Number);
    const dayCount = new Date(y!, m!, 0).getDate(); // Date(y, m, 0) = last of month m
    const mm = String(m).padStart(2, "0");
    return Array.from(
      { length: dayCount },
      (_, i) => `${y}-${mm}-${String(i + 1).padStart(2, "0")}`,
    );
  }, [eventsZoom, selectedIso]);

  const eventRows = useMemo(
    () => eventRowsForDays(client, eventsIsos, recurringEvents, spannedEvents),
    [client, eventsIsos, recurringEvents, spannedEvents, version],
  );

  // Group by containing page (the shared grouping): embedded blocks group
  // under their day page, standalone event pages stand alone; rows ride the
  // breadcrumb trail (the collection default).
  const eventItems = useMemo<NodeCollectionItem[]>(
    () =>
      eventRows.map((row) => ({
        node: row.node,
        meta: { containingPageId: containingPageIdOf(client, row.node) },
      })),
    [client, eventRows],
  );
  const { standalone, groups } = useMemo(
    () => groupByContainingPage(client, eventItems, onOpenPage),
    [client, eventItems, onOpenPage],
  );

  return (
    <div className="events-panel" aria-label="Events">
      <div className="events-panel__head">
        <h2 className="events-panel__title">Events</h2>
        <div className="events-panel__zoom" role="group" aria-label="Events scope">
          {EVENTS_ZOOMS.map((zoom) => (
            <Button
              key={zoom.value}
              variant="ghost"
              size="sm"
              active={eventsZoom === zoom.value}
              aria-pressed={eventsZoom === zoom.value}
              onClick={() => setEventsZoom(zoom.value)}
            >
              {zoom.label}
            </Button>
          ))}
        </div>
      </div>
      {eventRows.length === 0 ? (
        <p className="events-panel__muted">No events this {eventsZoom}.</p>
      ) : (
        <NodeCollection
          viewMode="outline"
          client={client}
          /* The flattened rows ride `items` too — the outline's grouped
             path still gates on a non-empty item list (the grouped hosts'
             contract). */
          items={eventItems}
          groups={groups}
          ungroupedItems={standalone}
          editable
          onNodeClick={onOpenPage}
        />
      )}
    </div>
  );
}
