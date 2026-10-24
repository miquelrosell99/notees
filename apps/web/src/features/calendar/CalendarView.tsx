/**
 * CalendarView — the Capacities-style Day view behind the sidebar's
 * Calendar entry: a selected day (local ISO, default today) with the daily
 * note's child blocks embedded as a standalone editable outline
 * (no page chrome; the top bar names the day), open tasks scheduled for
 * the day (overdue surfaced above), general date references fanning into
 * the day node, everything created that day, and the month grid in the
 * right column (MonthCalendar) with the events element beneath it — the
 * breadth pass: range-aware dots (date refs and range ends fan out to the
 * deterministic day node) plus the reviewed tint on day cells.
 *
 * The grid IS the agenda (owner 2026-10-24, the redundancy ruling): the
 * retired events element's membership — event-family nodes dated into the
 * day or embedded at any level inside the day page — renders as colored
 * blocks on the Week/Month/Year grids (calendarRows.eventRowsForDays, the
 * same read model); the right panel carries ONLY the mini-month navigator
 * (the Google/Apple register). The day sections render through the shared
 * NodeCollection in outline mode —
 * plain editable block rows, no bespoke row chrome (owner 2026-10-23):
 * the rows inline-edit like every outline, Dated/Created ride the
 * containing-page breadcrumb trail (the family default), Tasks opts
 * out (standalone rows). Tasks keeps only its section-level organization
 * (the Overdue group above Scheduled) and the New affordance.
 *
 * The composition (owner 2026-10-23): the calendar is the MainContentFrame's
 * second host — the day content rides the middle cell, the mini-month +
 * events element ride the frame's raised-card right panel
 * (toggled from the top bar, device-local collapse like the nodeview's
 * properties panel; the panel's width rides the host override —
 * `var(--layout-size-8xl)`, the mini-month's old 320px column, owner
 * 2026-10-23). The view's own two-column body retired; the frame
 * owns the column split.
 *
 * Recurrence (compute-on-read ruling): date values
 * carrying a `repeat` rule (metadata, additive — no wire change) expand
 * into VIRTUAL occurrences here — the Dated/Tasks sections, the month
 * dots, and the events element consult the expansion; recurring rows wear an
 * honest repeats marker, never one phantom row per occurrence. Editing the
 * event edits the series (the rule rides the value; the property panel's
 * date pills author it).
 *
 * Data flow follows the JournalsView pattern: synchronous reads off the
 * local store plus client.subscribe re-render; the two structured queries
 * (open tasks, created-today) run through runQueryAst per notification and
 * cache their last result while a re-run lands (the QueryBlockView
 * contract). The task family is authored idempotently on first
 * open so scheduling actually works on a fresh workspace.
 */

import { useEffect, useMemo, useState } from "react";

import {
  occurrenceIsosOf,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
} from "@notees/domain";

import type { ClientNode, QueryRunResult } from "@/core/workspace-client/index.js";

import { instantiateTemplate } from "@/core/clone.js";
import { displayNameFromClient, formatDateName } from "../../ui/dateDisplay.js";
import { MainContentFrame } from "../../ui/MainContentFrame.js";
import { useDeviceSetting } from "../settings/deviceSettings.js";
import { TemplatePickerModal } from "../templates/TemplatePickerModal.js";
import { ensureTaskFamily } from "../classview/taskFamily.js";
import { ensureTemplateProperty, listClassTemplates } from "../templates/templateFamily.js";
import {
  addDaysIso,
  buildCreatedTodayAst,
  buildOpenTasksAst,
  chainNodeIds,
  closedStatusOptionIds,
  dayNodeId,
  hasDatedRefs,
  isoWeekNumber,
  partitionOpenTasks,
  todayIsoLocal,
  weekDaysOfIso,
  weekdayLabel,
} from "./calendarViewUtils.js";
import {
  datedRowsForDay,
  recurringRowsOf,
  spannedRowsOf,
  taskRowsOf,
} from "./calendarRows.js";
import { NodeCollection } from "../collection/index.js";
import type { NodeCollectionItem } from "../collection/index.js";
import { Button } from "../../components/ui/fleet/Button.js";
import { EmptyState } from "../../components/ui/fleet/EmptyState.js";
import { SurfaceTopBar } from "../../components/ui/fleet/SurfaceTopBar.js";
import { Tabs } from "../../components/ui/fleet/Tabs.js";
import { SelectionButton } from "../../components/ui/fleet/SelectionButton.js";
import { MonthCalendar } from "./MonthCalendar.js";
import {
  CalendarGrid,
  periodOf,
  shiftMonth,
  type GridZoom,
} from "./CalendarGrid.js";
import type { AnyClient } from "../../ui/app/Sidebar.js";
import "./CalendarView.css";

