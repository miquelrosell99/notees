/**
 * CardsBoard — the cards view's grouped rendering (property-dimension
 * groupBy): cards mode dispatches here when the container passes a usable
 * `groupByProperty` (a select property schema — single or multi). Columns
 * are seeded from the schema's options plus a trailing "None" column for
 * items with no (or no valid) value; multi-select schemas make the board
 * multi-membership (a card rides every column whose option it carries).
 *
 * Dragging a card onto a column writes the property through
 * client.setProperty/unsetProperty (drop on "None" clears) — single-select
 * sets, multi-select merges. Columns collapse via their header chevron
 * (session state); cards reorder within a column by dragging (session
 * order — persisting card order needs an order property, parked as a
 * designed-not-built follow-up). Cards reuse the flat NodeCard, cover
 * layouts included.
 *
 * Each column windows its card list independently (the shared
 * useWindowed + ShowMoreButton convention) — the column count badge and the
 * drop logic read the FULL bucket; only the rendering is windowed, and the
 * "Show more" affordance names the hidden count at the column's end.
 */

import { useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { EmptyState } from "../components/ui/index.js";
import { Icon } from "../Icon.js";
import { displayNameForSettings } from "../dateDisplay.js";
import { useCardLayoutPreference } from "../viewPrefs.js";
import { NodeCard, CoverLayoutToggle } from "./CardsView.js";
import { useViewSelection, SelectionExportControls } from "./selectionExport.js";
import { useWindowed } from "./useWindowed.js";
import { ShowMoreButton } from "./ShowMoreButton.js";
import type { AnyClient, CardLayout, NodeCollectionItem, NodeCollectionProps } from "./types.js";
import type { ViewSelection } from "./selectionExport.js";
import "./CardsBoard.css";

/** The bucket for items with no (or an unknown) option value. */
const NONE_COLUMN_ID = "__none__";

/** The card's current option values for the board property ([] when unset). */
function currentValues(
  props: NodeCollectionProps,
  schemaId: string,
  nodeId: string,
): { values: string[]; idx: number | undefined } {
  const prop = props.propertiesOf?.(nodeId)?.find((p) => p.propertySchemaId === schemaId);
  const raw = prop?.value;
  const values = Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === "string")
    : typeof raw === "string"
      ? [raw]
      : [];
  return { values, idx: prop?.idx };
}

/**
 * The drop write: land a card on a column. Single-select: set the option
 * (null = the None column clears). Multi-select: merge the option in (null
 * = clear all values). Extracted for direct testing.
 */
export async function applyCardGroupDrop(
  client: AnyClient,
  nodeId: string,
  propertySchemaId: string,
  targetOptionId: string | null,
  idx: number | undefined,
  multi = false,
): Promise<void> {
  if (targetOptionId === null) {
    if (idx !== undefined) await client.unsetProperty(nodeId, propertySchemaId, idx);
    return;
  }
  if (multi) {
    const { values } = currentValuesOf(client, nodeId, propertySchemaId);
    if (values.includes(targetOptionId)) return;
    await client.setProperty(nodeId, propertySchemaId, [...values, targetOptionId], idx ?? 0);
    return;
  }
  await client.setProperty(nodeId, propertySchemaId, targetOptionId, idx ?? 0);
}

/** Read-side helper for the multi merge (tests stub the client surface). */
function currentValuesOf(client: AnyClient, nodeId: string, schemaId: string): { values: string[] } {
  const prop = client.getEffectiveProperties(nodeId).find((p) => p.propertySchemaId === schemaId);
  const raw = prop?.value;
  return {
    values: Array.isArray(raw)
      ? raw.filter((entry): entry is string => typeof entry === "string")
      : typeof raw === "string"
        ? [raw]
        : [],
  };
}

