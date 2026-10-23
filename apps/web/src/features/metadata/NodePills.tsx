/**
 * NodePills — the class pill cluster shared by the page-header Classes row,
 * the block row's right-hand classes column, and the class view's extends
 * (parent-class) row: colored pills (effective color), click to open, × to
 * remove, right-click for the node menu (Change color…), and a "+" picker.
 *
 * The pills are a DERIVED VIEW (owner ruling 2026-10-15): a class referenced
 * by a `class_link` token in the node's own content is already visible
 * inline — the link IS the marker — so its pill hides automatically
 * (membership untouched; the picker still lists the class checkmarked and
 * the plain-pick toggle still removes it).
 *
 * The write path is parameterizable (`actions`): the default is class
 * membership on a node (assignClass / unassignClass / reorderClasses); the
 * class view's extends row passes setClassExtends-based handlers instead.
 *
 * Ordering: pills are drag-sortable (dnd-kit horizontal strategy) unless
 * `sortable` is false (extends order is deterministic); drops commit through
 * `actions.reorder` (user-defined order, display-only LWW).
 * `overflow` (the block column) renders only the FIRST pill plus a "+N"
 * button; clicking it opens a popup with the full sortable list. The block
 * column also passes `addAtStart`: the "+" picker rides LEFT of the pills
 * there — the right-pinned row-end group grows leftward on hover-reveal, so
 * the pills never shift.
 */

import { useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
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
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client/index.js";

import { labelFromClient } from "../../ui/dateDisplay.js";
import { Icon } from "../../ui/Icon.js";
import { AddPill } from "../../components/ui/fleet/AddPill.js";
import { ColorPickerRow } from "../pickers/ColorPickerRow.js";
import { NodeSelector } from "../pickers/NodeSelector.js";
import { NodeContextMenu } from "../node-menu/NodeContextMenu.js";
import { removeClassDissolvingLinks } from "./classRemoval.js";
import { ClassCreateModal } from "../modals/ClassCreateModal.js";
import { usePopupDismissal } from "../../components/ui/fleet/usePopupDismissal.js";
import { cssColorFor, resolveCssColor } from "../../components/ui/fleet/colorPresets.js";
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
  if (match === null) return "var(--md-sys-color-on-primary-container)";
  const rgb = parseInt(match[1]!, 16);
  const channel = (shift: number) => ((rgb >> shift) & 0xff) / 255;
  const luminance = 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  return luminance > 0.45 ? "var(--md-sys-color-black)" : "var(--md-sys-color-white)";
}

