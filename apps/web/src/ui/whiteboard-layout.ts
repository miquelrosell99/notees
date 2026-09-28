/**
 * whiteboard-layout — the typed layout schema of a `whiteboard` content
 * token (SCHEMA.md "Whiteboard modeling": per-card geometry keyed by node id
 * lives in the token; shapes/strokes are layout-token-only geometry with no
 * identity in the graph).
 *
 * The schema is deliberately tolerant on read (migration rule): unknown
 * fields are ignored and malformed entries are dropped, so a layout written
 * by a newer client degrades to "fewer things on the canvas" instead of a
 * broken token. Serialization is the strict inverse of the typed shape.
 */

/** Geometry of one card, in world units, keyed by the child block's node id. */
export interface CardGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A layout-only shape: rect / ellipse / arrow bounding box (+ chrome label). */
export interface WhiteboardShape {
  id: string;
  kind: "rect" | "ellipse" | "arrow";
  x: number;
  y: number;
  w: number;
  h: number;
  /** Chrome only — semantic text lives in cards, never in shape labels. */
  label?: string;
}

/** A freehand stroke: flat [x1, y1, x2, y2, …] world-unit points. */
export interface WhiteboardStroke {
  id: string;
  points: number[];
}

/** The `layout` field of a `whiteboard` content token. */
export interface WhiteboardLayout {
  cards: Record<string, CardGeometry>;
  shapes: WhiteboardShape[];
  strokes: WhiteboardStroke[];
}

export const EMPTY_LAYOUT: WhiteboardLayout = { cards: {}, shapes: [], strokes: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A geometry object is kept only when all four fields are finite numbers. */
function parseGeometry(value: unknown): CardGeometry | null {
  if (!isRecord(value)) return null;
  const x = finiteNumber(value.x);
  const y = finiteNumber(value.y);
  const w = finiteNumber(value.w);
  const h = finiteNumber(value.h);
  if (x === null || y === null || w === null || h === null) return null;
  return { x, y, w, h };
}

const SHAPE_KINDS = new Set(["rect", "ellipse", "arrow"]);

function parseShape(value: unknown): WhiteboardShape | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || typeof value.kind !== "string" || !SHAPE_KINDS.has(value.kind)) {
    return null;
  }
  const x = finiteNumber(value.x);
  const y = finiteNumber(value.y);
  const w = finiteNumber(value.w);
  const h = finiteNumber(value.h);
  if (x === null || y === null || w === null || h === null) return null;
  const shape: WhiteboardShape = { id: value.id, kind: value.kind as WhiteboardShape["kind"], x, y, w, h };
  if (typeof value.label === "string" && value.label !== "") shape.label = value.label;
  return shape;
}

function parseStroke(value: unknown): WhiteboardStroke | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || !Array.isArray(value.points)) return null;
  const points = value.points.filter((p): p is number => typeof p === "number" && Number.isFinite(p));
  // A stroke needs at least one full point pair.
  if (points.length < 2) return null;
  return { id: value.id, points };
}

/**
 * Parse the `layout` field of a whiteboard token (any JSON value; typically
 * `unknown` straight from the content AST). Returns the empty layout for
 * anything that is not a well-formed object; unknown fields are ignored.
 */
export function parseWhiteboardLayout(raw: unknown): WhiteboardLayout {
  if (!isRecord(raw)) return { ...EMPTY_LAYOUT, cards: {} };
  const cards: Record<string, CardGeometry> = {};
  if (isRecord(raw.cards)) {
    for (const [nodeId, geometry] of Object.entries(raw.cards)) {
      const parsed = parseGeometry(geometry);
      if (parsed !== null) cards[nodeId] = parsed;
    }
  }
  const shapes = Array.isArray(raw.shapes) ? raw.shapes.map(parseShape).filter((s) => s !== null) : [];
  const strokes = Array.isArray(raw.strokes) ? raw.strokes.map(parseStroke).filter((s) => s !== null) : [];
  return { cards, shapes, strokes };
}

/** Serialize to the JSON-ready value stored in the token's `layout` field. */
export function serializeWhiteboardLayout(layout: WhiteboardLayout): Record<string, unknown> {
  return {
    cards: layout.cards,
    shapes: layout.shapes.map((shape) => {
      const value: Record<string, unknown> = {
        id: shape.id,
        kind: shape.kind,
        x: shape.x,
        y: shape.y,
        w: shape.w,
        h: shape.h,
      };
      if (shape.label !== undefined && shape.label !== "") value.label = shape.label;
      return value;
    }),
    strokes: layout.strokes.map((stroke) => ({ id: stroke.id, points: stroke.points })),
  };
}

/**
 * Read the parsed layout of the whiteboard token at `tokenIndex` in a host
 * node's content AST; the empty layout when the token/index is missing.
 */
export function layoutFromContentAst(contentAst: readonly unknown[], tokenIndex: number): WhiteboardLayout {
  const token = contentAst[tokenIndex];
  if (!isRecord(token) || token.type !== "whiteboard") return { ...EMPTY_LAYOUT, cards: {} };
  return parseWhiteboardLayout(token.layout);
}

/**
 * Return a copy of the host's content AST with the whiteboard token at
 * `tokenIndex` carrying `layout` (the other tokens are untouched, so a host
 * that mixes prose and a whiteboard keeps its prose). The host's CURRENT AST
 * must be passed in — callers re-read it at write time so a coalesced layout
 * write never clobbers an interleaved content edit.
 */
export function withWhiteboardLayout(
  contentAst: readonly unknown[],
  tokenIndex: number,
  layout: WhiteboardLayout,
): unknown[] {
  const next = contentAst.map((token) =>
    isRecord(token) ? ({ ...token } as Record<string, unknown>) : token,
  );
  const token = next[tokenIndex];
  if (isRecord(token)) {
    token.layout = serializeWhiteboardLayout(layout);
  }
  return next;
}
