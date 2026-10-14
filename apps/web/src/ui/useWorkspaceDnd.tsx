/**
 * useWorkspaceDnd — the ONE drag session for the workspace (the drag-host
 * hoist: the per-surface DndContext machinery is gone; the session lives
 * here).
 *
 * Architecture:
 *
 * - `<WorkspaceDndHost>` renders the single dnd-kit context (sensors,
 *   collision detection, DragOverlay chip, the DropLineContext provider,
 *   the transient move-error banner) and wraps, in App, the main content
 *   card + the right rail INSIDE the FloatingEditorHost — so the floating
 *   editor windows join the same session too (they portal via createPortal
 *   but stay inside the host's React subtree, and React context flows
 *   through portals).
 * - Every mounted editing surface registers its drag facts as a ZONE via
 *   `useWorkspaceDndZone` (PageView does; embedded renders and rail cards
 *   render PageView, so they register automatically): the measured root,
 *   the live positions getter, the client, and the move executor. Card
 *   frames additionally register their header as a droppable via
 *   `useWorkspaceDndHeader`.
 * - At drag start the host measures every registered zone once and merges
 *   the per-zone valid-location sets (`mergeZoneCandidates` — every
 *   candidate tagged with its zone). Pointer moves project onto the merged
 *   set (proximity snapping); drops resolve against the candidate's zone.
 *   A zone registering mid-session (a collapsed card body mounting on a
 *   transient expand) is measured into the session at registration.
 * - Snap model, indicator, guards, and the event-driven fallback are
 *   unchanged from the intent model in block-dnd.ts — the hierarchy-end
 *   disambiguation and the drag-end fallback (nothing near → event-driven
 *   line) carry over; keyboard drags keep the event-driven path.
 * - Selection stacks: dragging the grip of a SELECTED row drags the whole
 *   level-capped selection (the zone facts expose `getSelection`) — the
 *   session's `dragIds` carries the top-level roots (document order), the
 *   chip reads "N blocks", every stack row renders faint via
 *   DragSourcesContext, and the drop plans + executes one chained move per
 *   root (planStackMove — internal structure preserved, first-slot swaps
 *   generalized). Single-block drags keep the resolveMove/executeZoneMove
 *   path untouched.
 * - Edge auto-scroll: the session collects the scrollable ancestors of
 *   every zone root and runs a rAF loop — a pointer in a container's edge
 *   band scrolls it (ramped speed, the innermost scroller under the
 *   pointer, dnd-kit's built-in autoScroll stays OFF to avoid double
 *   scrolls). ANY scroll during a block session re-measures every zone
 *   into the session and re-projects the drop line at the last pointer, so
 *   the indicator tracks content moving under a stationary pointer and
 *   freshly revealed rows become droppable.
 *
 * Card header drops (the card frame's header is a droppable):
 *
 * - Dropping ON a card header moves the dragged block as the LAST CHILD of
 *   the card's node (append). One code path: the header drop translates to
 *   the line { targetId: cardNodeId, intent: "child" } — the same line a
 *   child drop on the card node's title row produces — and flows through
 *   the ordinary cross-tree resolution + execution against the header's
 *   client. The header renders its own distinct active-drop state while it
 *   is the drop target (the host publishes it on the drag-UI context).
 * - A collapsed card under drag-hover transiently EXPANDS (the session
 *   holds the temporary set on the drag-UI context; the card's persistent
 *   collapse state never mutates) and re-collapses at drag end. The
 *   expansion mounts the card's body, whose zone registration measures it
 *   into the live session.
 *
 * Rail card reorder (the same session, a distinct drag kind):
 *
 * - A card frame's header carries a GRIP that registers the card as a
 *   reorder source (the block-row grip precedent — a small distinct
 *   handle, so the reorder gesture never conflicts with the header's
 *   drop gesture or the breadcrumb clicks). Dragging the grip starts a
 *   RAIL session: the block machinery stays out (no zone measuring, no
 *   drop line, no transient expands) — the feedback is the overlay chip
 *   plus the target header's reorder edge (before/after, the pointer's
 *   half of the header; keyboard drags default below).
 * - At drop, the host reports { activeCard, targetCard, position } to the
 *   App's onRailCardReorder — the App owns the card stack (session state)
 *   and its device-local persistence; the session never moves blocks for
 *   a card drag, and never reorders for a block drag. Dropping onto the
 *   dragged card's own header is a no-op.
 *
 * Cross-zone drops are always MOVE (re-parent) — never copy/link.
 *
 * Without a host (standalone renders, tests) the registration hooks are
 * no-ops and the contexts default to inert — surfaces stay editable but
 * nothing is draggable (the context-presence law, see
 * WorkspaceDragScopeContext in block-dnd.ts).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { DndContext, DragOverlay, useDraggable, useDroppable, type DragEndEvent, type DragMoveEvent, type DragStartEvent, type DraggableAttributes, type DraggableSyntheticListeners } from "@dnd-kit/core";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";
import type { OutlinePositionMap } from "@/editor/outline.js";

import { displayNameFromClient } from "./dateDisplay.js";
import {
  DragSourcesContext,
  DropLineContext,
  blockCollisionDetection,
  dragPointerOf,
  dropCandidatesOf,
  dropLineFromDragEvent,
  edgeScrollVelocity,
  effectiveDragIds,
  executeStackZoneMove,
  executeZoneMove,
  measureDragRows,
  mergeZoneCandidates,
  moveErrorMessage,
  nearestCandidate,
  planStackMove,
  resolveMove,
  resolveMoveFromClient,
  scrollContainersOf,
  siblingFactsFromClient,
  siblingFactsFromPositions,
  useBlockDndSensors,
  type DropCandidate,
  type DropLine,
  type StackPlan,
  type ZoneDropCandidate,
} from "./block-dnd.js";

type AnyClient = WorkspaceClient | WorkerClient;

/** A surface's registered drag facts (one per mounted editing surface). */
export interface WorkspaceDndZoneFacts {
  /** Stable per mount — React's useId at the surface. */
  id: string;
  /** The DOM root whose editable rows are measured for the snap model. */
  rootRef: RefObject<HTMLElement | null>;
  /** The surface's live outline positions (sibling/parent facts). */
  getPositions: () => OutlinePositionMap;
  /**
   * The surface's level-capped selection stack: dragging the grip of a
   * selected row promotes the drag to the whole stack. Absent on surfaces
   * without block multi-selection.
   */
  getSelection?: () => ReadonlySet<string>;
  /** The write client (resolution + execution + display names). */
  client: AnyClient;
}

