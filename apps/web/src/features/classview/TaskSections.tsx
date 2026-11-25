/**
 * TaskSections — the tasks hub's default surface (2026-11-25): the stacked
 * live-query sections (Overdue / Today / Upcoming / Unscheduled / Completed
 * / Review — taskSections.ts owns the ASTs and the driving-day grammar).
 * Each section runs its query through the query-run seam (`{today}`
 * placeholders resolve at compile time; the sections remount on the local
 * day boundary so a midnight crossing re-runs them) and intersects the
 * hub's FILTERED item set, so the hub's filter toolbar narrows every
 * section like it narrowed the retired buckets. Each section renders its
 * own NodeCollection with a per-section view switcher (outline default) and
 * the Group by picker (Status default) — the choices persist device-locally
 * under `hub.tasks.section.<id>` / `groupBy.hub.tasks.section.<id>`, never
 * an op. Registered as the "sections" collection view (the bucketsView
 * registry-seam precedent); the hub imports this module for the
 * registration side effect.
 */

import { useEffect, useMemo, useState } from "react";

import { SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import { Badge } from "../../components/ui/kit/index.js";
import { Icon } from "../../ui/Icon.js";
import { useQueryRun } from "../../ui/queryRun.js";
import { useGroupByPreference, useViewModePreference } from "../../ui/viewPrefs.js";
import { NodeCollection } from "../collection/NodeCollection.js";
import { ViewToolbar } from "../collection/ViewToolbar.js";
import { GroupByPicker } from "../collection/GroupByPicker.js";
import { getViewDefinition, registerView } from "../collection/registry.js";
import { isGroupablePropertyType, type GroupBySpec } from "../collection/grouping.js";
import type { AnyClient, NodeCollectionItem, NodeCollectionProps, ViewMode } from "../collection/types.js";
import { todayIsoLocal } from "../calendar/calendarViewUtils.js";
import { useDeviceSetting } from "../settings/deviceSettings.js";
import { ensureTaskFamily } from "./taskFamily.js";
import { TASK_SECTIONS, taskTableColumns, type TaskSectionDef } from "./taskSections.js";
import "./TaskSections.css";

/** The per-section view modes, in switcher order (outline is the default). */
const SECTION_MODES: Array<ViewMode | string> = ["outline", "table", "cards"];

function TaskSection({
  client,
  def,
  items,
  defaultGroupBy,
  onOpenNode,
  onOpenInSidebar,
}: {
  client: AnyClient;
  def: TaskSectionDef;
  /** The hub's FILTERED item set (the sections intersect their query with it). */
  items: NodeCollectionItem[];
  defaultGroupBy: GroupBySpec | null;
  onOpenNode: (nodeId: string) => void;
  onOpenInSidebar?: ((nodeId: string) => void) | undefined;
}) {
  const run = useQueryRun(client, def.ast);
  const sectionItems = useMemo(() => {
    if (run.result === null || run.result.kind !== "query") return [];
    const ids = new Set(run.result.ids);
    return items.filter((item) => ids.has(item.node.id));
  }, [items, run.result]);
  const [collapsed, setCollapsed] = useDeviceSetting(`tasksHubSectionCollapsed.${def.id}`, false);
  const [mode, setMode] = useViewModePreference(`hub.tasks.section.${def.id}`, "outline", SECTION_MODES);
  const [groupBy, setGroupBy] = useGroupByPreference(
    `hub.tasks.section.${def.id}`,
    defaultGroupBy,
    (spec) =>
      spec.kind !== "property" ||
      client
        .listPropertySchemas()
        .some((schema) => schema.id === spec.schemaId && isGroupablePropertyType(schema.type)),
  );
  const modeSupportsGroupBy = getViewDefinition(mode)?.capabilities.groupBy === true;
  return (
    <section className="task-section" data-section-id={def.id} aria-label={def.label}>
      <div className="task-section__header">
        <button
          type="button"
          className="task-section__toggle"
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${def.label}`}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
        >
          <Icon
            path={collapsed ? "mdi-chevron-right" : "mdi-chevron-down"}
            size={0.9}
            className="task-section__chevron"
          />
        </button>
        <Icon path={def.icon} size={0.9} className="task-section__icon" />
        <span className="task-section__name">{def.label}</span>
        {run.result !== null && (
          <Badge size="xs" className="task-section__count">
            {sectionItems.length}
          </Badge>
        )}
        <span className="task-section__controls">
          {modeSupportsGroupBy && (
            <GroupByPicker client={client} items={sectionItems} value={groupBy} onChange={setGroupBy} />
          )}
          <ViewToolbar modes={SECTION_MODES} value={mode} onChange={setMode} />
        </span>
      </div>
      {!collapsed && run.result !== null && (
        <NodeCollection
          viewMode={mode}
          client={client}
          items={sectionItems}
          editable
          tableEditable
          groupBy={groupBy ?? undefined}
          tableColumns={taskTableColumns(client)}
          propertiesOf={(id) => client.getEffectiveProperties(id)}
          defaultSort={{ key: "edited", direction: "desc" }}
          emptyText="No tasks."
          onNodeClick={onOpenNode}
          onNodeShiftClick={onOpenInSidebar}
        />
      )}
    </section>
  );
}

export function TaskSectionsView(props: NodeCollectionProps) {
  const { client, items = [], onNodeClick, onNodeShiftClick } = props;
  // Family ensure: idempotent no-op once the schemas + bindings exist.
  // Fire-and-forget: a mid-teardown rejection must not go unhandled (the
  // next mount re-runs the deploy).
  useEffect(() => {
    void ensureTaskFamily(client).catch(() => {});
  }, [client]);
  // Day rollover: the sections' `{today}` placeholders resolve at compile
  // time, so a midnight crossing remounts them (the key) and every query
  // re-runs against the new day.
  const [day, setDay] = useState(todayIsoLocal());
  useEffect(() => {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
    const timer = setTimeout(() => setDay(todayIsoLocal()), midnight.getTime() - now.getTime());
    return () => clearTimeout(timer);
  }, [day]);
  const defaultGroupBy: GroupBySpec | null = client
    .listPropertySchemas()
    .some((schema) => schema.id === SYSTEM_PROPERTY_UUIDS.taskStatus)
    ? { kind: "property", schemaId: SYSTEM_PROPERTY_UUIDS.taskStatus }
    : null;
  return (
    <div className="task-sections" key={day}>
      {TASK_SECTIONS.map((def) => (
        <TaskSection
          key={def.id}
          client={client}
          def={def}
          items={items}
          defaultGroupBy={defaultGroupBy}
          onOpenNode={(nodeId) => onNodeClick?.(nodeId)}
          onOpenInSidebar={onNodeShiftClick}
        />
      ))}
    </div>
  );
}

registerView({
  id: "sections",
  label: "Sections",
  icon: "mdi-format-list-checks",
  component: TaskSectionsView,
  capabilities: {},
});
