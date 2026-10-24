/**
 * CalendarView — the grid-first Google-style calendar behind the sidebar's
 * Calendar entry: a top bar with the Day/Week/Month/Year ladder (the
 * SelectionButton button-switch) and a centered period navigator, and one
 * body per zoom. Week/Month/Year ride the CalendarGrid — the events read
 * model (calendarRows.eventRowsForDays: event-family nodes dated into the
 * day or embedded in its page) as colored blocks, drag-and-drop, the
 * recurring scope dialog, dblclick-to-create. Day zoom is the DAY AGENDA
 * (owner 2026-10-24): the selected day's events as one full-width column
 * of large colored cards (DayAgenda) — NOT the day note (the journal/day
 * page owns the note; the day zoom owns the agenda). The old day-view
 * sections (the daily-note embed, Tasks/Dated/Created partitions, the
 * filter Tabs, the create-with-template flow) retired with it — the day
 * PAGE carries those aggregations (DayPageSections), and the tasks hub
 * carries the buckets.
 *
 * Data flow follows the JournalsView pattern: synchronous reads off the
 * local store plus client.subscribe re-render. Times and ranges (owner
 * 2026-10-24): a datetime value may carry a clock time and span a range of
 * days — blocks and agenda cards prefix the label with the driving value's
 * time, spannedRowsOf expands ranges across their covered days, and a grid
 * cell dblclick opens the event creation modal (EventCreateModal).
 */

import { useEffect, useMemo, useState } from "react";

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import { formatDateName } from "../../ui/dateDisplay.js";
import { MainContentFrame } from "../../ui/MainContentFrame.js";
import { useDeviceSetting } from "../settings/deviceSettings.js";
import {
  addDaysIso,
  isoWeekNumber,
  todayIsoLocal,
  weekdayLabel,
} from "./calendarViewUtils.js";
import {
  eventRowsForDays,
  recurringRowsOf,
  spannedRowsOf,
  type DatedRow,
} from "./calendarRows.js";
import { Button } from "../../components/ui/fleet/Button.js";
import { SurfaceTopBar } from "../../components/ui/fleet/SurfaceTopBar.js";
import { SelectionButton } from "../../components/ui/fleet/SelectionButton.js";
import { DayAgenda } from "./DayAgenda.js";
import {
  CalendarGrid,
  periodOf,
  shiftMonth,
  type GridZoom,
} from "./CalendarGrid.js";
import type { AnyClient } from "../../ui/app/Sidebar.js";
import "./CalendarView.css";

/** The calendar's own zoom ladder (owner 2026-10-23, google-calendar slice 2):
    Day = the day agenda (the day's event cards), Week/Month/Year = the
    colored-blocks grids. Grid-first per the owner: month is the default.
    The switch rides the SelectionButton register (owner 2026-10-24 — the
    same button-switch the mini-month's zoom uses): icons, radiogroup
    semantics, the sliding indicator. */
type CalendarZoom = "day" | GridZoom;

const CALENDAR_ZOOMS: ReadonlyArray<{ value: CalendarZoom; label: string; icon: string }> = [
  { value: "day", label: "Day", icon: "mdi-calendar-today" },
  { value: "week", label: "Week", icon: "mdi-view-agenda-outline" },
  { value: "month", label: "Month", icon: "mdi-calendar-month" },
  { value: "year", label: "Year", icon: "mdi-calendar-range" },
];