/** A card frame's registered header droppable. */
export interface WorkspaceDndHeaderFacts {
  droppableId: string;
  /** The card's node: a header drop appends the dragged block as its last child. */
  nodeId: string;
  client: AnyClient;
}

/** A rail card's registered reorder source (the header grip). */
export interface WorkspaceRailCardFacts {
  /** The grip's drag id — the `workspaceRailCardDraggableId` namespace. */
  draggableId: string;
  /** The card's node (the rail stack is keyed by it). */
  nodeId: string;
  /** The label source for the overlay chip. */
  client: AnyClient;
}

/** The edge of the target card a reorder lands on. */
export type RailReorderPosition = "before" | "after";

/** The drag-scoped UI state the frames read (header drop + transient expand + rail reorder). */
export interface WorkspaceDndDragUi {
  /** The header droppable id currently targeted, if any (block drags only). */
  headerDropId: string | null;
  /** Card node ids transiently expanded for the session (drag-scoped). */
  expandedNodeIds: ReadonlySet<string>;
  /** Rail reorder: the targeted card + edge while a card drag is live. */
  railReorder: { nodeId: string; position: RailReorderPosition } | null;
}

/** The host API surfaces register through (null without a host). */
export interface WorkspaceDndHostApi {
  registerZone: (facts: WorkspaceDndZoneFacts) => () => void;
  registerHeader: (facts: WorkspaceDndHeaderFacts) => () => void;
  registerRailCard: (facts: WorkspaceRailCardFacts) => () => void;
  dragUi: WorkspaceDndDragUi;
}

export const WorkspaceDndHostContext = createContext<WorkspaceDndHostApi | null>(null);

/** The droppable id a card frame's header registers under. */
export function workspaceCardHeaderDroppableId(nodeId: string): string {
  return `workspace-card-header:${nodeId}`;
}

/** The draggable id a rail card's grip registers under (its own namespace —
 *  never a block id, so the host can tell a card drag from a block drag). */
