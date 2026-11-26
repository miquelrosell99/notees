/**
 * TasksHub — the tasks hub's dedicated master–detail surface (2026-11-26):
 * the stacked live-query sections retire into a LEFT QUERY-LIST PANEL
 * (Overdue / Today / Upcoming / Unscheduled — the taskSections.ts ASTs,
 * unchanged) and the content column renders ONE section's collection at a
 * time. The section↔group-by hierarchy ambiguity the stack carried
 * disappears with the stack: the sections leave the content column, so the
 * only grouping chrome inside it is the selected collection's own (the
 * hub-level Group by, Status by default). The controls de-duplicate with
 * it — ONE view switcher + ONE Group by picker in the bar serve the
 * selected section in every mode (the per-section control clusters retired
 * with the stack; the per-section view/group-by device keys are stale and
 * simply never read again).
 *
 * Data flow: the panel runs the four section ASTs through the query-run
 * seam (`{today}` placeholders resolve at compile time; the body remounts
 * on the local day boundary so a midnight crossing re-runs them) and
 * intersects each with the hub's FILTERED item set (the report from
 * CollectionHub's filter toolbar), so the section badges narrow under an
 * active filter like the retired stack did. The selected section's id set
 * post-filter narrows the collection via CollectionHub's `narrowItems`
 * seam — the bar count, the filter toolbar and the mode-availability gate
 * keep reading the FULL task pool while the collection shows the section
 * (an empty section answers "No tasks in this section."). Selection and
 * the panel's collapsed state persist device-locally (`tasksHubSection` /
 * `tasksHubPanelCollapsed`, never ops); a fresh device opens on Today.
 *
 * The panel rides `useSidePanel` (the journals navigator-panel precedent):
 * the raised-card aside beside the body, the linked toggle in the bar's
 * leading slot (the LEFT-panel convention — the toggle rides left of the
 * title, the side it drives). HubView's tasks branch renders this
 * component directly; the "sections" collection view retired with the
 * stack — a device that persisted "sections" as its hub mode reads it back
 * against the offered set, fails the sanitize, and falls to the outline.
 *
 * Below the sweeps rides the PROJECTS group (2026-11-26): a collapsible,
 * height-capped, searchable list of the tasks' project contexts — the
 * explicit Project property values (the 2026-10-28 task→project relation),
 * falling back to each task's containing page, trailing a "No project"
 * bucket. The list derives from the OPEN tasks (closed ones are reachable
 * through All tasks once a project is selected); badges count the sweep ∩
 * the hub's filtered set like the date sweeps. Selection is one device
 * key: sweep ids as-is, `project:<id>` for a project (`project:none` for
 * the bucket); the same `narrowItems` seam scopes the collection.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS, TASK_STATUS_OPTION_UUIDS } from "@notees/domain";
import type { ClientNode } from "@/core/workspace-client/index.js";

import { Badge } from "../../components/ui/kit/index.js";
import { Input } from "../../components/ui/kit/Input.js";
import { Button } from "../../components/ui/kit/Button.js";
import { useSidePanel } from "../../components/ui/kit/SidePanel.js";
import { Icon } from "../../ui/Icon.js";
import { useQueryRun, type QueryRunState } from "../../ui/queryRun.js";
import { CollectionHub } from "../collection/CollectionHub.js";
import type { AnyClient, NodeCollectionItem } from "../collection/types.js";
import { todayIsoLocal } from "../calendar/calendarViewUtils.js";
import { titleOf } from "../../ui/dateDisplay.js";
import { useDeviceSetting } from "../settings/deviceSettings.js";
import { ensureTaskFamily } from "./taskFamily.js";
import { useTaskCreate } from "./useTaskCreate.js";
import { TASK_SECTIONS, taskTableColumns } from "./taskSections.js";
import "./TasksHub.css";

/** The "No project" bucket's project id + its device-key form. */
const PROJECT_NONE_ID = "__none__";
const PROJECT_NONE_KEY = `project:${PROJECT_NONE_ID}`;

