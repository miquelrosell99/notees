/**
 * DayPageDateBar — the day-page chrome bar (§34.28 #7 date bar, owner
 * refinements): ±1 day stepping over the deterministic date-node ids
 * (ensure-chain is idempotent, so stepping into a day with no page
 * materializes it) and a Today jump. The weekday/Today flags live next to
 * the page title (`DayFlags`, rendered by PageView's title row), and the
 * Reviewed checkbox is REMOVED (owner ruling: a bad feature) — the calendar
 * tint went with it.
 */

import { useEffect, useState } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { formatDateName } from "../dateDisplay.js";
import { addDaysIso, todayIsoLocal } from "./calendarViewUtils.js";
import { Button } from "./ui/Button.js";
import "./DayPageDateBar.css";

type AnyClient = WorkspaceClient | WorkerClient;

/** The weekday + Today flags — rendered next to the day page's title. */
export function DayFlags({ iso }: { iso: string }) {
  const isToday = iso === todayIsoLocal();
  return (
    <span className="day-page-bar__label day-page-bar__label--title">
      <span className="day-page-bar__weekday">{weekdayLabelOf(iso)}</span>
      {isToday && <span className="day-page-bar__today-marker">Today</span>}
      <span className="day-page-bar__date">{formatDateName(iso.replace(/-/g, "")) ?? iso}</span>
    </span>
  );
}

function weekdayLabelOf(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString(undefined, { weekday: "long" });
}

export function DayPageDateBar({
  client,
  iso,
  onOpenPage,
}: {
  client: AnyClient;
  /** The day node's date (local ISO — derived from the id by the host). */
  iso: string;
  onOpenPage: ((nodeId: string) => void) | undefined;
}) {
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  const openDay = (targetIso: string) => {
    if (onOpenPage === undefined) return;
    void client.ensureDateChain(targetIso).then(({ day }) => onOpenPage(day));
  };

  return (
    <div className="day-page-bar">
      <Button variant="ghost" size="sm" onClick={() => openDay(addDaysIso(iso, -1))} aria-label="Previous day">
        ‹
      </Button>
      <Button variant="ghost" size="sm" onClick={() => openDay(todayIsoLocal())}>
        Today
      </Button>
      <Button variant="ghost" size="sm" onClick={() => openDay(addDaysIso(iso, 1))} aria-label="Next day">
        ›
      </Button>
    </div>
  );
}
