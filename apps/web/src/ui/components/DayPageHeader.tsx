/**
 * DayPageHeader — the day-page header chrome (§34.28 #7 header, owner
 * refinement 2026-10-06): the weekday + Today flags ride a small line ABOVE
 * the title, and the ISO week number rides a small flag AFTER the title. The
 * title itself stays the user's dateFormat-aware display name (the caller
 * passes displayNameForSettings — the stored compact label must stay
 * canonical for sorting and date lookups). The ±1-day stepping bar and the
 * Reviewed checkbox are gone (owner ruling — day navigation rides the
 * calendar popup, the Today sidebar entry, and Ctrl/Cmd+Shift+T).
 */

import { isoWeekNumber, todayIsoLocal, weekdayLabel } from "./calendarViewUtils.js";
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
