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

import { DndContext, DragOverlay, useDraggable, useDroppable, type DragEndEvent, type DragMoveEvent, type DragStartEvent, type DraggableAttributes, type DraggableSyntheticListeners } from "@dnd-kit/core";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";
import type { OutlinePositionMap } from "@/editor/outline.js";

import { displayNameFromClient } from "./dateDisplay.js";
import {
  DropLineContext,
  blockCollisionDetection,
  dragPointerOf,
  dropCandidatesOf,
  dropLineFromDragEvent,
  executeZoneMove,
  measureDragRows,
  mergeZoneCandidates,
  moveErrorMessage,
  nearestCandidate,
  resolveMove,
  resolveMoveFromClient,
  useBlockDndSensors,
  type DropCandidate,
  type DropLine,
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
  activeId: string;
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

  useEffect(() => {
    if (moveError === null) return;
    const timer = setTimeout(() => setMoveError(null), 4000);
    return () => clearTimeout(timer);
  }, [moveError]);

  const measureZone = useCallback((facts: WorkspaceDndZoneFacts, activeId: string) => {
    const rows = measureDragRows(facts.rootRef.current);
    return dropCandidatesOf(facts.getPositions(), activeId, rows);
  }, []);

  const registerZone = useCallback(
    (facts: WorkspaceDndZoneFacts) => {
      zonesRef.current.set(facts.id, facts);
      const session = sessionRef.current;
      if (session !== null) {
        // Mid-session registration (a collapsed card's body mounting on a
        // transient expand): measure the zone straight into the session.
        session.perZone.set(facts.id, measureZone(facts, session.activeId));
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
    if (railCard !== undefined) {
      // A rail-card reorder drag: the block machinery stays out — no zone
      // measuring, no drop line, no transient expands. The feedback is the
      // overlay chip + the target header's reorder edge.
      setDragging({
        id,
        label: displayNameFromClient(railCard.client, railCard.nodeId) ?? railCard.nodeId,
      });
      setDragUi({ headerDropId: null, expandedNodeIds: new Set(), railReorder: null });
      sessionRef.current = { kind: "rail", activeId: id, perZone: new Map(), merged: [] };
      return;
    }
    const home = zoneFor(id, id);
    const client = home?.client;
    setDragging({ id, label: (client === undefined ? null : displayNameFromClient(client, id)) ?? id });
    setDragUi({ headerDropId: null, expandedNodeIds: new Set(), railReorder: null });
    const perZone = new Map<string, readonly DropCandidate[]>();
    for (const [zoneId, facts] of zonesRef.current) {
      perZone.set(zoneId, measureZone(facts, id));
    }
    const session: DragSession = { kind: "blocks", activeId: id, perZone, merged: [] };
    rebuildMerged(session);
    sessionRef.current = session;
  }, [measureZone, zoneFor]);

  const handleDragMove = useCallback(
    (event: DragMoveEvent) => {
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
            // resolved straight from the header's client.
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
    [zoneFor],
  );

  const handleDragCancel = useCallback(() => {
    sessionRef.current = null;
    setDropLine(null);
    setDragging(null);
    setDragUi({ headerDropId: null, expandedNodeIds: new Set(), railReorder: null });
  }, []);

  const hostApi = useMemo<WorkspaceDndHostApi>(
    () => ({ registerZone, registerHeader, registerRailCard, dragUi }),
    [registerZone, registerHeader, registerRailCard, dragUi],
  );

  return {
    sensors,
    dropLine,
    dragging,
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
      >
        <DropLineContext.Provider value={dnd.dropLine}>
          {dnd.moveError !== null && (
            <div role="alert" className="nt-dnd-error">
              {dnd.moveError}
            </div>
          )}
          {children}
          <DragOverlay dropAnimation={null}>
            {dnd.dragging !== null && <div className="nt-drag-ghost">{dnd.dragging.label}</div>}
          </DragOverlay>
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
