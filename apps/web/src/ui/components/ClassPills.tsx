/**
 * ClassPills — the class pill cluster shared by the page-header Classes row
 * and the block row's right-hand classes column: colored pills (effective
 * color), click to open, × to unassign, right-click for the node menu
 * (Change color…), and a "+" picker (assignClass).
 *
 * Ordering: pills are drag-sortable (dnd-kit horizontal strategy); drops
 * commit through `class.reorder` (user-defined order, display-only LWW).
 * `overflow` (the block column) renders only the FIRST pill plus a "+N"
 * button; clicking it opens a popup with the full sortable list.
 */

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client.js";

import { displayNameFromClient } from "../dateDisplay.js";
import { Icon } from "../Icon.js";
import { AddPill } from "./ui/AddPill.js";
import { ColorPickerRow } from "./pickers/ColorPickerRow.js";
import { NodeSelector } from "./pickers/NodeSelector.js";
import { NodeContextMenu } from "./NodeContextMenu.js";
import { canonicalColor, cssColorFor, resolveCssColor } from "./ui/colorPresets.js";
import "./ClassPills.css";

type AnyClient = WorkspaceClient | WorkerClient;

/** Readable text on a class-color background (stored colors resolved to hex). */
function contrastFor(color: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(resolveCssColor(color).trim());
  if (match === null) return "var(--color-on-primary-container)";
  const rgb = parseInt(match[1]!, 16);
  const channel = (shift: number) => ((rgb >> shift) & 0xff) / 255;
  const luminance = 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  return luminance > 0.45 ? "var(--color-black)" : "var(--color-white)";
}

