/**
 * WhiteboardCanvas — the spatial view of a whiteboard node's subtree
 * (SCHEMA.md "Whiteboard modeling": cards are child blocks, the whiteboard is
 * a spatial view of its subtree; shapes/strokes are layout-token-only
 * geometry). Renders cards (child blocks positioned by the geometry keyed to
 * their node ids in the whiteboard token's `layout`), SVG shapes
 * (rect/ellipse/line/arrow + the chrome-only text element) and freehand
 * strokes.
 *
 * Two mount modes, one component:
 * - fullscreen (embedded=false): the page IS the whiteboard (PageView renders
 *   this in place of the outline tree). Wheel zooms (cursor-anchored), the
 *   minimap and the zoom cluster navigate, middle-drag pans.
 * - embedded (embedded=true): the whiteboard is a block child of another
 *   block's content (BlockRow injects this via InlineTokens' renderWhiteboard
 *   callback; DeckView rides the same contract). Height is capped (scroll
 *   priority for the surrounding page: pan and wheel-zoom stay disabled; the
 *   full toolset still works).
 *
 * Toolset: select/move (background drag box-selects,
 * with marquee live highlight), card, sticky note (a colored child block —
 * the color rides the node's color field, not geometry), the shape
 * set (rect/ellipse/line/arrow, drag to draw, click for a default size),
 * the pen/highlighter/eraser group (freehand stroke; the highlighter commits
 * the layout schema's `highlight` marker — translucent wide stroke; the
 * eraser drag-removes strokes/shapes near the pointer in one coalesced
 * write and stays armed until Esc), text (chrome-only layout text), and the
 * connector (an arrow whose endpoints snap to card/shape anchors at creation
 * time). A right-click context menu on canvas objects (cards, shapes,
 * strokes) offers delete, bring-to-front/send-to-back (geometry), and color
 * — the kit ContextMenu primitive. Draw/place tools are one-shot — a
 * completed gesture returns the palette to select. Formatting: colors via
 * the color grammar (preset token or hex, "no color" clears) and
 * stroke-width tiers; alignment/distribution helpers over the multi-
 * selection; grid snap toggle. Keyboard (surface-focused): Delete removes
 * the selection, arrows nudge (Shift = one grid step), Esc exits the active
 * tool.
 *
 * Writes: every gesture (card drag end, stroke end, shape add, placement,
 * nudge, align/distribute, color/size apply, card create/delete) produces
 * exactly ONE `object.update` of the host's content AST with the token's
 * layout replaced — drags mutate local view state per pointermove and
 * coalesce to a single op at gesture end, no per-mousemove op spam
 * (SCHEMA.md). Card color writes ride the node's own `color` field. The
 * write re-reads the host's current AST so it never clobbers interleaved
 * content edits.
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
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import type { ContentAst } from "@notees/protocol";
import { uuidv7 } from "uuidv7";

import { rendersAsInlineBlock } from "@notees/domain";

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
import { openNodeLinkMenu } from "./components/NodeLinkContextMenu.js";
import { SAVE_DEBOUNCE_MS } from "./BlockTextEditor.js";
import { Button } from "./components/ui/Button.js";
import { ColorButton } from "./components/ui/ColorButton.js";
import { SelectionButton } from "./components/ui/SelectionButton.js";
import { PRESET_COLOR_ENTRIES, cssColorFor } from "./components/ui/colorPresets.js";
import {
  layoutFromContentAst,
  parseWhiteboardLayout,
  withWhiteboardLayout,
  type CardGeometry,
  type WhiteboardLayout,
} from "./whiteboard-layout.js";
import {
  ALIGN_MODES,
  GRID_STEP,
  alignBoxes,
  anchorPoints,
  distributeBoxes,
  eraserHit,
  layoutBounds,
  marqueeHit,
  normalizeRect,
  snapToAnchor,
  snapToGrid,
  strokeBounds,
  type AlignMode,
  type DistributeMode,
  type PositionedBox,
  type WorldRect,
} from "./whiteboard/geometry.js";
import { TOOL_SHAPE_KIND, WHITEBOARD_TOOLS, toolDef, type WhiteboardTool } from "./whiteboard/tools.js";
import { WhiteboardMinimap } from "./whiteboard/Minimap.js";
import { ContextMenu } from "./components/ui/ContextMenu.js";

// Re-exported so the typed schema lives at the component surface too (the
// layout module is the pure, React-free half of the component).
export {
  parseWhiteboardLayout,
  serializeWhiteboardLayout,
  layoutFromContentAst,
  withWhiteboardLayout,
} from "./whiteboard-layout.js";
export type { CardGeometry, WhiteboardLayout, WhiteboardShape, WhiteboardStroke } from "./whiteboard-layout.js";
export type { WhiteboardTool } from "./whiteboard/tools.js";

/** The client surface the canvas needs (satisfied by WorkspaceClient and the WorkerClient proxy). */
export interface WhiteboardClient {
  getNode(id: string): ClientNode | undefined;
  /** Direct children in child order (card candidates; the inline-body filter is applied here). */
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

/** Sticky-note size + seed color (a preset token; recolorable later). */
const STICKY_W = 180;
const STICKY_H = 180;
const STICKY_COLOR = "yellow";

/** Stroke-width tiers (world units) for the size formatting surface. */
const STROKE_WIDTH_TIERS = [
  { id: "s", width: 2, label: "S" },
  { id: "m", width: 4, label: "M" },
  { id: "l", width: 8, label: "L" },
] as const;

/** A drag shorter than this (world units, diagonal) counts as a click. */
const MIN_DRAW_SIZE = 6;

/** Connector endpoint snap radius, world units. */
const ANCHOR_SNAP_RADIUS = 14;

/** Eraser reach: strokes/shapes within this world-unit radius of the pointer erase. */
const ERASER_RADIUS = 10;

/** Highlighter marker defaults (preset token + world-unit width). */
const HIGHLIGHTER_COLOR = "yellow";
const HIGHLIGHTER_WIDTH = 12;

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

interface Viewport {
  x: number;
  y: number;
  k: number;
}

type DragState =
  | { mode: "pan"; startClientX: number; startClientY: number; startVp: Viewport }
  | {
      mode: "marquee";
      additive: boolean;
      startX: number;
      startY: number;
      currentX: number;
      currentY: number;
      base: readonly string[];
    }
  | {
      mode: "cards";
      startWorldX: number;
      startWorldY: number;
      origins: Record<string, CardGeometry>;
      latest: WhiteboardLayout;
      moved: boolean;
    }
  | {
      mode: "shape";
      shapeId: string;
      kind: "rect" | "ellipse" | "line" | "arrow";
      connector: boolean;
      startX: number;
      startY: number;
      currentX: number;
      currentY: number;
    }
  | { mode: "stroke"; strokeId: string; points: number[]; highlight: boolean }
  | {
      /** Eraser drag: strokes/shapes under the pointer accumulate here and
          leave the layout in ONE write at pointer-up (no per-move op spam). */
      mode: "erase";
      removedShapeIds: Set<string>;
      removedStrokeIds: Set<string>;
    };

/** Deterministic cascade slot for child blocks that have no geometry yet. */
function autoSlot(index: number): CardGeometry {
  const offset = 48 + (index % 8) * 40;
  return { x: offset, y: offset, w: CARD_DEFAULT_W, h: CARD_DEFAULT_H };
}

/** SVG paint for a colored/styled shape or stroke (undefined = CSS default). */
function paintStyle(color: string | undefined, width: number | undefined): CSSProperties {
  const style: CSSProperties = {};
  if (color !== undefined) style.stroke = cssColorFor(color);
  if (width !== undefined) style.strokeWidth = width;
  return style;
}

/** True when the key event originates in editable chrome (card text, label input). */
function isEditableKeyTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest('[contenteditable="true"], input, textarea, select') !== null
  );
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
  const [previewShape, setPreviewShape] = useState<WhiteboardLayout["shapes"][number] | null>(null);
  const [marqueeRect, setMarqueeRect] = useState<WorldRect | null>(null);

  const [tool, setTool] = useState<WhiteboardTool>("select");
  const [snap, setSnap] = useState(false);
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const selectedIdsRef = useRef<readonly string[]>([]);
  selectedIdsRef.current = selectedIds;
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

  /**
   * One coalesced write: replace the token's layout in the host's CURRENT AST.
   * While a previous canvas write is still applying (rapid successive
   * gestures — arrow-key nudges, quick recolors), the next write extends THAT
   * write's AST instead of re-reading the host, whose projection still lags:
   * two nudges fired in one tick would otherwise both compute from the same
   * base and the first would be lost. Once the write has applied, the host
   * read is authoritative again (remote edits included).
   */
  const pendingWriteRef = useRef<{ base: unknown[]; promise: Promise<void> } | null>(null);
  const commitLayout = useCallback(
    (layout: WhiteboardLayout) => {
      // The ref mirrors immediately (renders lag): rapid successive gestures
      // in one tick must compute from the layout we just committed.
      viewRef.current = layout;
      setView(layout);
      const inFlight = pendingWriteRef.current;
      const base = inFlight !== null ? inFlight.base : (client.getNode(hostId)?.contentAst ?? null);
      if (base === null) return;
      const next = withWhiteboardLayout(base, tokenIndex, layout) as unknown as unknown[];
      const promise = client
        .updateObject(hostId, { contentAst: next as ContentAst })
        .then(() => {
          if (pendingWriteRef.current?.promise === promise) pendingWriteRef.current = null;
        })
        .catch(() => {
          if (pendingWriteRef.current?.promise === promise) pendingWriteRef.current = null;
        });
      pendingWriteRef.current = { base: next, promise };
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

  /** The world point currently at the surface's center (placement fallback). */
  const centerWorld = useCallback((): { x: number; y: number } => {
    const vp = viewportRef.current;
    const rect = surfaceRef.current?.getBoundingClientRect();
    return {
      x: -(vp.x / vp.k) + (rect?.width ?? 0) / (2 * vp.k),
      y: -(vp.y / vp.k) + (rect?.height ?? 0) / (2 * vp.k),
    };
  }, []);

  /** Cards rendered on the canvas right now (inline-body children only). */
  const renderedCardIdsNow = useCallback((): string[] => {
    if (client.getNode(hostId) === undefined) return [];
    return client
      .getChildren(hostId)
      .filter((child) => rendersAsInlineBlock(child))
      .map((child) => child.id);
  }, [client, hostId]);

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

  // --- selection ---------------------------------------------------------------

  const isSelected = useCallback((id: string) => selectedIdsRef.current.includes(id), []);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((existing) => existing !== id) : [...prev, id]));
  }, []);

  /** Split the selection into rendered-card ids / shape ids / stroke ids. */
  const selectionParts = useCallback((): { cardIds: string[]; shapeIds: Set<string>; strokeIds: Set<string> } => {
    const layout = viewRef.current;
    const rendered = new Set(renderedCardIdsNow());
    const cardIds: string[] = [];
    const shapeIds = new Set<string>();
    const strokeIds = new Set<string>();
    for (const id of selectedIdsRef.current) {
      if (rendered.has(id) && layout.cards[id] !== undefined) cardIds.push(id);
      else if (layout.shapes.some((s) => s.id === id)) shapeIds.add(id);
      else if (layout.strokes.some((s) => s.id === id)) strokeIds.add(id);
    }
    return { cardIds, shapeIds, strokeIds };
  }, [renderedCardIdsNow]);

  /** Cards + shapes of the selection as alignable boxes (strokes excluded). */
  const selectionBoxes = useCallback((): PositionedBox[] => {
    const layout = viewRef.current;
    const { cardIds, shapeIds } = selectionParts();
    const boxes: PositionedBox[] = cardIds.map((id) => ({ id, ...layout.cards[id]! }));
    for (const shape of layout.shapes) {
      if (shapeIds.has(shape.id)) boxes.push({ id: shape.id, x: shape.x, y: shape.y, w: shape.w, h: shape.h });
    }
    return boxes;
  }, [selectionParts]);

  // --- geometry writes ---------------------------------------------------------

  /** Apply x/y deltas (from align/distribute) to the selected cards + shapes. */
  const applyDeltas = useCallback(
    (deltas: Map<string, { x: number; y: number }>) => {
      if (deltas.size === 0) return;
      const layout = viewRef.current;
      const cards: Record<string, CardGeometry> = { ...layout.cards };
      for (const [id, delta] of deltas) {
        const geometry = cards[id];
        if (geometry !== undefined) cards[id] = { ...geometry, x: delta.x, y: delta.y };
      }
      const shapes = layout.shapes.map((shape) => {
        const delta = deltas.get(shape.id);
        return delta === undefined ? shape : { ...shape, x: delta.x, y: delta.y };
      });
      commitLayout({ ...layout, cards, shapes });
    },
    [commitLayout],
  );

  const alignSelection = useCallback(
    (mode: AlignMode) => {
      applyDeltas(alignBoxes(selectionBoxes(), mode));
    },
    [applyDeltas, selectionBoxes],
  );

  const distributeSelection = useCallback(
    (mode: DistributeMode) => {
      applyDeltas(distributeBoxes(selectionBoxes(), mode));
    },
    [applyDeltas, selectionBoxes],
  );

  /** Arrow-key nudge: every selected element translates by dx/dy, one write. */
  const nudgeSelection = useCallback(
    (dx: number, dy: number) => {
      const layout = viewRef.current;
      const { cardIds, shapeIds, strokeIds } = selectionParts();
      if (cardIds.length === 0 && shapeIds.size === 0 && strokeIds.size === 0) return;
      const cards: Record<string, CardGeometry> = { ...layout.cards };
      for (const id of cardIds) {
        const geometry = cards[id]!;
        cards[id] = { ...geometry, x: geometry.x + dx, y: geometry.y + dy };
      }
      const shapes = layout.shapes.map((shape) =>
        shapeIds.has(shape.id) ? { ...shape, x: shape.x + dx, y: shape.y + dy } : shape,
      );
      const strokes = layout.strokes.map((stroke) =>
        strokeIds.has(stroke.id)
          ? { ...stroke, points: stroke.points.map((value, index) => value + (index % 2 === 0 ? dx : dy)) }
          : stroke,
      );
      commitLayout({ ...layout, cards, shapes, strokes });
    },
    [commitLayout, selectionParts],
  );

  /** Delete a selection: geometry leaves the token, cards leave the graph. */
  const deleteSelected = useCallback(
    (explicitIds?: readonly string[]) => {
      const layout = viewRef.current;
      const ids = explicitIds ?? selectedIdsRef.current;
      const rendered = new Set(renderedCardIdsNow());
      const cardIds = ids.filter((id) => rendered.has(id) && layout.cards[id] !== undefined);
      const idSet = new Set(ids);
      const shapeIds = new Set(layout.shapes.filter((s) => idSet.has(s.id)).map((s) => s.id));
      const strokeIds = new Set(layout.strokes.filter((s) => idSet.has(s.id)).map((s) => s.id));
      if (cardIds.length === 0 && shapeIds.size === 0 && strokeIds.size === 0) return;
      const cards = { ...layout.cards };
      for (const id of cardIds) delete cards[id];
      commitLayout({
        cards,
        shapes: layout.shapes.filter((s) => !shapeIds.has(s.id)),
        strokes: layout.strokes.filter((s) => !strokeIds.has(s.id)),
      });
      for (const id of cardIds) {
        if (editingCardId === id) setEditingCardId(null);
        void client.deleteObject(id);
      }
      if (labelEdit !== null && shapeIds.has(labelEdit.id)) setLabelEdit(null);
      setSelectedIds([]);
    },
    [client, commitLayout, editingCardId, labelEdit, renderedCardIdsNow],
  );

  /** Color of the selection's primary element (swatch display). */
  const selectionColor = useCallback((): string | null => {
    const layout = viewRef.current;
    for (const id of selectedIdsRef.current) {
      const shape = layout.shapes.find((s) => s.id === id);
      if (shape !== undefined) return shape.color ?? null;
      const stroke = layout.strokes.find((s) => s.id === id);
      if (stroke !== undefined) return stroke.color ?? null;
      const node = client.getNode(id);
      if (node !== undefined && node.color !== null && node.color !== "") return node.color;
    }
    return null;
  }, [client]);

  /**
   * Right-click context menu target (shapes/strokes/cards): the menu offers
   * delete, z-order (geometry), and color — the kit ContextMenu primitive.
   */
  const [canvasMenu, setCanvasMenu] = useState<{
    x: number;
    y: number;
    id: string;
    kind: "shape" | "stroke" | "card";
  } | null>(null);

  /** Delete one canvas element: geometry leaves the token; cards leave the graph. */
  const deleteCanvasElement = useCallback(
    (id: string, kind: "shape" | "stroke" | "card") => {
      if (kind === "card") {
        deleteSelected([id]);
        return;
      }
      const layout = viewRef.current;
      commitLayout({
        ...layout,
        shapes: kind === "shape" ? layout.shapes.filter((s) => s.id !== id) : layout.shapes,
        strokes: kind === "stroke" ? layout.strokes.filter((s) => s.id !== id) : layout.strokes,
      });
      setSelectedIds([]);
    },
    [commitLayout, deleteSelected],
  );

  /** Z-order for geometry: front/back within the shapes/strokes arrays. */
  const reorderGeometry = useCallback(
    (id: string, where: "front" | "back") => {
      const layout = viewRef.current;
      const move = <T extends { id: string }>(arr: readonly T[]): T[] => {
        const index = arr.findIndex((entry) => entry.id === id);
        if (index === -1) return [...arr];
        const next = [...arr];
        const [entry] = next.splice(index, 1);
        if (where === "front") next.push(entry!);
        else next.unshift(entry!);
        return next;
      };
      commitLayout({ ...layout, shapes: move(layout.shapes), strokes: move(layout.strokes) });
    },
    [commitLayout],
  );

  /** Color one canvas element (the color grammar; null clears). */
  const applyColorToElement = useCallback(
    (id: string, kind: "shape" | "stroke" | "card", color: string | null) => {
      if (kind === "card") {
        void client.updateObject(id, { color });
        return;
      }
      const layout = viewRef.current;
      const paint = <T extends { id: string; color?: string }>(entry: T): T => {
        if (entry.id !== id) return entry;
        const next = { ...entry };
        if (color === null) delete next.color;
        else next.color = color;
        return next;
      };
      commitLayout({
        ...layout,
        shapes: layout.shapes.map(paint),
        strokes: layout.strokes.map(paint),
      });
    },
    [client, commitLayout],
  );

  /** Open the context menu over an element (and select it). */
  const openCanvasMenu = (
    event: { preventDefault(): void; stopPropagation(): void; clientX: number; clientY: number },
    id: string,
    kind: "shape" | "stroke" | "card",
  ) => {
    event.preventDefault();
    event.stopPropagation();
    surfaceRef.current?.focus();
    setSelectedIds([id]);
    setCanvasMenu({ x: event.clientX, y: event.clientY, id, kind });
  };

  const canvasMenuItems = (() => {
    if (canvasMenu === null) return [];
    const { id, kind } = canvasMenu;
    return [
      {
        id: "delete",
        label: kind === "card" ? "Delete card" : "Delete",
        icon: "mdi-delete-outline",
        danger: true,
        onClick: () => deleteCanvasElement(id, kind),
      },
      { id: "sep1", label: "", separator: true },
      ...(kind === "card"
        ? []
        : [
            {
              id: "front",
              label: "Bring to front",
              icon: "mdi-arrow-collapse-up",
              onClick: () => reorderGeometry(id, "front"),
            },
            {
              id: "back",
              label: "Send to back",
              icon: "mdi-arrow-collapse-down",
              onClick: () => reorderGeometry(id, "back"),
            },
            { id: "sep2", label: "", separator: true },
          ]),
      {
        id: "color",
        label: "Color",
        icon: "mdi-palette-outline",
        keepOpen: true,
        submenu: (
          <div className="nt-wb-menu-color">
            <ColorButton
              color={
                (() => {
                  const layout = viewRef.current;
                  const shape = layout.shapes.find((s) => s.id === id);
                  if (shape !== undefined) return shape.color ?? "";
                  const stroke = layout.strokes.find((s) => s.id === id);
                  if (stroke !== undefined) return stroke.color ?? "";
                  const node = client.getNode(id);
                  return node !== undefined && node.color !== null ? node.color : "";
                })()
              }
              size="sm"
              showPicker
              showNoneOption
              colors={PRESET_COLOR_ENTRIES}
              aria-label="Element color"
              onColorChange={(color) => applyColorToElement(id, kind, color)}
            />
          </div>
        ),
      },
    ];
  })();

  /** Apply a color to the selection: shapes/strokes in one layout write, cards via the node color field. */
  const applyColorToSelection = useCallback(
    (color: string | null) => {
      const layout = viewRef.current;
      const { cardIds, shapeIds, strokeIds } = selectionParts();
      if (cardIds.length === 0 && shapeIds.size === 0 && strokeIds.size === 0) return;
      if (shapeIds.size > 0 || strokeIds.size > 0) {
        const shapes = layout.shapes.map((shape) => {
          if (!shapeIds.has(shape.id)) return shape;
          const next = { ...shape };
          if (color === null) delete next.color;
          else next.color = color;
          return next;
        });
        const strokes = layout.strokes.map((stroke) => {
          if (!strokeIds.has(stroke.id)) return stroke;
          const next = { ...stroke };
          if (color === null) delete next.color;
          else next.color = color;
          return next;
        });
        commitLayout({ ...layout, shapes, strokes });
      }
      for (const id of cardIds) {
        void client.updateObject(id, { color });
      }
    },
    [client, commitLayout, selectionParts],
  );

  /** Stroke-width tier of the primary selected element ("s" default). */
  const selectionSizeTier = useCallback((): string => {
    const layout = viewRef.current;
    for (const id of selectedIdsRef.current) {
      const shape = layout.shapes.find((s) => s.id === id);
      if (shape !== undefined && shape.strokeWidth !== undefined) {
        return nearestTier(shape.strokeWidth);
      }
      const stroke = layout.strokes.find((s) => s.id === id);
      if (stroke !== undefined && stroke.width !== undefined) {
        return nearestTier(stroke.width);
      }
    }
    return "s";
  }, []);

  /** Apply a stroke-width tier to the selected shapes/strokes (one write). */
  const applySizeToSelection = useCallback(
    (tierId: string) => {
      const tier = STROKE_WIDTH_TIERS.find((t) => t.id === tierId);
      if (tier === undefined) return;
      const layout = viewRef.current;
      const { shapeIds, strokeIds } = selectionParts();
      if (shapeIds.size === 0 && strokeIds.size === 0) return;
      const shapes = layout.shapes.map((shape) =>
        shapeIds.has(shape.id) ? { ...shape, strokeWidth: tier.width } : shape,
      );
      const strokes = layout.strokes.map((stroke) =>
        strokeIds.has(stroke.id) ? { ...stroke, width: tier.width } : stroke,
      );
      commitLayout({ ...layout, shapes, strokes });
    },
    [commitLayout, selectionParts],
  );

  // --- placements --------------------------------------------------------------

  const createCardAt = useCallback(
    async (world: { x: number; y: number }, size: { w: number; h: number } = { w: CARD_DEFAULT_W, h: CARD_DEFAULT_H }) => {
      // A parented child defaults to the inline body — cards ARE the body.
      const id = await client.createObject({ parentId: hostId, contentAst: [] });
      commitLayout({
        ...viewRef.current,
        cards: {
          ...viewRef.current.cards,
          [id]: { x: world.x - size.w / 2, y: world.y - size.h / 2, w: size.w, h: size.h },
        },
      });
      setEditingCardId(id);
      return id;
    },
    [client, commitLayout, hostId],
  );

  const createStickyAt = useCallback(
    async (world: { x: number; y: number }) => {
      const id = await createCardAt(world, { w: STICKY_W, h: STICKY_H });
      // The sticky's color is the NODE's color field, not geometry.
      void client.updateObject(id, { color: STICKY_COLOR });
    },
    [client, createCardAt],
  );

  /** Click-place a chrome-only text element and open its label editor. */
  const createTextAt = useCallback(
    (world: { x: number; y: number }) => {
      const shape = { id: uuidv7(), kind: "text" as const, x: world.x, y: world.y, w: 160, h: 24 };
      commitLayout({ ...viewRef.current, shapes: [...viewRef.current.shapes, shape] });
      setSelectedIds([shape.id]);
      setLabelEdit({ id: shape.id, text: "" });
    },
    [commitLayout],
  );

  /** Click-place a default-sized shape (a drag shorter than MIN_DRAW_SIZE). */
  const placeShapeAt = useCallback(
    (kind: "rect" | "ellipse" | "line" | "arrow", world: { x: number; y: number }) => {
      const box =
        kind === "rect" || kind === "ellipse"
          ? { x: world.x - 80, y: world.y - 50, w: 160, h: 100 }
          : { x: world.x - 70, y: world.y, w: 140, h: 0 };
      const shape = { id: uuidv7(), kind, ...box };
      commitLayout({ ...viewRef.current, shapes: [...viewRef.current.shapes, shape] });
      setSelectedIds([shape.id]);
    },
    [commitLayout],
  );

  const commitLabel = useCallback(
    (text: string) => {
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
    },
    [commitLayout, labelEdit],
  );

  // --- viewport controls ---------------------------------------------------------

  const applyZoomAt = useCallback((nextK: number, cx: number, cy: number) => {
    setViewport((vp) => {
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextK));
      const scale = k / vp.k;
      return { k, x: cx - (cx - vp.x) * scale, y: cy - (cy - vp.y) * scale };
    });
  }, []);

  const zoomBy = useCallback(
    (factor: number) => {
      const rect = surfaceRef.current?.getBoundingClientRect();
      applyZoomAt(viewportRef.current.k * factor, (rect?.width ?? 0) / 2, (rect?.height ?? 0) / 2);
    },
    [applyZoomAt],
  );

  const zoomToFit = useCallback(() => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (rect === undefined || rect.width <= 0 || rect.height <= 0) return;
    const bounds = layoutBounds(viewRef.current, renderedCardIdsNow());
    if (bounds === null) return;
    const k = Math.min(
      MAX_ZOOM,
      Math.max(
        MIN_ZOOM,
        Math.min((rect.width - 80) / Math.max(bounds.w, 1), (rect.height - 80) / Math.max(bounds.h, 1)),
      ),
    );
    setViewport({
      k,
      x: rect.width / 2 - (bounds.x + bounds.w / 2) * k,
      y: rect.height / 2 - (bounds.y + bounds.h / 2) * k,
    });
  }, [renderedCardIdsNow]);

  const navigateTo = useCallback((world: { x: number; y: number }) => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    const vp = viewportRef.current;
    setViewport({
      k: vp.k,
      x: (rect?.width ?? 0) / 2 - world.x * vp.k,
      y: (rect?.height ?? 0) / 2 - world.y * vp.k,
    });
  }, []);

  // --- gesture handlers ------------------------------------------------------

  const onSurfacePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const el = surfaceRef.current;
    if (el === null) return;
    el.focus();
    // Middle drag pans (fullscreen only; the embedded canvas keeps still).
    if (event.button === 1) {
      if (!embedded) {
        dragRef.current = {
          mode: "pan",
          startClientX: event.clientX,
          startClientY: event.clientY,
          startVp: viewportRef.current,
        };
        capturePointer(el, event);
      }
      return;
    }
    if (event.button !== 0) return;

    const world = toWorld(event.clientX, event.clientY);
    const snapped = snap ? { x: snapToGrid(world.x), y: snapToGrid(world.y) } : world;

    switch (tool) {
      case "select": {
        // Background drag box-selects (marquee); a bare click clears.
        dragRef.current = {
          mode: "marquee",
          additive: event.shiftKey,
          startX: world.x,
          startY: world.y,
          currentX: world.x,
          currentY: world.y,
          base: event.shiftKey ? [...selectedIdsRef.current] : [],
        };
        capturePointer(el, event);
        return;
      }
      case "card":
        void createCardAt(snapped);
        setTool("select");
        return;
      case "sticky":
        void createStickyAt(snapped);
        setTool("select");
        return;
      case "text":
        createTextAt(snapped);
        setTool("select");
        return;
      case "stroke":
      case "highlighter": {
        const points = [snapped.x, snapped.y];
        dragRef.current = { mode: "stroke", strokeId: uuidv7(), points, highlight: tool === "highlighter" };
        setDrawing(points);
        capturePointer(el, event);
        return;
      }
      case "eraser": {
        // Drag-to-erase: everything near the pointer accumulates into the
        // drag state and leaves the layout in one write at pointer-up. The
        // tool stays armed (like select) until Esc or another tool.
        const hit = eraserHit(viewRef.current, snapped, ERASER_RADIUS);
        dragRef.current = {
          mode: "erase",
          removedShapeIds: new Set(hit.shapeIds),
          removedStrokeIds: new Set(hit.strokeIds),
        };
        capturePointer(el, event);
        return;
      }
      default: {
        // Drag-drawn shapes (rect/ellipse/line/arrow) and the connector.
        const kind = TOOL_SHAPE_KIND[tool] ?? "arrow";
        const start = tool === "connector" ? anchorSnap(snapped) : snapped;
        dragRef.current = {
          mode: "shape",
          shapeId: uuidv7(),
          kind,
          connector: tool === "connector",
          startX: start.x,
          startY: start.y,
          currentX: start.x,
          currentY: start.y,
        };
        capturePointer(el, event);
      }
    }
  };

  const anchorSnap = (point: { x: number; y: number }) =>
    snapToAnchor(point, anchorPoints(viewRef.current, renderedCardIdsNow()), ANCHOR_SNAP_RADIUS);

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
    if (drag.mode === "marquee") {
      const world = toWorld(event.clientX, event.clientY);
      drag.currentX = world.x;
      drag.currentY = world.y;
      const rect = normalizeRect(drag.startX, drag.startY, drag.currentX - drag.startX, drag.currentY - drag.startY);
      setMarqueeRect(rect);
      const hits = marqueeHit(viewRef.current, renderedCardIdsNow(), rect);
      setSelectedIds([...new Set([...drag.base, ...hits])]);
      return;
    }
    if (drag.mode === "cards") {
      const world = toWorld(event.clientX, event.clientY);
      const dx = world.x - drag.startWorldX;
      const dy = world.y - drag.startWorldY;
      drag.moved = true;
      const cards = { ...viewRef.current.cards };
      for (const [cardId, origin] of Object.entries(drag.origins)) {
        const next = { x: origin.x + dx, y: origin.y + dy, w: origin.w, h: origin.h };
        cards[cardId] = snap
          ? { ...next, x: snapToGrid(next.x), y: snapToGrid(next.y) }
          : next;
      }
      const latest: WhiteboardLayout = { ...viewRef.current, cards };
      drag.latest = latest;
      setView(latest);
      return;
    }
    if (drag.mode === "shape") {
      const world = toWorld(event.clientX, event.clientY);
      const point = drag.connector ? anchorSnap(world) : snap ? { x: snapToGrid(world.x), y: snapToGrid(world.y) } : world;
      drag.currentX = point.x;
      drag.currentY = point.y;
      const box = normalizeRect(drag.startX, drag.startY, drag.currentX - drag.startX, drag.currentY - drag.startY);
      setPreviewShape({ id: drag.shapeId, kind: drag.kind, ...box });
      return;
    }
    if (drag.mode === "erase") {
      // Accumulate geometry under the moving pointer; the write lands at
      // pointer-up (one coalesced op, the same contract as the other drags).
      const world = toWorld(event.clientX, event.clientY);
      const hit = eraserHit(viewRef.current, world, ERASER_RADIUS);
      for (const id of hit.shapeIds) drag.removedShapeIds.add(id);
      for (const id of hit.strokeIds) drag.removedStrokeIds.add(id);
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
    if (drag.mode === "cards") {
      // A click without movement commits nothing (no no-op layout writes).
      if (drag.moved) commitLayout(drag.latest);
      return;
    }
    if (drag.mode === "marquee") {
      const moved = Math.hypot(drag.currentX - drag.startX, drag.currentY - drag.startY);
      if (moved * viewportRef.current.k < 3 && drag.base.length === 0) {
        // A bare background click clears the selection.
        setSelectedIds([]);
      }
      setMarqueeRect(null);
      return;
    }
    if (drag.mode === "shape") {
      const w = drag.currentX - drag.startX;
      const h = drag.currentY - drag.startY;
      setPreviewShape(null);
      if (Math.hypot(w, h) < MIN_DRAW_SIZE) {
        // A bare click places a default-sized shape at the point.
        placeShapeAt(drag.kind, { x: drag.startX, y: drag.startY });
      } else {
        const box = normalizeRect(drag.startX, drag.startY, w, h);
        commitLayout({
          ...viewRef.current,
          shapes: [...viewRef.current.shapes, { id: drag.shapeId, kind: drag.kind, ...box }],
        });
        setSelectedIds([drag.shapeId]);
      }
      setTool("select");
      return;
    }
    if (drag.mode === "stroke") {
      setDrawing(null);
      if (drag.points.length >= 4) {
        // The highlighter mode commits a translucent wide marker stroke (the
        // layout schema's `highlight` flag + the marker defaults); the pen
        // commits a plain stroke. Both return to select (one-shot tools).
        const stroke = drag.highlight
          ? { id: drag.strokeId, points: drag.points, highlight: true as const, color: HIGHLIGHTER_COLOR, width: HIGHLIGHTER_WIDTH }
          : { id: drag.strokeId, points: drag.points };
        commitLayout({
          ...viewRef.current,
          strokes: [...viewRef.current.strokes, stroke],
        });
        setSelectedIds([drag.strokeId]);
      }
      setTool("select");
      return;
    }
    if (drag.mode === "erase") {
      // One write drops every accumulated stroke/shape; the eraser stays
      // armed for the next pass.
      if (drag.removedShapeIds.size > 0 || drag.removedStrokeIds.size > 0) {
        commitLayout({
          ...viewRef.current,
          shapes: viewRef.current.shapes.filter((s) => !drag.removedShapeIds.has(s.id)),
          strokes: viewRef.current.strokes.filter((s) => !drag.removedStrokeIds.has(s.id)),
        });
        setSelectedIds([]);
      }
      return;
    }
  };

  // Card drag starts from the title bar (the body click enters text editing).
  const onCardPointerDown = (event: ReactPointerEvent<HTMLDivElement>, cardId: string, geometry: CardGeometry) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    surfaceRef.current?.focus();
    setEditingCardId(null);
    if (event.shiftKey) {
      toggleSelected(cardId);
      return;
    }
    const effective = selectedIdsRef.current.includes(cardId) ? [...selectedIdsRef.current] : [cardId];
    if (!selectedIdsRef.current.includes(cardId)) setSelectedIds(effective);
    const world = toWorld(event.clientX, event.clientY);
    const origins: Record<string, CardGeometry> = {};
    for (const id of effective) {
      const origin = viewRef.current.cards[id];
      if (origin !== undefined) origins[id] = origin;
    }
    dragRef.current = {
      mode: "cards",
      startWorldX: world.x,
      startWorldY: world.y,
      origins,
      latest: viewRef.current,
      moved: false,
    };
    capturePointer(event.currentTarget, event);
  };

  const onShapePointerDown = (event: ReactPointerEvent<SVGGElement>, id: string) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    surfaceRef.current?.focus();
    if (event.shiftKey) toggleSelected(id);
    else setSelectedIds([id]);
  };

  const onSurfaceKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isEditableKeyTarget(event.target)) return;
    if (event.key === "Escape") {
      // Esc cancels an in-flight gesture, exits the armed tool, else clears.
      if (dragRef.current !== null) {
        dragRef.current = null;
        setPreviewShape(null);
        setDrawing(null);
        setMarqueeRect(null);
        setTool("select");
        event.stopPropagation();
        return;
      }
      if (tool !== "select") {
        setTool("select");
        event.stopPropagation();
        return;
      }
      if (selectedIdsRef.current.length > 0) {
        setSelectedIds([]);
        event.stopPropagation();
      }
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      if (selectedIdsRef.current.length === 0) return;
      deleteSelected();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const step = event.shiftKey ? GRID_STEP : 1;
    const delta: { dx: number; dy: number } | null =
      event.key === "ArrowLeft"
        ? { dx: -step, dy: 0 }
        : event.key === "ArrowRight"
          ? { dx: step, dy: 0 }
          : event.key === "ArrowUp"
            ? { dx: 0, dy: -step }
            : event.key === "ArrowDown"
              ? { dx: 0, dy: step }
              : null;
    if (delta !== null && selectedIdsRef.current.length > 0) {
      nudgeSelection(delta.dx, delta.dy);
      event.preventDefault();
      event.stopPropagation();
    }
  };

  // --- derived render data -----------------------------------------------------

  // Cards are the host's inline-body children (the Revision-11 render
  // cascade: main children render in their own section, not on the canvas).
  const cards = host
    ? client.getChildren(hostId).filter((child) => rendersAsInlineBlock(child))
    : [];
  const renderedCardIds = cards.map((card) => card.id);

  if (host === undefined || storedLayoutJson === null) {
    return <div className="nt-wb-missing">Whiteboard unavailable.</div>;
  }

  const hasContent =
    cards.length > 0 || view.shapes.length > 0 || view.strokes.length > 0 || drawing !== null;
  const resolveName = (id: string) => displayNameFromClient(client, id);

  const toolbar = (
    <div className="nt-wb-toolbar">
      {WHITEBOARD_TOOLS.map((def) => (
        <Button
          key={def.id}
          type="button"
          variant="ghost"
          size="sm"
          icon={`mdi mdi-${def.icon}`}
          aria-label={def.label}
          aria-pressed={tool === def.id}
          active={tool === def.id}
          title={def.label}
          onClick={() => setTool(def.id)}
        >
          {def.shortLabel}
        </Button>
      ))}
      <span className="nt-wb-toolbar-sep" aria-hidden="true" />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label="Snap to grid"
        aria-pressed={snap}
        active={snap}
        onClick={() => setSnap((value) => !value)}
      >
        Snap
      </Button>
      {selectedIds.length > 0 && (
        <>
          <span className="nt-wb-toolbar-sep" aria-hidden="true" />
          <ColorButton
            color={selectionColor() ?? ""}
            size="sm"
            showPicker
            showNoneOption
            colors={PRESET_COLOR_ENTRIES}
            aria-label="Selection color"
            onColorChange={(color) => applyColorToSelection(color)}
          />
          <SelectionButton
            size="sm"
            aria-label="Stroke width"
            options={STROKE_WIDTH_TIERS.map((tier) => ({ value: tier.id, icon: tier.label, label: `Stroke width ${tier.label}` }))}
            value={selectionSizeTier()}
            onChange={(value) => applySizeToSelection(value)}
          />
          {selectedIds.length >= 2 && (
            <>
              {ALIGN_MODES.map(({ mode, label }) => (
                <Button
                  key={mode}
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={label}
                  title={label}
                  onClick={() => alignSelection(mode)}
                >
                  {alignShortLabel(mode)}
                </Button>
              ))}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Distribute horizontally"
                title="Distribute horizontally"
                onClick={() => distributeSelection("horizontal")}
              >
                ⇶
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Distribute vertically"
                title="Distribute vertically"
                onClick={() => distributeSelection("vertical")}
              >
                ⇅
              </Button>
            </>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Delete selection"
            onClick={() => deleteSelected()}
          >
            ⌫
          </Button>
        </>
      )}
    </div>
  );

  const surfaceRect = surfaceRef.current?.getBoundingClientRect();
  const zoomControls = !embedded && (
    // Inside the surface: pointerdown must not become a canvas gesture.
    <div className="nt-wb-zoom" onPointerDown={(event) => event.stopPropagation()}>
      <Button type="button" variant="ghost" size="sm" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.25)}>
        −
      </Button>
      <span className="nt-wb-zoom-level" aria-label="Zoom level">
        {Math.round(viewport.k * 100)}%
      </span>
      <Button type="button" variant="ghost" size="sm" aria-label="Zoom in" onClick={() => zoomBy(1.25)}>
        +
      </Button>
      <Button type="button" variant="ghost" size="sm" aria-label="Zoom to fit" onClick={zoomToFit}>
        Fit
      </Button>
      <Button type="button" variant="ghost" size="sm" aria-label="Reset zoom" onClick={() => setViewport({ x: 0, y: 0, k: 1 })}>
        1:1
      </Button>
    </div>
  );

  const renderShape = (shape: (typeof view.shapes)[number]): ReactNode => {
    const selected = isSelected(shape.id);
    const paint = paintStyle(shape.color, shape.strokeWidth);
    const textPaint: CSSProperties = shape.color !== undefined ? { fill: cssColorFor(shape.color) } : {};
    const common = {
      className: selected ? "nt-wb-shape nt-wb-shape-selected" : "nt-wb-shape",
      onPointerDown: (event: ReactPointerEvent<SVGGElement>) => onShapePointerDown(event, shape.id),
      onContextMenu: (event: { preventDefault(): void; stopPropagation(): void; clientX: number; clientY: number }) =>
        openCanvasMenu(event, shape.id, "shape"),
      onDoubleClick: (event: ReactMouseEvent<SVGGElement>) => {
        event.stopPropagation();
        setSelectedIds([shape.id]);
        setLabelEdit({ id: shape.id, text: shape.label ?? "" });
      },
    };
    const box = normalizeRect(shape.x, shape.y, shape.w, shape.h);
    return (
      <g key={shape.id} {...common}>
        {selected && (
          <rect
            className="nt-wb-selection-box"
            x={box.x - 3}
            y={box.y - 3}
            width={box.w + 6}
            height={box.h + 6}
          />
        )}
        {shape.kind === "rect" && (
          <rect
            x={Math.min(shape.x, shape.x + shape.w)}
            y={Math.min(shape.y, shape.y + shape.h)}
            width={Math.abs(shape.w)}
            height={Math.abs(shape.h)}
            style={paint}
          />
        )}
        {shape.kind === "ellipse" && (
          <ellipse
            cx={shape.x + shape.w / 2}
            cy={shape.y + shape.h / 2}
            rx={Math.abs(shape.w / 2)}
            ry={Math.abs(shape.h / 2)}
            style={paint}
          />
        )}
        {(shape.kind === "line" || shape.kind === "arrow") && (
          <>
            <line
              x1={shape.x}
              y1={shape.y}
              x2={shape.x + shape.w}
              y2={shape.y + shape.h}
              markerEnd={shape.kind === "arrow" ? "url(#nt-wb-arrowhead)" : undefined}
              style={paint}
            />
            {shape.label !== undefined && (
              <text x={(shape.x + shape.x + shape.w) / 2} y={(shape.y + shape.y + shape.h) / 2 - 6} textAnchor="middle" style={textPaint}>
                {shape.label}
              </text>
            )}
          </>
        )}
        {shape.kind === "text" &&
          (shape.label !== undefined ? (
            <text x={shape.x} y={shape.y + 12} style={textPaint}>
              {shape.label}
            </text>
          ) : (
            <rect x={shape.x} y={shape.y} width={shape.w} height={shape.h} className="nt-wb-text-placeholder" />
          ))}
        {(shape.kind === "rect" || shape.kind === "ellipse") && shape.label !== undefined && (
          <text x={shape.x + shape.w / 2} y={shape.y + shape.h / 2} textAnchor="middle" style={textPaint}>
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
        className={tool === "select" ? "nt-wb-surface" : "nt-wb-surface nt-wb-draw-mode"}
        style={{ cursor: toolDef(tool).cursor }}
        tabIndex={-1}
        aria-label="Whiteboard canvas"
        onPointerDown={onSurfacePointerDown}
        onPointerMove={onSurfacePointerMove}
        onPointerUp={onSurfacePointerUp}
        onKeyDown={onSurfaceKeyDown}
        onDoubleClick={(event) => {
          if (tool !== "select" && tool !== "card") return;
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
            {previewShape !== null && renderShape(previewShape)}
            {view.strokes.map((stroke) => {
              const selected = isSelected(stroke.id);
              const bounds = strokeBounds(stroke.points);
              return (
                <g key={stroke.id}>
                  <polyline
                    className={
                      stroke.highlight === true
                        ? selected
                          ? "nt-wb-stroke nt-wb-stroke-highlight nt-wb-shape-selected"
                          : "nt-wb-stroke nt-wb-stroke-highlight"
                        : selected
                          ? "nt-wb-stroke nt-wb-shape-selected"
                          : "nt-wb-stroke"
                    }
                    points={stroke.points.join(" ")}
                    style={paintStyle(stroke.color, stroke.width)}
                    onPointerDown={(event) => onShapePointerDown(event, stroke.id)}
                    onContextMenu={(event) => openCanvasMenu(event, stroke.id, "stroke")}
                  />
                  {selected && bounds !== null && (
                    <rect
                      className="nt-wb-selection-box"
                      x={bounds.x - 3}
                      y={bounds.y - 3}
                      width={bounds.w + 6}
                      height={bounds.h + 6}
                    />
                  )}
                </g>
              );
            })}
            {drawing !== null && <polyline className="nt-wb-stroke nt-wb-drawing" points={drawing.join(" ")} />}
          </svg>
          {cards.map((card, index) => {
            const geometry = view.cards[card.id] ?? autoSlot(index);
            const name = displayNameFromClient(client, card.id) ?? "Untitled";
            const cardColor = card.color !== null && card.color !== "" ? card.color : null;
            const colored = cardColor !== null;
            return (
              <div
                key={card.id}
                // The title bar stops propagation itself (it drags); the body
                // must not let a press bubble into a surface marquee either.
                onPointerDown={(event) => event.stopPropagation()}
                onContextMenu={(event) => openCanvasMenu(event, card.id, "card")}
                className={
                  isSelected(card.id)
                    ? colored
                      ? "nt-wb-card nt-wb-card-selected nt-wb-card-colored"
                      : "nt-wb-card nt-wb-card-selected"
                    : colored
                      ? "nt-wb-card nt-wb-card-colored"
                      : "nt-wb-card"
                }
                data-card-id={card.id}
                style={{
                  left: geometry.x,
                  top: geometry.y,
                  width: geometry.w,
                  height: geometry.h,
                  ...(colored ? { background: cssColorFor(cardColor) } : {}),
                }}
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
                      deleteSelected([card.id]);
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
                    <InlineTokens
                      tokens={card.contentAst}
                      resolveName={resolveName}
                      onMentionMenu={(info) => openNodeLinkMenu({ blockId: card.id, ...info })}
                    />
                  )}
                </div>
              </div>
            );
          })}
          {marqueeRect !== null && (
            <div
              className="nt-wb-marquee"
              style={{ left: marqueeRect.x, top: marqueeRect.y, width: marqueeRect.w, height: marqueeRect.h }}
            />
          )}
          {labelEdit !== null && (
            <input
              className="nt-wb-label-input"
              style={{ left: labelX(view, labelEdit.id), top: labelY(view, labelEdit.id) }}
              aria-label="Shape label"
              value={labelEdit.text}
              autoFocus
              onPointerDown={(event) => event.stopPropagation()}
              onChange={(event) => setLabelEdit({ id: labelEdit.id, text: event.target.value })}
              onBlur={(event) => commitLabel(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") commitLabel(labelEdit.text);
                if (event.key === "Escape") setLabelEdit(null);
              }}
            />
          )}
          {!hasContent && (
            <div className="nt-wb-empty">Double-click to add a card — cards are blocks of this whiteboard.</div>
          )}
        </div>
        {canvasMenu !== null && (
          <ContextMenu
            items={canvasMenuItems}
            position={{ x: canvasMenu.x, y: canvasMenu.y }}
            onClose={() => setCanvasMenu(null)}
          />
        )}
        {zoomControls}
        {!embedded && (
          <WhiteboardMinimap
            layout={view}
            renderedCardIds={renderedCardIds}
            viewport={viewport}
            surfaceW={surfaceRect?.width ?? 0}
            surfaceH={surfaceRect?.height ?? 0}
            onNavigate={navigateTo}
          />
        )}
      </div>
    </div>
  );
}

function nearestTier(width: number): string {
  let best: (typeof STROKE_WIDTH_TIERS)[number] = STROKE_WIDTH_TIERS[0]!;
  for (const tier of STROKE_WIDTH_TIERS) {
    if (Math.abs(tier.width - width) < Math.abs(best.width - width)) best = tier;
  }
  return best.id;
}

function alignShortLabel(mode: AlignMode): string {
  switch (mode) {
    case "left":
      return "⇤";
    case "centerX":
      return "↔";
    case "right":
      return "⇥";
    case "top":
      return "⤒";
    case "centerY":
      return "↕";
    case "bottom":
      return "⤓";
  }
}

function labelX(layout: WhiteboardLayout, id: string): number {
  const shape = layout.shapes.find((s) => s.id === id);
  return shape ? shape.x : 0;
}

function labelY(layout: WhiteboardLayout, id: string): number {
  const shape = layout.shapes.find((s) => s.id === id);
  if (shape === undefined) return 0;
  if (shape.kind === "text") return shape.y;
  return (shape.y + shape.y + shape.h) / 2 - 6;
}
