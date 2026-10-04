/**
 * NodePills — the class pill cluster shared by the page-header Classes row,
 * the block row's right-hand classes column, and the class view's extends
 * (parent-class) row: colored pills (effective color), click to open, × to
 * remove, right-click for the node menu (Change color…), and a "+" picker.
 *
 * The write path is parameterizable (`actions`): the default is class
 * membership on a node (assignClass / unassignClass / reorderClasses); the
 * class view's extends row passes setClassExtends-based handlers instead.
 *
 * Ordering: pills are drag-sortable (dnd-kit horizontal strategy) unless
 * `sortable` is false (extends order is deterministic); drops commit through
 * `actions.reorder` (user-defined order, display-only LWW).
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
import { usePopupDismissal } from "./ui/usePopupDismissal.js";
import { cssColorFor, resolveCssColor } from "./ui/colorPresets.js";
import { classRemovalRefusal, isClassNonRemovable, refuseClassRemoval } from "./classRemoval.js";
import "./NodePills.css";

type AnyClient = WorkspaceClient | WorkerClient;

/** Overrides for the cluster's writes; unspecified entries keep the default
 *  class-membership behavior (assign/unassign/reorder on `nodeId`). */
export interface NodePillsActions {
  /** Default: `client.assignClass(nodeId, classId)`. */
  add?: ((classId: string) => void) | undefined;
  /** Default: `client.unassignClass(nodeId, classId)`. */
  remove?: ((classId: string) => void) | undefined;
  /** Default: `client.reorderClasses(nodeId, ordered)`. */
  reorder?: ((orderedIds: string[]) => void) | undefined;
}

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
  onRemove,
  removeLabel,
}: {
  classId: string;
  nodeId: string;
  client: AnyClient;
  onOpenPage?: ((pageId: string) => void) | undefined;
  onContextMenuNode: (node: ClientNode, x: number, y: number) => void;
  onRemove: (classId: string) => void;
  removeLabel: (label: string) => string;
}) {
  const cls = client.getNode(classId);
  const label = displayNameFromClient(client, classId) ?? classId;
  const colored = client.effectiveClassColor(classId);
  // Effective icon: the class glyph (display-time default when none is set).
  const icon = client.effectiveClassIcon(classId);
  // §34.19: system/journal classes refuse ×-removal (lock + honest toast).
  const nonRemovable = isClassNonRemovable(classId);
  return (
    <span
      className={`pill pill--hover-reveal-right${nonRemovable ? " pill--non-removable" : ""}`}
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
      {nonRemovable ? (
        <button
          type="button"
          className="pill__right-button pill__right-button--locked"
          aria-label={`${label} can't be removed`}
          title={classRemovalRefusal(classId) ?? undefined}
          onClick={() => refuseClassRemoval(classId)}
        >
          <Icon path="mdi-lock-outline" size={0.6} />
        </button>
      ) : (
        <button
          type="button"
          className="pill__right-button"
          aria-label={removeLabel(label)}
          onClick={() => onRemove(classId)}
        >
          ×
        </button>
      )}
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
      className={`node-pills__sortable${isDragging ? " node-pills__sortable--dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
    >
      <PillShell {...props} />
    </span>
  );
}

/** One row of the overflow popup (optional grip handle + icon + name + ×). */
function PopupRow({
  classId,
  nodeId,
  client,
  sortable,
  onRemove,
  removeLabel,
}: {
  classId: string;
  nodeId: string;
  client: AnyClient;
  sortable: boolean;
  onRemove: (classId: string) => void;
  removeLabel: (label: string) => string;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: classId,
    disabled: !sortable,
  });
  const label = displayNameFromClient(client, classId) ?? classId;
  // Effective icon: the class glyph (display-time default when none is set).
  const icon = client.effectiveClassIcon(classId);
  const nonRemovable = isClassNonRemovable(classId);
  return (
    <li
      ref={setNodeRef}
      className={`node-pills-popup__row${isDragging ? " node-pills-popup__row--dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      {sortable && (
        <button
          type="button"
          className="node-pills-popup__grip"
          aria-label={`Reorder ${label}`}
          {...attributes}
          {...listeners}
        >
          <Icon path="mdi-drag-vertical" size={0.7} />
        </button>
      )}
      <Icon path={icon} size={0.7} className="node-pills-popup__icon" />
      <span className="node-pills-popup__name">{label}</span>
      {nonRemovable ? (
        <button
          type="button"
          className="pill__right-button pill__right-button--locked"
          aria-label={`${label} can't be removed`}
          title={classRemovalRefusal(classId) ?? undefined}
          onClick={() => refuseClassRemoval(classId)}
        >
          <Icon path="mdi-lock-outline" size={0.6} />
        </button>
      ) : (
        <button
          type="button"
          className="pill__right-button"
          aria-label={removeLabel(label)}
          onClick={() => onRemove(classId)}
        >
          ×
        </button>
      )}
    </li>
  );
}