function reorder(ids: string[], activeId: string, overId: string): string[] {
  const next = ids.slice();
  const from = next.indexOf(activeId);
  const to = next.indexOf(overId);
  if (from === -1 || to === -1 || from === to) return ids;
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

function PillShell({
  classId,
  nodeId,
  client,
  onOpenPage,
  onContextMenuNode,
}: {
  classId: string;
  nodeId: string;
  client: AnyClient;
  onOpenPage?: ((pageId: string) => void) | undefined;
  onContextMenuNode: (node: ClientNode, x: number, y: number) => void;
}) {
  const cls = client.getNode(classId);
  const label = displayNameFromClient(client, classId) ?? classId;
  const colored = client.effectiveClassColor(classId);
  // Effective icon: the class glyph (display-time default when none is set).
  const icon = client.effectiveClassIcon(classId);
  return (
    <span
      className="pill pill--hover-reveal-right"
      style={
        colored !== null
          ? { background: cssColorFor(colored), color: contrastFor(colored) }
          : undefined
      }
      onContextMenu={(event) => {
        if (cls === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        onContextMenuNode(cls, event.clientX, event.clientY);
      }}
    >
      <span className="pill__left-icon">
        <Icon path={icon} size={0.7} />
      </span>
      <button type="button" className="pill__text" onClick={() => onOpenPage?.(classId)}>
        {label}
      </button>
      <button
        type="button"
        className="pill__right-button"
        aria-label={`Remove class ${label}`}
        onClick={() => void client.unassignClass(nodeId, classId)}
      >
        ×
      </button>
    </span>
  );
}

/** One sortable pill (the pill surface is the drag handle). */
function SortablePill(props: Parameters<typeof PillShell>[0]) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.classId,
  });
  return (
    <span
      ref={setNodeRef}
      className={`class-pills__sortable${isDragging ? " class-pills__sortable--dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
    >
      <PillShell {...props} />
    </span>
  );
}

/** One sortable row of the overflow popup (grip handle + icon + name + ×). */
function SortablePopupRow({
  classId,
  nodeId,
  client,
}: {
  classId: string;
  nodeId: string;
  client: AnyClient;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: classId,
  });
  const label = displayNameFromClient(client, classId) ?? classId;
  // Effective icon: the class glyph (display-time default when none is set).
  const icon = client.effectiveClassIcon(classId);
  return (
    <li
      ref={setNodeRef}
      className={`class-pills-popup__row${isDragging ? " class-pills-popup__row--dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button
        type="button"
        className="class-pills-popup__grip"
        aria-label={`Reorder ${label}`}
        {...attributes}
        {...listeners}
      >
        <Icon path="mdi-drag-vertical" size={0.7} />
      </button>
      <Icon path={icon} size={0.7} className="class-pills-popup__icon" />
      <span className="class-pills-popup__name">{label}</span>
      <button
        type="button"
        className="pill__right-button"
        aria-label={`Remove class ${label}`}
        onClick={() => void client.unassignClass(nodeId, classId)}
      >
        ×
      </button>
    </li>
  );
}

export function ClassPills({
  client,
  nodeId,
  classIds,
  onOpenPage,
  /** Block-column mode: first pill + "+N" popup with the full sortable list. */
  overflow = false,
  /** Icon-only add pill (Pill.css reveals it on chips-container hover). */
  iconOnlyAdd = false,
}: {
  client: AnyClient;
  nodeId: string;
  classIds: string[];
  onOpenPage?: ((pageId: string) => void) | undefined;
  overflow?: boolean | undefined;
  iconOnlyAdd?: boolean | undefined;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [colorMenu, setColorMenu] = useState<{ classId: string; x: number; y: number } | null>(null);
  const [nodeMenu, setNodeMenu] = useState<{ node: ClientNode; x: number; y: number } | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [overflowPos, setOverflowPos] = useState<{ top: number; left: number } | null>(null);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const overflowButtonRef = useRef<HTMLButtonElement | null>(null);

  const assignedClasses = classIds
    .map((classId) => client.getNode(classId))
    .filter((node): node is ClientNode => node !== undefined);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const commitOrder = (ordered: string[]) => {
    void client.reorderClasses(nodeId, ordered);
  };
  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over === null || active.id === over.id) return;
    commitOrder(reorder(classIds, String(active.id), String(over.id)));
  };

  const visible = overflow && classIds.length > 1 ? classIds.slice(0, 1) : classIds;
  const extraCount = classIds.length - visible.length;

  const onContextMenuNode = (node: ClientNode, x: number, y: number) =>
    setNodeMenu({ node, x, y });

  return (
    <>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={visible} strategy={horizontalListSortingStrategy}>
          <div className="nt-property-chips node-metadata-pills">
            {visible.map((classId) => (
              <SortablePill
                key={classId}
                classId={classId}
                nodeId={nodeId}
                client={client}
                onOpenPage={onOpenPage}
                onContextMenuNode={onContextMenuNode}
              />
            ))}
            {extraCount > 0 && (
              <button
                type="button"
                ref={overflowButtonRef}
                className="pill pill--add class-pills__overflow"
                aria-label={`Show ${extraCount} more class${extraCount > 1 ? "es" : ""}`}
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setOverflowPos({ top: rect.bottom + 4, left: rect.left });
                  setOverflowOpen((open) => !open);
                }}
              >
                +{extraCount}
              </button>
            )}
            <span className="nt-class-add-anchor">
              <AddPill
                ref={addButtonRef}
                className={iconOnlyAdd || classIds.length > 0 ? "pill--icon-only" : ""}
                label="Add class"
                aria-expanded={pickerOpen}
                onClick={(element) => {
                  addButtonRef.current = element;
                  setPickerOpen((open) => !open);
                }}
              />
            </span>
          </div>
        </SortableContext>
      </DndContext>
      {overflowOpen && overflowPos !== null && (
        <>
          {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- backdrop closes on click */}
          <div
            style={{ position: "fixed", inset: 0, zIndex: "var(--z-9998)" }}
            onClick={() => setOverflowOpen(false)}
            onContextMenu={(event) => {
              event.preventDefault();
              setOverflowOpen(false);
            }}
          />
          {createPortal(
            <div
              className="class-pills-popup"
              role="dialog"
              aria-label="All classes"
              style={{ position: "fixed", top: overflowPos.top, left: overflowPos.left, zIndex: "var(--z-9999)" }}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                <SortableContext items={classIds} strategy={verticalListSortingStrategy}>
                  <ul className="class-pills-popup__list">
                    {classIds.map((classId) => (
                      <SortablePopupRow key={classId} classId={classId} nodeId={nodeId} client={client} />
                    ))}
                  </ul>
                </SortableContext>
              </DndContext>
            </div>,
            document.body,
          )}
        </>
      )}
      {pickerOpen && (
        <NodeSelector
          client={client}
          searchMode="classes"
          nodes={assignedClasses}
          anchorEl={addButtonRef.current}
          onClose={() => setPickerOpen(false)}
          searchPlaceholder="Search classes"
          onAdd={(node) => {
            void client.assignClass(nodeId, node.id);
            setPickerOpen(false);
          }}
        />
      )}
      {colorMenu !== null && (
        <>
          {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- backdrop closes on click */}
          <div
            style={{ position: "fixed", inset: 0, zIndex: "var(--z-9998)" }}
            onClick={() => setColorMenu(null)}
          />
          {createPortal(
            <div
              style={{
                position: "fixed",
                left: colorMenu.x,
                top: colorMenu.y,
                zIndex: "var(--z-9999)",
              }}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <ColorPickerRow
                currentColor={client.getNode(colorMenu.classId)?.color ?? null}
                onColorChange={(color) => {
                  // null = "No color" — object.update color:null clears (§34.43).
                  void client.updateObject(colorMenu.classId, { color });
                  setColorMenu(null);
                }}
              />
            </div>,
            document.body,
          )}
        </>
      )}
      <NodeContextMenu
        state={nodeMenu === null ? null : { ...nodeMenu, ownerId: nodeId, isPage: true }}
        client={client}
        onClose={() => setNodeMenu(null)}
        onOpenNode={(id) => onOpenPage?.(id)}
        onChangeColor={(x, y) => {
          if (nodeMenu !== null) setColorMenu({ classId: nodeMenu.node.id, x, y });
        }}
      />
    </>
  );
}
