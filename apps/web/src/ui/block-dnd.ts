/**
 * block-dnd — drag-and-drop reordering for the block tree (dnd-kit).
 *
 * Intent model (deliberately simple):
 *
 * - The row under the pointer is the anchor (closestCenter collision).
 * - POINTER X in the deep zone of the anchor row (≥ CHILD_DROP_OFFSET_PX from
 *   the row's left edge) → CHILD intent: reparent under that row, appended as
 *   its last child (`object.move` with afterId omitted).
 * - Otherwise the vertical half decides REORDER intent within the anchor's
 *   sibling group: lower half → afterId = the anchor row; upper half →
 *   afterId = the row above the drop line (the anchor's previous sibling).
 * - The drop line ABOVE the first sibling has no "row above"; `object.move`
 *   cannot express "before X" (afterId omitted appends at END), so it is
 *   executed as a two-move swap: dragged after the first sibling, then the
 *   first sibling after the dragged.
 * - Keyboard drags (no pointer) anchor "below" the over row — except onto the
 *   dragged block's previous sibling, which anchors "above" — so ArrowUp/Down
 *   read as outliner up/down moves.
 *
 * Zones (Revision 11): the page renders two child zones — the inline body
 * (is_embedded = 1) and the main-children section (is_embedded = 0,
 * the Pages zone). A drop's zone follows its anchor row (dropZoneOf); the
 * executor flips the dragged node's is_embedded bit to match the zone
 * (promotion 0→1 stringifies content server-side; demotion never
 * un-flattens).
 *
 * Guards (client-side, before issuing; the store's MoveGuardError remains the
 * defense-in-depth backstop surfaced as a transient banner):
 *
 * - A block may never drop into its own subtree (child intent onto itself or
 *   a descendant; reorder intent into a group whose parent is inside its own
 *   subtree) — computed by walking the positions parent chain.
 * - Dropping exactly where the block already sits is a silent no-op.
 *
 * Drag-session feedback (pointer drags ride a snap model, not live
 * hit-testing): at drag start the workspace host measures the visible rows
 * of EVERY registered surface once and builds the valid-location set — per
 * row a sibling pair (above/below) plus a child candidate, each anchored at
 * a fixed point. Sibling anchors sit at the row's divider (y = the row
 * boundary) at the row depth's gutter x; the child anchor sits at the row's
 * BOTTOM divider at the child-offset x. Every anchor's y is an ELEMENT
 * boundary — a block's measured element spans the whole block (text row,
 * properties, linked references, children), so a "below"/"child" line
 * always means "after THE ENTIRE block element". Because sibling and child
 * anchors share the bottom divider, one boundary hosts every nesting level
 * the surrounding tree allows — e.g. the divider before a top-level row is
 * simultaneously "previous sibling of it", "next sibling of the subtree
 * above at its own depth", and "first child of that subtree's last block" —
 * and the pointer's indentation (x distance, the nearestCandidate tie-
 * break) picks the level. The dragged block's own subtree is excluded. Each
 * pointer move projects the pointer onto the nearest anchor within a y
 * threshold (x distance breaks ties); far from every anchor, no indicator
 * renders. The preview is FROZEN by design: no row ever applies the
 * sortable strategy transform (BlockRow dropped it), so nothing slides to
 * make room — the feedback is the highlight line at the drop position (the
 * drop- intent classes), the dragged source(s) reading faint in place (the
 * drag-source class, whole selection stack included), and the floating
 * DragOverlay chip. At the edges of a scrollable view the session auto-
 * scrolls (see the edge-scroll section) and re-measures the anchors on
 * every scroll so the indicator tracks the content. Keyboard drags (no
 * pointer) keep the event-driven path below.
 *
 * Selection stacks: dragging the grip of a SELECTED row (or the stack's
 * lead) drags the whole level-capped selection — only the top-level roots
 * reparent, internal structure preserved (planStackMove). The chip reads
 * "N blocks".
 *
 * The workspace session (useWorkspaceDnd.ts): ONE drag session owns the
 * whole workspace — the host in App wraps the main content card, the right
 * rail, and the floating editor windows (portals keep the React context),
 * and every mounted editing surface registers its drag facts (measured
 * root, positions map, client, move executor) as a ZONE. Per-zone candidate
 * sets merge into one session set (mergeZoneCandidates — every candidate
 * tagged with its zone; drops resolve against the zone under the pointer).
 * Card frames additionally register a header droppable: dropping on a card
 * header is one code path with a child drop on the card's node — move as
 * the LAST CHILD of that node (append). Cross-zone drops are always MOVE
 * (re-parent), never copy/link.
 */