export function workspaceRailCardDraggableId(nodeId: string): string {
  return `workspace-rail-card:${nodeId}`;
}

interface DragSession {
  /** Rail sessions reorder the App's card stack; block sessions move blocks. */
  kind: "blocks" | "rail";
  /** The dragged block (the grip row); the first of `dragIds` in a stack drag. */
  activeId: string;
  /** The blocks the session moves — a lone block, or the selection stack. */
  dragIds: readonly string[];
  /** Per-zone valid-location sets; the merged projection rides alongside
   *  (empty for rail sessions — the block machinery stays out). */
  perZone: Map<string, readonly DropCandidate[]>;
  merged: readonly ZoneDropCandidate[];
}

/** Rebuild the session's merged projection from its per-zone sets. */
function rebuildMerged(session: DragSession): void {
  session.merged = mergeZoneCandidates(
    Array.from(session.perZone, ([zoneId, candidates]) => ({ zoneId, candidates })),
  );
}

/** Positions map used where a resolution path never reads positions
 *  (header drops always resolve cross-tree, straight from the client). */
const NO_POSITIONS: OutlinePositionMap = new Map();

/**
 * The rail reorder edge for a drag event: the pointer's half of the target
 * header's rect (above the midpoint → before, below → after). Keyboard
 * drags carry no pointer — they resolve below, the event-driven default in
 * the same spirit as the block keyboard line anchoring under the over row.
 * Pure — exported for the rail reorder tests.
 */
export function railReorderPositionOf(
  pointer: { x: number; y: number } | null,
  overRect: { top: number; height: number } | null,
): RailReorderPosition {
  if (pointer === null || overRect === null) return "after";
  return pointer.y < overRect.top + overRect.height / 2 ? "before" : "after";
}

