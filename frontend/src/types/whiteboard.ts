/**
 * Whiteboard type definitions for Notees.
 *
 * Whiteboard layout data is stored directly in the node's `name` AST as an
 * `ASTWhiteboard` block: `[{ type: 'paragraph', children: [...] }, { type: 'whiteboard', data: {...} }]`.
 *
 * The data describes the positions, sizes, and visual properties of all elements
 * on the canvas, including:
 *   - Cards (child block references)
 *   - Shapes (rectangles, ellipses, triangles, diamonds)
 *   - Strokes (freehand drawing with stylus pressure support)
 *   - Text labels
 *   - Connectors (arrows between elements)
 *   - Images
 */

// ─── Common types ──────────────────────────────────────────────────

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ─── Stroke point with pressure ────────────────────────────────────

export interface StrokePoint {
  x: number;
  y: number;
  pressure: number; // 0-1, from stylus or default 0.5 for mouse
  timestamp?: number;
}

// ─── Element types ─────────────────────────────────────────────────

export type WhiteboardElementType =
  | 'card'
  | 'shape'
  | 'stroke'
  | 'text'
  | 'connector'
  | 'image'
  | 'line';

export type ShapeType =
  | 'rectangle'
  | 'ellipse'
  | 'triangle'
  | 'triangle-right'    // right-angle triangle (Shift variant)
  | 'hexagon'
  | 'hexagon-pointy'   // pointy-top hexagon (Shift variant)
  | 'star'
  | 'arrow-right'
  | 'arrow-left'
  | 'arrow-up'
  | 'arrow-down';

export type ConnectorEndpoint = {
  type: 'element';
  elementId: string;
  anchor: 'top' | 'right' | 'bottom' | 'left' | 'center';
} | {
  type: 'point';
  x: number;
  y: number;
};

export type ConnectorPathType = 'straight' | 'curved' | 'elbow';

export type ArrowheadType = 'none' | 'arrow' | 'triangle' | 'diamond' | 'circle';

export type StrokeStyle = 'solid' | 'dashed' | 'dotted';

export type TextAlign = 'left' | 'center' | 'right';

// ─── Base element ──────────────────────────────────────────────────

export interface WhiteboardElementBase {
  id: string;            // Unique element ID
  type: WhiteboardElementType;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;      // Degrees
  locked: boolean;
  opacity: number;       // 0-1
  zIndex: number;
}

// ─── Card element (references a child block) ──────────────────────

export interface WhiteboardCardElement extends WhiteboardElementBase {
  type: 'card';
  nodeId: number;        // Numeric ID of the child block node
  nodeUuid: string;      // UUID of the child block node
  collapsed: boolean;    // Whether card body is collapsed
  color: string | null;  // Card background color
  showChildren: boolean; // Whether to show nested children
  /**
   * 'block'     — Normal editable child block (default). The whiteboard creates
   *               a real child block under the whiteboard node.
   * 'reference' — Read-only reference card. The block's name contains a
   *               [[nodeLink]] to an external node. The card renders that node's
   *               full content (like a sidebar card) and is not editable.
   */
  cardMode: 'block' | 'reference';
}

// ─── Shape element ─────────────────────────────────────────────────

export interface WhiteboardShapeElement extends WhiteboardElementBase {
  type: 'shape';
  shapeType: ShapeType;
  fill: string;          // Fill color (hex or 'transparent')
  stroke: string;        // Stroke color
  strokeWidth: number;
  strokeStyle: StrokeStyle;
  borderRadius: number;  // For rectangles
  text: string;          // Optional text inside shape
  textColor: string;
  fontSize: number;
  textAlign: TextAlign;
  fontWeight: 'normal' | 'bold';
}

// ─── Stroke element (freehand drawing) ─────────────────────────────

export interface WhiteboardStrokeElement extends WhiteboardElementBase {
  type: 'stroke';
  points: StrokePoint[];
  color: string;
  strokeWidth: number;
  opacity: number;
  tool: 'pen' | 'highlighter' | 'eraser';
  // Computed bounding box from points
}