export function NodePills({
  client,
  nodeId,
  classIds,
  onOpenPage,
  /** Block-column mode: first pill + "+N" popup with the full sortable list. */
  overflow = false,
  /** Icon-only add pill (Pill.css reveals it on chips-container hover). */
  iconOnlyAdd = false,
  /** Drag-sortable pills + grip (false for deterministic orders, e.g. extends). */
  sortable = true,
  /** Write-path overrides; defaults are the class-membership ops on `nodeId`. */
  actions = undefined,
  /** × aria-label factory (default "Remove class <label>"). */
  removeLabel = undefined,
  /** The "+" picker pill's visible label. */
  addLabel = "Add class",
  /** Excluded from the "+" picker (the class view excludes the class itself). */
  excludePickerNodeId = undefined,
}: {
  client: AnyClient;
  nodeId: string;
  classIds: string[];
  onOpenPage?: ((pageId: string) => void) | undefined;
  overflow?: boolean | undefined;
  iconOnlyAdd?: boolean | undefined;
  sortable?: boolean | undefined;
  actions?: NodePillsActions | undefined;
  removeLabel?: ((label: string) => string) | undefined;
  addLabel?: string | undefined;
  excludePickerNodeId?: string | undefined;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [colorMenu, setColorMenu] = useState<{ classId: string; x: number; y: number } | null>(null);
  const [nodeMenu, setNodeMenu] = useState<{ node: ClientNode; x: number; y: number } | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [overflowPos, setOverflowPos] = useState<{ top: number; left: number } | null>(null);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const overflowButtonRef = useRef<HTMLButtonElement | null>(null);
  const overflowPopupRef = useRef<HTMLDivElement>(null);
  const colorMenuRef = useRef<HTMLDivElement>(null);

  // Dismissal (§34.67): Escape closes the two portaled popups; the backdrop
  // divs keep owning outside-click (pointer-down on them lands outside the
  // popup refs, so the hook agrees).
  usePopupDismissal({
    popupRef: overflowPopupRef,
    isOpen: overflowOpen,
    onClose: () => setOverflowOpen(false),
  });
  usePopupDismissal({
    popupRef: colorMenuRef,
    isOpen: colorMenu !== null,
    onClose: () => setColorMenu(null),
  });

  const assignedClasses = classIds
    .map((classId) => client.getNode(classId))
    .filter((node): node is ClientNode => node !== undefined);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const onAdd = actions?.add ?? ((classId: string) => void client.assignClass(nodeId, classId));
  const onRemove =
    actions?.remove ?? ((classId: string) => void client.unassignClass(nodeId, classId));
  const commitOrder = actions?.reorder ?? ((ordered: string[]) => void client.reorderClasses(nodeId, ordered));
  const labelForRemove = removeLabel ?? ((label: string) => `Remove class ${label}`);

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over === null || active.id === over.id) return;
    commitOrder(reorder(classIds, String(active.id), String(over.id)));
  };

  const visible = overflow && classIds.length > 1 ? classIds.slice(0, 1) : classIds;
  const extraCount = classIds.length - visible.length;

  const onContextMenuNode = (node: ClientNode, x: number, y: number) =>
    setNodeMenu({ node, x, y });

  const pillProps = {
    nodeId,
    client,
    onOpenPage,
    onContextMenuNode,
    onRemove,
    removeLabel: labelForRemove,
  };

  return (
    <>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={visible} strategy={horizontalListSortingStrategy}>
          <div className="nt-property-chips node-metadata-pills">
            {visible.map((classId) =>
              sortable ? (
                <SortablePill key={classId} classId={classId} {...pillProps} />
              ) : (
                <PillShell key={classId} classId={classId} {...pillProps} />
              ),
            )}
            {extraCount > 0 && (
              <button
                type="button"
                ref={overflowButtonRef}
                className="pill pill--add node-pills__overflow"
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
                label={addLabel}
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
              className="node-pills-popup"
              role="dialog"
              aria-label="All classes"
              ref={overflowPopupRef}
              style={{ position: "fixed", top: overflowPos.top, left: overflowPos.left, zIndex: "var(--z-9999)" }}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                <SortableContext items={classIds} strategy={verticalListSortingStrategy}>
                  <ul className="node-pills-popup__list">
                    {classIds.map((classId) => (
                      <PopupRow
                        key={classId}
                        classId={classId}
                        nodeId={nodeId}
                        client={client}
                        sortable={sortable}
                        onRemove={onRemove}
                        removeLabel={labelForRemove}
                      />
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
          excludeNodeId={excludePickerNodeId}
          anchorEl={addButtonRef.current}
          onClose={() => setPickerOpen(false)}
          searchPlaceholder="Search classes"
          onAdd={(node) => {
            onAdd(node.id);
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
              ref={colorMenuRef}
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