export function useWorkspaceDnd(opts: {
  /**
   * The rail reorder report: the App owns the card stack and its
   * device-local persistence; the host only reports the gesture
   * { activeCard, targetCard, edge }.
   */
  onRailCardReorder?:
    | ((activeNodeId: string, targetNodeId: string, position: RailReorderPosition) => void)
    | undefined;
} = {}) {
  const onRailCardReorderRef = useRef(opts.onRailCardReorder);
  onRailCardReorderRef.current = opts.onRailCardReorder;
  const sensors = useBlockDndSensors();
  const [dropLine, setDropLine] = useState<DropLine | null>(null);
  const [dragging, setDragging] = useState<{ id: string; label: string } | null>(null);
  const [dragSources, setDragSources] = useState<ReadonlySet<string> | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [dragUi, setDragUi] = useState<WorkspaceDndDragUi>({
    headerDropId: null,
    expandedNodeIds: new Set(),
    railReorder: null,
  });
  const zonesRef = useRef(new Map<string, WorkspaceDndZoneFacts>());
  const headersRef = useRef(new Map<string, WorkspaceDndHeaderFacts>());
  const railCardsRef = useRef(new Map<string, WorkspaceRailCardFacts>());
  const sessionRef = useRef<DragSession | null>(null);
  // Drag edge auto-scroll: the last live pointer (null for keyboard drags),
  // the session's scrollable containers (collected at drag start), and the
  // rAF loop handle.
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const scrollContainersRef = useRef<readonly HTMLElement[]>([]);
  const edgeScrollRafRef = useRef<number | null>(null);
  // Scroll re-measure: the rAF coalescer for the capture-phase scroll listener.
  const remeasureRafRef = useRef<number | null>(null);

  useEffect(() => {
    if (moveError === null) return;
    const timer = setTimeout(() => setMoveError(null), 4000);
    return () => clearTimeout(timer);
  }, [moveError]);

  const edgeScrollTick = useCallback(() => {
    edgeScrollRafRef.current = null;
    const session = sessionRef.current;
    const pointer = pointerRef.current;
    if (session === null || pointer === null) return;
    for (const container of scrollContainersRef.current) {
      const rect = container.getBoundingClientRect();
      if (pointer.x < rect.left || pointer.x > rect.right) continue;
      const step = edgeScrollVelocity({
        pointerY: pointer.y,
        rectTop: rect.top,
        rectHeight: rect.height,
        canScrollUp: container.scrollTop > 0,
        canScrollDown: container.scrollTop + container.clientHeight < container.scrollHeight - 1,
      });
      if (step !== 0) {
        container.scrollTop += step;
        // The innermost container under the pointer scrolls — one scroller
        // per frame (nested scrollers would compound into a jump).
        break;
      }
    }
    edgeScrollRafRef.current = requestAnimationFrame(edgeScrollTick);
  }, []);

  const stopEdgeScroll = useCallback(() => {
    if (edgeScrollRafRef.current !== null) {
      cancelAnimationFrame(edgeScrollRafRef.current);
      edgeScrollRafRef.current = null;
    }
  }, []);

  const measureZone = useCallback(
    (facts: WorkspaceDndZoneFacts, activeId: string, dragIds: readonly string[] = [activeId]) => {
      const rows = measureDragRows(facts.rootRef.current);
      // The whole stack's roots are excluded — nothing may drop into a
      // dragged subtree (the lead's own subtree included via activeId).
      const extraExcluded = dragIds.length > 1 ? new Set(dragIds) : undefined;
      return dropCandidatesOf(facts.getPositions(), activeId, rows, extraExcluded);
    },
    [],
  );

  /**
   * Re-anchor the snap set after ANY scroll while a block drag is live (the
   * session's own edge auto-scroll, the wheel, a trackpad): the measured
   * anchors are viewport-fixed and go stale the moment content moves, and
   * rows revealed by the scroll become droppable only once measured. The
   * drop line re-projects at the last pointer so the indicator tracks
   * content moving under a stationary pointer. Coalesced to one re-measure
   * per animation frame.
   */
  const handleScrollCapture = useCallback(() => {
    const session = sessionRef.current;
    if (session === null || session.kind !== "blocks") return;
    if (remeasureRafRef.current !== null) return;
    remeasureRafRef.current = requestAnimationFrame(() => {
      remeasureRafRef.current = null;
      const live = sessionRef.current;
      if (live === null || live.kind !== "blocks") return;
      for (const [zoneId, facts] of zonesRef.current) {
        live.perZone.set(zoneId, measureZone(facts, live.activeId, live.dragIds));
      }
      rebuildMerged(live);
      const pointer = pointerRef.current;
      if (pointer !== null) {
        const candidate = nearestCandidate(pointer, live.merged);
        setDropLine(candidate === null ? null : { targetId: candidate.targetId, intent: candidate.intent });
      }
    });
  }, [measureZone]);

  useEffect(() => {
    window.addEventListener("scroll", handleScrollCapture, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", handleScrollCapture, { capture: true });
  }, [handleScrollCapture]);

  const registerZone = useCallback(
    (facts: WorkspaceDndZoneFacts) => {
      zonesRef.current.set(facts.id, facts);
      const session = sessionRef.current;
      if (session !== null) {
        // Mid-session registration (a collapsed card's body mounting on a
        // transient expand): measure the zone straight into the session.
        session.perZone.set(facts.id, measureZone(facts, session.activeId, session.dragIds));
        rebuildMerged(session);
      }
      return () => {
        zonesRef.current.delete(facts.id);
        const live = sessionRef.current;
        if (live !== null && live.perZone.delete(facts.id)) rebuildMerged(live);
      };
    },
    [measureZone],
  );

  const registerHeader = useCallback((facts: WorkspaceDndHeaderFacts) => {
    headersRef.current.set(facts.droppableId, facts);
    return () => {
      headersRef.current.delete(facts.droppableId);
    };
  }, []);

  const registerRailCard = useCallback((facts: WorkspaceRailCardFacts) => {
    railCardsRef.current.set(facts.draggableId, facts);
    return () => {
      railCardsRef.current.delete(facts.draggableId);
    };
  }, []);

  /** The zone whose positions own the id (the dragged row's home zone
   *  first — the event-driven keyboard line reads the ACTIVE row's
   *  previous sibling; then the zone under the pointer). */
  const zoneFor = useCallback((activeId: string, overId: string | null) => {
    for (const facts of zonesRef.current.values()) {
      if (facts.getPositions().has(activeId)) return facts;
    }
    if (overId !== null) {
      for (const facts of zonesRef.current.values()) {
        if (facts.getPositions().has(overId)) return facts;
      }
    }
    return zonesRef.current.values().next().value as WorkspaceDndZoneFacts | undefined;
  }, []);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const id = String(event.active.id);
    const railCard = railCardsRef.current.get(id);
    setMoveError(null);
    // Session-owned edge auto-scroll: the live pointer rides pointerRef, the
    // scrollable containers are collected from every zone, and the rAF loop
    // starts (it no-ops until the pointer nears an edge).
    pointerRef.current = dragPointerOf({ delta: { x: 0, y: 0 }, activatorEvent: event.activatorEvent });
    const containers: HTMLElement[] = [];
    const seenContainers = new Set<HTMLElement>();
    for (const facts of zonesRef.current.values()) {
      for (const el of scrollContainersOf(facts.rootRef.current)) {
        if (!seenContainers.has(el)) {
          seenContainers.add(el);
          containers.push(el);
        }
      }
    }
    scrollContainersRef.current = containers;
    if (edgeScrollRafRef.current === null && containers.length > 0) {
      edgeScrollRafRef.current = requestAnimationFrame(edgeScrollTick);
    }
    if (railCard !== undefined) {
      // A rail-card reorder drag: the block machinery stays out — no zone
      // measuring, no drop line, no transient expands. The feedback is the
      // overlay chip + the target header's reorder edge.
      setDragging({
        id,
        label: displayNameFromClient(railCard.client, railCard.nodeId) ?? railCard.nodeId,
      });
      setDragSources(null);
      setDragUi({ headerDropId: null, expandedNodeIds: new Set(), railReorder: null });
      sessionRef.current = { kind: "rail", activeId: id, dragIds: [id], perZone: new Map(), merged: [] };
      return;
    }
    const home = zoneFor(id, id);
    const client = home?.client;
    // The selection stack: a grip drag on a SELECTED row (with more than one
    // root selected) promotes the session to the whole stack — only the
    // top-level roots move, internal structure preserved.
    const homePositions = home?.getPositions() ?? NO_POSITIONS;
    const selection = home?.getSelection?.() ?? null;
    const dragIds =
      selection !== null && selection.size > 1 && selection.has(id)
        ? effectiveDragIds(selection, homePositions)
        : [id];
    const leadId = dragIds[0] ?? id;
    setDragging({
      id,
      label:
        dragIds.length > 1
          ? `${dragIds.length} blocks`
          : ((client === undefined ? null : displayNameFromClient(client, id)) ?? id),
    });
    setDragSources(new Set(dragIds));
    setDragUi({ headerDropId: null, expandedNodeIds: new Set(), railReorder: null });
    const perZone = new Map<string, readonly DropCandidate[]>();
    for (const [zoneId, facts] of zonesRef.current) {
      perZone.set(zoneId, measureZone(facts, leadId, dragIds));
    }
    const session: DragSession = { kind: "blocks", activeId: leadId, dragIds, perZone, merged: [] };
    rebuildMerged(session);
    sessionRef.current = session;
  }, [edgeScrollTick, measureZone, zoneFor]);

  const handleDragMove = useCallback(
    (event: DragMoveEvent) => {
      // The edge-scroll loop reads the live pointer between pointer events.
      const livePointer = dragPointerOf(event);
      if (livePointer !== null) pointerRef.current = livePointer;
      const railSession = sessionRef.current;
      if (railSession?.kind === "rail") {
        // Rail reorder: only another card's header is a target (block-row
        // droppables under the pointer are ignored); the dragged card's own
        // header is not.
        const railCard = railCardsRef.current.get(railSession.activeId);
        const overId = event.over === null ? null : String(event.over.id);
        const header = overId === null ? undefined : headersRef.current.get(overId);
        const target =
          header !== undefined && railCard !== undefined && header.nodeId !== railCard.nodeId
            ? header
            : undefined;
        const position =
          target === undefined
            ? "after"
            : railReorderPositionOf(dragPointerOf(event), event.over?.rect ?? null);
        setDragUi((prev) => {
          const current = prev.railReorder;
          if (
            (target === undefined && current === null) ||
            (target !== undefined &&
              current !== null &&
              current.nodeId === target.nodeId &&
              current.position === position)
          ) {
            return prev;
          }
          return {
            ...prev,
            railReorder: target === undefined ? null : { nodeId: target.nodeId, position },
          };
        });
        return;
      }
      const overId = event.over === null ? null : String(event.over.id);
      const header = overId === null ? undefined : headersRef.current.get(overId);
      if (header !== undefined) {
        // Header drop ≡ a child drop on the card node: the end-of-list line.
        const line: DropLine = { targetId: header.nodeId, intent: "child" };
        setDropLine(line);
        setDragUi((prev) =>
          prev.headerDropId === overId && prev.expandedNodeIds.has(header.nodeId)
            ? prev
            : {
                headerDropId: overId,
                expandedNodeIds: new Set(prev.expandedNodeIds).add(header.nodeId),
                railReorder: null,
              },
        );
        return;
      }
      setDragUi((prev) => (prev.headerDropId === null ? prev : { ...prev, headerDropId: null }));
      const session = sessionRef.current;
      const pointer = dragPointerOf(event);
      if (session === null || pointer === null) {
        // Keyboard drags (no pointer) keep the event-driven indicator.
        const home = zoneFor(String(event.active.id), overId);
        setDropLine(dropLineFromDragEvent(event, home === undefined ? NO_POSITIONS : home.getPositions()));
        return;
      }
      const candidate = nearestCandidate(pointer, session.merged);
      setDropLine(candidate === null ? null : { targetId: candidate.targetId, intent: candidate.intent });
    },
    [zoneFor],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const activeId = String(event.active.id);
      const session = sessionRef.current;
      sessionRef.current = null;
      setDropLine(null);
      setDragging(null);
      setDragSources(null);
      // The edge-scroll loop and its pointer end with the session.
      pointerRef.current = null;
      scrollContainersRef.current = [];
      stopEdgeScroll();
      // Drag-scoped UI releases: header drops, transient expansions, and
      // the rail reorder edge all end with the session.
      setDragUi({ headerDropId: null, expandedNodeIds: new Set(), railReorder: null });
      if (session?.kind === "rail") {
        // The report seam: the App owns the stack + its persistence; a
        // self-drop (or a drop on nothing) reports nothing.
        const railCard = railCardsRef.current.get(activeId);
        const overId = event.over === null ? null : String(event.over.id);
        const header = overId === null ? undefined : headersRef.current.get(overId);
        if (railCard === undefined || header === undefined || header.nodeId === railCard.nodeId) {
          return;
        }
        onRailCardReorderRef.current?.(
          railCard.nodeId,
          header.nodeId,
          railReorderPositionOf(dragPointerOf(event), event.over?.rect ?? null),
        );
        return;
      }
      const dragIds = session?.dragIds ?? [activeId];
      const pointer = dragPointerOf(event);
      const overId = event.over === null ? null : String(event.over.id);
      const header = overId === null ? undefined : headersRef.current.get(overId);
      let line: DropLine | null = null;
      let zone: WorkspaceDndZoneFacts | undefined;
      if (header !== undefined) {
        line = { targetId: header.nodeId, intent: "child" };
      } else {
        const snapped =
          session !== null && pointer !== null ? nearestCandidate(pointer, session.merged) : null;
        if (snapped !== null) {
          line = { targetId: snapped.targetId, intent: snapped.intent };
          zone = zonesRef.current.get(snapped.zoneId);
        } else {
          // Nothing near → the event-driven line still resolves the drop so
          // guard refusals surface their banner exactly as before.
          zone = zoneFor(activeId, overId);
          line = dropLineFromDragEvent(event, zone === undefined ? NO_POSITIONS : zone.getPositions());
        }
      }
      if (line === null) return;
      void (async () => {
        try {
          if (header !== undefined) {
            // Header path: one code path with a child drop on the card node,
            // resolved straight from the header's client. A stack drops its
            // roots as the card's children in stack order.
            if (dragIds.length > 1) {
              const plan = planStackMove(dragIds, line, siblingFactsFromClient(header.client));
              if (plan.status === "noop") return;
              if (plan.status === "refused") {
                setMoveError(plan.reason);
                return;
              }
              await executeStackZoneMove({ line, plan, client: header.client });
              return;
            }
            const resolution = resolveMoveFromClient({ activeId, line, client: header.client });
            if (resolution.status === "noop") return;
            if (resolution.status === "refused") {
              setMoveError(resolution.reason);
              return;
            }
            await executeZoneMove({
              activeId,
              line,
              command: resolution.command,
              crossTree: true,
              positions: NO_POSITIONS,
              client: header.client,
            });
            return;
          }
          if (zone === undefined) return;
          const positions = zone.getPositions();
          if (dragIds.length > 1) {
            // Selection-stack drop: plan over the zone's sibling facts; when
            // one end lives outside the zone's own tree (a linked reference /
            // embed target, a block dragged in from ANOTHER surface), re-plan
            // straight from the client — cross-zone stack drops are always
            // moves, never copy/link.
            let plan: StackPlan = planStackMove(dragIds, line, siblingFactsFromPositions(positions));
            if (plan.status === "noop" && positions.get(line.targetId) === undefined) {
              plan = planStackMove(dragIds, line, siblingFactsFromClient(zone.client));
            }
            if (plan.status === "noop") return;
            if (plan.status === "refused") {
              setMoveError(plan.reason);
              return;
            }
            await executeStackZoneMove({ line, plan, client: zone.client });
            return;
          }
          let resolution = resolveMove({ activeId, line, positions });
          let crossTree = false;
          if (
            resolution.status === "noop" &&
            (positions.get(line.targetId) === undefined || positions.get(activeId) === undefined)
          ) {
            // One end of the drop lives outside the zone's own tree — a
            // linked reference / embed / a main-children section row as the
            // target, or a block dragged in from ANOTHER surface (cross-zone
            // drops are always moves): resolve straight from the client.
            resolution = resolveMoveFromClient({ activeId, line, client: zone.client });
            crossTree = resolution.status === "move";
          }
          if (resolution.status === "noop") return;
          if (resolution.status === "refused") {
            setMoveError(resolution.reason);
            return;
          }
          await executeZoneMove({
            activeId,
            line,
            command: resolution.command,
            crossTree,
            positions,
            client: zone.client,
          });
        } catch (err) {
          setMoveError(moveErrorMessage(err));
        }
      })();
    },
    [stopEdgeScroll, zoneFor],
  );

  const handleDragCancel = useCallback(() => {
    sessionRef.current = null;
    setDropLine(null);
    setDragging(null);
    setDragSources(null);
    pointerRef.current = null;
    scrollContainersRef.current = [];
    stopEdgeScroll();
    setDragUi({ headerDropId: null, expandedNodeIds: new Set(), railReorder: null });
  }, [stopEdgeScroll]);

  const hostApi = useMemo<WorkspaceDndHostApi>(
    () => ({ registerZone, registerHeader, registerRailCard, dragUi }),
    [registerZone, registerHeader, registerRailCard, dragUi],
  );

  /**
   * The live indicator geometry for the portaled drop line (owner: the
   * floating chip covered the class-based line's start — the indentation
   * cue). The snapped candidate's anchor IS the line's start: sibling lines
   * begin at the row's left edge, the child line at the child offset. The
   * row-level ::before/::after lines stay as the no-host/no-candidate
   * fallback; this portal repaints the same line (plus its start tick)
   * above the DragOverlay at --z-node-overlay. Anchors re-measure on scroll,
   * and the drop line re-projects right after, so a render keyed on dropLine
   * always reads fresh geometry.
   */
  const dropAnchor = useMemo(() => {
    if (dropLine === null) return null;
    const session = sessionRef.current;
    if (session === null || session.kind !== "blocks") return null;
    const candidate = session.merged.find(
      (c) => c.targetId === dropLine.targetId && c.intent === dropLine.intent,
    );
    if (candidate === undefined) return null;
    return {
      x: candidate.anchorX,
      y: candidate.anchorY,
      right: candidate.rowRight,
    };
  }, [dropLine]);

  return {
    sensors,
    dropLine,
    dropAnchor,
    dragging,
    dragSources,
    moveError,
    hostApi,
    handleDragStart,
    handleDragMove,
    handleDragEnd,
    handleDragCancel,
  };
}