import { createContext } from "react";

import {
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { MoveGuardError } from "@notees/store";

import type { OutlinePositionMap } from "@/editor/outline.js";

/** Pointer x at least this far into a row (from its left edge) = child intent. */
export const CHILD_DROP_OFFSET_PX = 48;

export interface DropLine {
  targetId: string;
  intent: "above" | "below" | "child";
}

/** Live drop indicator, provided by the workspace host while a drag is in
 *  flight. BlockRow reads it; surfaces never provide it themselves. */
export const DropLineContext = createContext<DropLine | null>(null);

/**
 * The drag session's source set (the dragged block plus the rest of the
 * selection stack), provided by the workspace host while a drag is in
 * flight — every listed row renders faint in place. Null outside a drag.
 */
export const DragSourcesContext = createContext<ReadonlySet<string> | null>(null);

/**
 * The workspace drag-scope law: block rows are draggable ONLY inside a
 * workspace editing surface (a PageView tree, which provides this context).
 * Read-only projections and standalone reference trees render editable rows
 * outside the scope — editable, never draggable (the context-presence law:
 * outside the session there is nothing to drag into, so the grip stays inert).
 */
export const WorkspaceDragScopeContext = createContext(false);

export function useBlockDndSensors() {
  return useSensors(
    // A small distance so plain clicks (collapse toggle, edit) never start a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
}

/**
 * Pointer drags hit-test the pointer (pointerWithin). Keyboard drags have no
 * pointer coordinates (the activator is a keydown), so those fall back to the
 * translated collision rect against the nearest center — otherwise keyboard
 * moves would never produce an `over`.
 */
export const blockCollisionDetection: CollisionDetection = (args) => {
  if (args.pointerCoordinates) return pointerWithin(args);
  return closestCenter(args);
};

export function dropLineFromPointer(args: {
  overId: string;
  pointerX: number;
  pointerY: number;
  overRect: { left: number; top: number; height: number };
}): DropLine {
  const { overId, pointerX, pointerY, overRect } = args;
  if (pointerX - overRect.left >= CHILD_DROP_OFFSET_PX) {
    return { targetId: overId, intent: "child" };
  }
  return {
    targetId: overId,
    intent: pointerY < overRect.top + overRect.height / 2 ? "above" : "below",
  };
}

/**
 * The live pointer position for a drag event: the activator origin + the
 * drag delta (dnd-kit does not expose the pointer on the event itself).
 * Keyboard drags have no pointer — null.
 */
export function dragPointerOf(event: {
  delta: { x: number; y: number };
  activatorEvent: unknown;
}): { x: number; y: number } | null {
  const origin = event.activatorEvent as Partial<PointerEvent>;
  if (typeof origin.clientX !== "number" || typeof origin.clientY !== "number") return null;
  return { x: origin.clientX + event.delta.x, y: origin.clientY + event.delta.y };
}

/**
 * The drop line for a drag event: pointer position = activator origin + delta
 * (dnd-kit does not expose the live pointer on the event). Keyboard-driven
 * drags have no pointer; they anchor below the over row (above when the over
 * row is the dragged block's previous sibling).
 */
export function dropLineFromDragEvent(
  event: DragMoveEvent | DragEndEvent,
  positions: OutlinePositionMap,
): DropLine | null {
  const { active, over } = event;
  if (over === null || active === null) return null;
  const pointer = dragPointerOf(event);
  if (pointer === null) {
    const previous = positions.get(String(active.id))?.previousSiblingId;
    return {
      targetId: String(over.id),
      intent: String(over.id) === previous ? "above" : "below",
    };
  }
  return dropLineFromPointer({
    overId: String(over.id),
    pointerX: pointer.x,
    pointerY: pointer.y,
    overRect: over.rect,
  });
}

// --- drag-session snap model ------------------------------------------------------
//
// The feedback layer: the valid-location set for one drag session plus the
// pointer projection that drives the drop indicator. Pure and unit-testable;
// the machinery measures the rows once at drag start and memoizes the set
// for the session.

/** A visible row's measured rect for one drag session. */
export interface DragRowRect {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * One valid drop location: the drop line plus the anchor point the pointer
 * snaps to. Sibling anchors sit at the row's divider (y = the row boundary)
 * at the row depth's gutter x; the child anchor sits at the row's BOTTOM
 * divider at the child-offset x — so at every element boundary the sibling
 * and child candidates share the divider and the pointer's indentation
 * (nearestCandidate's x tie-break) picks the level.
 */
export interface DropCandidate {
  targetId: string;
  intent: DropLine["intent"];
  anchorX: number;
  anchorY: number;
  /** The row's right edge (viewport x) — the indicator line spans from the
   *  anchor to here; the row-level class lines use the same geometry. */
  rowRight: number;
}

/** Default y threshold for the pointer projection (see nearestCandidate). */
export const DROP_SNAP_MAX_DY_PX = 24;

/**
 * Measures the rows that can receive a block drop during a drag session: the
 * editable block rows and table-grid rows under the page root. Read-only
 * projections (linked-reference chrome, embeds, the Child pages tree) are
 * not droppable and stay out of the candidate set. Rows are measured in
 * document order, once, at drag start.
 */
export function measureDragRows(root: HTMLElement | null): DragRowRect[] {
  if (root === null) return [];
  const rows: DragRowRect[] = [];
  const seen = new Set<string>();
  const elements = root.querySelectorAll<HTMLElement>(
    "[data-block-id].nt-block, [data-block-id].nt-blocktable-row",
  );
  for (const el of elements) {
    if (el.classList.contains("nt-block--readonly")) continue;
    const id = el.getAttribute("data-block-id");
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    const rect = el.getBoundingClientRect();
    rows.push({ id, left: rect.left, top: rect.top, width: rect.width, height: rect.height });
  }
  return rows;
}

/**
 * The valid-location set for a drag session: for every visible row except
 * the dragged subtrees (the dragged block itself included — dropping onto
 * it is a no-op the indicator should not suggest; `extraExcluded` carries
 * the rest of a selection stack's roots), a sibling pair above/below the
 * row and a child candidate, each carrying its anchor point.
 */
export function dropCandidatesOf(
  positions: OutlinePositionMap,
  activeId: string,
  rows: readonly DragRowRect[],
  extraExcluded?: ReadonlySet<string>,
): DropCandidate[] {
  const inDraggedSubtree = (startId: string): boolean => {
    let current: string | null | undefined = startId;
    const seen = new Set<string>();
    while (typeof current === "string" && !seen.has(current)) {
      if (current === activeId || extraExcluded?.has(current) === true) return true;
      seen.add(current);
      current = positions.get(current)?.parentId ?? null;
    }
    return false;
  };
  const candidates: DropCandidate[] = [];
  for (const row of rows) {
    if (inDraggedSubtree(row.id)) continue;
    const rowRight = row.left + row.width;
    candidates.push({
      targetId: row.id,
      intent: "above",
      anchorX: row.left,
      anchorY: row.top,
      rowRight,
    });
    candidates.push({
      targetId: row.id,
      intent: "below",
      anchorX: row.left,
      anchorY: row.top + row.height,
      rowRight,
    });
    candidates.push({
      targetId: row.id,
      intent: "child",
      anchorX: row.left + CHILD_DROP_OFFSET_PX,
      anchorY: row.top + row.height,
      rowRight,
    });
  }
  return candidates;
}

/**
 * The candidate whose anchor is nearest the pointer among those within the y
 * threshold (default DROP_SNAP_MAX_DY_PX; maxDxPx gates horizontally, unbounded
 * by default so a deep pointer still reaches its row's child anchor). Ties
 * break by x distance, then by generation order. Null when nothing is near —
 * the machinery renders no indicator then.
 */
export function nearestCandidate<T extends DropCandidate>(
  pointer: { x: number; y: number },
  candidates: readonly T[],
  thresholds: { maxDyPx?: number; maxDxPx?: number } = {},
): T | null {
  const maxDyPx = thresholds.maxDyPx ?? DROP_SNAP_MAX_DY_PX;
  const maxDxPx = thresholds.maxDxPx ?? Number.POSITIVE_INFINITY;
  let best: T | null = null;
  let bestDistSq = Number.POSITIVE_INFINITY;
  let bestDx = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const dy = Math.abs(candidate.anchorY - pointer.y);
    if (dy > maxDyPx) continue;
    const dx = Math.abs(candidate.anchorX - pointer.x);
    if (dx > maxDxPx) continue;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq || (distSq === bestDistSq && dx < bestDx)) {
      best = candidate;
      bestDistSq = distSq;
      bestDx = dx;
    }
  }
  return best;
}

/**
 * A session candidate tagged with the zone it belongs to: the host merges
 * every registered surface's set into one and resolves drops against the
 * zone under the pointer.
 */
export interface ZoneDropCandidate extends DropCandidate {
  zoneId: string;
}

/**
 * The session's merged valid-location set: per-zone candidate lists merged
 * in registration order, each candidate tagged with its zone. Pure —
 * the host re-merges whenever a zone's set changes mid-session (a card
 * body mounting on a transient expand).
 */
export function mergeZoneCandidates(
  perZone: ReadonlyArray<{ zoneId: string; candidates: readonly DropCandidate[] }>,
): ZoneDropCandidate[] {
  const merged: ZoneDropCandidate[] = [];
  for (const { zoneId, candidates } of perZone) {
    for (const candidate of candidates) merged.push({ ...candidate, zoneId });
  }
  return merged;
}

export type MoveCommand =
  | { kind: "reorder"; parentId: string; afterId: string | null }
  | { kind: "child"; parentId: string };

/**
 * The render zone a drop line lands in (Revision 11): a REORDER line anchored
 * on a present-as-main row targets the parent's main-children zone (the drop
 * promotes the dragged node); anything else — body-row anchors, CHILD intents
 * (the dragged node becomes an inline child of the anchor) — is the inline
 * body (the drop demotes when the dragged node was a main child).
 */
export function dropZoneOf(
  line: DropLine,
  getNode: (id: string) => { isClass: boolean; isEmbedded: boolean } | undefined,
): "main" | "body" {
  if (line.intent === "child") return "body";
  const target = getNode(line.targetId);
  return target !== undefined && !target.isClass && !target.isEmbedded ? "main" : "body";
}

export type MoveResolution =
  | { status: "move"; command: MoveCommand }
  | { status: "noop" }
  | { status: "refused"; reason: string };

export function resolveMove(args: {
  activeId: string;
  line: DropLine;
  positions: OutlinePositionMap;
}): MoveResolution {
  const { activeId, line, positions } = args;
  const overPos = positions.get(line.targetId);
  const activePos = positions.get(activeId);
  if (overPos === undefined || activePos === undefined) return { status: "noop" };

  // Walk the parent chain upward (O(depth)) to detect own-subtree drops.
  const inOwnSubtree = (startId: string): boolean => {
    let current: string | null | undefined = startId;
    const seen = new Set<string>();
    while (typeof current === "string" && !seen.has(current)) {
      if (current === activeId) return true;
      seen.add(current);
      current = positions.get(current)?.parentId ?? null;
    }
    return false;
  };

  if (line.intent === "child") {
    if (inOwnSubtree(line.targetId)) {
      return { status: "refused", reason: "Can't drop a block into its own subtree" };
    }
    return { status: "move", command: { kind: "child", parentId: line.targetId } };
  }

  const parentId = overPos.parentId;
  if (parentId === null) return { status: "noop" };
  if (inOwnSubtree(parentId)) {
    return { status: "refused", reason: "Can't drop a block into its own subtree" };
  }
  const afterId = line.intent === "below" ? line.targetId : overPos.previousSiblingId;
  if (afterId === activeId) return { status: "noop" };
  if (parentId === activePos.parentId && afterId === activePos.previousSiblingId) {
    return { status: "noop" };
  }
  return { status: "move", command: { kind: "reorder", parentId, afterId } };
}

/**
 * Issue the resolved move. The first-slot reorder (afterId null) is the
 * two-move swap documented in the intent model: dragged after the first
 * sibling, then the first sibling after the dragged.
 */
export async function executeMove(args: {
  activeId: string;
  command: MoveCommand;
  positions: OutlinePositionMap;
  moveObject: (id: string, parentId: string | null, afterId?: string) => Promise<void>;
}): Promise<void> {
  const { activeId, command, positions, moveObject } = args;
  if (command.kind === "child") {
    await moveObject(activeId, command.parentId);
    return;
  }
  if (command.afterId !== null) {
    await moveObject(activeId, command.parentId, command.afterId);
    return;
  }
  const firstEntry = [...positions.entries()].find(
    ([id, pos]) => pos.parentId === command.parentId && pos.previousSiblingId === null,
  );
  const firstId = firstEntry?.[0];
  if (firstId === undefined || firstId === activeId) return;
  await moveObject(activeId, command.parentId, firstId);
  await moveObject(firstId, command.parentId, activeId);
}

/** Transient-banner message for a failed move (store guards, LWW races, …). */
export function moveErrorMessage(err: unknown): string {
  if (err instanceof MoveGuardError) return err.message;
  if (err instanceof Error) return err.message;
  return "Block move failed";
}

// --- cross-tree resolution -------------------------------------------------------
//
// Rows that live OUTSIDE the page's own tree (linked references, embeds)
// are not in the outliner positions map. resolveMoveFromClient resolves
// those drops straight from the client: parent chains and sibling order via
// getNode/getChildren. Same intent model, same guards.

export interface ClientShape {
  getNode(id: string): { id: string; parentId: string | null } | undefined;
  getChildren(id: string): Array<{ id: string }>;
}

export function resolveMoveFromClient(args: {
  activeId: string;
  line: DropLine;
  client: ClientShape;
}): MoveResolution {
  const { activeId, line, client } = args;
  const over = client.getNode(line.targetId);
  if (over === undefined) return { status: "noop" };

  const inOwnSubtree = (startId: string | null): boolean => {
    let current: string | null = startId;
    const seen = new Set<string>();
    while (typeof current === "string" && !seen.has(current)) {
      if (current === activeId) return true;
      seen.add(current);
      current = client.getNode(current)?.parentId ?? null;
    }
    return false;
  };

  if (line.intent === "child") {
    if (inOwnSubtree(line.targetId)) {
      return { status: "refused", reason: "Can't drop a block into its own subtree" };
    }
    return { status: "move", command: { kind: "child", parentId: line.targetId } };
  }

  const parentId = over.parentId;
  if (parentId === null) return { status: "noop" };
  if (inOwnSubtree(parentId)) {
    return { status: "refused", reason: "Can't drop a block into its own subtree" };
  }
  const siblings = client.getChildren(parentId);
  const index = siblings.findIndex((sibling) => sibling.id === line.targetId);
  const afterId =
    line.intent === "below" ? line.targetId : index > 0 ? siblings[index - 1]!.id : null;
  if (afterId === activeId) return { status: "noop" };
  return { status: "move", command: { kind: "reorder", parentId, afterId } };
}

/** Cross-tree execute: the first-slot swap resolves siblings from the client. */
export async function executeMoveFromClient(args: {
  activeId: string;
  command: MoveCommand;
  client: ClientShape;
  moveObject: (id: string, parentId: string | null, afterId?: string) => Promise<void>;
}): Promise<void> {
  const { activeId, command, client, moveObject } = args;
  if (command.kind === "child") {
    await moveObject(activeId, command.parentId);
    return;
  }
  if (command.afterId !== null) {
    await moveObject(activeId, command.parentId, command.afterId);
    return;
  }
  const firstId = client.getChildren(command.parentId)[0]?.id;
  if (firstId === undefined || firstId === activeId) return;
  await moveObject(activeId, command.parentId, firstId);
  await moveObject(firstId, command.parentId, activeId);
}

/**
 * The client shape the zone move executor issues through: the cross-tree
 * resolution reads (`ClientShape`) plus the write path and the render-bit
 * facts the present-as-main flip reads.
 */
export interface MoveExecutionClient extends ClientShape {
  getNode(
    id: string,
  ): { id: string; parentId: string | null; isClass: boolean; isEmbedded: boolean } | undefined;
  moveObject: (id: string, parentId: string | null, afterId?: string) => Promise<void>;
  updateObject: (id: string, patch: { isEmbedded: boolean }) => Promise<void>;
}

/**
 * The zone move executor: issue the resolved move through the surface's
 * client and flip the dragged node's present-as-main bit to the zone the
 * drop landed in (`dropZoneOf` — a main-children anchored line promotes,
 * everything else demotes/keeps the inline body). Every registered zone
 * executes through this same contract; the host catches rejections and
 * surfaces the transient banner.
 */
export async function executeZoneMove(args: {
  activeId: string;
  line: DropLine;
  command: MoveCommand;
  crossTree: boolean;
  positions: OutlinePositionMap;
  client: MoveExecutionClient;
}): Promise<void> {
  const { activeId, line, command, crossTree, positions, client } = args;
  const moveObject = (id: string, parentId: string | null, afterId?: string) =>
    afterId === undefined ? client.moveObject(id, parentId) : client.moveObject(id, parentId, afterId);
  if (crossTree) {
    await executeMoveFromClient({ activeId, command, client, moveObject });
  } else {
    await executeMove({ activeId, command, positions, moveObject });
  }
  const zone = dropZoneOf(line, (id) => client.getNode(id));
  const dragged = client.getNode(activeId);
  if (dragged !== undefined && dragged.isEmbedded !== (zone === "body")) {
    await client.updateObject(activeId, { isEmbedded: zone === "body" });
  }
}

// --- selection-stack drags ---------------------------------------------------
//
// Dragging the grip of a SELECTED row drags the whole level-capped selection
// stack: only the top-level roots reparent — a selected block's selected
// descendants ride inside it, so the internal structure is preserved by
// construction. The planner works on SiblingFacts (positions map or client)
// with list semantics: drop the stack into the parent's child list (drag ids
// removed) right after the anchor; a block whose current (parent, previous
// sibling) already matches its intended placement is skipped by the executor.

/**
 * The effective drag set for a selection stack: the selected roots in
 * document order (the positions map iterates in document order). The stack
 * is level-capped upstream (outliner-context), so no root is another's
 * descendant — descendants ride implicitly inside their root's subtree.
 */
export function effectiveDragIds(
  selectionRoots: ReadonlySet<string>,
  positions: OutlinePositionMap,
): string[] {
  const ids: string[] = [];
  for (const [id] of positions) {
    if (selectionRoots.has(id)) ids.push(id);
  }
  return ids;
}

/** Sibling/parent reads the stack planner needs — from positions or client. */
export interface SiblingFacts {
  /** The parent id, or null when unknown (outside this tree). */
  parentOf(id: string): string | null;
  /** The previous sibling in document order, or null (first child / unknown). */
  prevOf(id: string): string | null;
  /** The children of a parent in document order. */
  childrenOf(parentId: string): string[];
}

export function siblingFactsFromPositions(positions: OutlinePositionMap): SiblingFacts {
  // The positions map iterates in document order, so per-parent accumulation
  // yields document-ordered child lists.
  const children = new Map<string, string[]>();
  for (const [id, pos] of positions) {
    if (pos.parentId === null) continue;
    const list = children.get(pos.parentId);
    if (list === undefined) children.set(pos.parentId, [id]);
    else list.push(id);
  }
  return {
    parentOf: (id) => positions.get(id)?.parentId ?? null,
    prevOf: (id) => positions.get(id)?.previousSiblingId ?? null,
    childrenOf: (parentId) => children.get(parentId) ?? [],
  };
}

export function siblingFactsFromClient(client: ClientShape): SiblingFacts {
  const cache = new Map<string, string[]>();
  const childrenOf = (parentId: string): string[] => {
    const cached = cache.get(parentId);
    if (cached !== undefined) return cached;
    const list = client.getChildren(parentId).map((child) => child.id);
    cache.set(parentId, list);
    return list;
  };
  return {
    parentOf: (id) => client.getNode(id)?.parentId ?? null,
    prevOf: (id) => {
      const parentId = client.getNode(id)?.parentId;
      if (parentId === undefined || parentId === null) return null;
      const list = childrenOf(parentId);
      const index = list.indexOf(id);
      return index > 0 ? list[index - 1]! : null;
    },
    childrenOf,
  };
}

/** One block's move in a stack plan. */
export interface PlannedMove {
  id: string;
  command: MoveCommand;
  /** The block already sits at its intended placement — the executor skips it. */
  alreadyThere: boolean;
  /**
   * First-slot anchor: a reorder with afterId null executes as the
   * three-phase swap (see executeStackPlan); the current first child is
   * carried here.
   */
  firstSlotSwapWith?: string;
}

export type StackPlan =
  | { status: "move"; moves: PlannedMove[] }
  | { status: "noop" }
  | { status: "refused"; reason: string };

/**
 * Plan a selection-stack drop under the intent model's list semantics.
 * Guards: the would-be parent (reorder) or target (child) may not lie in any
 * dragged block's own subtree — checked per block, loud refusal. The plan
 * covers EVERY stack block (already-there ones included) so the first-slot
 * swap can order the whole stack deterministically.
 */
export function planStackMove(
  ids: readonly string[],
  line: DropLine,
  facts: SiblingFacts,
): StackPlan {
  const idSet = new Set(ids);
  if (idSet.has(line.targetId)) return { status: "noop" };

  const inOwnSubtree = (startId: string, blockId: string): boolean => {
    const seen = new Set<string>();
    let current: string | null = startId;
    while (typeof current === "string" && !seen.has(current)) {
      if (current === blockId) return true;
      seen.add(current);
      current = facts.parentOf(current);
    }
    return false;
  };

  if (line.intent === "child") {
    const target = line.targetId;
    for (const id of ids) {
      if (inOwnSubtree(target, id)) {
        return { status: "refused", reason: "Can't drop a block into its own subtree" };
      }
    }
    // Intended placement: the stack appended at the END of the target's
    // children in stack order; the lead's intended previous sibling is the
    // last child that is not part of the stack.
    const remaining = facts.childrenOf(target).filter((child) => !idSet.has(child));
    const intendedPrev0 = remaining[remaining.length - 1] ?? null;
    return finishPlan(
      ids.map((id, index) => ({
        id,
        command: { kind: "child", parentId: target } as MoveCommand,
        parentMatches: facts.parentOf(id) === target,
        prevMatches: facts.prevOf(id) === (index === 0 ? intendedPrev0 : ids[index - 1]!),
      })),
    );
  }

  const parent = facts.parentOf(line.targetId);
  if (parent === null) return { status: "noop" };
  for (const id of ids) {
    if (inOwnSubtree(parent, id)) {
      return { status: "refused", reason: "Can't drop a block into its own subtree" };
    }
  }
  // The parent's child list with the stack removed; the stack inserts right
  // after the anchor row ("above" anchors on the row before the target).
  const siblings = facts.childrenOf(parent).filter((child) => !idSet.has(child));
  const targetIndex = siblings.indexOf(line.targetId);
  if (targetIndex === -1) return { status: "noop" };
  const insertAfter = line.intent === "below" ? targetIndex : targetIndex - 1;
  const intendedPrev0 = insertAfter >= 0 ? (siblings[insertAfter] ?? null) : null;
  const firstSlotSwapWith = intendedPrev0 === null ? siblings[0] : undefined;
  return finishPlan(
    ids.map((id, index) => ({
      id,
      command: {
        kind: "reorder",
        parentId: parent,
        afterId: index === 0 ? intendedPrev0 : ids[index - 1]!,
      } as MoveCommand,
      parentMatches: facts.parentOf(id) === parent,
      prevMatches: facts.prevOf(id) === (index === 0 ? intendedPrev0 : ids[index - 1]!),
      ...(firstSlotSwapWith !== undefined && index === 0 ? { firstSlotSwapWith } : {}),
    })),
  );
}

/**
 * Assemble the moves + the alreadyThere flags. The flag is PREFIX-GATED: a
 * block may keep its place only while every block before it in the stack
 * does too — block i's intended previous sibling is block i-1, so the
 * moment a predecessor issues a move, every successor must be re-anchored
 * on it (the chain rebuilds the stack sequence from the anchor). All flags
 * true → the whole plan is a noop.
 */
function finishPlan(
  drafted: Array<{
    id: string;
    command: MoveCommand;
    parentMatches: boolean;
    prevMatches: boolean;
    firstSlotSwapWith?: string;
  }>,
): StackPlan {
  let prefixIntact = true;
  const moves: PlannedMove[] = drafted.map((move) => {
    const stays = prefixIntact && move.parentMatches && move.prevMatches;
    if (!stays) prefixIntact = false;
    const { parentMatches, prevMatches, ...rest } = move;
    return { ...rest, alreadyThere: stays };
  });
  if (moves.every((move) => move.alreadyThere)) return { status: "noop" };
  return { status: "move", moves };
}

/**
 * Issue a stack plan: each pending block moves to its intended placement,
 * chained on the stack's own order (block i lands after block i-1). The
 * first-slot reorder (afterId null) runs the three-phase swap from
 * executeMove, generalized to the stack: the whole stack moves after the
 * current first child in order, then the first child moves after the stack —
 * the stack ends up ahead of it, order kept.
 */
export async function executeStackPlan(
  moves: readonly PlannedMove[],
  moveObject: (id: string, parentId: string | null, afterId?: string) => Promise<void>,
): Promise<void> {
  if (moves.every((move) => move.alreadyThere)) return;
  const lead = moves[0]!;
  if (lead.command.kind === "reorder" && lead.command.afterId === null) {
    const firstId = lead.firstSlotSwapWith;
    if (typeof firstId !== "string") return;
    await moveObject(lead.id, lead.command.parentId, firstId);
    for (let index = 1; index < moves.length; index += 1) {
      const move = moves[index]!;
      if (move.command.kind === "reorder") {
        await moveObject(move.id, move.command.parentId, moves[index - 1]!.id);
      }
    }
    await moveObject(firstId, lead.command.parentId, moves[moves.length - 1]!.id);
    return;
  }
  for (const move of moves) {
    if (move.alreadyThere) continue;
    if (move.command.kind === "child") {
      await moveObject(move.id, move.command.parentId);
    } else if (move.command.afterId !== null) {
      await moveObject(move.id, move.command.parentId, move.command.afterId);
    }
  }
}

/**
 * The zone executor for a stack drop: issue the plan through the surface's
 * client and flip every dragged block's present-as-main bit to the zone the
 * drop landed in (`dropZoneOf` — the same line decides for the whole stack).
 */
export async function executeStackZoneMove(args: {
  line: DropLine;
  plan: Extract<StackPlan, { status: "move" }>;
  client: MoveExecutionClient;
}): Promise<void> {
  const { line, plan, client } = args;
  const moveObject = (id: string, parentId: string | null, afterId?: string) =>
    afterId === undefined ? client.moveObject(id, parentId) : client.moveObject(id, parentId, afterId);
  await executeStackPlan(plan.moves, moveObject);
  const zone = dropZoneOf(line, (id) => client.getNode(id));
  for (const move of plan.moves) {
    const dragged = client.getNode(move.id);
    if (dragged !== undefined && dragged.isEmbedded !== (zone === "body")) {
      await client.updateObject(move.id, { isEmbedded: zone === "body" });
    }
  }
}

// --- drag-session edge auto-scroll ------------------------------------------
//
// A block drag auto-scrolls the scrollable views it rides (the page body,
// a rail card, a floating editor) when the pointer sits in the edge band of
// a container that can still scroll that way — the only motion during a
// drag, which is otherwise frozen. The rAF loop lives in the workspace
// host; these are its pure, unit-tested pieces.

/** Pointer distance from a scrollable container's edge that arms the drag edge-scroll. */
export const DRAG_EDGE_SCROLL_BAND_PX = 40;

/** Maximum per-frame scroll step at the container's very edge. */
export const DRAG_EDGE_SCROLL_MAX_SPEED_PX = 6;

/**
 * The scrollable views a zone root rides, innermost first: every element in
 * the root's ancestor chain (the root included) whose overflow-y is
 * auto/scroll and whose content overflows vertically, then the document
 * scroller when it overflows, then — the PageView case — the root's own
 * SUBTREE: the zone root spans the whole page chrome while the scrolling
 * cell (`.nt-nodeview-body`) is its descendant, so an ancestor-only walk
 * misses the scroller and edge auto-scroll never arms (owner 2026-10-14:
 * "reaching the top or the bottom of the current list does not scroll").
 */
export function scrollContainersOf(root: HTMLElement | null): HTMLElement[] {
  if (root === null) return [];
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  const containers: HTMLElement[] = [];
  const collect = (el: HTMLElement): void => {
    if (containers.includes(el)) return;
    const overflowY = view === null ? "" : view.getComputedStyle(el).overflowY;
    if (overflowY !== "auto" && overflowY !== "scroll") return;
    if (el.scrollHeight <= el.clientHeight) return;
    containers.push(el);
  };
  for (let el: HTMLElement | null = root; el !== null; el = el.parentElement) collect(el);
  const scroller = doc.scrollingElement;
  if (scroller instanceof HTMLElement) collect(scroller);
  // Subtree sweep — same cost class as the drag-start row measurement (one
  // querySelectorAll pass over the zone root).
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) collect(el);
  return containers;
}

/**
 * The per-frame vertical scroll step for a pointer near a container's edge:
 * within the band of the top edge the container scrolls up, of the bottom
 * edge down, linearly ramping from zero at the band's outer bound to the
 * max speed at the edge; the nearer edge wins on short containers. Zero
 * when the pointer sits outside the band or the container cannot scroll
 * further in that direction. Pure — the host feeds live rect + scroll facts
 * each frame.
 */
export function edgeScrollVelocity(args: {
  pointerY: number;
  rectTop: number;
  rectHeight: number;
  canScrollUp: boolean;
  canScrollDown: boolean;
}): number {
  const { pointerY, rectTop, rectHeight, canScrollUp, canScrollDown } = args;
  const band = DRAG_EDGE_SCROLL_BAND_PX;
  const max = DRAG_EDGE_SCROLL_MAX_SPEED_PX;
  const distFromTop = pointerY - rectTop;
  const distFromBottom = rectTop + rectHeight - pointerY;
  const topIn = distFromTop >= 0 && distFromTop < band && canScrollUp;
  const bottomIn = distFromBottom >= 0 && distFromBottom < band && canScrollDown;
  if (topIn && (!bottomIn || distFromTop <= distFromBottom)) {
    return -Math.ceil(((band - distFromTop) / band) * max);
  }
  if (bottomIn) {
    return Math.ceil(((band - distFromBottom) / band) * max);
  }
  return 0;
}
