/**
 * KanbanView — the board mode. Columns are seeded from the options of the
 * container's `kanbanProperty` (a single-select property schema — the
 * property-dimension groupBy) plus a trailing "None" column for items whose
 * value is empty or not among the options. Cards reuse the flat NodeCard;
 * dragging a card onto a column writes the property (drop on "None" clears
 * it) through client.setProperty/unsetProperty, so the board mutates data
 * exactly like the table's select cell. Column order = schema option order;
 * card order within a column = the input order.
 */

import { useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";

import { EmptyState } from "../components/ui/index.js";
import { displayNameForSettings } from "../dateDisplay.js";
import { registerView } from "./registry.js";
import { NodeCard } from "./CardsView.js";
import type { AnyClient, NodeCollectionItem, NodeCollectionProps } from "./types.js";
import "./KanbanView.css";

/** The bucket for items with no (or an unknown) option value. */
const NONE_COLUMN_ID = "__none__";

/**
 * The drop write: land a card on a column. `targetOptionId` null = the None
 * column (clear the value). Extracted for direct testing (dnd-kit drags are
 * not worth simulating in jsdom).
 */
export async function applyKanbanDrop(
  client: AnyClient,
  nodeId: string,
  propertySchemaId: string,
  targetOptionId: string | null,
  idx: number | undefined,
): Promise<void> {
  if (targetOptionId === null) {
    if (idx !== undefined) await client.unsetProperty(nodeId, propertySchemaId, idx);
    return;
  }
  await client.setProperty(nodeId, propertySchemaId, targetOptionId, idx ?? 0);
}

/** The card's current option value for the board property (null when unset). */
function currentValue(
  props: NodeCollectionProps,
  schemaId: string,
  nodeId: string,
): { value: string | null; idx: number | undefined } {
  const prop = props.propertiesOf?.(nodeId)?.find((p) => p.propertySchemaId === schemaId);
  const value = typeof prop?.value === "string" ? prop.value : null;
  return { value, idx: prop?.idx };
}

function DraggableCard({ item, props }: { item: NodeCollectionItem; props: NodeCollectionProps }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: item.node.id,
  });
  return (
    <div
      ref={setNodeRef}
      className={`kanban-card${isDragging ? " kanban-card--dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform) }}
      {...attributes}
      {...listeners}
    >
      <NodeCard item={item} props={props} />
    </div>
  );
}

function KanbanColumn({
  columnId,
  label,
  count,
  items,
  props,
}: {
  columnId: string;
  label: string;
  count: number;
  items: NodeCollectionItem[];
  props: NodeCollectionProps;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: columnId });
  return (
    <section className={`kanban-column${isOver ? " kanban-column--over" : ""}`} data-column-id={columnId}>
      <header className="kanban-column__header">
        <span className="kanban-column__title">{label}</span>
        <span className="kanban-column__count">{count}</span>
      </header>
      <div className="kanban-column__body" ref={setNodeRef}>
        {items.map((item) => (
          <DraggableCard key={item.node.id} item={item} props={props} />
        ))}
        {items.length === 0 && <div className="kanban-column__empty" aria-hidden="true" />}
      </div>
    </section>
  );
}

export function KanbanView(props: NodeCollectionProps) {
  const { client, items, kanbanProperty } = props;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const [dragging, setDragging] = useState<NodeCollectionItem | null>(null);

  const schema =
    kanbanProperty !== undefined
      ? client.listPropertySchemas().find((s) => s.id === kanbanProperty)
      : undefined;

  if (items.length === 0) return null;

  if (schema === undefined || schema.options === null || schema.options.length === 0 || schema.multi) {
    return (
      <EmptyState
        title="Kanban needs a single-select property"
        description="Add a select property with options to group the board by."
      />
    );
  }

  const buckets = new Map<string, NodeCollectionItem[]>();
  for (const item of items) {
    const { value } = currentValue(props, schema.id, item.node.id);
    const key =
      value !== null && schema.options.some((option) => option.id === value) ? value : NONE_COLUMN_ID;
    const bucket = buckets.get(key);
    if (bucket !== undefined) bucket.push(item);
    else buckets.set(key, [item]);
  }
  const columns = [
    ...schema.options.map((option) => ({ id: option.id, label: option.label })),
    { id: NONE_COLUMN_ID, label: "None" },
  ];

  const handleDragStart = (event: DragStartEvent) => {
    const item = items.find((entry) => entry.node.id === String(event.active.id));
    setDragging(item ?? null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const nodeId = String(event.active.id);
    setDragging(null);
    if (event.over === null) return;
    const columnId = String(event.over.id);
    const { value, idx } = currentValue(props, schema.id, nodeId);
    const target = columnId === NONE_COLUMN_ID ? null : columnId;
    if (value === target) return;
    void applyKanbanDrop(client, nodeId, schema.id, target, idx).catch(() => {
      // The write surfaces through the client notification path; a rejected
      // drop leaves the card where it was (no local mutation happened).
    });
  };

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={() => setDragging(null)}>
      <div className="kanban-board">
        {columns.map((column) => (
          <KanbanColumn
            key={column.id}
            columnId={column.id}
            label={column.label}
            count={buckets.get(column.id)?.length ?? 0}
            items={buckets.get(column.id) ?? []}
            props={props}
          />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>
        {dragging !== null && (
          <div className="kanban-ghost">{displayNameForSettings(dragging.node) || "Untitled"}</div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

registerView({
  id: "kanban",
  label: "Kanban",
  icon: "mdi-view-grid",
  component: KanbanView,
  capabilities: { groupBy: true, sorting: true },
});
