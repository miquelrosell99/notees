/**
 * CalendarView — the Capacities-style Day view behind the sidebar's
 * Calendar entry: a selected day (local ISO, default today) with the daily
 * note's child blocks embedded as a standalone editable outline
 * (DailyNoteOutline — no page chrome; the top bar names the day), open
 * tasks scheduled for the day (overdue surfaced above), general date
 * references fanning into the day node, everything created that day,
 * quick-create chips (configurable per workspace in Workspace
 * Settings; defaults = every class with a date-typed binding), and the
 * month grid in the right column (MonthCalendar) — the breadth pass:
 * range-aware dots (date refs and range ends fan out to the
 * deterministic day node) plus the reviewed tint on day cells and the
 * week agenda beneath the grid.
 *
 * The day sections (Daily note, Tasks, Dated, Created) and the week
 * agenda render through the shared NodeCollection in outline mode —
 * plain editable block rows, no bespoke row chrome (owner 2026-10-23):
 * the rows inline-edit like every outline, Dated/Created/agenda ride
 * the containing-page breadcrumb trail (the family default), Tasks opts
 * out (standalone rows). Tasks keeps only its section-level organization
 * (the Overdue group above Scheduled) and the New affordance.
 *
 * The composition (owner 2026-10-23): the calendar is the MainContentFrame's
 * second host — the day content rides the middle cell, the mini-month +
 * week agenda ride the frame's raised-card right panel
 * (toggled from the top bar, device-local collapse like the nodeview's
 * properties panel; the panel's width rides the host override —
 * `var(--layout-size-8xl)`, the mini-month's old 320px column, owner
 * 2026-10-23). The view's own two-column body retired; the frame
 * owns the column split.
 *
 * Recurrence (compute-on-read ruling): date values
 * carrying a `repeat` rule (metadata, additive — no wire change) expand
 * into VIRTUAL occurrences here — the Dated/Tasks sections, the month
 * dots, and the week agenda consult the expansion; recurring rows wear an
 * honest repeats marker, never one phantom row per occurrence. Editing the
 * event edits the series (the rule rides the value; the quick-create bar
 * and the property panel's date pills author it).
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
import { isClassFamilyEnabled } from "../settings/featureGates.js";
import {
  addDaysIso,
  buildCreatedTodayAst,
  buildOpenTasksAst,
  chainNodeIds,
  closedStatusOptionIds,
  dateChipCandidates,
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
  taskRowsOf,
} from "./calendarRows.js";
import {
  resolveQuickCreateChipClasses,
  useQuickCreateClassesSetting,
} from "./calendarQuickCreateSettings.js";
import { NodeCollection } from "../collection/index.js";
import { childQuery } from "../collection/childQuery.js";
import type { NodeCollectionItem } from "../collection/index.js";
import { RepeatPicker } from "../date-pickers/RepeatPicker.js";
import { Button } from "../../components/ui/fleet/Button.js";
import { EmptyState } from "../../components/ui/fleet/EmptyState.js";
import { SurfaceTopBar } from "../../components/ui/fleet/SurfaceTopBar.js";
import { Tabs } from "../../components/ui/fleet/Tabs.js";
import { MonthCalendar } from "./MonthCalendar.js";
import type { AnyClient } from "../../ui/app/Sidebar.js";
import "./CalendarView.css";

type DayFilter = "all" | "daily" | "tasks" | "dated" | "created";

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
  /**
   * The agenda panel's device-local collapse (the MainContentFrame opt-in,
   * owner 2026-10-23 — the calendar is the frame's second host): the
   * mini-month / week-agenda column rides the frame's raised-
   * card right panel, toggled from the top bar like the nodeview's
   * properties panel.
   */
  const [agendaCollapsed, setAgendaCollapsed] = useDeviceSetting(
    "calendarAgendaPanelCollapsed",
    false,
  );

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
      for (const iso of occurrenceIsosOf(
        { rule: row.rule, anchorIso: row.anchorIso },
        fromIso,
        toIso,
      )) {
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
          hasDatedRefs(client.getBacklinks(dayNodeId(iso))) || recurringDayIsos.has(iso),
      }),
    [client, recurringDayIsos, version],
  );

  // The visible week of the selected day (first-day-of-week aware).
  const weekDays = useMemo(
    () => weekDaysOfIso(selectedIso, firstDayOfWeek),
    [selectedIso, firstDayOfWeek],
  );

  // The week agenda as collection groups: each visible day with dated rows
  // is a collapsible group (its formatted date the header, the click
  // selecting the day); the rows are plain editable outline rows with the
  // breadcrumb trail — the same collection grammar as the Dated section
  // (owner 2026-10-23).
  const weekAgendaGroups = useMemo(
    () =>
      weekDays
        .map((iso) => {
          const rows = datedRowsForDay(client, iso, recurringEvents);
          if (rows.length === 0) return null;
          const [y, m, d] = iso.split("-").map(Number);
          return {
            id: iso,
            label: new Date(y!, m! - 1, d!, 12).toLocaleDateString(undefined, {
              weekday: "short",
              month: "short",
              day: "numeric",
            }),
            items: rows.map((row) => ({ node: row.node })),
            onHeaderClick: () => setSelectedIso(iso),
          };
        })
        .filter((group) => group !== null),
    [client, weekDays, recurringEvents, setSelectedIso, version],
  );

  // --- quick-create chips ------------------------------------------------------
  // Defaults follow current eligibility (every class with a date-typed
  // binding); a per-workspace device-local setting narrows the list, and the
  // settings-changed event re-renders this memo live.
  const [storedChips] = useQuickCreateClassesSetting(client.getWorkspaceId());
  const chips = useMemo(() => {
    const classes = client
      .listClasses()
      .map((cls) => ({ id: cls.id, name: displayNameFromClient(client, cls.id) }));
    const all = dateChipCandidates(classes, (classId) => client.getClassBindings(classId)).filter(
      (chip) => isClassFamilyEnabled(client, chip.classId),
    );
    const effective = new Set(
      resolveQuickCreateChipClasses(
        storedChips,
        all.map((chip) => chip.classId),
      ),
    );
    return all.filter((chip) => effective.has(chip.classId));
  }, [client, version, storedChips]);

  // --- create flow (create-with-template) ---------------------------------------
  // A class with bound has-template values opens the picker; a class without
  // (the common case) creates directly, exactly as before. The quick-create
  // bar's repeat picker stamps the new event's date value with the
  // chosen rule — device state, never an op; absent = plain event.
  const [quickRepeat, setQuickRepeat] = useState<string | null>(null);
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
    await client.setDatetimeProperty(
      id,
      schemaId,
      { iso: selectedIso },
      0,
      quickRepeat !== null ? { repeat: quickRepeat } : undefined,
    );
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

  const quickCreate = async (chip: { classId: string; schemaId: string }) => {
    await offerCreate(chip.classId, chip.schemaId);
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
              <div className="calendar-view__date-line">
                <span className="calendar-view__weekday">{weekdayLabel(selectedIso)}</span>
                {isToday && <span className="calendar-view__today-marker">Today</span>}
                <span className="calendar-view__date">{formattedDate}</span>
                <span className="calendar-view__week">Week {isoWeekNumber(selectedIso)}</span>
              </div>
            }
            actions={
              <>
                <div className="calendar-view__nav">
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="mdi-chevron-left"
                    aria-label="Previous day"
                    onClick={() => setSelectedIso((iso) => addDaysIso(iso, -1))}
                  />
                  {/* The outline variant + "Jump to today" title/aria (the
                     Journals view's register, owner 2026-10-23): the
                     bordered button reads clickable where the ghost idiom
                     doesn't. */}
                  <Button
                    variant="outline"
                    size="sm"
                    title="Jump to today"
                    aria-label="Jump to today"
                    onClick={() => setSelectedIso(todayIsoLocal())}
                  >
                    Today
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="mdi-chevron-right"
                    aria-label="Next day"
                    onClick={() => setSelectedIso((iso) => addDaysIso(iso, 1))}
                  />
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  icon="mdi-view-agenda-outline"
                  aria-label={agendaCollapsed ? "Show agenda panel" : "Hide agenda panel"}
                  aria-pressed={!agendaCollapsed}
                  title={agendaCollapsed ? "Show agenda panel" : "Hide agenda panel"}
                  active={!agendaCollapsed}
                  onClick={() => setAgendaCollapsed(!agendaCollapsed)}
                />
              </>
            }
          />
        }
        rightLabel="Agenda"
        rightPanelWidth="var(--layout-size-8xl)"
        rightPanel={
          !agendaCollapsed ? (
            <div className="calendar-view__panel">
              <MonthCalendar
                selectedDate={selectedIso}
                onSelectDate={setSelectedIso}
                firstDayOfWeek={firstDayOfWeek}
                hasNote={(iso) => client.getNodeRaw(dayNodeId(iso)) !== undefined}
                extraMarks={dayExtraMarks}
                /* The popup's title-button wiring (owner 2026-10-23): the
                   month/year buttons open the monthly/yearly date-chain
                   pages. */
                onSelectMonth={(year, month) => {
                  const iso = `${year}-${String(month).padStart(2, "0")}-01`;
                  void client.ensureDateChain(iso).then(({ month: monthId }) => onOpenPage(monthId));
                }}
                onSelectYear={(year) => {
                  void client
                    .ensureDateChain(`${year}-01-01`)
                    .then(({ year: yearId }) => onOpenPage(yearId));
                }}
              />
              <div className="calendar-view__agenda" aria-label="Week agenda">
                <h2 className="calendar-view__agenda-title">This week</h2>
                {weekAgendaGroups.length === 0 ? (
                  <p className="calendar-view__muted">Nothing dated this week.</p>
                ) : (
                  <NodeCollection
                    viewMode="outline"
                    client={client}
                    /* The flattened rows ride `items` too — the outline's
                       grouped path still gates on a non-empty item list
                       (the grouped hosts' contract). */
                    items={weekAgendaGroups.flatMap((group) => group.items)}
                    groups={weekAgendaGroups}
                    editable
                    onNodeClick={onOpenPage}
                  />
                )}
              </div>
            </div>
          ) : undefined
        }
      >
        <div className="calendar-view__main">
          {chips.length > 0 && (
            <div className="calendar-view__quick-create" aria-label="Quick create">
              {chips.map((chip) => (
                <Button
                  key={chip.classId}
                  variant="ghost"
                  size="sm"
                  onClick={() => void quickCreate(chip)}
                >
                  {chip.label}
                </Button>
              ))}
              <span className="calendar-view__quick-repeat">
                <RepeatPicker
                  value={quickRepeat}
                  onChange={setQuickRepeat}
                  ariaLabel="Repeat new events"
                />
              </span>
            </div>
          )}
  
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
                     2026-10-23): the collection self-hosts the outliner
                     context, the edit thread, and the add-block ghost —
                     the host names only the ghost's parent. No PageView,
                     no date header: the top bar names the day. */
                  <NodeCollection
                    viewMode="outline"
                    client={client}
                    items={childQuery(client, dayId)}
                    tree
                    editable
                    showBreadcrumbs={false}
                    onNodeClick={onOpenPage}
                    addGhost={{ parentId: dayId }}
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
