/**
 * WhiteboardCanvas — the spatial view of a whiteboard node's subtree
 * (SCHEMA.md "Whiteboard modeling": cards are child blocks, the whiteboard is
 * a spatial view of its subtree; shapes/strokes are layout-token-only
 * geometry). Renders cards (child blocks positioned by the geometry keyed to
 * their node ids in the whiteboard token's `layout`), SVG shapes
 * (rect/ellipse/arrow with an optional chrome label) and freehand strokes.
 *
 * Two mount modes, one component:
 * - fullscreen (embedded=false): the page IS the whiteboard (PageView renders
 *   this in place of the outline tree). Wheel zooms (cursor-anchored),
 *   background drag pans.
 * - embedded (embedded=true): the whiteboard is a block child of another
 *   block's content (BlockRow injects this via InlineTokens' renderWhiteboard
 *   callback). Height is capped (scroll priority for the surrounding page:
 *   pan and wheel-zoom are disabled; cards/shapes stay editable).
 *
 * Writes: every gesture (card drag end, stroke end, shape add/delete, label
 * commit, card create/delete) produces exactly ONE `object.update` of the
 * host's content AST with the token's layout replaced — drags mutate local
 * view state per pointermove and coalesce to a single op at gesture end, no
 * per-mousemove op spam (SCHEMA.md). The write re-reads the host's current
 * AST so it never clobbers interleaved content edits.
 *
 * Card text editing: click a card body to swap the read-only InlineTokens
 * projection for a slim contentEditable that saves through the same
 * structural path as the outliner editor (applyTextEdit + withCandidateSpans,
 * debounced, skip-when-unchanged). BlockTextEditor itself is NOT reused: its
 * keyboard contract (Enter→outline sibling, Tab→indent, Backspace-delete with
 * caret hand-off through the outline position map) is built for the sibling
 * tree and has no meaning on a spatial canvas — the machinery that matters
 * for content correctness (the structural edit apply) is shared.
 *
 * Live updates ride the standard notify subscription (same pattern as
 * EmbedView): a change from any source re-renders the canvas.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import type { ContentAst } from "@notees/protocol";
import { uuidv7 } from "uuidv7";

import { applyTextEdit } from "@/editor/edit-apply.js";
import { withCandidateSpans } from "@/editor/capture.js";
import { proseFromAst } from "@/editor/prose.js";
import type {
  ClientNode,
  CreateObjectInput,
  DeleteObjectOptions,
  UpdateObjectInput,
} from "@/core/workspace-client.js";

import { displayNameFromClient } from "./dateDisplay.js";
import { InlineTokens } from "./InlineTokens.js";
import { SAVE_DEBOUNCE_MS } from "./BlockTextEditor.js";
import {
  layoutFromContentAst,
  parseWhiteboardLayout,
  withWhiteboardLayout,
  type CardGeometry,
  type WhiteboardLayout,
} from "./whiteboard-layout.js";

// Re-exported so the typed schema lives at the component surface too (the
// layout module is the pure, React-free half of the component).
export {
  parseWhiteboardLayout,
  serializeWhiteboardLayout,
  layoutFromContentAst,
  withWhiteboardLayout,
} from "./whiteboard-layout.js";
export type { CardGeometry, WhiteboardLayout, WhiteboardShape, WhiteboardStroke } from "./whiteboard-layout.js";

/** The client surface the canvas needs (satisfied by WorkspaceClient and the WorkerClient proxy). */
export interface WhiteboardClient {
  getNode(id: string): ClientNode | undefined;
  /** Direct children in child order (card candidates; node_type filter applied here). */
  getChildren(id: string): ClientNode[];
  getDisplayName(id: string): string | null;
  subscribe(listener: () => void): () => void;
  createObject(partial: CreateObjectInput): Promise<string>;
  updateObject(id: string, fields: UpdateObjectInput): Promise<void>;
  deleteObject(id: string, opts?: DeleteObjectOptions): Promise<void>;
}