/** The panel's selection: a date sweep or a project context. */
type ScopeSelection = { kind: "sweep"; id: string } | { kind: "project"; id: string };

/** A select schema with options — usable as the cards-board grouping (single or multi). */
function usableGroupingSchema(
  schemas: Array<{ id: string; type: string; multi: boolean; options: Array<{ id: string; label: string }> | null }>,
  id: string,
) {
  const schema = schemas.find((s) => s.id === id);
  return schema !== undefined && schema.type === "select" && schema.options !== null && schema.options.length > 0
    ? schema
    : undefined;
}

/**
 * The cards-board grouping property: the task status schema when it exists
 * with options (fixed seed id), else any select property at least one task
 * actually carries (migrated workspaces may hold the status schema under
 * another id). Undefined → the cards mode renders the flat grid
 * (no board without a grouping select).
 */
function taskGroupingProperty(client: AnyClient, members: ClientNode[]): string | undefined {
  const schemas = client.listPropertySchemas();
  const status = usableGroupingSchema(schemas, SYSTEM_PROPERTY_UUIDS.taskStatus);
  if (status !== undefined) return status.id;
  // The shells read: only the schema ids are inspected here — no values.
  for (const member of members) {
    for (const prop of client.getPropertyRowShells(member.id)) {
      if (usableGroupingSchema(schemas, prop.propertySchemaId) !== undefined) {
        return prop.propertySchemaId;
      }
    }
  }
  return undefined;
}

export function TasksHub({
  client,
  title,
  onOpenNode,
  onOpenInSidebar,
}: {
  client: AnyClient;
  title: string;
  onOpenNode: (nodeId: string) => void;
  onOpenInSidebar?: ((nodeId: string) => void) | undefined;
}) {
  // Family ensure: idempotent no-op once the schemas + bindings exist.
  // Fire-and-forget: a mid-teardown rejection must not go unhandled (the
  // next mount re-runs the deploy).
  useEffect(() => {
    void ensureTaskFamily(client).catch(() => {});
  }, [client]);
  // Day rollover: the sections' `{today}` placeholders resolve at compile
  // time, so a midnight crossing remounts the body (the key) and every
  // query re-runs against the new day.
  const [day, setDay] = useState(todayIsoLocal());
  useEffect(() => {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
    const timer = setTimeout(() => setDay(todayIsoLocal()), midnight.getTime() - now.getTime());
    return () => clearTimeout(timer);
  }, [day]);
  return (
    <TasksHubBody
      key={day}
      client={client}
      title={title}
      onOpenNode={onOpenNode}
      onOpenInSidebar={onOpenInSidebar}
    />
  );
}