// ─── Text element ──────────────────────────────────────────────────

export interface WhiteboardTextElement extends WhiteboardElementBase {
  type: 'text';
  text: string;
  color: string;
  fontSize: number;
  fontWeight: 'normal' | 'bold';
  fontStyle: 'normal' | 'italic';
  textAlign: TextAlign;
  fontFamily: string;
}

// ─── Connector element (arrows/lines between elements) ─────────────

export interface WhiteboardConnectorElement extends WhiteboardElementBase {
  type: 'connector';
  start: ConnectorEndpoint;
  end: ConnectorEndpoint;
  pathType: ConnectorPathType;
  stroke: string;
  strokeWidth: number;
  strokeStyle: StrokeStyle;
  startArrowhead: ArrowheadType;
  endArrowhead: ArrowheadType;
  label: string;
  labelPosition: number; // 0-1 along path
  controlPoints: Point[]; // For curved/elbow paths
}

// ─── Line element (straight line between two points) ─────────────

export interface WhiteboardLineElement extends WhiteboardElementBase {
  type: 'line';
  /**
   * Direction of the line across its bounding box.
   * false → top-left (x,y) to bottom-right (x+width, y+height)
   * true  → top-right (x+width, y) to bottom-left (x, y+height)
   */
  lineFlipped: boolean;
  stroke: string;
  strokeWidth: number;
  strokeStyle: StrokeStyle;
}

// ─── Image element ─────────────────────────────────────────────────

export interface WhiteboardImageElement extends WhiteboardElementBase {
  type: 'image';
  src: string;           // Asset URL or data URL
  assetNodeUuid?: string; // UUID of asset node if from assets
  objectFit: 'contain' | 'cover' | 'fill';
  borderRadius: number;
}

// ─── Union type ────────────────────────────────────────────────────

export type WhiteboardElement =
  | WhiteboardCardElement
  | WhiteboardShapeElement
  | WhiteboardStrokeElement
  | WhiteboardTextElement
  | WhiteboardConnectorElement
  | WhiteboardImageElement
  | WhiteboardLineElement;

// ─── Whiteboard data (stored as property) ──────────────────────────

export interface WhiteboardData {
  version: number;       // Schema version for future migrations
  viewport: {
    x: number;           // Pan offset X
    y: number;           // Pan offset Y
    zoom: number;        // Zoom level (1 = 100%)
  };
  elements: WhiteboardElement[];
  grid: {
    enabled: boolean;
    size: number;        // Grid size in pixels
    snap: boolean;       // Snap to grid
    visible: boolean;
  };
  background: string;    // Canvas background color
}

// ─── Tool types ────────────────────────────────────────────────────

export type WhiteboardTool =
  | 'select'
  | 'pan'
  | 'card'
  | 'rectangle'
  | 'ellipse'
  | 'triangle'
  | 'hexagon'
  | 'star'
  | 'arrow'
  | 'line'
  | 'pen'
  | 'highlighter'
  | 'eraser'
  | 'text'
  | 'connector'
  | 'image';

// ─── Canvas interaction state ──────────────────────────────────────

export interface WhiteboardInteractionState {
  tool: WhiteboardTool;
  selectedIds: Set<string>;
  hoveredId: string | null;
  isDragging: boolean;
  isResizing: boolean;
  isRotating: boolean;
  isPanning: boolean;
  isDrawing: boolean;
  isSelectionBox: boolean;    // Right-click drag selection
  selectionBox: Bounds | null;
  dragStart: Point | null;
  resizeHandle: string | null; // 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
  // Drawing state
  currentStroke: StrokePoint[];
  // Eraser: elements marked for deletion during the current eraser stroke
  eraserMarkedIds: Set<string>;
  // Connector creation state
  connectorStart: ConnectorEndpoint | null;
}

// ─── Tool settings ─────────────────────────────────────────────────

export interface PenSettings {
  color: string;
  strokeWidth: number;
  opacity: number;
}

export interface EraserSettings {
  strokeWidth: number;
}

