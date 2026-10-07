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
 * (present_as_main = 0) and the main-children section (present_as_main = 1,
 * the Pages zone). A drop's zone follows its anchor row (dropZoneOf); the
 * executor flips the dragged node's present_as_main bit to match the zone
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
 * hit-testing): at drag start the machinery measures the visible rows once
 * and builds the valid-location set — per row a sibling pair (above/below)
 * plus a child candidate, each anchored at a fixed point. Sibling anchors
 * sit at the row's divider (y = the row boundary) at the row depth's gutter
 * x; the child anchor sits at the row's vertical center at the child-offset
 * x. The dragged block's own subtree is excluded. Each pointer move projects
 * the pointer onto the nearest anchor within a y threshold (x distance
 * breaks ties); far from every anchor, no indicator renders. The dragged row
 * itself stays in place and renders muted (see BlockRow's drag-source
 * class); the floating DragOverlay chip is the only preview. Keyboard drags
 * (no pointer) keep the event-driven path below.
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

/** Live drop indicator, provided by PageView while a drag is in flight. */
export const DropLineContext = createContext<DropLine | null>(null);

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
 * at the row depth's gutter x; the child anchor sits at the row's vertical
 * center at the child-offset x.
 */
export interface DropCandidate {
  targetId: string;
  intent: DropLine["intent"];
  anchorX: number;
  anchorY: number;
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
 * the dragged subtree (the dragged block itself included — dropping onto it
 * is a no-op the indicator should not suggest), a sibling pair above/below
 * the row and a child candidate, each carrying its anchor point.
 */
export function dropCandidatesOf(
  positions: OutlinePositionMap,
  activeId: string,
  rows: readonly DragRowRect[],
): DropCandidate[] {
  const inDraggedSubtree = (startId: string): boolean => {
    let current: string | null | undefined = startId;
    const seen = new Set<string>();
    while (typeof current === "string" && !seen.has(current)) {
      if (current === activeId) return true;
      seen.add(current);
      current = positions.get(current)?.parentId ?? null;
    }
    return false;
  };
  const candidates: DropCandidate[] = [];
  for (const row of rows) {
    if (inDraggedSubtree(row.id)) continue;
    candidates.push({ targetId: row.id, intent: "above", anchorX: row.left, anchorY: row.top });
    candidates.push({
      targetId: row.id,
      intent: "below",
      anchorX: row.left,
      anchorY: row.top + row.height,
    });
    candidates.push({
      targetId: row.id,
      intent: "child",
      anchorX: row.left + CHILD_DROP_OFFSET_PX,
      anchorY: row.top + row.height / 2,
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
export function nearestCandidate(
  pointer: { x: number; y: number },
  candidates: readonly DropCandidate[],
  thresholds: { maxDyPx?: number; maxDxPx?: number } = {},
): DropCandidate | null {
  const maxDyPx = thresholds.maxDyPx ?? DROP_SNAP_MAX_DY_PX;
  const maxDxPx = thresholds.maxDxPx ?? Number.POSITIVE_INFINITY;
  let best: DropCandidate | null = null;
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
  getNode: (id: string) => { isClass: boolean; presentAsMain: boolean } | undefined,
): "main" | "body" {
  if (line.intent === "child") return "body";
  const target = getNode(line.targetId);
  return target !== undefined && !target.isClass && target.presentAsMain ? "main" : "body";
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