function TasksHubBody({
  client,
  title,
  onOpenNode,
  onOpenInSidebar,
}: {
  client: AnyClient;
  title: string;
  onOpenNode: (nodeId: string) => void;
  onOpenInSidebar?: ((nodeId: string) => void) | undefined;
}) {
  /** The tasks-hub create flow (shared with the global Ctrl/Cmd+Shift+N chord). */
  const { offerTaskCreate, taskCreateModal } = useTaskCreate({ client, onOpenNode });
  const members = client.getClassMembers(SYSTEM_CLASS_UUIDS.task);
  const memberItems = useMemo(() => members.map((node) => ({ node })), [members]);

  // The four section runs (fixed call order — TASK_SECTIONS is a module
  // constant). Each result lands async through the query-run seam; until
  // then the section's badge and narrowing read null (the badge renders
  // once its run lands, the narrowing yields nothing — a brief empty state
  // the local projection resolves in a microtask).
  const sectionRuns: Array<QueryRunState | null> = [
    useQueryRun(client, TASK_SECTIONS[0]!.ast).result,
    useQueryRun(client, TASK_SECTIONS[1]!.ast).result,
    useQueryRun(client, TASK_SECTIONS[2]!.ast).result,
    useQueryRun(client, TASK_SECTIONS[3]!.ast).result,
    useQueryRun(client, TASK_SECTIONS[4]!.ast).result,
  ];
  const sectionIdSets: Array<Set<string> | null> = sectionRuns.map((run) =>
    run !== null && run.kind === "query" ? new Set(run.ids) : null,
  );

  // The hub-filtered set (the CollectionHub report): the section badges and
  // the narrowing intersect with it, so the filter toolbar narrows the
  // whole master–detail — badges and content together. The initial state is
  // the full pool (the filter starts inactive; the mount report agrees).
  const [filtered, setFiltered] = useState<NodeCollectionItem[]>(memberItems);
  const filteredIds = useMemo(() => new Set(filtered.map((item) => item.node.id)), [filtered]);
  const sectionCounts = sectionIdSets.map((ids) =>
    ids === null ? null : [...ids].filter((id) => filteredIds.has(id)).length,
  );

  // The projects derivation: per OPEN task, its project contexts — the
  // explicit Project property values (object refs, the effective read),
  // falling back to the containing page; tasks with neither land in the
  // "No project" bucket. One task may ride several projects (multi).
  const projectTasks = useMemo(() => {
    const closed = new Set<string>([TASK_STATUS_OPTION_UUIDS.done, TASK_STATUS_OPTION_UUIDS.cancelled]);
    const byProject = new Map<string, Set<string>>();
    const taskProjects = new Map<string, Set<string>>();
    for (const item of memberItems) {
      const id = item.node.id;
      const statusValue = client
        .getPropertyRowShells(id)
        .find((row) => row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.taskStatus)?.value;
      if (typeof statusValue === "string" && closed.has(statusValue)) continue;
      const projects = new Set<string>();
      for (const row of client.getEffectiveProperties(id)) {
        if (row.propertySchemaId !== SYSTEM_PROPERTY_UUIDS.project || row.value === null) continue;
        const ref = typeof row.value === "object" ? (row.value as { nodeId?: unknown }).nodeId : row.value;
        if (typeof ref === "string" && client.getNode(ref) !== undefined) projects.add(ref);
      }
      if (projects.size === 0) {
        // The structural fallback: the task's ROOT page (the top-level
        // ancestor — the owner's "project" context in the breadcrumb
        // sense). A task that IS its own root (a parentless task page)
        // names no project, and a root riding the journal's date chain
        // (a task captured under a daily note) is scaffolding, not a
        // project.
        const seen = new Set<string>();
        let current = client.getNode(id);
        let root: string | undefined;
        while (current !== undefined && !seen.has(current.id)) {
          seen.add(current.id);
          root = current.id;
          if (current.parentId === null) break;
          current = client.getNode(current.parentId);
        }
        if (root !== undefined && root !== id) {
          const rootNode = client.getNode(root);
          const dateClass = [SYSTEM_CLASS_UUIDS.year, SYSTEM_CLASS_UUIDS.month, SYSTEM_CLASS_UUIDS.day];
          if (rootNode !== undefined && !rootNode.classIds.some((classId) => dateClass.includes(classId))) {
            projects.add(root);
          }
        }
      }
      if (projects.size === 0) projects.add(PROJECT_NONE_ID);
      taskProjects.set(id, projects);
      for (const project of projects) {
        let set = byProject.get(project);
        if (set === undefined) {
          set = new Set();
          byProject.set(project, set);
        }
        set.add(id);
      }
    }
    return { byProject, taskProjects };
  }, [client, memberItems]);

  // The selected scope (device-local; a stale/unknown sweep id reads Today,
  // a dangling project id falls back the same way).
  const [storedSection, setStoredSection] = useDeviceSetting<string>("tasksHubSection", "today");
  const selection: ScopeSelection =
    storedSection.startsWith("project:") &&
    (storedSection === PROJECT_NONE_KEY || projectTasks.byProject.has(storedSection.slice("project:".length)))
      ? { kind: "project", id: storedSection.slice("project:".length) }
      : { kind: "sweep", id: TASK_SECTIONS.some((def) => def.id === storedSection) ? storedSection : "today" };
  const selectedIndex = Math.max(
    0,
    TASK_SECTIONS.findIndex((def) => def.id === (selection.kind === "sweep" ? selection.id : "today")),
  );
  const sweepIds = selection.kind === "sweep" ? (sectionIdSets[selectedIndex] ?? null) : null;
  const projectIds = selection.kind === "project" ? (projectTasks.byProject.get(selection.id) ?? null) : null;

  // The collection narrowing: the selected scope's id set applied to the
  // hub's filtered set. Chrome above (bar count, filter toolbar, mode gate)
  // keeps reading the full pool — the seam narrows only what the collection
  // sees.
  const narrowItems = useCallback(
    (items: NodeCollectionItem[]): NodeCollectionItem[] => {
      const scope = selection.kind === "sweep" ? sweepIds : projectIds;
      return scope === null ? [] : items.filter((item) => scope.has(item.node.id));
    },
    [selection.kind, selection.id, sweepIds, projectIds],
  );

  // The section panel + its bar toggle as ONE component-level unit
  // (useSidePanel): the side is declared once — "left" — and the toggle
  // lands in the bar's leading slot on the same side, so the two can never
  // drift apart.
  const [panelCollapsed, setPanelCollapsed] = useDeviceSetting<boolean>("tasksHubPanelCollapsed", false);
  const sectionPanel = useSidePanel({
    side: "left",
    open: !panelCollapsed,
    onToggle: () => setPanelCollapsed(!panelCollapsed),
    label: "task sections",
    panelLabel: "Task sections",
    className: "tasks-hub__panel",
    children: (
      <div className="tasks-hub__sections">
        {TASK_SECTIONS.map((def, index) => {
          const count = sectionCounts[index] ?? null;
          const selected = selection.kind === "sweep" && index === selectedIndex;
          return (
            <button
              key={def.id}
              type="button"
              className={[
                "tasks-hub__section",
                selected ? "tasks-hub__section--selected" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              aria-pressed={selected}
              onClick={() => setStoredSection(def.id)}
            >
              <Icon path={def.icon} size={0.9} className="tasks-hub__section-icon" />
              <span className="tasks-hub__section-name">{def.label}</span>
              {count !== null && (
                <Badge
                  size="xs"
                  className={count === 0 ? "tasks-hub__section-count tasks-hub__section-count--zero" : "tasks-hub__section-count"}
                >
                  {count}
                </Badge>
              )}
            </button>
          );
        })}
        <ProjectsGroup
          client={client}
          byProject={projectTasks.byProject}
          filteredIds={filteredIds}
          selection={selection}
          onSelect={(id) => setStoredSection(`project:${id}`)}
        />
      </div>
    ),
  });

  // The cards board groups by the status property; the hub-level group-by
  // axis (the bar picker) defaults to Status when the schema exists.
  const groupByProperty = taskGroupingProperty(client, members);
  const defaultGroupBy = client
    .listPropertySchemas()
    .some((schema) => schema.id === SYSTEM_PROPERTY_UUIDS.taskStatus)
    ? { kind: "property" as const, schemaId: SYSTEM_PROPERTY_UUIDS.taskStatus }
    : undefined;

  return (
    <div className="nt-hub-tasks">
      <CollectionHub
        client={client}
        title={title}
        items={memberItems}
        modes={["outline", "table", "cards", "pivot", "graph", "gantt", "calendar"]}
        defaultMode="outline"
        persistKey="hub.tasks"
        // A subtask (a task-classed child of a task) nests under its parent
        // in the outline and rides parent-before-child in unset table
        // order; the cards/kanban surface is flat by design.
        nestUnderParents
        tableColumns={taskTableColumns(client)}
        defaultSort={{ key: "edited", direction: "desc" }}
        tableEditable
        groupByProperty={groupByProperty}
        {...(defaultGroupBy !== undefined ? { defaultGroupBy } : {})}
        editable
        emptyTitle="No tasks yet"
        // The row previews + the status bullet answer "what" — the collapsed
        // "Properties N" disclosure was a third line of chrome per row.
        hidePropertySection
        narrowItems={narrowItems}
        narrowEmptyTitle={
          selection.kind === "project" ? "No tasks in this project." : "No tasks in this section."
        }
        leading={sectionPanel.toggle}
        sidePanel={sectionPanel.panel}
        headerActions={
          <Button size="sm" variant="ghost" icon="mdi-plus" aria-label="New task" onClick={() => void offerTaskCreate()}>
            New
          </Button>
        }
        onFilterChange={(_query, filteredItems) => setFiltered(filteredItems)}
        onOpenNode={onOpenNode}
        onOpenInSidebar={onOpenInSidebar}
      />
      {taskCreateModal}
    </div>
  );
}

/**
 * ProjectsGroup — the panel's projects list (2026-11-26): collapsible
 * (device-local), height-capped with its own scroll, searchable by title.
 * Rows ride the same nav-list register as the sweeps, counts reading the
 * project ∩ the hub's filtered set; the "No project" bucket trails the
 * list.
 */
function ProjectsGroup({
  client,
  byProject,
  filteredIds,
  selection,
  onSelect,
}: {
  client: AnyClient;
  byProject: ReadonlyMap<string, ReadonlySet<string>>;
  filteredIds: ReadonlySet<string>;
  selection: ScopeSelection;
  onSelect: (projectId: string) => void;
}) {
  const [collapsed, setCollapsed] = useDeviceSetting<boolean>("tasksHubProjectsCollapsed", false);
  const [search, setSearch] = useState("");
  const entries = useMemo(() => {
    const list = [...byProject.entries()].map(([id, taskIds]) => ({
      id,
      label: id === PROJECT_NONE_ID ? "No project" : (titleOf(client, id) ?? "Untitled"),
      icon: (() => {
        if (id === PROJECT_NONE_ID) return "mdi-inbox-outline";
        const node = client.getNode(id);
        return node !== undefined ? (client.effectiveNodeIcon(node) ?? "mdi-briefcase-outline") : "mdi-briefcase-outline";
      })(),
      count: [...taskIds].filter((taskId) => filteredIds.has(taskId)).length,
    }));
    list.sort((a, b) =>
      a.id === PROJECT_NONE_ID ? 1 : b.id === PROJECT_NONE_ID ? -1 : a.label.localeCompare(b.label),
    );
    const needle = search.trim().toLowerCase();
    return needle === "" ? list : list.filter((entry) => entry.label.toLowerCase().includes(needle));
  }, [client, byProject, filteredIds, search]);
  return (
    <div className="tasks-hub__projects">
      <button
        type="button"
        className="tasks-hub__projects-toggle"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed(!collapsed)}
      >
        <Icon
          path={collapsed ? "mdi-chevron-right" : "mdi-chevron-down"}
          size={0.8}
          className="tasks-hub__projects-chevron"
        />
        <span className="tasks-hub__projects-name">Projects</span>
        <Badge size="xs" className="tasks-hub__projects-count">
          {byProject.size}
        </Badge>
      </button>
      {!collapsed && (
        <>
          <Input
            size="sm"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter projects"
            aria-label="Filter projects"
            className="tasks-hub__projects-search"
          />
          <div className="tasks-hub__projects-list">
            {entries.map((entry) => {
              const selected = selection.kind === "project" && selection.id === entry.id;
              return (
                <button
                  key={entry.id}
                  type="button"
                  className={[
                    "tasks-hub__section",
                    "tasks-hub__project",
                    selected ? "tasks-hub__section--selected" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  aria-pressed={selected}
                  onClick={() => onSelect(entry.id)}
                >
                  <Icon path={entry.icon} size={0.9} className="tasks-hub__section-icon" />
                  <span className="tasks-hub__section-name">{entry.label}</span>
                  <Badge
                    size="xs"
                    className={
                      entry.count === 0
                        ? "tasks-hub__section-count tasks-hub__section-count--zero"
                        : "tasks-hub__section-count"
                    }
                  >
                    {entry.count}
                  </Badge>
                </button>
              );
            })}
            {entries.length === 0 && (
              <div className="tasks-hub__projects-empty">No matching projects.</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