type DayFilter = "all" | "daily" | "tasks" | "dated" | "created";

/** The calendar's own zoom ladder (owner 2026-10-23, google-calendar slice 2):
    Day = the day view (sections + the right panel), Week/Month/Year = the
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

const FILTERS: Array<{ value: DayFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "daily", label: "Daily note" },
  { value: "tasks", label: "Tasks" },
  { value: "dated", label: "Dated" },
  { value: "created", label: "Created" },
];

/**
 * A node's collection item, undefined filtered — the sections feed the
 * shared NodeCollection plain `{node}` rows (no bespoke row chrome,
 * owner 2026-10-23).
 */
function itemsOf(client: AnyClient, ids: string[]): NodeCollectionItem[] {
  return ids
    .map((id) => client.getNode(id))
    .filter((node): node is ClientNode => node !== undefined)
    .map((node) => ({ node }));
}

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
  const [filter, setFilter] = useState<DayFilter>("all");
  const [firstDayOfWeek] = useDeviceSetting("firstDayOfWeek", 1);

  // Family ensure: idempotent no-op once the six schemas + bindings exist.
  // Fire-and-forget: a rejection (e.g. the store closing mid-deploy) must not
  // surface as an unhandled rejection — the next mount re-runs the deploy.
  useEffect(() => {
    void ensureTaskFamily(client).catch(() => {});
  }, [client]);

  const dayId = dayNodeId(selectedIso);
  const chain = chainNodeIds(selectedIso);
  // Day-existence only, exactly like the calendar popup's has-note dots
  // (an existing day page renders, even before today's exists).
  const hasDailyNote = client.getNodeRaw(dayId) !== undefined;

  const statusSchema = client
    .listPropertySchemas()
    .find((schema) => schema.id === SYSTEM_PROPERTY_UUIDS.taskStatus);

  // --- structured queries (open tasks + created-today), re-run per notify ---
  const [tasksResult, setTasksResult] = useState<QueryRunResult | null>(null);
  const [createdResult, setCreatedResult] = useState<QueryRunResult | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const schemas = client.listPropertySchemas();
        const closedIds = closedStatusOptionIds(
          schemas.find((schema) => schema.id === SYSTEM_PROPERTY_UUIDS.taskStatus),
        );
        const [tasks, created] = await Promise.all([
          Promise.resolve(client.runQueryAst(buildOpenTasksAst(closedIds))),
          Promise.resolve(client.runQueryAst(buildCreatedTodayAst(selectedIso))),
        ]);
        if (cancelled) return;
        setTasksResult(tasks);
        setCreatedResult(created);
        setQueryError(null);
      } catch (error) {
        if (cancelled) return;
        setTasksResult(null);
        setCreatedResult(null);
        setQueryError(error instanceof Error ? error.message : String(error));
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
    // statusSchema's options feed the open-task AST — re-resolve per notify.
  }, [client, selectedIso, version]);

  // --- tasks: client-side partition of the one query -------------------------
  const partitioned = useMemo(() => {
    if (tasksResult === null) return { overdue: [], scheduled: [] };
    return partitionOpenTasks(
      taskRowsOf(
        client,
        statusSchema,
        tasksResult.rows.map((summary) => summary.id),
      ),
      selectedIso,
    );
  }, [client, tasksResult, selectedIso, statusSchema, version]);

  const openCount =
    partitioned.overdue.length + partitioned.scheduled.filter((row) => !row.occurrenceDone).length;

  // The Tasks section's plain outline rows (owner 2026-10-23: no checkbox,
  // status pill, or repeat marker — the shared editable outline row, like
  // Dated/Created, no breadcrumbs). Overdue keeps its own group above
  // Scheduled — section-level organization, not row chrome.
  const overdueItems = useMemo(
    () => itemsOf(client, partitioned.overdue.map((row) => row.id)),
    [client, partitioned, version],
  );
  const scheduledItems = useMemo(
    () => itemsOf(client, partitioned.scheduled.map((row) => row.id)),
    [client, partitioned, version],
  );

  // --- recurrence (compute-on-read) -------------------------------------------
  // Every date value carrying a `repeat` rule, scanned once per store change.
  // Occurrences are virtual — the Dated section, the month dots, and the week
  // agenda all expand from this list; tasks recur through the same metadata
  // (a repeating task shows on every occurrence day, never as overdue).
  const recurringRows = useMemo(() => recurringRowsOf(client), [client, version]);
  const recurringEvents = useMemo(
    () => recurringRows.filter((row) => !row.node.classIds.includes(SYSTEM_CLASS_UUIDS.task)),
    [recurringRows],
  );
  // Multi-day spans (the datetime-range ruling): the client-side expansion
  // feed for the events element, the grid blocks, and the day dots.
  const spannedEvents = useMemo(() => spannedRowsOf(client), [client, version]);

  // The Dated rows for the selected day: materialized backlinks UNION the
  // recurring events occurring on this day (deduped by id). The section
  // renders them as plain editable outline rows riding the breadcrumb
  // trail (the collection default).
  const datedItems = useMemo(
    () => datedRowsForDay(client, selectedIso, recurringEvents).map((row) => ({ node: row.node })),
    [client, selectedIso, recurringEvents, version],
  );

  // Occurrence days around the visible month, for the grid dots.
  // The grid follows the selected day across month boundaries, so ±40 days
  // covers the whole visible month in every steady state.
  const recurringDayIsos = useMemo(() => {
    const fromIso = addDaysIso(selectedIso, -40);
    const toIso = addDaysIso(selectedIso, 40);
    const isos = new Set<string>();
    for (const row of recurringRows) {
      for (const iso of occurrenceIsosOf(row.series, fromIso, toIso)) {
        isos.add(iso);
      }
    }
    return isos;
  }, [recurringRows, selectedIso]);

  // --- created today: createdAt range query, newest first --------------------
  const createdRows = useMemo(() => {
    if (createdResult === null) return [] as ClientNode[];
    const excluded = new Set([chain.year, chain.month, chain.day]);
    return createdResult.rows
      .filter((row) => !excluded.has(row.id))
      .map((row) => client.getNode(row.id))
      .filter((node): node is ClientNode => node !== undefined)
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || a.id.localeCompare(b.id));
  }, [client, createdResult, selectedIso, version]);

  // Created renders as plain editable outline rows with the breadcrumb
  // trail (the collection default), newest first.
  const createdItems = useMemo(() => createdRows.map((node) => ({ node })), [createdRows]);

  // --- day marks + week breadth -------------------------------------------
  // Range-aware dots + the reviewed tint read the same materialized state as
  // the sections: one backlink read per day cell (the edge projection fans
  // date refs and range ends out to the deterministic day node, so an
  // existing day page is NOT required for a mark). Recurring events dot
  // every occurrence day from the virtual expansion (their backlink lands
  // on the anchor day only).
  const dayExtraMarks = useMemo(
    () =>
      (iso: string): { dated: boolean } => ({
        dated:
          hasDatedRefs(client.getBacklinks(dayNodeId(iso))) ||
          recurringDayIsos.has(iso) ||
          spannedEvents.some((row) => iso >= row.startIso && iso <= row.endIso),
      }),
    [client, recurringDayIsos, spannedEvents, version],
  );

  // --- events element (the panel's events list, owner 2026-10-23) -------------
  // Replaces the retired week agenda / quick-create bar: a NodeCollection
  // outline with day/week/month zoom over event-family nodes — dated into
  // the scope days OR embedded at any parent level inside the scope day
  // pages. The zoom rides a device-local setting; the scope follows the
  // selected day (day = the day, week = its week, month = its whole month).

  // The calendar's own zoom ladder state (owner 2026-10-23): grid-first,
  // month default. The day-number register: a grid day number opens the day
  // PAGE — the chain is ensured on demand, the page opens.
  const [calendarZoom, setCalendarZoom] = useDeviceSetting<CalendarZoom>(
    "calendarZoom",
    "month",
  );
  /** The grid's visible period — the top-bar navigator owns it (owner
   * 2026-10-24): it follows the selection when that drifts across a
   * boundary (the MonthCalendar contract) and shifts by the zoom's step. */
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

  // --- create flow (create-with-template) ---------------------------------------
  // A class with bound has-template values opens the picker; a class without
  // (the common case) creates directly, exactly as before.
  const [pendingCreate, setPendingCreate] = useState<{
    classId: string;
    schemaId: string;
    templates: ClientNode[];
  } | null>(null);

  const createClassed = async (
    classId: string,
    schemaId: string,
    templateId: string | null,
  ): Promise<void> => {
    const id = await client.createObject({ isEmbedded: false, classIds: [classId] });
    if (templateId !== null) {
      // Graft the template root onto the fresh object + clone its children
      // beneath it (SCHEMA.md "Templates", instantiate-at-create).
      await instantiateTemplate(
        { reads: client, writes: client },
        { templateRootId: templateId, objectId: id },
      );
    }
    await client.setDatetimeProperty(id, schemaId, { iso: selectedIso }, 0);
    onOpenPage(id);
  };

  const offerCreate = async (classId: string, schemaId: string): Promise<void> => {
    await ensureTemplateProperty(client);
    const templates = listClassTemplates(client, classId);
    if (templates.length === 0) {
      await createClassed(classId, schemaId, null);
      return;
    }
    setPendingCreate({ classId, schemaId, templates });
  };

  const runPickedCreate = (templateId: string | null): void => {
    const pending = pendingCreate;
    setPendingCreate(null);
    if (pending === null) return;
    void createClassed(pending.classId, pending.schemaId, templateId);
  };

  const createTask = async () => {
    await offerCreate(SYSTEM_CLASS_UUIDS.task, SYSTEM_PROPERTY_UUIDS.taskScheduled);
  };

  const isToday = selectedIso === todayIsoLocal();
  const formattedDate = formatDateName(selectedIso.replace(/-/g, "")) ?? selectedIso;
  const show = (section: DayFilter) => filter === "all" || filter === section;

  return (
    <div className="calendar-view">
      {/* The composition rides the shared MainContentFrame (owner
          2026-10-23 — the calendar is the frame's second host): the top
          bar spans the whole card above the column split (the agenda
          toggle at its right end, above the panel it reveals), the day
          content rides the middle cell, and the mini-month + week agenda
          ride the frame's raised-card right panel. The quick-
          create row and the filter Tabs are content-level controls and
          stay in the body. */}
      <MainContentFrame
        topBar={
          <SurfaceTopBar
            className="calendar-view__topbar"
            icon="mdi-calendar-today"
            title="Calendar"
            context={
              calendarZoom === "day" ? (
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
              <>
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
              </>
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
          <>
          <Tabs value={filter} onChange={setFilter} className="calendar-view__filter">
            <Tabs.List>
              {FILTERS.map((entry) => (
                <Tabs.Tab key={entry.value} value={entry.value}>
                  {entry.label}
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </Tabs>
  
          <div className="calendar-view__sections">
            {show("daily") && (
              <section className="calendar-view__section" aria-label="Daily note">
                <h2 className="calendar-view__section-title">Daily Note</h2>
                {hasDailyNote ? (
                  /* The standalone editable outline (owner rulings
                     2026-10-23): BODY MODE — rootId names the day, the
                     collection resolves the items, self-hosts the outliner
                     context + edit thread, and constructs the add-block
                     ghost. The host names nothing else. No PageView, no
                     date header: the top bar names the day. */
                  <NodeCollection
                    viewMode="outline"
                    client={client}
                    rootId={dayId}
                    ghost
                    tree
                    editable
                    showBreadcrumbs={false}
                    onNodeClick={onOpenPage}
                  />
                ) : (
                  <div className="calendar-view__empty-block">
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="mdi-plus"
                      onClick={() => void client.ensureDateChain(selectedIso)}
                    >
                      Daily Note
                    </Button>
                  </div>
                )}
              </section>
            )}

            {show("tasks") && (
              <section className="calendar-view__section" aria-label="Tasks">
                <div className="calendar-view__section-head">
                  <h2 className="calendar-view__section-title">Tasks</h2>
                  <span className="calendar-view__count">{openCount} open</span>
                  <Button variant="ghost" size="sm" icon="mdi-plus" onClick={() => void createTask()}>
                    New
                  </Button>
                </div>
                {queryError !== null && <p className="calendar-view__error">{queryError}</p>}
                {queryError === null && openCount === 0 && (
                  <p className="calendar-view__muted">Nothing scheduled for this day.</p>
                )}
                {overdueItems.length > 0 && (
                  <div className="calendar-view__group">
                    <h3 className="calendar-view__group-title calendar-view__group-title--overdue">
                      Overdue
                    </h3>
                    <NodeCollection
                      viewMode="outline"
                      client={client}
                      items={overdueItems}
                      editable
                      showBreadcrumbs={false}
                      onNodeClick={onOpenPage}
                    />
                  </div>
                )}
                {scheduledItems.length > 0 && (
                  <div className="calendar-view__group">
                    <h3 className="calendar-view__group-title">Scheduled</h3>
                    <NodeCollection
                      viewMode="outline"
                      client={client}
                      items={scheduledItems}
                      editable
                      showBreadcrumbs={false}
                      onNodeClick={onOpenPage}
                    />
                  </div>
                )}
              </section>
            )}

            {show("dated") &&
              (datedItems.length > 0 ? (
                <section className="calendar-view__section" aria-label="Dated">
                  <h2 className="calendar-view__section-title">Dated</h2>
                  <NodeCollection
                    viewMode="outline"
                    client={client}
                    items={datedItems}
                    editable
                    onNodeClick={onOpenPage}
                  />
                </section>
              ) : (
                filter === "dated" && <EmptyState title="Nothing references this day yet." />
              ))}

            {show("created") &&
              (createdItems.length > 0 ? (
                <section className="calendar-view__section" aria-label="Created">
                  <h2 className="calendar-view__section-title">Created</h2>
                  <NodeCollection
                    viewMode="outline"
                    client={client}
                    items={createdItems}
                    editable
                    onNodeClick={onOpenPage}
                  />
                </section>
              ) : (
                filter === "created" && <EmptyState title="There's nothing here (yet)." />
              ))}
          </div>
          </>
          )}
        </div>
      </MainContentFrame>

      {pendingCreate !== null && (
        <TemplatePickerModal
          isOpen
          onClose={() => setPendingCreate(null)}
          classLabel={displayNameFromClient(client, pendingCreate.classId) ?? "object"}
          templates={pendingCreate.templates}
          onPick={runPickedCreate}
        />
      )}
    </div>
  );
}