/**
 * The single workspace drag session: ONE DndContext for the main content,
 * the right rail, and the floating editor windows; the DropLineContext the
 * block rows read; the overlay chip; the transient move-error banner.
 */
export function WorkspaceDndHost({
  children,
  onRailCardReorder,
}: {
  children: ReactNode;
  /**
   * The rail reorder report — the App owns the card stack (session state +
   * device-local persistence); the host reports the gesture.
   */
  onRailCardReorder?:
    | ((activeNodeId: string, targetNodeId: string, position: RailReorderPosition) => void)
    | undefined;
}) {
  const dnd = useWorkspaceDnd({ onRailCardReorder });
  return (
    <WorkspaceDndHostContext.Provider value={dnd.hostApi}>
      <DndContext
        sensors={dnd.sensors}
        collisionDetection={blockCollisionDetection}
        onDragStart={dnd.handleDragStart}
        onDragMove={dnd.handleDragMove}
        onDragEnd={dnd.handleDragEnd}
        onDragCancel={dnd.handleDragCancel}
        // The host owns edge auto-scroll (the rAF loop + the snap-set
        // re-anchor on scroll): dnd-kit's built-in would double-scroll and
        // move content without re-measuring the anchors.
        autoScroll={false}
      >
        <DropLineContext.Provider value={dnd.dropLine}>
          <DragSourcesContext.Provider value={dnd.dragSources}>
            {dnd.moveError !== null && (
              <div role="alert" className="nt-dnd-error">
                {dnd.moveError}
              </div>
            )}
            {children}
            <DragOverlay dropAnimation={null}>
              {dnd.dragging !== null && <div className="nt-drag-ghost">{dnd.dragging.label}</div>}
            </DragOverlay>
            {dnd.dropAnchor !== null &&
              typeof document !== "undefined" &&
              createPortal(
                <div
                  className="nt-drop-indicator"
                  style={{
                    left: dnd.dropAnchor.x,
                    top: dnd.dropAnchor.y - 1,
                    width: Math.max(0, dnd.dropAnchor.right - dnd.dropAnchor.x),
                  }}
                />,
                document.body,
              )}
          </DragSourcesContext.Provider>
        </DropLineContext.Provider>
      </DndContext>
    </WorkspaceDndHostContext.Provider>
  );
}

