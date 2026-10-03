/**
 * DayPageDateBar — the day-page chrome bar (§34.28 #7 date bar + #15
 * reviewed toggle): ±1 day stepping over the deterministic date-node ids
 * (ensure-chain is idempotent, so stepping into a day with no page
 * materializes it), a Today jump, the weekday/date label with a Today
 * marker, and the Reviewed checkbox writing the §34.28 #15 boolean
 * property the calendar reads for the day-cell tint.
 */

import { useEffect, useState } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { formatDateName } from "../dateDisplay.js";
import {
  addDaysIso,
  todayIsoLocal,
  weekdayLabel,
} from "./calendarViewUtils.js";
import {
  dayReviewedOf,
  ensureDayReviewedProperty,
  setDayReviewed,
} from "./dayReviewedProperty.js";
import { Button } from "./ui/Button.js";
import { Checkbox } from "./ui/Checkbox.js";
import "./DayPageDateBar.css";

type AnyClient = WorkspaceClient | WorkerClient;

export function DayPageDateBar({
  client,
  pageId,
  iso,
  onOpenPage,
}: {
  client: AnyClient;
  /** The day node's id (the write target for Reviewed). */
  pageId: string;
  /** The day node's date (local ISO — derived from the id by the host). */
  iso: string;
  onOpenPage: ((nodeId: string) => void) | undefined;
}) {
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  // §34.28 #15 — idempotent no-op once the schema + binding exist.
  useEffect(() => {
    void ensureDayReviewedProperty(client);
  }, [client]);

  const openDay = (targetIso: string) => {
    if (onOpenPage === undefined) return;
    void client.ensureDateChain(targetIso).then(({ day }) => onOpenPage(day));
  };

  const isToday = iso === todayIsoLocal();

  return (
    <div className="day-page-bar">
      <div className="day-page-bar__nav">
        {onOpenPage !== undefined && (
          <>
            <Button
              variant="ghost"
              size="sm"
              icon="mdi-chevron-left"
              aria-label="Previous day"
              onClick={() => openDay(addDaysIso(iso, -1))}
            />
            <Button variant="ghost" size="sm" onClick={() => openDay(todayIsoLocal())}>
              Today
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon="mdi-chevron-right"
              aria-label="Next day"
              onClick={() => openDay(addDaysIso(iso, 1))}
            />
          </>
        )}
      </div>
      <span className="day-page-bar__label">
        <span className="day-page-bar__weekday">{weekdayLabel(iso)}</span>
        {isToday && <span className="day-page-bar__today-marker">Today</span>}
        <span className="day-page-bar__date">{formatDateName(iso.replace(/-/g, "")) ?? iso}</span>
      </span>
      <Checkbox
        size="sm"
        label="Reviewed"
        checked={dayReviewedOf(client, pageId)}
        onChange={(event) => void setDayReviewed(client, pageId, event.target.checked)}
      />
    </div>
  );
}
