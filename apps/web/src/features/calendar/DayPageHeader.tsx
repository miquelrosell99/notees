/**
 * DayPageHeader — the day-page header chrome (owner
 * refinement 2026-10-06): the weekday + Today flags ride a small line ABOVE
 * the title, and the ISO week number rides a small flag AFTER the title. The
 * title itself stays the user's dateFormat-aware display name (the caller
 * passes nodeDisplayName — the stored compact label must stay
 * canonical for sorting and date lookups). The ±1-day stepping bar is
 * BACK (owner 2026-10-24, the day-page register — the Logseq/Capacities
 * precedent: prev/today/next lives on the daily note itself): ‹ / › step
 * one day either side, Today jumps back; the target day page is
 * materialized on demand (the ensureDateChain pattern) and opened through
 * the caller's navigation seam. Preview surfaces pass no seam and get no
 * bar. The Reviewed checkbox stays retired (Properties owns it).
 */

import { Button } from "../../components/ui/fleet/Button.js";
import { addDaysIso, isoWeekNumber, todayIsoLocal, weekdayLabel } from "./calendarViewUtils.js";
import "./DayPageHeader.css";

export function DayPageHeader({
  iso,
  title,
  onNavigateDay,
}: {
  iso: string;
  title: string;
  /** Step to a day page (materialized on demand); undefined = no bar. */
  onNavigateDay?: ((iso: string) => void) | undefined;
}) {
  const isToday = iso === todayIsoLocal();
  return (
    <div className="day-page-header">
      <div className="day-page-header__flags">
        <span className="day-page-header__weekday">{weekdayLabel(iso)}</span>
        {isToday && <span className="day-page-header__today">Today</span>}
        {onNavigateDay !== undefined && (
          /* The stepping bar: ghost chevrons + the outline-variant Today
             (the Journals register — the bordered button reads clickable
             where the ghost idiom doesn't). Today hides on today itself. */
          <span className="day-page-header__nav">
            <Button
              variant="ghost"
              size="sm"
              icon="mdi-chevron-left"
              aria-label="Previous day"
              onClick={() => onNavigateDay(addDaysIso(iso, -1))}
            />
            {!isToday && (
              <Button
                variant="outline"
                size="sm"
                title="Jump to today"
                aria-label="Jump to today"
                onClick={() => onNavigateDay(todayIsoLocal())}
              >
                Today
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              icon="mdi-chevron-right"
              aria-label="Next day"
              onClick={() => onNavigateDay(addDaysIso(iso, 1))}
            />
          </span>
        )}
      </div>
      <h1 className="nt-page-title day-page-header__title">
        {title}
        <span className="day-page-header__week">Week {isoWeekNumber(iso)}</span>
      </h1>
    </div>
  );
}