export function CalendarView({
  client,
  onOpenPage,
}: {
  client: AnyClient;
  onOpenPage: (nodeId: string) => void;
}) {
  const [version, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);
  const [selectedIso, setSelectedIso] = useState(todayIsoLocal);
  const [firstDayOfWeek] = useDeviceSetting("firstDayOfWeek", 1);

  // The calendar's own zoom ladder state (owner 2026-10-23): grid-first,
  // month default. The day-number register: a grid day number opens the
  // day PAGE — the chain is ensured on demand, the page opens.
  const [calendarZoom, setCalendarZoom] = useDeviceSetting<CalendarZoom>(
    "calendarZoom",
    "month",
  );

  // --- recurrence + spans (compute-on-read) ---------------------------------
  // Every date value carrying a `repeat` rule, scanned once per store
  // change. Occurrences are virtual — the grid blocks and the day agenda
  // expand from this list; tasks recur through the same metadata (a
  // repeating task shows on every occurrence day, never as overdue).
  const recurringRows = useMemo(() => recurringRowsOf(client), [client, version]);
  const recurringEvents = useMemo(
    () => recurringRows.filter((row) => !row.node.classIds.includes(SYSTEM_CLASS_UUIDS.task)),
    [recurringRows],
  );
  // Multi-day spans (the datetime-range ruling): the client-side expansion
  // feed for the grid blocks and the day agenda — canonical range values
  // plus the legacy endDate metadata register (spannedRowsOf's doc).
  const spannedEvents = useMemo(() => spannedRowsOf(client), [client, version]);

  // The day agenda's rows: the events read model over the selected day
  // only (the zoom gates the work — the grid computes its own per cells).
  const agendaRows = useMemo<DatedRow[]>(
    () =>
      calendarZoom === "day"
        ? eventRowsForDays(client, [selectedIso], recurringEvents, spannedEvents)
        : [],
    [client, calendarZoom, selectedIso, recurringEvents, spannedEvents, version],
  );

  // --- the grid's visible period — the top-bar navigator owns it (owner
  // 2026-10-24): it follows the selection when that drifts across a
  // boundary (the MonthCalendar contract) and shifts by the zoom's step.
  const [period, setPeriod] = useState(() => periodOf(selectedIso));
  useEffect(() => {
    const next = periodOf(selectedIso);
    if (calendarZoom === "month" && (next.year !== period.year || next.month0 !== period.month0)) {
      setPeriod(next);
    }
    if (calendarZoom === "year" && next.year !== period.year) setPeriod(next);
    if (calendarZoom === "week") setPeriod(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follow the selection only
  }, [selectedIso, calendarZoom]);
  const shiftPeriod = (delta: number): void => {
    if (calendarZoom === "week") setSelectedIso((iso) => addDaysIso(iso, delta * 7));
    else if (calendarZoom === "year") setPeriod((p) => ({ ...p, year: p.year + delta }));
    else setPeriod((p) => shiftMonth(p, delta));
  };
  const jumpToToday = (): void => {
    // The period resets too — the selection may ALREADY be today (a bare
    // setSelectedIso would no-op and leave a wandered period behind).
    setSelectedIso(todayIsoLocal());
    setPeriod(periodOf(todayIsoLocal()));
  };
  const openDayPage = (iso: string): void => {
    void client
      .ensureDateChain(iso)
      .then(({ day }) => onOpenPage(day))
      .catch(() => {});
  };
  // A year-zoom month pick: jump to the month grid at its first day.
  const openMonthZoom = (year: number, month0: number): void => {
    setSelectedIso(`${year}-${String(month0 + 1).padStart(2, "0")}-01`);
    setCalendarZoom("month");
  };
  // The grid title buttons (panel/popup parity): open the monthly/yearly
  // date-chain pages.
  const openMonthPage = (year: number, month0: number): void => {
    const iso = `${year}-${String(month0 + 1).padStart(2, "0")}-01`;
    void client.ensureDateChain(iso).then(({ month }) => onOpenPage(month)).catch(() => {});
  };
  const openYearPage = (year: number): void => {
    void client
      .ensureDateChain(`${year}-01-01`)
      .then(({ year: yearId }) => onOpenPage(yearId))
      .catch(() => {});
  };

  const isToday = selectedIso === todayIsoLocal();
  const formattedDate = formatDateName(selectedIso.replace(/-/g, "")) ?? selectedIso;

  return (
    <div className="calendar-view">
      {/* The composition rides the shared MainContentFrame (owner
          2026-10-23 — the calendar is the frame's second host): the top
          bar spans the whole card above the body, and the day content
          rides the middle cell. */}
      <MainContentFrame
        topBar={
          <SurfaceTopBar
            className="calendar-view__topbar"
            icon="mdi-calendar-today"
            title="Calendar"
            context={
              calendarZoom === "day" ? (
                /* The Day zoom keeps the date-line context: weekday, the
                   Today marker (today only), the full date in the
                   date-format setting, and the ISO week number. */
                <div className="calendar-view__date-line">
                  <span className="calendar-view__weekday">{weekdayLabel(selectedIso)}</span>
                  {isToday && <span className="calendar-view__today-marker">Today</span>}
                  <span className="calendar-view__date">{formattedDate}</span>
                  <span className="calendar-view__week">Week {isoWeekNumber(selectedIso)}</span>
                </div>
              ) : (
                /* The period navigator (owner 2026-10-24): centered in the
                   top bar — Today, the prev/next chevrons stepping by the
                   zoom's period, and the panel/popup title buttons (month
                   prominent, year greyed) opening the date-chain pages. */
                <div className="calendar-view__period-nav">
                  <Button
                    variant="outline"
                    size="sm"
                    title="Jump to today"
                    aria-label="Jump to today"
                    onClick={jumpToToday}
                  >
                    Today
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="mdi-chevron-left"
                    aria-label="Previous period"
                    onClick={() => shiftPeriod(-1)}
                  />
                  <span className="calendar-title">
                    {calendarZoom === "year" ? (
                      <button
                        type="button"
                        className="calendar-title-btn"
                        title="Open yearly page"
                        onClick={() => openYearPage(period.year)}
                      >
                        {period.year}
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="calendar-title-btn calendar-title-btn--month"
                          title="Open monthly page"
                          onClick={() => openMonthPage(period.year, period.month0)}
                        >
                          {new Date(period.year, period.month0, 1).toLocaleDateString(undefined, {
                            month: calendarZoom === "month" ? "long" : "short",
                          })}
                        </button>
                        <button
                          type="button"
                          className="calendar-title-btn"
                          title="Open yearly page"
                          onClick={() => openYearPage(period.year)}
                        >
                          {period.year}
                        </button>
                      </>
                    )}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="mdi-chevron-right"
                    aria-label="Next period"
                    onClick={() => shiftPeriod(1)}
                  />
                </div>
              )
            }
            actions={
              <div className="calendar-view__ladder">
                <SelectionButton
                  size="sm"
                  options={CALENDAR_ZOOMS.map((zoom) => ({
                    value: zoom.value,
                    icon: zoom.icon,
                    label: zoom.label,
                  }))}
                  value={calendarZoom}
                  onChange={(value) => setCalendarZoom(value as CalendarZoom)}
                />
              </div>
            }
          />
        }
      >
        <div className="calendar-view__main">
          {calendarZoom !== "day" && (
            <CalendarGrid
              client={client}
              zoom={calendarZoom}
              selectedIso={selectedIso}
              firstDayOfWeek={firstDayOfWeek}
              recurringRows={recurringEvents}
              spannedRows={spannedEvents}
              period={period}
              onSelectDay={setSelectedIso}
              onOpenEvent={onOpenPage}
              onOpenDayPage={openDayPage}
              onOpenMonth={openMonthZoom}
              onOpenMonthPage={openMonthPage}
              onOpenYearPage={openYearPage}
            />
          )}
          {calendarZoom === "day" && (
            <DayAgenda
              client={client}
              iso={selectedIso}
              rows={agendaRows}
              onOpenEvent={onOpenPage}
            />
          )}
        </div>
      </MainContentFrame>
    </div>
  );
}