export interface ShapeSettings {
  fill: string;
  stroke: string;
  strokeWidth: number;
  strokeStyle: StrokeStyle;
  borderRadius: number;
}

export interface TextSettings {
  color: string;
  fontSize: number;
  fontWeight: 'normal' | 'bold';
  fontStyle: 'normal' | 'italic';
  textAlign: TextAlign;
}

export interface ConnectorSettings {
  stroke: string;
  strokeWidth: number;
  strokeStyle: StrokeStyle;
  pathType: ConnectorPathType;
  startArrowhead: ArrowheadType;
  endArrowhead: ArrowheadType;
}

export interface WhiteboardSettings {
  pen: PenSettings;
  highlighter: PenSettings;
  eraser: EraserSettings;
  shape: ShapeSettings;
  text: TextSettings;
  connector: ConnectorSettings;
}

// ─── History ───────────────────────────────────────────────────────

export interface WhiteboardHistoryEntry {
  elements: WhiteboardElement[];
  timestamp: number;
}

// ─── Default values ────────────────────────────────────────────────

export const DEFAULT_WHITEBOARD_DATA: WhiteboardData = {
  version: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  elements: [],
  grid: {
    enabled: true,
    size: 20,
    snap: true,
    visible: true,
  },
  background: 'var(--color-background)',
};

export const DEFAULT_PEN_SETTINGS: PenSettings = {
  color: 'var(--color-on-surface)',
  strokeWidth: 2,
  opacity: 1,
};

export const DEFAULT_HIGHLIGHTER_SETTINGS: PenSettings = {
  color: 'var(--color-preset-yellow)',
  strokeWidth: 20,
  opacity: 0.4,
};

export const DEFAULT_ERASER_SETTINGS: EraserSettings = {
  strokeWidth: 15,
};

export const DEFAULT_SHAPE_SETTINGS: ShapeSettings = {
  fill: 'transparent',
  stroke: 'var(--color-on-surface)',
  strokeWidth: 2,
  strokeStyle: 'solid',
  borderRadius: 4,
};

export const DEFAULT_TEXT_SETTINGS: TextSettings = {
  color: 'var(--color-on-surface)',
  fontSize: 16,
  fontWeight: 'normal',
  fontStyle: 'normal',
  textAlign: 'left',
};

export const DEFAULT_CONNECTOR_SETTINGS: ConnectorSettings = {
  stroke: 'var(--color-on-surface)',
  strokeWidth: 2,
  strokeStyle: 'solid',
  pathType: 'curved',
  startArrowhead: 'none',
  endArrowhead: 'arrow',
};

export const DEFAULT_WHITEBOARD_SETTINGS: WhiteboardSettings = {
  pen: DEFAULT_PEN_SETTINGS,
  highlighter: DEFAULT_HIGHLIGHTER_SETTINGS,
  eraser: DEFAULT_ERASER_SETTINGS,
  shape: DEFAULT_SHAPE_SETTINGS,
  text: DEFAULT_TEXT_SETTINGS,
  connector: DEFAULT_CONNECTOR_SETTINGS,
};

// ─── Helpers ───────────────────────────────────────────────────────

export function createElementId(): string {
  return crypto.randomUUID();
}

export function getBounds(elements: WhiteboardElement[]): Bounds | null {
  if (elements.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const el of elements) {
    minX = Math.min(minX, el.x);
    minY = Math.min(minY, el.y);
    maxX = Math.max(maxX, el.x + el.width);
    maxY = Math.max(maxY, el.y + el.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function isPointInBounds(point: Point, bounds: Bounds): boolean {
  return (
    point.x >= bounds.x &&
    point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y <= bounds.y + bounds.height
  );
}

export function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return !(
    a.x + a.width < b.x ||
    b.x + b.width < a.x ||
    a.y + a.height < b.y ||
    b.y + b.height < a.y
  );
}

/** Compute bounding box for a set of stroke points */
export function getStrokeBounds(points: StrokePoint[]): Bounds {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