/** Default cap for the embedded mini-canvas (scroll priority for the page). */
export const EMBEDDED_HEIGHT_PX = 320;

/** New-card size, world units. */
export const CARD_DEFAULT_W = 240;
export const CARD_DEFAULT_H = 120;

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

interface Viewport {
  x: number;
  y: number;
  k: number;
}

type DragState =
  | { mode: "pan"; startClientX: number; startClientY: number; startVp: Viewport }
  | { mode: "card"; cardId: string; startWorldX: number; startWorldY: number; origin: CardGeometry; latest: WhiteboardLayout }
  | { mode: "stroke"; strokeId: string; points: number[] };

/** Deterministic cascade slot for child blocks that have no geometry yet. */
function autoSlot(index: number): CardGeometry {
  const offset = 48 + (index % 8) * 40;
  return { x: offset, y: offset, w: CARD_DEFAULT_W, h: CARD_DEFAULT_H };
}

/** Slim inline card editor — see the module docstring for why not BlockTextEditor. */
function CardTextEditor({
  node,
  client,
  onExit,
}: {
  node: ClientNode;
  client: WhiteboardClient;
  onExit: () => void;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef(proseFromAst(node.contentAst));
  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nodeRef = useRef(node);
  nodeRef.current = node;

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    const el = editorRef.current;
    const draft = el?.textContent ?? draftRef.current;
    draftRef.current = draft;
    const current = nodeRef.current.contentAst;
    // Prose unchanged: leave rich tokens (mentions/chips/marks) untouched.
    if (draft === proseFromAst(current)) return;
    const next = withCandidateSpans(applyTextEdit(current, draft));
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    void client.updateObject(nodeRef.current.id, { contentAst: next });
  }, [client]);

  useEffect(() => {
    const el = editorRef.current;
    // Hydrate the DOM from the draft and land the caret at the end: React
    // never re-renders this div's children (it stays a flat text run), so
    // the draft survives the client's notify-driven re-renders untouched.
    if (el !== undefined && el !== null) {
      el.textContent = draftRef.current;
      el.focus();
      try {
        const selection = window.getSelection();
        if (selection !== null) {
          const range = document.createRange();
          range.selectNodeContents(el);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      } catch {
        // jsdom: focus alone is enough.
      }
    }
    return () => {
      // Flush a dirty draft if the editor unmounts without a blur (e.g. the
      // card was deleted mid-edit); a client torn down before the unmount
      // (test teardown order) simply loses the draft.
      try {
        flush();
      } catch {
        // client already closed
      }
    };
  }, [flush]);

  return (
    <div
      ref={editorRef}
      className="nt-wb-card-editor"
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-label="Card text"
      onInput={() => {
        dirtyRef.current = true;
        draftRef.current = editorRef.current?.textContent ?? "";
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => flush(), SAVE_DEBOUNCE_MS);
      }}
      onBlur={() => {
        flush();
        onExit();
      }}
    />
  );
}

