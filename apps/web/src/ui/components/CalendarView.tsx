/**
 * CalendarView — the Capacities-style Day view behind the sidebar's
 * Calendar entry: a selected day (local ISO, default today) with the daily
 * note embedded, open tasks scheduled for the day (overdue surfaced above),
 * general date references fanning into the day node, everything created
 * that day, quick-create chips (configurable per workspace in Workspace
 * Settings; defaults = every class with a date-typed binding), and the
 * month grid in the right column (MonthCalendar).
 *
 * Data flow follows the JournalsView pattern: synchronous reads off the
 * local store plus client.subscribe re-render; the two structured queries
 * (open tasks, created-today) run through runQueryAst per notification and
 * cache their last result while a re-run lands (the QueryBlockView
 * contract). The §34.28 #2 task family is authored idempotently on first
 * open so scheduling actually works on a fresh workspace.
 */

import { useEffect, useMemo, useState } from "react";

import {
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
  TASK_CLOSED_STATUSES,
  TASK_DEFAULT_STATUS,
  parseDateNodeId,
} from "@notees/domain";

import type { ClientNode, QueryRunResult } from "@/core/workspace-client.js";

import { displayNameFromClient, formatDateName } from "../dateDisplay.js";
import { Icon } from "../Icon.js";
import { PageView } from "../PageView.js";
import { useDeviceSetting } from "./modals/deviceSettings.js";
import { ensureTaskFamily } from "./taskFamily.js";
import {
  addDaysIso,
  buildCreatedTodayAst,
  buildOpenTasksAst,
  chainNodeIds,
  closedStatusOptionIds,
  dateChipCandidates,
  dayNodeId,
  isoWeekNumber,
  partitionOpenTasks,
  todayIsoLocal,
  weekdayLabel,
  type OpenTaskRow,
} from "./calendarViewUtils.js";
import {
  resolveQuickCreateChipClasses,
  useQuickCreateClassesSetting,
} from "./calendarQuickCreateSettings.js";
import { Button } from "./ui/Button.js";
import { Checkbox } from "./ui/Checkbox.js";
import { EmptyState } from "./ui/EmptyState.js";
import { Pill } from "./ui/Pill.js";
import { Tabs } from "./ui/Tabs.js";
import { MonthCalendar } from "./ui/calendar/MonthCalendar.js";
import type { AnyClient } from "./Sidebar.js";
import "./CalendarView.css";

type DayFilter = "all" | "daily" | "tasks" | "dated" | "created";

const FILTERS: Array<{ value: DayFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "daily", label: "Daily note" },
  { value: "tasks", label: "Tasks" },
  { value: "dated", label: "Dated" },
  { value: "created", label: "Created" },
];

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** The local ISO day a taskScheduled value points at (null unless day-precision). */
function scheduledIsoOf(value: unknown): string | null {
  const ref = value as { nodeId?: unknown } | undefined;
  if (typeof ref?.nodeId !== "string") return null;
  const parsed = parseDateNodeId(ref.nodeId);
  if (parsed === null || parsed.precision !== "day") return null;
  return `${String(parsed.year).padStart(4, "0")}-${pad2(parsed.month)}-${pad2(parsed.day)}`;
}