function DraggableCard({
  item,
  props,
  coverLayout,
  selection,
}: {
  item: NodeCollectionItem;
  props: NodeCollectionProps;
  coverLayout: CardLayout;
  selection?: { checked: boolean; onToggle: () => void } | undefined;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({
    id: item.node.id,
  });
  return (
    <div
      ref={setNodeRef}
      className={`board-card${isDragging ? " board-card--dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform) }}
      {...attributes}
      {...listeners}
    >
      <NodeCard item={item} props={props} coverLayout={coverLayout} selection={selection} />
    </div>
  );
}

function BoardColumn({
  columnId,
  label,
  count,
  items,
  props,
  collapsed,
  onToggleCollapse,
  coverLayout,
  selectable,
  selection,
}: {
  columnId: string;
  label: string;
  count: number;
  items: NodeCollectionItem[];
  props: NodeCollectionProps;
  collapsed: boolean;
  onToggleCollapse: () => void;
  coverLayout: CardLayout;
  /** Selection export: card checkboxes + the column's checked set. */
  selectable: boolean;
  selection: ViewSelection;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: columnId });
  // The column's cards are the windowed collection — the header
  // count above still names the FULL bucket, and drags resolve positions
  // against it (ordered() at the board level), so the window is display-only.
  const { visible, remaining, showMore } = useWindowed(items, {
    enabled: props.windowed ?? true,
  });
  return (
    <section className={`board-column${isOver ? " board-column--over" : ""}`} data-column-id={columnId}>
      <header className="board-column__header">
        <button
          type="button"
          className="board-column__toggle"
          aria-label={`${collapsed ? "Expand" : "Collapse"} column ${label}`}
          aria-expanded={!collapsed}
          onClick={onToggleCollapse}
        >
          <Icon
            path={collapsed ? "mdi-chevron-right" : "mdi-chevron-down"}
            size={0.8}
            className="board-column__chevron"
          />
        </button>
        <span className="board-column__title">{label}</span>
        <span className="board-column__count">{count}</span>
      </header>
      {!collapsed && (
        <div className="board-column__body" ref={setNodeRef}>
          <SortableContext items={visible.map((item) => item.node.id)} strategy={verticalListSortingStrategy}>
            {visible.map((item) => (
              <DraggableCard
                key={item.node.id}
                item={item}
                props={props}
                coverLayout={coverLayout}
                selection={
                  selectable
                    ? {
                        checked: selection.isSelected(item.node.id),
                        onToggle: () => selection.toggle(item.node.id),
                      }
                    : undefined
                }
              />
            ))}
          </SortableContext>
          {items.length === 0 && <div className="board-column__empty" aria-hidden="true" />}
          <ShowMoreButton remaining={remaining} onShowMore={showMore} />
        </div>
      )}
    </section>
  );
}

export function CardsBoard({ props }: { props: NodeCollectionProps }) {
  const { client, items = [], groupByProperty } = props;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const [dragging, setDragging] = useState<NodeCollectionItem | null>(null);
  const [collapsedColumns, setCollapsedColumns] = useState<ReadonlySet<string>>(new Set());
  /** Within-column order overrides (session — see the persistence note). */
  const [columnOrder, setColumnOrder] = useState<ReadonlyMap<string, readonly string[]>>(new Map());
  /** The cover layout persists device-locally — never an op. */
  const [coverLayout, setCoverLayout] = useCardLayoutPreference("no-cover");
  /** Selection export — the same affordance the table toolbar has. */
  const selection = useViewSelection();
  const selectable = props.selectable ?? true;

  const schema =
    groupByProperty !== undefined
      ? client.listPropertySchemas().find((s) => s.id === groupByProperty)
      : undefined;

  if (items.length === 0) return null;

  if (schema === undefined || schema.options === null || schema.options.length === 0) {
    return (
      <EmptyState
        title="The board needs a select property"
        description="Add a select property with options to group the board by."
      />
    );
  }
  const multi = schema.multi === true;
  const validOptionIds = new Set(schema.options.map((option) => option.id));

  const buckets = new Map<string, NodeCollectionItem[]>();
  const bucketOf = new Map<string, string>();
  const register = (key: string, item: NodeCollectionItem) => {
    const bucket = buckets.get(key);
    if (bucket !== undefined) bucket.push(item);
    else buckets.set(key, [item]);
    bucketOf.set(item.node.id, key);
  };
  for (const item of items) {
    const { values } = currentValues(props, schema.id, item.node.id);
    const hits = values.filter((value) => validOptionIds.has(value));
    if (multi) {
      // Multi-membership: the card rides every column whose option it
      // carries; no valid values → None.
      if (hits.length === 0) register(NONE_COLUMN_ID, item);
      else for (const hit of hits) register(hit, item);
    } else {
      register(hits.length > 0 ? hits[0]! : NONE_COLUMN_ID, item);
    }
  }
  /** Column items with the session reorder applied (order override wins). */
  const ordered = (columnId: string): NodeCollectionItem[] => {
    const bucket = buckets.get(columnId) ?? [];
    const override = columnOrder.get(columnId);
    if (override === undefined) return bucket;
    const byId = new Map(bucket.map((item) => [item.node.id, item]));
    const orderedItems = override.map((id) => byId.get(id)).filter((item): item is NodeCollectionItem => item !== undefined);
    // Cards added after the override was taken keep their input order at the end.
    return [...orderedItems, ...bucket.filter((item) => !override.includes(item.node.id))];
  };
  const columns = [
    ...schema.options.map((option) => ({ id: option.id, label: option.label })),
    { id: NONE_COLUMN_ID, label: "None" },
  ];

  const toggleCollapse = (columnId: string) => {
    setCollapsedColumns((prev) => {
      const next = new Set(prev);
      if (next.has(columnId)) next.delete(columnId);
      else next.add(columnId);
      return next;
    });
  };

  const handleDragStart = (event: DragStartEvent) => {
    const item = items.find((entry) => entry.node.id === String(event.active.id));
    setDragging(item ?? null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const nodeId = String(event.active.id);
    setDragging(null);
    if (event.over === null) return;
    const overId = String(event.over.id);
    const sourceColumn = bucketOf.get(nodeId);
    if (sourceColumn === undefined) return;
    // Landing on a card resolves to that card's column (and position).
    const targetColumn = validOptionIds.has(overId) || overId === NONE_COLUMN_ID ? overId : bucketOf.get(overId);
    if (targetColumn === undefined) return;

    const { values, idx } = currentValues(props, schema.id, nodeId);
    const target = targetColumn === NONE_COLUMN_ID ? null : targetColumn;

    if (targetColumn === sourceColumn && target !== null) {
      // Same column (and not None): reorder within the column (session).
      const list = ordered(sourceColumn);
      const oldIndex = list.findIndex((item) => item.node.id === nodeId);
      const newIndex = overId !== targetColumn ? list.findIndex((item) => item.node.id === overId) : list.length - 1;
      if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;
      const reordered = arrayMove(list, oldIndex, newIndex).map((item) => item.node.id);
      setColumnOrder((prev) => new Map(prev).set(sourceColumn, reordered));
      return;
    }
    if (multi ? target === null && values.length === 0 : values[0] === target) return;
    void applyCardGroupDrop(client, nodeId, schema.id, target, idx, multi).catch(() => {
      // The write surfaces through the client notification path; a rejected
      // drop leaves the card where it was (no local mutation happened).
    });
  };

  return (
    <div>
      <div className="board-toolbar">
        <SelectionExportControls client={client} selection={selection} />
        <CoverLayoutToggle value={coverLayout} onChange={setCoverLayout} />
      </div>
      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setDragging(null)}
      >
        <div className="board">
          {columns.map((column) => (
            <BoardColumn
              key={column.id}
              columnId={column.id}
              label={column.label}
              count={buckets.get(column.id)?.length ?? 0}
              items={ordered(column.id)}
              props={props}
              collapsed={collapsedColumns.has(column.id)}
              onToggleCollapse={() => toggleCollapse(column.id)}
              coverLayout={coverLayout}
              selectable={selectable}
              selection={selection}
            />
          ))}
        </div>
        <DragOverlay dropAnimation={null}>
          {dragging !== null && (
            <div className="board-ghost">{displayNameForSettings(dragging.node) || "Untitled"}</div>
          )}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