function reorder(ids: string[], activeId: string, overId: string): string[] {
  const next = ids.slice();
  const from = next.indexOf(activeId);
  const to = next.indexOf(overId);
  if (from === -1 || to === -1 || from === to) return ids;
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

/**
 * NodePill — the ONE pill element every node-relation surface renders: the
 * nodeview classes list (NodePills below), the tags row, and multi-value
 * node-typed property cells all ride it, so a pill looks and behaves the
 * same everywhere — effective color background with contrast text, the left
 * icon, a label click that opens the node, and the hover-reveal ×.
 * Color/icon resolution stays with each host (class pills resolve the class
 * chain; property pills the linked node's own effective color).
 */
export function NodePill({
  /** Effective color (preset token or hex) or null for the neutral surface. */
  color,
  /** MDI icon path or null (no left icon). */
  icon,
  label,
  className = "",
  onOpen,
  onContextMenu,
  onRemove,
  removeLabel,
  /** Extra chrome after the × (annotations, qualifier ranges, …). */
  trailing,
  /** False keeps the right chrome always visible (derived-default pills). */
  hoverReveal = true,
}: {
  color: string | null;
  icon: string | null;
  label: string;
  className?: string;
  onOpen?: (() => void) | undefined;
  onContextMenu?: ((event: MouseEvent<HTMLSpanElement>) => void) | undefined;
  onRemove?: (() => void) | undefined;
  removeLabel?: string | undefined;
  trailing?: ReactNode;
  hoverReveal?: boolean;
}) {
  return (
    <span
      className={`pill${hoverReveal ? " pill--hover-reveal-right" : ""}${className ? ` ${className}` : ""}`}
      style={
        color !== null
          ? { background: cssColorFor(color), color: contrastFor(color) }
          : undefined
      }
      onContextMenu={onContextMenu}
    >
      {icon !== null && (
        <span className="pill__left-icon">
          <Icon path={icon} size={0.7} />
        </span>
      )}
      {onOpen !== undefined ? (
        <button type="button" className="pill__text" onClick={onOpen}>
          {label}
        </button>
      ) : (
        // No navigation of its own (e.g. the label rides inside a larger
        // control such as the single-value selection cell) — a plain span,
        // the same pattern features/metadata/MetadataSection.css styles for
        // span.pill__text.
        <span className="pill__text">{label}</span>
      )}
      {onRemove !== undefined && (
        <button
          type="button"
          className="pill__right-button"
          aria-label={removeLabel}
          onClick={onRemove}
        >
          <Icon path="mdi-close" size={0.6} />
        </button>
      )}
      {trailing}
    </span>
  );
}

function PillShell({
  classId,
  nodeId,
  client,
  onOpenPage,
  onContextMenuNode,
  onRemove,
  removeLabel,
  /** Read-only projection: static pill — open on click, no remove, no menu. */
  readOnly = false,
}: {
  classId: string;
  nodeId: string;
  client: AnyClient;
  onOpenPage?: ((pageId: string) => void) | undefined;
  onContextMenuNode: (node: ClientNode, x: number, y: number) => void;
  onRemove: (classId: string) => void;
  removeLabel: (label: string) => string;
  readOnly?: boolean | undefined;
}) {
  const cls = client.getNode(classId);
  // Never a bare UUID (owner 2026-10-23): archived/trashed classes keep
  // their name via the raw read; a dangling binding (the class row
  // permanently deleted — the retired class-class debt) reads "Deleted
  // class" and stays ×-removable.
  const label = labelFromClient(client, classId) ?? "Deleted class";
  // Class-chain color/icon resolution — the class pill's identity.
  const colored = client.effectiveClassColor(classId);
  const icon = client.effectiveClassIcon(classId);
  // System/journal classes refuse ×-removal (lock + honest toast).
  const nonRemovable = isClassNonRemovable(classId);
  return (
    <NodePill
      color={colored}
      icon={icon}
      label={label}
      className={nonRemovable ? "pill--non-removable" : ""}
      onOpen={() => onOpenPage?.(classId)}
      onContextMenu={
        readOnly
          ? undefined
          : (event) => {
              if (cls === undefined) return;
              event.preventDefault();
              event.stopPropagation();
              onContextMenuNode(cls, event.clientX, event.clientY);
            }
      }
      onRemove={readOnly || nonRemovable ? undefined : () => onRemove(classId)}
      removeLabel={removeLabel(label)}
      trailing={
        !readOnly && nonRemovable ? (
          <button
            type="button"
            className="pill__right-button pill__right-button--locked"
            aria-label={`${label} can't be removed`}
            title={classRemovalRefusal(classId) ?? undefined}
            onClick={() => refuseClassRemoval(classId)}
          >
            <Icon path="mdi-lock-outline" size={0.6} />
          </button>
        ) : undefined
      }
    />
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
  /** Read-only projection: no grip, no × — icon + name only. */
  readOnly = false,
}: {
  classId: string;
  nodeId: string;
  client: AnyClient;
  sortable: boolean;
  onRemove: (classId: string) => void;
  removeLabel: (label: string) => string;
  readOnly?: boolean | undefined;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: classId,
    disabled: !sortable,
  });
  // Same never-a-bare-UUID contract as PillShell (owner 2026-10-23).
  const label = labelFromClient(client, classId) ?? "Deleted class";
  // Effective icon: the class glyph (display-time default when none is set).
  const icon = client.effectiveClassIcon(classId);
  const nonRemovable = isClassNonRemovable(classId);
  return (
    <li
      ref={setNodeRef}
      className={`node-pills-popup__row${isDragging ? " node-pills-popup__row--dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      {!readOnly && sortable && (
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
      {readOnly ? null : nonRemovable ? (
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
          <Icon path="mdi-close" size={0.6} />
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
  /**
   * Block-row mode: render the "+" picker FIRST, left of the pills. The
   * block row-end group is right-pinned, so a hover-revealed add pill at
   * the END would shove the pills (and the backlink toggle) sideways;
   * at the START the group grows leftward over the flexible text column
   * and the pills never move.
   */
  addAtStart = false,
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
  /**
   * Read-only projection (read-only block rows): the pills render
   * statically — click opens the class, but no add/remove/reorder, no
   * context menu; the "+N" overflow popup lists the classes without
   * mutation chrome.
   */
  readOnly = false,
}: {
  client: AnyClient;
  nodeId: string;
  classIds: string[];
  onOpenPage?: ((pageId: string) => void) | undefined;
  overflow?: boolean | undefined;
  iconOnlyAdd?: boolean | undefined;
  addAtStart?: boolean | undefined;
  sortable?: boolean | undefined;
  actions?: NodePillsActions | undefined;
  removeLabel?: ((label: string) => string) | undefined;
  addLabel?: string | undefined;
  excludePickerNodeId?: string | undefined;
  readOnly?: boolean | undefined;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [colorMenu, setColorMenu] = useState<{ classId: string; x: number; y: number } | null>(null);
  const [nodeMenu, setNodeMenu] = useState<{ node: ClientNode; x: number; y: number } | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [overflowPos, setOverflowPos] = useState<{ top: number; left: number } | null>(null);
  /**
   * #14 — the picker's create-class row opens the ClassCreateModal instead
   * of a bare createClass: the typed query carries in as the name, and the
   * created class comes back through the promise the picker handed us.
   */
  const [classCreate, setClassCreate] = useState<{
    initialName: string;
    mode: "blank" | "gallery";
    resolve: (id: string | undefined) => void;
  } | null>(null);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const overflowButtonRef = useRef<HTMLButtonElement | null>(null);
  const overflowPopupRef = useRef<HTMLDivElement>(null);
  const colorMenuRef = useRef<HTMLDivElement>(null);

  // Dismissal: Escape closes the two portaled popups; the backdrop
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

  // Inline-linked classes hide their pill (owner ruling 2026-10-15): the
  // classes pills are a DERIVED VIEW — a class referenced by a class_link
  // token in the node's own content is already visible inline (the link IS
  // the marker), so rendering the pill too would duplicate the reference.
  // Membership is untouched: the picker still lists the class (checkmarked)
  // and the plain-pick toggle still removes it. Quote children are walked
  // too (tokens nest).
  const inlineLinkedClassIds = useMemo(() => {
    const found = new Set<string>();
    const walk = (tokens: unknown): void => {
      if (!Array.isArray(tokens)) return;
      for (const token of tokens) {
        if (token === null || typeof token !== "object") continue;
        const t = token as Record<string, unknown>;
        if (t.type === "class_link" && typeof t.classId === "string") found.add(t.classId);
        if (Array.isArray(t.children)) walk(t.children);
      }
    };
    walk(client.getNode(nodeId)?.contentAst);
    return found;
  }, [client, nodeId]);

  const displayClassIds = classIds.filter((classId) => !inlineLinkedClassIds.has(classId));

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const onAdd = actions?.add ?? ((classId: string) => void client.assignClass(nodeId, classId));
  const onRemove =
    actions?.remove ??
    // The removal ruling (owner 2026-10-15): dissolve inline class links to
    // the class into plain text with the same gesture (classRemoval.ts).
    ((classId: string) => void removeClassDissolvingLinks(client, nodeId, classId));
  const commitOrder = actions?.reorder ?? ((ordered: string[]) => void client.reorderClasses(nodeId, ordered));
  const labelForRemove = removeLabel ?? ((label: string) => `Remove class ${label}`);

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over === null || active.id === over.id) return;
    commitOrder(reorder(classIds, String(active.id), String(over.id)));
  };

  const visible = overflow && displayClassIds.length > 1 ? displayClassIds.slice(0, 1) : displayClassIds;
  const extraCount = displayClassIds.length - visible.length;

  const onContextMenuNode = (node: ClientNode, x: number, y: number) =>
    setNodeMenu({ node, x, y });

  const pillProps = {
    nodeId,
    client,
    onOpenPage,
    onContextMenuNode,
    onRemove,
    removeLabel: labelForRemove,
    readOnly,
  };

  const addPill = !readOnly ? (
    <span className="nt-class-add-anchor">
      <AddPill
        ref={addButtonRef}
        className={iconOnlyAdd || displayClassIds.length > 0 ? "pill--icon-only" : ""}
        label={addLabel}
        aria-expanded={pickerOpen}
        onClick={(element) => {
          addButtonRef.current = element;
          setPickerOpen((open) => !open);
        }}
      />
    </span>
  ) : null;

  const chips = (
    <div className="nt-property-chips node-metadata-pills">
      {addAtStart && addPill}
      {visible.map((classId) =>
        sortable && !readOnly ? (
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
      {!addAtStart && addPill}
    </div>
  );

  return (
    <>
      {readOnly ? (
        chips
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={visible} strategy={horizontalListSortingStrategy}>
            {chips}
          </SortableContext>
        </DndContext>
      )}
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
                <SortableContext items={displayClassIds} strategy={verticalListSortingStrategy}>
                  <ul className="node-pills-popup__list">
                    {displayClassIds.map((classId) => (
                      <PopupRow
                        key={classId}
                        classId={classId}
                        nodeId={nodeId}
                        client={client}
                        sortable={sortable}
                        onRemove={onRemove}
                        removeLabel={labelForRemove}
                        readOnly={readOnly}
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
          onCreateNew={(name) => {
            // The modal takes over; the picker closes. The promise resolves
            // with the created class id (undefined when cancelled) — the
            // picker's create-result flow then assigns it like any pick.
            setPickerOpen(false);
            return new Promise<string | undefined>((resolve) =>
              setClassCreate({ initialName: name, mode: "blank", resolve }),
            );
          }}
          onBrowseAllTypes={(query) => {
            // The picker's "Browse all classes…" row opens the gallery tab,
            // carrying the typed query across (the blank mode's "Create
            // your own" card uses it as the name).
            setPickerOpen(false);
            return new Promise<string | undefined>((resolve) =>
              setClassCreate({ initialName: query, mode: "gallery", resolve }),
            );
          }}
        />
      )}
      {classCreate !== null && (
        <ClassCreateModal
          isOpen
          client={client}
          initialName={classCreate.initialName}
          initialMode={classCreate.mode}
          onClose={() => {
            classCreate.resolve(undefined);
            setClassCreate(null);
          }}
          onCreated={(id) => {
            classCreate.resolve(id);
            setClassCreate(null);
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
                  // null = "No color" — object.update color:null clears.
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