/** Read-only class chips (the table view's idiom) on a calendar row. */
function RowClassChips({ client, classIds }: { client: AnyClient; classIds: string[] }) {
  const classes = classIds
    .map((classId) => client.getNode(classId))
    .filter((node): node is ClientNode => node !== undefined);
  if (classes.length === 0) return null;
  return (
    <span className="calendar-view__chips">
      {classes.map((cls) => (
        <span key={cls.id} className="calendar-view__chip">
          {displayNameFromClient(client, cls.id) ?? cls.id}
        </span>
      ))}
    </span>
  );
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

  // §34.28 #2 — idempotent no-op once the six schemas + bindings exist.
  useEffect(() => {
    void ensureTaskFamily(client);
  }, [client]);

  const dayId = dayNodeId(selectedIso);
  const chain = chainNodeIds(selectedIso);
  // Day-existence only, exactly like the calendar popup's has-note dots
  // (§34.28 #11 — an existing day page renders, even before today's exists).
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
    if (tasksResult === null) return { overdue: [] as OpenTaskRow[], scheduled: [] as OpenTaskRow[] };
    const rows: OpenTaskRow[] = [];
    for (const summary of tasksResult.rows) {
      const node = client.getNode(summary.id);
      if (node === undefined) continue;
      const props = client.getEffectiveProperties(node.id);
      const scheduledIso = scheduledIsoOf(
        props.find((prop) => prop.propertySchemaId === SYSTEM_PROPERTY_UUIDS.taskScheduled)?.value,
      );
      const statusValue = props.find(
        (prop) => prop.propertySchemaId === SYSTEM_PROPERTY_UUIDS.taskStatus,
      )?.value;
      const statusLabel =
        typeof statusValue === "string"
          ? (statusSchema?.options?.find((option) => option.id === statusValue)?.label ?? null)
          : null;
      rows.push({
        id: node.id,
        scheduledIso,
        closed: statusLabel !== null && TASK_CLOSED_STATUSES.has(statusLabel as "Done" | "Cancelled"),
      });
    }
    return partitionOpenTasks(rows, selectedIso);
  }, [client, tasksResult, selectedIso, statusSchema, version]);

  const openCount = partitioned.overdue.length + partitioned.scheduled.length;

  /** The tasks hub's done write, exactly: property.set with the option id. */
  const setTaskDone = async (row: OpenTaskRow, done: boolean) => {
    if (statusSchema?.options === null || statusSchema === undefined) return;
    const targetLabel = done ? ("Done" as const) : TASK_DEFAULT_STATUS;
    const target = statusSchema.options?.find((option) => option.label === targetLabel);
    if (target === undefined) return;
    const prop = client
      .getEffectiveProperties(row.id)
      .find((entry) => entry.propertySchemaId === statusSchema.id);
    await client.setProperty(row.id, statusSchema.id, target.id, prop?.idx ?? 0);
  };

  const statusLabelOf = (id: string): string | null => {
    const value = client
      .getEffectiveProperties(id)
      .find((entry) => entry.propertySchemaId === SYSTEM_PROPERTY_UUIDS.taskStatus)?.value;
    if (typeof value !== "string") return null;
    return statusSchema?.options?.find((option) => option.id === value)?.label ?? value;
  };

  // --- dated: the day node's existing backlink set (§34.28 #4a) --------------
  const datedRows = useMemo(() => {
    const seen = new Set<string>();
    const rows: ClientNode[] = [];
    for (const edge of client.getBacklinks(dayId)) {
      if (seen.has(edge.sourceId)) continue;
      seen.add(edge.sourceId);
      // Date-chain nodes and the daily note itself carry no section row.
      if (parseDateNodeId(edge.sourceId) !== null) continue;
      const node = client.getNode(edge.sourceId);
      if (node === undefined) continue;
      if (node.classIds.includes(SYSTEM_CLASS_UUIDS.task)) continue; // own section
      rows.push(node);
    }
    rows.sort(
      (a, b) =>
        (displayNameFromClient(client, a.id) ?? a.id).localeCompare(
          displayNameFromClient(client, b.id) ?? b.id,
        ) || a.id.localeCompare(b.id),
    );
    return rows;
  }, [client, dayId, version]);

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

  // --- quick-create chips (§34.28 #10) ---------------------------------------
  // Defaults follow current eligibility (every class with a date-typed
  // binding); a per-workspace device-local setting narrows the list, and the
  // settings-changed event re-renders this memo live.
  const [storedChips] = useQuickCreateClassesSetting(client.getWorkspaceId());
  const chips = useMemo(() => {
    const classes = client
      .listClasses()
      .map((cls) => ({ id: cls.id, name: displayNameFromClient(client, cls.id) }));
    const all = dateChipCandidates(classes, (classId) => client.getClassBindings(classId));
    const effective = new Set(
      resolveQuickCreateChipClasses(
        storedChips,
        all.map((chip) => chip.classId),
      ),
    );
    return all.filter((chip) => effective.has(chip.classId));
  }, [client, version, storedChips]);

  const quickCreate = async (chip: { classId: string; schemaId: string }) => {
    const id = await client.createObject({ presentAsMain: true, classIds: [chip.classId] });
    await client.setDateProperty(id, chip.schemaId, selectedIso);
    onOpenPage(id);
  };

  const createTask = async () => {
    const id = await client.createObject({ presentAsMain: true, classIds: [SYSTEM_CLASS_UUIDS.task] });
    await client.setDateProperty(id, SYSTEM_PROPERTY_UUIDS.taskScheduled, selectedIso);
    onOpenPage(id);
  };

  const isToday = selectedIso === todayIsoLocal();
  const formattedDate = formatDateName(selectedIso.replace(/-/g, "")) ?? selectedIso;
  const show = (section: DayFilter) => filter === "all" || filter === section;

  const renderTaskRow = (row: OpenTaskRow, group: "overdue" | "scheduled") => (
    <li
      key={row.id}
      className={`calendar-view__row${
        group === "overdue" ? " calendar-view__row--overdue" : ""
      }`}
    >
      <Checkbox
        size="sm"
        checked={row.closed}
        disabled={statusSchema === undefined}
        aria-label={row.closed ? "Reopen task" : "Mark task done"}
        onChange={(event) => void setTaskDone(row, event.target.checked)}
      />
      <button
        type="button"
        className="calendar-view__row-name"
        onClick={() => onOpenPage(row.id)}
      >
        {displayNameFromClient(client, row.id) ?? row.id}
      </button>
      {statusSchema !== undefined && statusLabelOf(row.id) !== null && (
        <Pill text={statusLabelOf(row.id)!} />
      )}
      {group === "overdue" && row.scheduledIso !== null && (
        <span className="calendar-view__row-day">{row.scheduledIso}</span>
      )}
    </li>
  );

  return (
    <div className="calendar-view">
      <div className="calendar-view__main">
        <header className="calendar-view__header">
          <div className="calendar-view__heading">
            <h1 className="calendar-view__title">
              <Icon path="mdi-calendar-today" size={1.1} />
              Calendar
            </h1>
            <div className="calendar-view__date-line">
              <span className="calendar-view__weekday">{weekdayLabel(selectedIso)}</span>
              {isToday && <span className="calendar-view__today-marker">Today</span>}
              <span className="calendar-view__date">{formattedDate}</span>
              <span className="calendar-view__week">Week {isoWeekNumber(selectedIso)}</span>
            </div>
          </div>
          <div className="calendar-view__nav">
            <Button
              variant="ghost"
              size="sm"
              icon="mdi-chevron-left"
              aria-label="Previous day"
              onClick={() => setSelectedIso((iso) => addDaysIso(iso, -1))}
            />
            <Button variant="ghost" size="sm" onClick={() => setSelectedIso(todayIsoLocal())}>
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
        </header>

        {chips.length > 0 && (
          <div className="calendar-view__quick-create" aria-label="Quick create">
            {chips.map((chip) => (
              <Button
                key={chip.classId}
                variant="outline"
                size="sm"
                onClick={() => void quickCreate(chip)}
              >
                {chip.label}
              </Button>
            ))}
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
                <PageView client={client} pageId={dayId} onOpenPage={onOpenPage} embedded />
              ) : (
                <div className="calendar-view__empty-block">
                  <Button
                    variant="outline"
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
              {partitioned.overdue.length > 0 && (
                <div className="calendar-view__group">
                  <h3 className="calendar-view__group-title calendar-view__group-title--overdue">
                    Overdue
                  </h3>
                  <ul className="calendar-view__rows">
                    {partitioned.overdue.map((row) => renderTaskRow(row, "overdue"))}
                  </ul>
                </div>
              )}
              {partitioned.scheduled.length > 0 && (
                <div className="calendar-view__group">
                  <h3 className="calendar-view__group-title">Scheduled</h3>
                  <ul className="calendar-view__rows">
                    {partitioned.scheduled.map((row) => renderTaskRow(row, "scheduled"))}
                  </ul>
                </div>
              )}
            </section>
          )}

          {show("dated") &&
            (datedRows.length > 0 ? (
              <section className="calendar-view__section" aria-label="Dated">
                <h2 className="calendar-view__section-title">Dated</h2>
                <ul className="calendar-view__rows">
                  {datedRows.map((node) => (
                    <li key={node.id} className="calendar-view__row">
                      <button
                        type="button"
                        className="calendar-view__row-name"
                        onClick={() => onOpenPage(node.id)}
                      >
                        {displayNameFromClient(client, node.id) ?? node.id}
                      </button>
                      <RowClassChips client={client} classIds={node.classIds} />
                    </li>
                  ))}
                </ul>
              </section>
            ) : (
              filter === "dated" && <EmptyState title="Nothing references this day yet." />
            ))}

          {show("created") &&
            (createdRows.length > 0 ? (
              <section className="calendar-view__section" aria-label="Created">
                <h2 className="calendar-view__section-title">Created</h2>
                <ul className="calendar-view__rows">
                  {createdRows.map((node) => (
                    <li key={node.id} className="calendar-view__row">
                      <button
                        type="button"
                        className="calendar-view__row-name"
                        onClick={() => onOpenPage(node.id)}
                      >
                        {displayNameFromClient(client, node.id) ?? node.id}
                      </button>
                      <RowClassChips client={client} classIds={node.classIds} />
                    </li>
                  ))}
                </ul>
              </section>
            ) : (
              filter === "created" && <EmptyState title="There's nothing here (yet)." />
            ))}
        </div>
      </div>

      <aside className="calendar-view__side">
        <MonthCalendar
          selectedDate={selectedIso}
          onSelectDate={setSelectedIso}
          firstDayOfWeek={firstDayOfWeek}
          hasNote={(iso) => client.getNodeRaw(dayNodeId(iso)) !== undefined}
        />
      </aside>
    </div>
  );
}
