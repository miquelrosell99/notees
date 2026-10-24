/**
 * DayStepper — the ‹ / Today / › day-stepping cluster (owner 2026-10-24,
 * the top-bar register): ghost chevrons stepping one day either side,
 * with the BORDERED Today button BETWEEN them (the owner's "centered" —
 * centered between the arrows, not the bar). Rendered in the main
 * content top bar's right cluster while a day page is open; Today stays
 * visible on today itself (a bare reset, the calendar navigator's
 * register). The target day page is materialized on demand (the
 * ensureDateChain pattern) by the CALLER's onNavigateDay seam.
 */

import { Button } from "../../components/ui/fleet/Button.js";
import {
  addDaysIso,
  isoWeekNumber,
  todayIsoLocal,
  weekdayLabel,
} from "./calendarViewUtils.js";

export function DayStepper({ iso, onNavigateDay }: { iso: string; onNavigateDay: (iso: string) => void }) {
  return (
    <span className="day-stepper" role="group" aria-label="Day navigation">
      <Button
        variant="ghost"
        size="sm"
        icon="mdi-chevron-left"
        aria-label="Previous day"
        onClick={() => onNavigateDay(addDaysIso(iso, -1))}
      />
      <Button
        variant="outline"
        size="sm"
        title="Jump to today"
        aria-label="Jump to today"
        onClick={() => onNavigateDay(todayIsoLocal())}
      >
        Today
      </Button>
      <Button
        variant="ghost"
        size="sm"
        icon="mdi-chevron-right"
        aria-label="Next day"
        onClick={() => onNavigateDay(addDaysIso(iso, 1))}
      />
    </span>
  );
}

/**
 * DayPageHeader — the day-page header chrome (owner
 * refinement 2026-10-06): the weekday + Today flags ride a small line ABOVE
 * the title, and the ISO week number rides a small flag AFTER the title. The
 * title itself stays the user's dateFormat-aware display name (the caller
 * passes nodeDisplayName — the stored compact label must stay
 * canonical for sorting and date lookups). The ±1-day stepping lives in the
 * MAIN TOP BAR's right cluster now (owner 2026-10-24 pass 3 — the DayStepper,
 * replacing the header-internal bar of the same morning): the header stays
 * the date's own chrome. The Reviewed checkbox stays retired (Properties
 * owns it).
 */

import "./DayPageHeader.css";

export function DayPageHeader({ iso, title }: { iso: string; title: string }) {
  const isToday = iso === todayIsoLocal();
  return (
    <div className="day-page-header">
      <div className="day-page-header__flags">
        <span className="day-page-header__weekday">{weekdayLabel(iso)}</span>
        {isToday && <span className="day-page-header__today">Today</span>}
      </div>
      <h1 className="nt-page-title day-page-header__title">
        {title}
        <span className="day-page-header__week">Week {isoWeekNumber(iso)}</span>
      </h1>
    </div>
  );
}