export function WhiteboardCanvas({
  client,
  hostId,
  tokenIndex,
  embedded = false,
  height = EMBEDDED_HEIGHT_PX,
}: {
  client: WhiteboardClient;
  /** The node whose content AST carries the whiteboard token. */
  hostId: string;
  /** Index of the whiteboard token in the host's content AST. */
  tokenIndex: number;
  /** Embedded mini-canvas (block child): capped height, no pan/zoom. */
  embedded?: boolean;
  /** Embedded height cap in px (ignored fullscreen). */
  height?: number;
}) {
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  const surfaceRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, k: 1 });
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  const [view, setView] = useState<WhiteboardLayout>(() => {
    const host = client.getNode(hostId);
    return host ? layoutFromContentAst(host.contentAst, tokenIndex) : { cards: {}, shapes: [], strokes: [] };
  });
  const viewRef = useRef(view);
  viewRef.current = view;

  const dragRef = useRef<DragState | null>(null);
  const [drawing, setDrawing] = useState<number[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawMode, setDrawMode] = useState(false);
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [labelEdit, setLabelEdit] = useState<{ id: string; text: string } | null>(null);

  const host = client.getNode(hostId);
  // The token's raw layout field, keyed by its JSON identity: the sync effect
  // below must re-run only when the STORED layout actually changes (every
  // render re-parses content into fresh objects, so identity deps would loop).
  const storedLayoutJson = (() => {
    if (host === undefined) return null;
    const token = host.contentAst[tokenIndex];
    if (typeof token !== "object" || token === null) return null;
    const raw = (token as { layout?: unknown }).layout;
    return JSON.stringify(raw ?? null);
  })();

  // Remote/other-source layout changes re-project unless a local gesture is
  // in flight (its commit lands at gesture end, one op). The equality guard
  // returns the previous state object when nothing changed, so the effect
  // never re-renders in a loop.
  useEffect(() => {
    if (storedLayoutJson === null || dragRef.current !== null) return;
    const parsed = parseWhiteboardLayout(JSON.parse(storedLayoutJson));
    setView((prev) => (JSON.stringify(prev) === storedLayoutJson ? prev : parsed));
  }, [storedLayoutJson]);

  /** One coalesced write: replace the token's layout in the host's CURRENT AST. */
  const commitLayout = useCallback(
    (layout: WhiteboardLayout) => {
      setView(layout);
      const current = client.getNode(hostId);
      if (!current) return;
      void client.updateObject(hostId, {
        contentAst: withWhiteboardLayout(current.contentAst, tokenIndex, layout) as ContentAst,
      });
    },
    [client, hostId, tokenIndex],
  );

  /** Screen (client) coords → world coords under the current viewport. */
  const toWorld = useCallback((clientX: number, clientY: number) => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    const vp = viewportRef.current;
    const sx = clientX - (rect?.left ?? 0);
    const sy = clientY - (rect?.top ?? 0);
    return { x: (sx - vp.x) / vp.k, y: (sy - vp.y) / vp.k };
  }, []);

  const capturePointer = (el: HTMLElement, event: ReactPointerEvent) => {
    // jsdom has no PointerEvent capture — guarded, browsers always have it.
    try {
      el.setPointerCapture?.(event.pointerId);
    } catch {
      // not capturable in this environment
    }
  };

  // Wheel zoom (fullscreen only; the embedded canvas leaves scroll to the page).
  useEffect(() => {
    const el = surfaceRef.current;
    if (embedded || el === null || el === undefined) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      setViewport((vp) => {
        const nextK = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, vp.k * Math.exp(-event.deltaY * 0.0015)));
        const scale = nextK / vp.k;
        return { k: nextK, x: mx - (mx - vp.x) * scale, y: my - (my - vp.y) * scale };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [embedded]);

  // --- gesture handlers ------------------------------------------------------

  const onSurfacePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const el = surfaceRef.current;
    if (drawMode) {
      // Stroke drawing starts on the background (cards stay draggable).
      const world = toWorld(event.clientX, event.clientY);
      const points = [world.x, world.y];
      dragRef.current = { mode: "stroke", strokeId: uuidv7(), points };
      setDrawing(points);
      if (el) capturePointer(el, event);
      return;
    }
    if (!embedded) {
      const vp = viewportRef.current;
      dragRef.current = {
        mode: "pan",
        startClientX: event.clientX,
        startClientY: event.clientY,
        startVp: vp,
      };
      if (el) capturePointer(el, event);
    }
    setSelectedId(null);
  };

  const onSurfacePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null) return;
    if (drag.mode === "pan") {
      setViewport({
        ...drag.startVp,
        x: drag.startVp.x + (event.clientX - drag.startClientX),
        y: drag.startVp.y + (event.clientY - drag.startClientY),
      });
      return;
    }
    if (drag.mode === "card") {
      const world = toWorld(event.clientX, event.clientY);
      const dx = world.x - drag.startWorldX;
      const dy = world.y - drag.startWorldY;
      const geometry: CardGeometry = {
        x: drag.origin.x + dx,
        y: drag.origin.y + dy,
        w: drag.origin.w,
        h: drag.origin.h,
      };
      const latest: WhiteboardLayout = {
        ...viewRef.current,
        cards: { ...viewRef.current.cards, [drag.cardId]: geometry },
      };
      drag.latest = latest;
      setView(latest);
      return;
    }
    // stroke: append the world point (view state, committed on pointer-up).
    const world = toWorld(event.clientX, event.clientY);
    drag.points = [...drag.points, world.x, world.y];
    setDrawing(drag.points);
  };

  const onSurfacePointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag === null) return;
    if (drag.mode === "card") {
      commitLayout(drag.latest);
      return;
    }
    if (drag.mode === "stroke") {
      setDrawing(null);
      if (drag.points.length >= 4) {
        commitLayout({
          ...viewRef.current,
          strokes: [...viewRef.current.strokes, { id: drag.strokeId, points: drag.points }],
        });
      }
      setDrawMode(false);
    }
  };

  // Card drag starts from the title bar (the body click enters text editing).
  const onCardPointerDown = (event: ReactPointerEvent<HTMLDivElement>, cardId: string, geometry: CardGeometry) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    setEditingCardId(null);
    const world = toWorld(event.clientX, event.clientY);
    dragRef.current = {
      mode: "card",
      cardId,
      startWorldX: world.x,
      startWorldY: world.y,
      origin: geometry,
      latest: viewRef.current,
    };
    capturePointer(event.currentTarget, event);
  };

  const createCardAt = async (world: { x: number; y: number }) => {
    const id = await client.createObject({ nodeType: "block", parentId: hostId, contentAst: [] });
    commitLayout({
      ...viewRef.current,
      cards: {
        ...viewRef.current.cards,
        [id]: { x: world.x - CARD_DEFAULT_W / 2, y: world.y - CARD_DEFAULT_H / 2, w: CARD_DEFAULT_W, h: CARD_DEFAULT_H },
      },
    });
    setEditingCardId(id);
  };

  const deleteCard = (cardId: string) => {
    const cards = { ...viewRef.current.cards };
    delete cards[cardId];
    commitLayout({ ...viewRef.current, cards });
    if (editingCardId === cardId) setEditingCardId(null);
    void client.deleteObject(cardId);
  };

  const addShape = (kind: "rect" | "ellipse" | "arrow") => {
    const vp = viewportRef.current;
    const rect = surfaceRef.current?.getBoundingClientRect();
    const originX = -(vp.x / vp.k) + (rect?.width ?? 0) / (2 * vp.k);
    const originY = -(vp.y / vp.k) + (rect?.height ?? 0) / (2 * vp.k);
    // Cascade so consecutive additions do not stack exactly.
    const n = viewRef.current.shapes.length + viewRef.current.strokes.length;
    const offset = 40 + (n % 8) * 24;
    const shape =
      kind === "arrow"
        ? { id: uuidv7(), kind, x: originX + offset - 70, y: originY + offset, w: 140, h: 0 }
        : { id: uuidv7(), kind, x: originX + offset - 80, y: originY + offset - 50, w: 160, h: 100 };
    commitLayout({ ...viewRef.current, shapes: [...viewRef.current.shapes, shape] });
    setSelectedId(shape.id);
  };

  const deleteSelected = () => {
    if (selectedId === null) return;
    const current = viewRef.current;
    const shapes = current.shapes.filter((s) => s.id !== selectedId);
    const strokes = current.strokes.filter((s) => s.id !== selectedId);
    if (shapes.length === current.shapes.length && strokes.length === current.strokes.length) return;
    commitLayout({ ...current, shapes, strokes });
    setSelectedId(null);
  };

  const commitLabel = (text: string) => {
    if (labelEdit === null) return;
    const { id } = labelEdit;
    setLabelEdit(null);
    const current = viewRef.current;
    const shapes = current.shapes.map((s) => {
      if (s.id !== id) return s;
      const trimmed = text.trim();
      const next = { ...s };
      if (trimmed === "") delete next.label;
      else next.label = trimmed;
      return next;
    });
    commitLayout({ ...current, shapes });
  };

  // --- derived render data -----------------------------------------------------

  // Cards are the host's child BLOCKS (SCHEMA.md projection rules as
  // implemented by the M1 client: child pages render in their own section,
  // not on the canvas).
  const cards = host
    ? client.getChildren(hostId).filter((child) => child.nodeType === "block")
    : [];

  if (host === undefined || storedLayoutJson === null) {
    return <div className="nt-wb-missing">Whiteboard unavailable.</div>;
  }

  const centerWorld = (): { x: number; y: number } => {
    const vp = viewportRef.current;
    const rect = surfaceRef.current?.getBoundingClientRect();
    return {
      x: -(vp.x / vp.k) + (rect?.width ?? 0) / (2 * vp.k),
      y: -(vp.y / vp.k) + (rect?.height ?? 0) / (2 * vp.k),
    };
  };

  const hasContent =
    cards.length > 0 || view.shapes.length > 0 || view.strokes.length > 0 || drawing !== null;
  const resolveName = (id: string) => displayNameFromClient(client, id);

  const toolbar = (
    <div className="nt-wb-toolbar">
      <button type="button" aria-label="Add card" onClick={() => void createCardAt(centerWorld())}>
        + Card
      </button>
      <button type="button" aria-label="Add rectangle" onClick={() => addShape("rect")}>
        ▭ Rect
      </button>
      <button type="button" aria-label="Add ellipse" onClick={() => addShape("ellipse")}>
        ◯ Ellipse
      </button>
      <button type="button" aria-label="Add arrow" onClick={() => addShape("arrow")}>
        → Arrow
      </button>
      <button
        type="button"
        aria-label="Draw stroke"
        aria-pressed={drawMode}
        className={drawMode ? "nt-wb-tool-active" : undefined}
        onClick={() => setDrawMode((mode) => !mode)}
      >
        ✎ Stroke
      </button>
      <button
        type="button"
        aria-label="Delete selection"
        disabled={selectedId === null}
        onClick={deleteSelected}
      >
        ⌫ Delete
      </button>
    </div>
  );

  const renderShape = (shape: (typeof view.shapes)[number]): ReactNode => {
    const selected = shape.id === selectedId;
    const common = {
      className: selected ? "nt-wb-shape nt-wb-shape-selected" : "nt-wb-shape",
      onPointerDown: (event: ReactPointerEvent<SVGGElement>) => {
        event.stopPropagation();
        setSelectedId(shape.id);
      },
      onDoubleClick: (event: ReactMouseEvent<SVGGElement>) => {
        event.stopPropagation();
        setSelectedId(shape.id);
        setLabelEdit({ id: shape.id, text: shape.label ?? "" });
      },
    };
    return (
      <g key={shape.id} {...common}>
        {shape.kind === "rect" && (
          <rect
            x={Math.min(shape.x, shape.x + shape.w)}
            y={Math.min(shape.y, shape.y + shape.h)}
            width={Math.abs(shape.w)}
            height={Math.abs(shape.h)}
          />
        )}
        {shape.kind === "ellipse" && (
          <ellipse cx={shape.x + shape.w / 2} cy={shape.y + shape.h / 2} rx={Math.abs(shape.w / 2)} ry={Math.abs(shape.h / 2)} />
        )}
        {shape.kind === "arrow" && (
          <>
            <line x1={shape.x} y1={shape.y} x2={shape.x + shape.w} y2={shape.y + shape.h} markerEnd="url(#nt-wb-arrowhead)" />
            {shape.label !== undefined && (
              <text x={(shape.x + shape.x + shape.w) / 2} y={(shape.y + shape.y + shape.h) / 2 - 6} textAnchor="middle">
                {shape.label}
              </text>
            )}
          </>
        )}
        {shape.kind !== "arrow" && shape.label !== undefined && (
          <text x={shape.x + shape.w / 2} y={shape.y + shape.h / 2} textAnchor="middle">
            {shape.label}
          </text>
        )}
      </g>
    );
  };

  return (
    <div
      className={embedded ? "nt-wb nt-wb-embedded" : "nt-wb nt-wb-fullscreen"}
      style={embedded ? { height } : undefined}
      data-testid={embedded ? "whiteboard-embedded" : "whiteboard-fullscreen"}
      onClick={(event) => event.stopPropagation()}
    >
      {toolbar}
      <div
        ref={surfaceRef}
        className={drawMode ? "nt-wb-surface nt-wb-draw-mode" : "nt-wb-surface"}
        onPointerDown={onSurfacePointerDown}
        onPointerMove={onSurfacePointerMove}
        onPointerUp={onSurfacePointerUp}
        onDoubleClick={(event) => {
          if (drawMode) return;
          const world = toWorld(event.clientX, event.clientY);
          void createCardAt(world);
        }}
      >
        <div
          className="nt-wb-world"
          style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})` }}
        >
          <svg className="nt-wb-svg" width={1} height={1}>
            <defs>
              <marker id="nt-wb-arrowhead" markerWidth={8} markerHeight={8} refX={7} refY={4} orient="auto">
                <path d="M0,0 L8,4 L0,8 z" className="nt-wb-arrowhead" />
              </marker>
            </defs>
            {view.shapes.map(renderShape)}
            {view.strokes.map((stroke) => (
              <polyline
                key={stroke.id}
                className={stroke.id === selectedId ? "nt-wb-stroke nt-wb-shape-selected" : "nt-wb-stroke"}
                points={stroke.points.join(" ")}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  setSelectedId(stroke.id);
                }}
              />
            ))}
            {drawing !== null && <polyline className="nt-wb-stroke nt-wb-drawing" points={drawing.join(" ")} />}
          </svg>
          {cards.map((card, index) => {
            const geometry = view.cards[card.id] ?? autoSlot(index);
            const name = displayNameFromClient(client, card.id) ?? "Untitled";
            return (
              <div
                key={card.id}
                className="nt-wb-card"
                data-card-id={card.id}
                style={{ left: geometry.x, top: geometry.y, width: geometry.w, height: geometry.h }}
              >
                <div
                  className="nt-wb-card-title"
                  onPointerDown={(event) => onCardPointerDown(event, card.id, geometry)}
                >
                  <span className="nt-wb-card-name">{name}</span>
                  <button
                    type="button"
                    className="nt-wb-card-delete"
                    aria-label={`Delete card ${name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      deleteCard(card.id);
                    }}
                  >
                    ×
                  </button>
                </div>
                <div
                  className="nt-wb-card-body"
                  onClick={() => {
                    if (editingCardId !== card.id) setEditingCardId(card.id);
                  }}
                >
                  {editingCardId === card.id ? (
                    <CardTextEditor node={card} client={client} onExit={() => setEditingCardId(null)} />
                  ) : (
                    <InlineTokens tokens={card.contentAst} resolveName={resolveName} />
                  )}
                </div>
              </div>
            );
          })}
          {labelEdit !== null && (
            <input
              className="nt-wb-label-input"
              style={{ left: labelX(view, labelEdit.id), top: labelY(view, labelEdit.id) }}
              aria-label="Shape label"
              value={labelEdit.text}
              autoFocus
              onChange={(event) => setLabelEdit({ id: labelEdit.id, text: event.target.value })}
              onBlur={(event) => commitLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitLabel(labelEdit.text);
                if (event.key === "Escape") setLabelEdit(null);
              }}
            />
          )}
          {!hasContent && (
            <div className="nt-wb-empty">Double-click to add a card — cards are blocks of this whiteboard.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function labelX(layout: WhiteboardLayout, id: string): number {
  const shape = layout.shapes.find((s) => s.id === id);
  return shape ? shape.x : 0;
}

function labelY(layout: WhiteboardLayout, id: string): number {
  const shape = layout.shapes.find((s) => s.id === id);
  return shape ? shape.y - 8 : 0;
}