/**
 * An editing surface joins the workspace session as a zone: registers its
 * drag facts with the host (no-op without one) and re-registers only when
 * the facts' identity inputs change — the getters keep positions/client live
 * between renders.
 */
export function useWorkspaceDndZone(facts: WorkspaceDndZoneFacts): void {
  const host = useContext(WorkspaceDndHostContext);
  const factsRef = useRef(facts);
  factsRef.current = facts;
  useEffect(() => {
    if (host === null) return;
    return host.registerZone(factsRef.current);
    // The facts object is rebuilt per render; registration is keyed on the
    // stable zone id (the host reads the getters live).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, facts.id]);
}

/**
 * A card frame's header joins the session as a droppable: registers the
 * header facts with the host (no-op without one) and returns the ref
 * callback to attach to the header element (inert without a host).
 */
export function useWorkspaceDndHeader(
  facts: WorkspaceDndHeaderFacts,
): (element: HTMLElement | null) => void {
  const host = useContext(WorkspaceDndHostContext);
  const { setNodeRef } = useDroppable({ id: facts.droppableId, disabled: host === null });
  const factsRef = useRef(facts);
  factsRef.current = facts;
  useEffect(() => {
    if (host === null) return;
    return host.registerHeader(factsRef.current);
    // The facts object is rebuilt per render; registration is keyed on the
    // stable droppable id (the host reads the client live).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, facts.droppableId]);
  return setNodeRef;
}

/**
 * A rail card's GRIP joins the session as a reorder source: registers the
 * card with the host (no-op without one) and returns the draggable's ref
 * callback + activator props for the grip element (inert without a host).
 */
export function useWorkspaceDndRailCard(facts: WorkspaceRailCardFacts): {
  setGripRef: (element: HTMLElement | null) => void;
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
  isDragging: boolean;
} {
  const host = useContext(WorkspaceDndHostContext);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: facts.draggableId,
    disabled: host === null,
  });
  const factsRef = useRef(facts);
  factsRef.current = facts;
  useEffect(() => {
    if (host === null) return;
    return host.registerRailCard(factsRef.current);
    // The facts object is rebuilt per render; registration is keyed on the
    // stable draggable id (the host reads the client live).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, facts.draggableId]);
  return { setGripRef: setNodeRef, attributes, listeners, isDragging };
}
