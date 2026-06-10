/**
 * WhiteboardCanvas — Core rendering engine for whiteboard elements.
 *
 * Handles:
 * - Canvas-to-screen coordinate transforms (pan + zoom)
 * - Element rendering (cards, shapes, strokes, text, connectors, images)
 * - Mouse/touch/stylus interaction dispatching
 * - Drag, resize, rotate operations
 * - Selection box (right-click drag)
 * - Grid rendering
 * - Stroke drawing (pen, highlighter, eraser) with pressure
 */
import React, { useRef, useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import type {
  WhiteboardElement,
  WhiteboardCardElement,
  WhiteboardShapeElement,
  WhiteboardStrokeElement,
  WhiteboardTextElement,
  WhiteboardConnectorElement,
  WhiteboardImageElement,
  WhiteboardLineElement,
  WhiteboardGroup,
  Point,
  Bounds,
  ConnectorEndpoint,
  StrokeStyle,
} from '@/types/whiteboard';
import { boundsOverlap, isPointInBounds, getBounds } from '@/types/whiteboard';
import type { UseWhiteboardReturn } from '@/hooks/useWhiteboard';

function ShortcutRow({ keys, action }: { keys: string; action: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: '1px solid var(--color-outline-variant)' }}>
      <span style={{ color: 'var(--color-on-surface)' }}>{action}</span>
      <kbd style={{ background: 'var(--color-surface-variant)', padding: '2px 8px', borderRadius: 4, fontSize: 12, fontFamily: 'monospace', color: 'var(--color-on-surface-variant)' }}>{keys}</kbd>
    </div>
  );
}
import { WhiteboardCardRenderer } from './WhiteboardCardRenderer';
import { WhiteboardShapeRenderer } from './WhiteboardShapeRenderer';
import { getShapePath } from './whiteboardShapeUtils';
import { WhiteboardStrokeRenderer } from './WhiteboardStrokeRenderer';
import { strokeToLivePath } from './whiteboardStrokeUtils';
import { useWhiteboardStore } from '@/stores/whiteboardStore';
import './WhiteboardView.css';

interface WhiteboardCanvasProps {
  wb: UseWhiteboardReturn;
  onContextMenu: (e: React.MouseEvent, elementId?: string) => void;
  onDoubleClick: (elementId: string) => void;
}

// Minimum drag distance before starting a drag/draw operation
const DRAG_THRESHOLD = 3;
// Minimum drag distance (in canvas px) before a shape preview appears / shape is committed
const MIN_SHAPE_DRAG_PX = 8;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.1;

// ─── Shape hit-testing via Path2D ─────────────────────────────────
// Reuse a single off-screen canvas context across all hit tests.
let _hitTestCtx: CanvasRenderingContext2D | null = null;
function getHitTestCtx(): CanvasRenderingContext2D | null {
  if (!_hitTestCtx) {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    _hitTestCtx = canvas.getContext('2d');
  }
  return _hitTestCtx;
}

/**
 * Returns true when `canvasPoint` is within hit-radius of a line element's segment.
 */
function isPointOnLineElement(canvasPoint: Point, el: WhiteboardLineElement): boolean {
  const x1 = el.lineFlipped ? el.x + el.width : el.x;
  const y1 = el.y;
  const x2 = el.lineFlipped ? el.x : el.x + el.width;
  const y2 = el.y + el.height;
  const hitRadius = el.strokeWidth / 2 + 10;
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = 0;
  if (lenSq > 0) t = Math.max(0, Math.min(1, ((canvasPoint.x - x1) * dx + (canvasPoint.y - y1) * dy) / lenSq));
  const closestX = x1 + t * dx;
  const closestY = y1 + t * dy;
  return (canvasPoint.x - closestX) ** 2 + (canvasPoint.y - closestY) ** 2 <= hitRadius * hitRadius;
}

/**
 * Returns true when `canvasPoint` is on the actual stroke polyline
 * rather than just inside its bounding box.
 * Stroke points are element-local; hit radius = half stroke width + 14px slop.
 */
function isPointOnStroke(canvasPoint: Point, el: WhiteboardStrokeElement): boolean {
  const lx = canvasPoint.x - el.x;
  const ly = canvasPoint.y - el.y;
  const { points, strokeWidth } = el;
  const hitRadius = strokeWidth / 2 + 14;

  for (let i = 0; i < points.length - 1; i++) {
    const ax = points[i].x, ay = points[i].y;
    const bx = points[i + 1].x, by = points[i + 1].y;
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = 0;
    if (lenSq > 0) {
      t = Math.max(0, Math.min(1, ((lx - ax) * dx + (ly - ay) * dy) / lenSq));
    }
    const closestX = ax + t * dx;
    const closestY = ay + t * dy;
    const distSq = (lx - closestX) ** 2 + (ly - closestY) ** 2;
    if (distSq <= hitRadius * hitRadius) return true;
  }
  // Also check individual points (for single-dot strokes)
  for (const p of points) {
    const distSq = (lx - p.x) ** 2 + (ly - p.y) ** 2;
    if (distSq <= hitRadius * hitRadius) return true;
  }
  return false;
}

/**
 * Returns true when `canvasPoint` lies on the actual shape geometry
 * (fill area OR stroke edge) rather than just the bounding box.
 */
function isPointInShapePath(canvasPoint: Point, el: WhiteboardShapeElement): boolean {
  const px = canvasPoint.x - el.x;
  const py = canvasPoint.y - el.y;
  const margin = 14;
  // Quick bounding-box pre-check
  if (px < -margin || py < -margin || px > el.width + margin || py > el.height + margin) return false;

  const ctx = getHitTestCtx();
  if (!ctx) return true; // fallback: accept

  const path = new Path2D(getShapePath(el.shapeType, el.width, el.height));

  // Filled shapes: click inside the fill
  const isFilled = el.fill !== 'transparent' && el.fill !== 'none' && el.fill !== '';
  if (isFilled && ctx.isPointInPath(path, px, py)) return true;

  // Stroke edge: generous hit area (at least 20px wide)
  ctx.lineWidth = Math.max((el.strokeWidth ?? 1) + 16, 20);
  if (ctx.isPointInStroke(path, px, py)) return true;

  return false;
}

/**
 * Returns true when `canvasPoint` is within `hitRadius` of any segment
 * in the given polyline (list of consecutive Points).
 */
function isPointOnPolyline(canvasPoint: Point, segments: Point[], hitRadius: number): boolean {
  for (let i = 0; i < segments.length - 1; i++) {
    const ax = segments[i].x, ay = segments[i].y;
    const bx = segments[i + 1].x, by = segments[i + 1].y;
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = 0;
    if (lenSq > 0) t = Math.max(0, Math.min(1, ((canvasPoint.x - ax) * dx + (canvasPoint.y - ay) * dy) / lenSq));
    const cx = ax + t * dx, cy = ay + t * dy;
    if ((canvasPoint.x - cx) ** 2 + (canvasPoint.y - cy) ** 2 <= hitRadius * hitRadius) return true;
  }
  return false;
}

/**
 * Returns true when `canvasPoint` is within eraser range of a connector's rendered path.
 * Supports straight, elbow, and curved (sampled) path types.
 */
function isPointOnConnectorPath(
  canvasPoint: Point,
  conn: WhiteboardConnectorElement,
  elements: WhiteboardElement[],
  hitRadius: number,
): boolean {
  const resolve = (ep: ConnectorEndpoint): Point => {
    if (ep.type === 'point') return { x: ep.x, y: ep.y };
    const el = elements.find(e => e.id === ep.elementId);
    if (!el) return { x: 0, y: 0 };
    switch (ep.anchor) {
      case 'top':    return { x: el.x + el.width / 2, y: el.y };
      case 'right':  return { x: el.x + el.width, y: el.y + el.height / 2 };
      case 'bottom': return { x: el.x + el.width / 2, y: el.y + el.height };
      case 'left':   return { x: el.x, y: el.y + el.height / 2 };
      default:       return { x: el.x + el.width / 2, y: el.y + el.height / 2 };
    }
  };
  const s = resolve(conn.start);
  const e = resolve(conn.end);
  if (conn.pathType === 'straight') {
    return isPointOnPolyline(canvasPoint, [s, e], hitRadius);
  }
  if (conn.pathType === 'elbow') {
    const mx = (s.x + e.x) / 2;
    return isPointOnPolyline(canvasPoint, [s, { x: mx, y: s.y }, { x: mx, y: e.y }, e], hitRadius);
  }
  // Curved: sample the cubic bezier
  const dx = e.x - s.x;
  const cx1 = s.x + dx * 0.25, cy1 = s.y;
  const cx2 = e.x - dx * 0.25, cy2 = e.y;
  const SAMPLES = 24;
  const pts: Point[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const mt = 1 - t;
    pts.push({
      x: mt ** 3 * s.x + 3 * mt ** 2 * t * cx1 + 3 * mt * t ** 2 * cx2 + t ** 3 * e.x,
      y: mt ** 3 * s.y + 3 * mt ** 2 * t * cy1 + 3 * mt * t ** 2 * cy2 + t ** 3 * e.y,
    });
  }
  return isPointOnPolyline(canvasPoint, pts, hitRadius);
}

/**
 * Given a canvas point near an element, returns the nearest border side.
 * Normalizes by element dimensions so aspect ratio doesn't bias the result.
 */
function getElementAnchor(canvasPoint: Point, el: { x: number; y: number; width: number; height: number }): 'top' | 'right' | 'bottom' | 'left' {
  const cx = el.x + el.width / 2;
  const cy = el.y + el.height / 2;
  const dx = canvasPoint.x - cx;
  const dy = canvasPoint.y - cy;
  const nx = el.width > 0 ? dx / (el.width / 2) : dx;
  const ny = el.height > 0 ? dy / (el.height / 2) : dy;
  if (Math.abs(nx) >= Math.abs(ny)) return nx >= 0 ? 'right' : 'left';
  return ny >= 0 ? 'bottom' : 'top';
}

/**
 * Returns the canvas coordinates of a named border anchor on an element.
 */
function getElementAnchorPos(el: { x: number; y: number; width: number; height: number }, anchor: 'top' | 'right' | 'bottom' | 'left'): Point {
  switch (anchor) {
    case 'top':    return { x: el.x + el.width / 2, y: el.y };
    case 'right':  return { x: el.x + el.width, y: el.y + el.height / 2 };
    case 'bottom': return { x: el.x + el.width / 2, y: el.y + el.height };
    case 'left':   return { x: el.x, y: el.y + el.height / 2 };
  }
}

export const WhiteboardCanvas: React.FC<WhiteboardCanvasProps> = ({
  wb,
  onContextMenu,
  onDoubleClick,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  // Imperative live-stroke refs — updated via RAF during drawing to avoid React re-renders
  const currentStrokeRef = useRef<{ x: number; y: number; pressure: number; timestamp?: number }[]>([]);
  const livePathRef = useRef<SVGPathElement>(null);
  const liveLineRef = useRef<SVGLineElement>(null);
  // Imperative connector drawing refs
  const liveConnectorRef = useRef<SVGLineElement>(null);
  const connectorHoverCircleRef = useRef<SVGCircleElement>(null);
  // Eraser cursor circle — updated imperatively, lives in live SVG so opacity dimming never affects it
  const eraserCursorRef = useRef<SVGCircleElement>(null);
  const rafRef = useRef<number>(0);
  const liveStrokeStyleRef = useRef({ color: 'black', strokeWidth: 2, opacity: 1, strokeStyle: 'solid' as StrokeStyle });
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [isEmptyPanning, setIsEmptyPanning] = useState(false);
  // Tracks shift key during shape creation drag for preview re-renders
  const [shiftConstraint, setShiftConstraint] = useState(false);

  // Canvas search
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (isSearchOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }
  }, [isSearchOpen]);

  // Keyboard shortcuts modal
  const [showShortcuts, setShowShortcuts] = useState(false);

  // Track pointer state
  const pointerState = useRef({
    isDown: false,
    startScreenPos: { x: 0, y: 0 } as Point,
    startCanvasPos: { x: 0, y: 0 } as Point,
    startElementPositions: new Map<string, Point>(),
    startElementBounds: null as Bounds | null,
    resizingElementId: null as string | null,
    // Group resize (multi-select via selection card handles)
    isGroupResize: false,
    startSelectionBounds: null as Bounds | null,
    startElementBoundsMap: new Map<string, Bounds>(),
    rotationCenter: null as Point | null,
    startRotation: 0,
    hasDragged: false,
    button: 0,
    pointerId: -1,
    startedOnEmpty: false,
    isEmptyPanning: false,
    lastPanPos: { x: 0, y: 0 } as Point,
    lastCanvasPos: { x: 0, y: 0 } as Point,
    shiftHeld: false,
  });

  const { data, interaction, setInteraction } = wb;
  const { viewport } = data;
  const { gridSnap } = useWhiteboardStore();

  // ─── Coordinate transforms ────────────────────────────────────────

  const screenToCanvas = useCallback((screenX: number, screenY: number): Point => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (screenX - rect.left - viewport.x) / viewport.zoom,
      y: (screenY - rect.top - viewport.y) / viewport.zoom,
    };
  }, [viewport]);

  // ─── Hit testing ──────────────────────────────────────────────────

  const hitTest = useCallback((canvasPoint: Point): WhiteboardElement | null => {
    // Iterate from top (highest zIndex) to bottom
    const sorted = [...data.elements].sort((a, b) => b.zIndex - a.zIndex);
    for (const el of sorted) {
      if (el.locked) continue;
      // Shapes use precise path-based hit testing so that, e.g., clicking in
      // the corner of an ellipse's bounding box does NOT select the ellipse.
      if (el.type === 'shape') {
        if (isPointInShapePath(canvasPoint, el as WhiteboardShapeElement)) return el;
      } else if (el.type === 'stroke') {
        if (isPointOnStroke(canvasPoint, el as WhiteboardStrokeElement)) return el;
      } else if (el.type === 'line') {
        if (isPointOnLineElement(canvasPoint, el as WhiteboardLineElement)) return el;
      } else {
        const bounds: Bounds = { x: el.x, y: el.y, width: el.width, height: el.height };
        if (isPointInBounds(canvasPoint, bounds)) return el;
      }
    }
    return null;
  }, [data.elements]);

  /** Find a group whose bounding box contains canvasPoint. */
  const findGroupAtPoint = useCallback((canvasPoint: Point): WhiteboardGroup | null => {
    for (const group of data.groups) {
      const memberEls = data.elements.filter(el => group.elementIds.includes(el.id));
      if (memberEls.length === 0) continue;
      const bounds = getBounds(memberEls);
      if (!bounds) continue;
      const pad = 12;
      const padded: Bounds = { x: bounds.x - pad, y: bounds.y - pad, width: bounds.width + 2 * pad, height: bounds.height + 2 * pad };
      if (isPointInBounds(canvasPoint, padded)) return group;
    }
    return null;
  }, [data.elements, data.groups]);

  // Hit-test resize handles on the group selection card (any selection size)
  // All coordinates are in canvas space; hitRadius is in canvas units.
  const hitTestSelectionCardHandle = useCallback((canvasX: number, canvasY: number): string | null => {
    if (interaction.selectedIds.size === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of data.elements) {
      if (!interaction.selectedIds.has(el.id)) continue;
      minX = Math.min(minX, el.x); minY = Math.min(minY, el.y);
      maxX = Math.max(maxX, el.x + el.width); maxY = Math.max(maxY, el.y + el.height);
    }
    const pad = 10 / viewport.zoom;
    const x1 = minX - pad, y1 = minY - pad;
    const x2 = maxX + pad, y2 = maxY + pad;
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    // Hit radius: 14 screen-px converted to canvas units
    const r = 14 / viewport.zoom;
    const handles = [
      { id: 'nw', x: x1, y: y1 },
      { id: 'n',  x: mx, y: y1 },
      { id: 'ne', x: x2, y: y1 },
      { id: 'e',  x: x2, y: my },
      { id: 'se', x: x2, y: y2 },
      { id: 's',  x: mx, y: y2 },
      { id: 'sw', x: x1, y: y2 },
      { id: 'w',  x: x1, y: my },
    ];
    for (const h of handles) {
      if (Math.abs(canvasX - h.x) < r && Math.abs(canvasY - h.y) < r) return h.id;
    }
    return null;
  }, [data.elements, interaction.selectedIds, viewport.zoom]);

  // Hit-test rotation handle (single-element selection only)
  const hitTestRotationHandle = useCallback((canvasX: number, canvasY: number): boolean => {
    if (interaction.selectedIds.size !== 1) return false;
    const id = [...interaction.selectedIds][0];
    const el = data.elements.find(e => e.id === id);
    if (!el) return false;
    const cx = el.x + el.width / 2;
    const cy = el.y - 30 / viewport.zoom; // handle is above the element
    const r = 14 / viewport.zoom;
    return Math.abs(canvasX - cx) < r && Math.abs(canvasY - cy) < r;
  }, [data.elements, interaction.selectedIds, viewport.zoom]);

  // ─── Pointer event handlers ───────────────────────────────────────

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (!containerRef.current) return;

    const canvasPos = screenToCanvas(e.clientX, e.clientY);
    const state = pointerState.current;

    state.isDown = true;
    state.startScreenPos = { x: e.clientX, y: e.clientY };
    state.startCanvasPos = canvasPos;
    state.hasDragged = false;
    state.button = e.button;
    state.pointerId = e.pointerId;
    // Reset resize state from any previous interaction
    state.resizingElementId = null;
    state.isGroupResize = false;
    state.startedOnEmpty = false;

    containerRef.current.setPointerCapture(e.pointerId);

    const tool = interaction.tool;

    // Middle-click → pan
    if (e.button === 1) {
      // Hide custom cursors while panning
      if (eraserCursorRef.current) eraserCursorRef.current.setAttribute('r', '0');
      if (connectorHoverCircleRef.current) connectorHoverCircleRef.current.setAttribute('r', '0');
      setInteraction(prev => ({ ...prev, isPanning: true, dragStart: { x: e.clientX, y: e.clientY } }));
      return;
    }

    // Right-click → context menu only (handled by onContextMenu); ignore here
    if (e.button === 2) return;

    // Drawing tools
    if (tool === 'pen' || tool === 'highlighter' || tool === 'eraser') {
      const pressure = e.pressure > 0 ? e.pressure : 0.5;
      const firstPoint = { x: canvasPos.x, y: canvasPos.y, pressure, timestamp: Date.now() };
      if (tool !== 'eraser') {
        // Pen/highlighter: use imperative path for zero-lag live rendering
        currentStrokeRef.current = [firstPoint];
        const penSettings = tool === 'highlighter' ? wb.settings.highlighter : wb.settings.pen;
        liveStrokeStyleRef.current = {
          color: penSettings.color,
          strokeWidth: penSettings.strokeWidth,
          opacity: tool === 'highlighter' ? 0.4 : penSettings.opacity,
          strokeStyle: penSettings.strokeStyle,
        };
        if (livePathRef.current) {
          livePathRef.current.setAttribute('stroke', liveStrokeStyleRef.current.color);
          livePathRef.current.setAttribute('stroke-width', String(liveStrokeStyleRef.current.strokeWidth));
          livePathRef.current.setAttribute('opacity', String(liveStrokeStyleRef.current.opacity));
          const ss = liveStrokeStyleRef.current.strokeStyle;
          livePathRef.current.setAttribute('class', ss === 'dashed' ? 'wb-ss-dashed' : ss === 'dotted' ? 'wb-ss-dotted' : '');
          livePathRef.current.setAttribute('d', '');
        }
        setInteraction(prev => ({ ...prev, isDrawing: true, currentStroke: [] }));
      } else {
        setInteraction(prev => ({
          ...prev,
          isDrawing: true,
          currentStroke: [firstPoint],
        }));
      }
      return;
    }

    // Line tool — imperative live-line rendering (same zero-lag approach as pen strokes)
    if (tool === 'line') {
      setInteraction(prev => ({ ...prev, isDragging: true, dragStart: { x: canvasPos.x, y: canvasPos.y } }));
      if (liveLineRef.current) {
        const ss = wb.settings.shape.strokeStyle;
        liveLineRef.current.setAttribute('x1', String(canvasPos.x));
        liveLineRef.current.setAttribute('y1', String(canvasPos.y));
        liveLineRef.current.setAttribute('x2', String(canvasPos.x));
        liveLineRef.current.setAttribute('y2', String(canvasPos.y));
        liveLineRef.current.setAttribute('stroke', wb.settings.shape.stroke);
        liveLineRef.current.setAttribute('stroke-width', String(wb.settings.shape.strokeWidth));
        liveLineRef.current.setAttribute('stroke-dasharray', ss === 'dashed' ? '8 4' : ss === 'dotted' ? '2 4' : '');
      }
      return;
    }

    // Connector tool — only begins if the pointer is on an element
    if (tool === 'connector') {
      const hitElement = hitTest(canvasPos);
      if (connectorHoverCircleRef.current) connectorHoverCircleRef.current.setAttribute('r', '0');
      if (!hitElement) return; // must start on an element
      const anchor = getElementAnchor(canvasPos, hitElement);
      const anchorPos = getElementAnchorPos(hitElement, anchor);
      if (liveConnectorRef.current) {
        liveConnectorRef.current.setAttribute('x1', String(anchorPos.x));
        liveConnectorRef.current.setAttribute('y1', String(anchorPos.y));
        liveConnectorRef.current.setAttribute('x2', String(anchorPos.x));
        liveConnectorRef.current.setAttribute('y2', String(anchorPos.y));
      }
      setInteraction(prev => ({
        ...prev,
        connectorStart: { type: 'element', elementId: hitElement.id, anchor },
      }));
      return;
    }

    // Select tool
    if (tool === 'select') {
      // Check rotation handle (single element only)
      if (interaction.selectedIds.size === 1 && hitTestRotationHandle(canvasPos.x, canvasPos.y)) {
        const id = [...interaction.selectedIds][0];
        const el = data.elements.find(e => e.id === id);
        if (el) {
          state.rotationCenter = { x: el.x + el.width / 2, y: el.y + el.height / 2 };
          state.startRotation = el.rotation || 0;
          setInteraction(prev => ({ ...prev, isRotating: true }));
          return;
        }
      }
      // Check selection-card handles (works for both single and multi-select)
      if (interaction.selectedIds.size > 0) {
        const cardHandle = hitTestSelectionCardHandle(canvasPos.x, canvasPos.y);
        if (cardHandle) {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          const boundsMap = new Map<string, Bounds>();
          for (const el of data.elements) {
            if (!interaction.selectedIds.has(el.id)) continue;
            minX = Math.min(minX, el.x); minY = Math.min(minY, el.y);
            maxX = Math.max(maxX, el.x + el.width); maxY = Math.max(maxY, el.y + el.height);
            boundsMap.set(el.id, { x: el.x, y: el.y, width: el.width, height: el.height });
          }
          state.isGroupResize = true;
          state.startSelectionBounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
          state.startElementBoundsMap = boundsMap;
          state.startElementPositions.clear();
          setInteraction(prev => ({ ...prev, isResizing: true, resizeHandle: cardHandle }));
          return;
        }
      }

      const hitElement = hitTest(canvasPos);
      if (hitElement) {
        // Check if element belongs to a group — if so, select all group members
        const group = wb.getElementGroup(hitElement.id);
        if (!e.shiftKey) {
          if (group && !interaction.selectedIds.has(hitElement.id)) {
            // Select entire group
            setInteraction(prev => ({ ...prev, selectedIds: new Set(group.elementIds) }));
            state.startElementPositions.clear();
            for (const id of group.elementIds) {
              const el = data.elements.find(e => e.id === id);
              if (el) state.startElementPositions.set(id, { x: el.x, y: el.y });
            }
          } else if (!interaction.selectedIds.has(hitElement.id)) {
            setInteraction(prev => ({ ...prev, selectedIds: new Set([hitElement.id]) }));
            state.startElementPositions.clear();
            state.startElementPositions.set(hitElement.id, { x: hitElement.x, y: hitElement.y });
          } else {
            // Already in the current selection — store positions for drag
            state.startElementPositions.clear();
            for (const id of interaction.selectedIds) {
              const el = data.elements.find(e => e.id === id);
              if (el) state.startElementPositions.set(id, { x: el.x, y: el.y });
            }
          }
        } else {
          // Shift-click: toggle individual element
          const newSelected = new Set(interaction.selectedIds);
          if (newSelected.has(hitElement.id)) {
            newSelected.delete(hitElement.id);
          } else {
            newSelected.add(hitElement.id);
          }
          setInteraction(prev => ({ ...prev, selectedIds: newSelected }));
          state.startElementPositions.clear();
          for (const id of newSelected) {
            const el = data.elements.find(e => e.id === id);
            if (el) state.startElementPositions.set(id, { x: el.x, y: el.y });
          }
        }
      } else {
        // Empty space: check for group hit first
        if (!e.shiftKey) {
          const hitGroup = findGroupAtPoint(canvasPos);
          if (hitGroup) {
            setInteraction(prev => ({ ...prev, selectedIds: new Set(hitGroup.elementIds) }));
            state.startElementPositions.clear();
            for (const id of hitGroup.elementIds) {
              const el = data.elements.find(e => e.id === id);
              if (el) state.startElementPositions.set(id, { x: el.x, y: el.y });
            }
            return;
          }
        }
        // Empty space: Shift+drag → box select, plain drag → pan, plain click → deselect (on up)
        if (e.shiftKey) {
          setInteraction(prev => ({
            ...prev,
            isSelectionBox: true,
            selectionBox: { x: canvasPos.x, y: canvasPos.y, width: 0, height: 0 },
          }));
        } else {
          state.startedOnEmpty = true;
          state.lastPanPos = { x: e.clientX, y: e.clientY };
        }
      }
      return;
    }

    // Shape creation tools
    if (['rectangle', 'ellipse', 'triangle', 'hexagon', 'star', 'diamond', 'cylinder', 'cloud', 'parallelogram', 'trapezoid', 'cross', 'heart', 'document'].includes(tool)) {
      setInteraction(prev => ({
        ...prev,
        isDragging: true,
        dragStart: canvasPos,
      }));
      return;
    }

    // Text tool
    if (tool === 'text') {
      const snapped = wb.snapToGrid(canvasPos);
      const textEl = wb.createText(snapped);
      wb.addElement(textEl);
      setEditingTextId(textEl.id);
      wb.setTool('select');
      wb.selectElements([textEl.id]);
      return;
    }

    // Card tool
    if (tool === 'card') {
      // Card creation will be handled by the toolbar (create node + card element)
      return;
    }
  }, [screenToCanvas, hitTest, hitTestSelectionCardHandle, hitTestRotationHandle, findGroupAtPoint, interaction, data.elements, wb, setInteraction]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const state = pointerState.current;
    if (e.pointerId !== state.pointerId && state.isDown) return;

    const canvasPos = screenToCanvas(e.clientX, e.clientY);
    state.lastCanvasPos = canvasPos;

    // Update hover
    if (!state.isDown) {
      const hitElement = hitTest(canvasPos);
      setInteraction(prev => ({
        ...prev,
        hoveredId: hitElement?.id ?? null,
      }));
      // Connector tool: show which anchor side will be used on hover
      if (interaction.tool === 'connector' && !interaction.connectorStart) {
        if (hitElement) {
          const anchor = getElementAnchor(canvasPos, hitElement);
          const pos = getElementAnchorPos(hitElement, anchor);
          if (connectorHoverCircleRef.current) {
            connectorHoverCircleRef.current.setAttribute('cx', String(pos.x));
            connectorHoverCircleRef.current.setAttribute('cy', String(pos.y));
            connectorHoverCircleRef.current.setAttribute('r', '5');
          }
        } else if (connectorHoverCircleRef.current) {
          connectorHoverCircleRef.current.setAttribute('r', '0');
        }
      }
      // Eraser tool: follow cursor with size circle
      if (interaction.tool === 'eraser') {
        if (eraserCursorRef.current) {
          eraserCursorRef.current.setAttribute('cx', String(canvasPos.x));
          eraserCursorRef.current.setAttribute('cy', String(canvasPos.y));
          eraserCursorRef.current.setAttribute('r', String(wb.settings.eraser.strokeWidth / 2 / viewport.zoom));
          eraserCursorRef.current.setAttribute('stroke-width', String(1.5 / viewport.zoom));
        }
      } else if (eraserCursorRef.current) {
        eraserCursorRef.current.setAttribute('r', '0');
      }
      return;
    }

    const dx = e.clientX - state.startScreenPos.x;
    const dy = e.clientY - state.startScreenPos.y;

    if (!state.hasDragged && Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
    state.hasDragged = true;

    // Empty-space pan (select tool, drag without Shift)
    if (state.startedOnEmpty) {
      const pdx = e.clientX - state.lastPanPos.x;
      const pdy = e.clientY - state.lastPanPos.y;
      state.lastPanPos = { x: e.clientX, y: e.clientY };
      if (!state.isEmptyPanning) {
        state.isEmptyPanning = true;
        setIsEmptyPanning(true);
      }
      wb.setViewport({ x: viewport.x + pdx, y: viewport.y + pdy, zoom: viewport.zoom });
      return;
    }

    // Panning (middle-click)
    if (interaction.isPanning) {
      wb.setViewport({
        x: viewport.x + (e.clientX - (interaction.dragStart?.x ?? 0)),
        y: viewport.y + (e.clientY - (interaction.dragStart?.y ?? 0)),
        zoom: viewport.zoom,
      });
      setInteraction(prev => ({ ...prev, dragStart: { x: e.clientX, y: e.clientY } }));
      return;
    }

    // Selection box
    if (interaction.isSelectionBox) {
      const startPos = state.startCanvasPos;
      const box: Bounds = {
        x: Math.min(startPos.x, canvasPos.x),
        y: Math.min(startPos.y, canvasPos.y),
        width: Math.abs(canvasPos.x - startPos.x),
        height: Math.abs(canvasPos.y - startPos.y),
      };
      // Find elements within selection box
      const selectedIds = new Set<string>();
      for (const el of data.elements) {
        if (el.locked) continue;
        const elBounds: Bounds = { x: el.x, y: el.y, width: el.width, height: el.height };
        if (boundsOverlap(box, elBounds)) {
          selectedIds.add(el.id);
        }
      }
      setInteraction(prev => ({
        ...prev,
        selectionBox: box,
        selectedIds,
      }));
      return;
    }

    // Drawing
    if (interaction.isDrawing) {
      const pressure = e.pressure > 0 ? e.pressure : 0.5;

      if (interaction.tool === 'eraser') {
        // Eraser keeps state-driven path for real-time element marking
        const newPoint = { x: canvasPos.x, y: canvasPos.y, pressure, timestamp: Date.now() };
        setInteraction(prev => {
          const stroke = prev.currentStroke;
          if (stroke.length > 0) {
            const last = stroke[stroke.length - 1];
            const dx = newPoint.x - last.x;
            const dy = newPoint.y - last.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const minDist = Math.max(2, Math.min(10, stroke.length * 0.015));
            if (dist < minDist) return prev;
          }
          const newStroke = [...stroke, newPoint];
          const eraserRadius = wb.settings.eraser.strokeWidth / 2 + 2;
          const newMarkedIds = new Set(prev.eraserMarkedIds);
          for (const el of data.elements) {
            if (newMarkedIds.has(el.id)) continue;
            if (el.type === 'stroke') {
              const strokeEl = el as WhiteboardStrokeElement;
              for (const sp of strokeEl.points) {
                const dist = Math.sqrt(
                  Math.pow(newPoint.x - (sp.x + el.x), 2) + Math.pow(newPoint.y - (sp.y + el.y), 2)
                );
                if (dist < eraserRadius) { newMarkedIds.add(el.id); break; }
              }
            } else if (el.type === 'line') {
              if (isPointOnLineElement(newPoint, el as WhiteboardLineElement)) newMarkedIds.add(el.id);
            } else if (el.type === 'connector') {
              if (isPointOnConnectorPath(newPoint, el as WhiteboardConnectorElement, data.elements, eraserRadius)) newMarkedIds.add(el.id);
            }
          }
          return { ...prev, currentStroke: newStroke, eraserMarkedIds: newMarkedIds };
        });
        // Update eraser cursor circle position imperatively during drawing
        if (eraserCursorRef.current) {
          eraserCursorRef.current.setAttribute('cx', String(canvasPos.x));
          eraserCursorRef.current.setAttribute('cy', String(canvasPos.y));
          eraserCursorRef.current.setAttribute('r', String(wb.settings.eraser.strokeWidth / 2 / viewport.zoom));
          eraserCursorRef.current.setAttribute('stroke-width', String(1.5 / viewport.zoom));
        }
        return;
      }

      // Pen / highlighter: imperative — NO setInteraction, update DOM directly via RAF

      // Shift: snap to horizontal, vertical, or 45° diagonal from stroke start
      if (e.shiftKey && currentStrokeRef.current.length > 0) {
        const start = currentStrokeRef.current[0];
        const rawDx = canvasPos.x - start.x;
        const rawDy = canvasPos.y - start.y;
        const angle = Math.atan2(rawDy, rawDx);
        const snappedAngle = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
        const dist = Math.sqrt(rawDx * rawDx + rawDy * rawDy);
        currentStrokeRef.current = [
          start,
          { x: start.x + dist * Math.cos(snappedAngle), y: start.y + dist * Math.sin(snappedAngle), pressure, timestamp: Date.now() },
        ];
      } else {
        const newPoint = { x: canvasPos.x, y: canvasPos.y, pressure, timestamp: Date.now() };
        const stroke = currentStrokeRef.current;
        if (stroke.length > 0) {
          const last = stroke[stroke.length - 1];
          const dx = newPoint.x - last.x;
          const dy = newPoint.y - last.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const minDist = Math.max(2, Math.min(8, stroke.length * 0.01));
          if (dist < minDist) return;
        }
        currentStrokeRef.current = [...stroke, newPoint];
      }

      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        if (livePathRef.current && currentStrokeRef.current.length > 1) {
          livePathRef.current.setAttribute('d', strokeToLivePath(currentStrokeRef.current));
        }
      });
      return;
    }

    // Resizing
    if (interaction.isResizing && interaction.resizeHandle) {
      const handle = interaction.resizeHandle;
      const canvasDx = canvasPos.x - state.startCanvasPos.x;
      const canvasDy = canvasPos.y - state.startCanvasPos.y;
      const isShift = e.shiftKey;

      // ── Group resize (multi-select via selection card handles) ─────
      if (state.isGroupResize && state.startSelectionBounds) {
        const sb = state.startSelectionBounds;
        const newSB = { ...sb };

        if (isShift) {
          const cx = sb.x + sb.width / 2;
          const cy = sb.y + sb.height / 2;
          if (handle.includes('n')) { newSB.height = Math.max(20, sb.height - 2 * canvasDy); newSB.y = cy - newSB.height / 2; }
          if (handle.includes('s')) { newSB.height = Math.max(20, sb.height + 2 * canvasDy); newSB.y = cy - newSB.height / 2; }
          if (handle.includes('w')) { newSB.width = Math.max(20, sb.width - 2 * canvasDx); newSB.x = cx - newSB.width / 2; }
          if (handle.includes('e')) { newSB.width = Math.max(20, sb.width + 2 * canvasDx); newSB.x = cx - newSB.width / 2; }
        } else {
          if (handle.includes('n')) { newSB.y = sb.y + canvasDy; newSB.height = sb.height - canvasDy; }
          if (handle.includes('s')) { newSB.height = sb.height + canvasDy; }
          if (handle.includes('w')) { newSB.x = sb.x + canvasDx; newSB.width = sb.width - canvasDx; }
          if (handle.includes('e')) { newSB.width = sb.width + canvasDx; }
          if (newSB.width < 20) { if (handle.includes('w')) newSB.x = sb.x + sb.width - 20; newSB.width = 20; }
          if (newSB.height < 20) { if (handle.includes('n')) newSB.y = sb.y + sb.height - 20; newSB.height = 20; }
        }

        const scaleX = sb.width > 0 ? newSB.width / sb.width : 1;
        const scaleY = sb.height > 0 ? newSB.height / sb.height : 1;
        for (const [id, eb] of state.startElementBoundsMap) {
          wb.resizeElement(id, {
            x: newSB.x + (eb.x - sb.x) * scaleX,
            y: newSB.y + (eb.y - sb.y) * scaleY,
            width: Math.max(10, eb.width * scaleX),
            height: Math.max(10, eb.height * scaleY),
          });
        }
        return;
      }

      // ── Single-element resize ─────────────────────────────────────
      const selectedId = state.resizingElementId;
      const startBounds = state.startElementBounds;
      if (!selectedId || !startBounds) return;

      const newBounds = { ...startBounds };

      if (isShift) {
        const cx = startBounds.x + startBounds.width / 2;
        const cy = startBounds.y + startBounds.height / 2;
        if (handle.includes('n')) { newBounds.height = Math.max(20, startBounds.height - 2 * canvasDy); newBounds.y = cy - newBounds.height / 2; }
        if (handle.includes('s')) { newBounds.height = Math.max(20, startBounds.height + 2 * canvasDy); newBounds.y = cy - newBounds.height / 2; }
        if (handle.includes('w')) { newBounds.width = Math.max(20, startBounds.width - 2 * canvasDx); newBounds.x = cx - newBounds.width / 2; }
        if (handle.includes('e')) { newBounds.width = Math.max(20, startBounds.width + 2 * canvasDx); newBounds.x = cx - newBounds.width / 2; }
      } else {
        if (handle.includes('n')) { newBounds.y = startBounds.y + canvasDy; newBounds.height = startBounds.height - canvasDy; }
        if (handle.includes('s')) { newBounds.height = startBounds.height + canvasDy; }
        if (handle.includes('w')) { newBounds.x = startBounds.x + canvasDx; newBounds.width = startBounds.width - canvasDx; }
        if (handle.includes('e')) { newBounds.width = startBounds.width + canvasDx; }
        if (newBounds.width < 20) { if (handle.includes('w')) newBounds.x = startBounds.x + startBounds.width - 20; newBounds.width = 20; }
        if (newBounds.height < 20) { if (handle.includes('n')) newBounds.y = startBounds.y + startBounds.height - 20; newBounds.height = 20; }
      }

      if (gridSnap) {
        const snapped = wb.snapToGrid({ x: newBounds.x, y: newBounds.y });
        newBounds.x = snapped.x;
        newBounds.y = snapped.y;
      }

      wb.resizeElement(selectedId, newBounds);
      return;
    }

    // Rotating
    if (interaction.isRotating && state.rotationCenter) {
      const cx = state.rotationCenter.x;
      const cy = state.rotationCenter.y;
      const angle = Math.atan2(canvasPos.y - cy, canvasPos.x - cx) * (180 / Math.PI);
      const newRotation = state.startRotation + angle + 90; // +90 because handle is at top
      const id = [...interaction.selectedIds][0];
      if (id) wb.rotateElement(id, Math.round(newRotation));
      return;
    }

    // Dragging elements (ref guard prevents firing when resize just started but React state not yet propagated)
    if (!state.resizingElementId && !state.isGroupResize && interaction.selectedIds.size > 0 && state.isDown && state.button === 0 && interaction.tool === 'select') {
      const canvasDx = canvasPos.x - state.startCanvasPos.x;
      const canvasDy = canvasPos.y - state.startCanvasPos.y;

      setInteraction(prev => ({ ...prev, isDragging: true }));

      // Move all selected elements
      // When moving multiple elements (group), snap the delta once using a
      // reference element so all members shift by the same amount.  Snapping
      // each element individually causes jagged movement because their
      // differing start positions round to different grid cells.
      let snappedDx = canvasDx;
      let snappedDy = canvasDy;
      if (gridSnap && state.startElementPositions.size > 1) {
        const [, refPos] = state.startElementPositions.entries().next().value as [string, Point];
        const snapped = wb.snapToGrid({ x: refPos.x + canvasDx, y: refPos.y + canvasDy });
        snappedDx = snapped.x - refPos.x;
        snappedDy = snapped.y - refPos.y;
      }

      for (const [id, startPos] of state.startElementPositions) {
        let newX = startPos.x + snappedDx;
        let newY = startPos.y + snappedDy;
        if (gridSnap && state.startElementPositions.size === 1) {
          const snapped = wb.snapToGrid({ x: newX, y: newY });
          newX = snapped.x;
          newY = snapped.y;
        }
        wb.updateElement(id, { x: newX, y: newY });
      }
      return;
    }

    // Shape creation drag
    if (interaction.isDragging && interaction.dragStart && ['rectangle', 'ellipse', 'triangle', 'hexagon', 'star', 'diamond', 'cylinder', 'cloud', 'parallelogram', 'trapezoid', 'cross', 'heart', 'document'].includes(interaction.tool)) {
      const start = interaction.dragStart;
      const tool = interaction.tool;
      const isShift = e.shiftKey;

      // Track shift state so the preview can re-render accordingly
      if (isShift !== pointerState.current.shiftHeld) {
        pointerState.current.shiftHeld = isShift;
        setShiftConstraint(isShift);
      }

      let endX = canvasPos.x;
      let endY = canvasPos.y;

      // Shift + rectangle or ellipse → constrain to square / circle
      if (isShift && (tool === 'rectangle' || tool === 'ellipse')) {
        const rawW = Math.abs(endX - start.x);
        const rawH = Math.abs(endY - start.y);
        const size = Math.min(rawW, rawH);
        endX = start.x + Math.sign(endX - start.x || 1) * size;
        endY = start.y + Math.sign(endY - start.y || 1) * size;
      }

      const dragDist = Math.sqrt((endX - start.x) ** 2 + (endY - start.y) ** 2);
      if (dragDist >= MIN_SHAPE_DRAG_PX) {
        setInteraction(prev => ({
          ...prev,
          selectionBox: {
            x: Math.min(start.x, endX),
            y: Math.min(start.y, endY),
            width: Math.abs(endX - start.x),
            height: Math.abs(endY - start.y),
          },
        }));
      }
      return;
    }

    // Line creation drag — update live SVG line imperatively (no React re-render)
    if (interaction.isDragging && interaction.tool === 'line' && interaction.dragStart) {
      const start = interaction.dragStart;
      let endX = canvasPos.x, endY = canvasPos.y;
      if (e.shiftKey) {
        const rawDx = endX - start.x, rawDy = endY - start.y;
        const angle = Math.atan2(rawDy, rawDx);
        const snapped = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
        const dist = Math.sqrt(rawDx ** 2 + rawDy ** 2);
        endX = start.x + dist * Math.cos(snapped);
        endY = start.y + dist * Math.sin(snapped);
      }
      if (liveLineRef.current) {
        liveLineRef.current.setAttribute('x2', endX.toFixed(1));
        liveLineRef.current.setAttribute('y2', endY.toFixed(1));
      }
      return;
    }

    // Connector creation drag — imperatively track endpoint
    if (interaction.connectorStart && state.isDown) {
      const startElId = interaction.connectorStart.type === 'element' ? interaction.connectorStart.elementId : null;
      const hitElement = hitTest(canvasPos);
      let ex = canvasPos.x, ey = canvasPos.y;
      if (hitElement && hitElement.id !== startElId) {
        const anchor = getElementAnchor(canvasPos, hitElement);
        const pos = getElementAnchorPos(hitElement, anchor);
        ex = pos.x; ey = pos.y;
        if (connectorHoverCircleRef.current) {
          connectorHoverCircleRef.current.setAttribute('cx', String(pos.x));
          connectorHoverCircleRef.current.setAttribute('cy', String(pos.y));
          connectorHoverCircleRef.current.setAttribute('r', '5');
        }
      } else if (connectorHoverCircleRef.current) {
        connectorHoverCircleRef.current.setAttribute('r', '0');
      }
      if (liveConnectorRef.current) {
        liveConnectorRef.current.setAttribute('x2', String(ex));
        liveConnectorRef.current.setAttribute('y2', String(ey));
      }
    }
  }, [screenToCanvas, hitTest, interaction, viewport, data, wb, setInteraction]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const state = pointerState.current;
    if (e.pointerId !== state.pointerId) return;

    state.isDown = false;
    containerRef.current?.releasePointerCapture(e.pointerId);

    const canvasPos = screenToCanvas(e.clientX, e.clientY);

    // End empty-space pan / click-to-deselect
    if (state.startedOnEmpty) {
      if (!state.hasDragged) wb.clearSelection();
      state.startedOnEmpty = false;
      state.isEmptyPanning = false;
      setIsEmptyPanning(false);
      return;
    }

    // End panning
    if (interaction.isPanning) {
      setInteraction(prev => ({ ...prev, isPanning: false, dragStart: null }));
      return;
    }

    // End selection box
    if (interaction.isSelectionBox) {
      setInteraction(prev => ({ ...prev, isSelectionBox: false, selectionBox: null }));
      return;
    }

    // End drawing
    if (interaction.isDrawing) {
      const tool = interaction.tool as 'pen' | 'highlighter' | 'eraser';
      // Cancel any pending RAF and blank the live path
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (livePathRef.current) livePathRef.current.setAttribute('d', '');
      if (tool === 'eraser') {
        if (interaction.currentStroke.length > 1) {
          const toRemove = [...interaction.eraserMarkedIds];
          if (toRemove.length > 0) wb.removeElements(toRemove);
        }
      } else {
        if (currentStrokeRef.current.length > 1) {
          const strokeEl = wb.createStroke(currentStrokeRef.current, tool);
          wb.addElement(strokeEl);
        }
        currentStrokeRef.current = [];
      }
      setInteraction(prev => ({ ...prev, isDrawing: false, currentStroke: [], eraserMarkedIds: new Set() }));
      return;
    }

    // End connector creation
    if (interaction.connectorStart) {
      // Always clear live refs
      if (liveConnectorRef.current) {
        liveConnectorRef.current.setAttribute('x1', '0');
        liveConnectorRef.current.setAttribute('y1', '0');
        liveConnectorRef.current.setAttribute('x2', '0');
        liveConnectorRef.current.setAttribute('y2', '0');
      }
      if (connectorHoverCircleRef.current) connectorHoverCircleRef.current.setAttribute('r', '0');
      setInteraction(prev => ({ ...prev, connectorStart: null }));
      // Only commit if the pointer was released on a different element
      const hitElement = hitTest(canvasPos);
      const start = interaction.connectorStart;
      if (start.type !== 'element') return;
      const startId = start.elementId;
      if (!hitElement || hitElement.id === startId) return;
      const anchor = getElementAnchor(canvasPos, hitElement);
      const end: ConnectorEndpoint = { type: 'element', elementId: hitElement.id, anchor };
      const connector = wb.createConnector(start, end);
      wb.addElement(connector);
      return;
    }

    // End drag-to-create (lines and shapes share the same interaction pattern)
    if (interaction.isDragging && interaction.dragStart && ['line', 'rectangle', 'ellipse', 'triangle', 'hexagon', 'star', 'diamond', 'cylinder', 'cloud', 'parallelogram', 'trapezoid', 'cross', 'heart', 'document'].includes(interaction.tool)) {
      const tool = interaction.tool;
      const start = interaction.dragStart;
      const isShift = e.shiftKey || pointerState.current.shiftHeld;

      if (tool === 'line') {
        // Clear the imperative live SVG line
        if (liveLineRef.current) {
          liveLineRef.current.setAttribute('x1', '0');
          liveLineRef.current.setAttribute('y1', '0');
          liveLineRef.current.setAttribute('x2', '0');
          liveLineRef.current.setAttribute('y2', '0');
        }
        let endX = canvasPos.x, endY = canvasPos.y;
        if (isShift) {
          const rawDx = endX - start.x, rawDy = endY - start.y;
          const angle = Math.atan2(rawDy, rawDx);
          const snapped = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
          const dist = Math.sqrt(rawDx ** 2 + rawDy ** 2);
          endX = start.x + dist * Math.cos(snapped);
          endY = start.y + dist * Math.sin(snapped);
        }
        if (Math.abs(endX - start.x) > 5 || Math.abs(endY - start.y) > 5) {
          const line = wb.createLine(start, { x: endX, y: endY });
          wb.addElement(line);
          wb.selectElements([line.id]);
          wb.setTool('select');
        }
      } else if (interaction.selectionBox) {
        const shapeMap: Record<string, WhiteboardShapeElement['shapeType']> = {
          rectangle: 'rectangle',
          ellipse: 'ellipse',
          triangle: isShift ? 'triangle-right' : 'triangle',
          hexagon: isShift ? 'hexagon-pointy' : 'hexagon',
          star: 'star',
          diamond: 'diamond',
          cylinder: 'cylinder',
          cloud: 'cloud',
          parallelogram: 'parallelogram',
          trapezoid: 'trapezoid',
          cross: 'cross',
          heart: 'heart',
          document: 'document',
        };
        if (tool in shapeMap) {
          const bounds = interaction.selectionBox;
          if (bounds.width >= MIN_SHAPE_DRAG_PX || bounds.height >= MIN_SHAPE_DRAG_PX) {
            const shape = wb.createShape(shapeMap[tool], bounds);
            // Rectangle + Shift → rotate 45° (rhombus look)
            if (isShift && tool === 'rectangle') {
              wb.addElement({ ...shape, rotation: 45 });
            } else {
              wb.addElement(shape);
            }
            wb.selectElements([shape.id]);
            wb.setTool('select');
          }
        }
        setShiftConstraint(false);
      }

      pointerState.current.shiftHeld = false;
      setInteraction(prev => ({
        ...prev,
        isDragging: false,
        dragStart: null,
        selectionBox: null,
      }));
      return;
    }

    // End element drag
    if (interaction.isDragging) {
      setInteraction(prev => ({ ...prev, isDragging: false }));
      return;
    }

    // End resize
    if (interaction.isResizing) {
      setInteraction(prev => ({ ...prev, isResizing: false, resizeHandle: null }));
      state.startElementBounds = null;
      state.resizingElementId = null;
      state.isGroupResize = false;
      state.startSelectionBounds = null;
      state.startElementBoundsMap.clear();
      return;
    }

    // End rotation
    if (interaction.isRotating) {
      setInteraction(prev => ({ ...prev, isRotating: false }));
      state.rotationCenter = null;
      state.startRotation = 0;
      return;
    }
  }, [screenToCanvas, hitTest, hitTestRotationHandle, interaction, data.elements, wb, setInteraction]);

  // ─── Wheel zoom ───────────────────────────────────────────────────

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    // Always zoom to mouse cursor position
    const zoomFactor = Math.pow(0.999, e.deltaY);
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, viewport.zoom * zoomFactor));
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const newX = mouseX - (mouseX - viewport.x) * (newZoom / viewport.zoom);
    const newY = mouseY - (mouseY - viewport.y) * (newZoom / viewport.zoom);
    wb.setViewport({ x: newX, y: newY, zoom: newZoom });

    // Update eraser cursor circle size immediately so it doesn't require a mouse move
    if (interaction.tool === 'eraser' && eraserCursorRef.current) {
      const canvasX = (mouseX - newX) / newZoom;
      const canvasY = (mouseY - newY) / newZoom;
      eraserCursorRef.current.setAttribute('cx', String(canvasX));
      eraserCursorRef.current.setAttribute('cy', String(canvasY));
      eraserCursorRef.current.setAttribute('r', String(wb.settings.eraser.strokeWidth / 2 / newZoom));
      eraserCursorRef.current.setAttribute('stroke-width', String(1.5 / newZoom));
    }
  }, [viewport, wb, interaction.tool]);

  // ─── Double click ─────────────────────────────────────────────────

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    const canvasPos = screenToCanvas(e.clientX, e.clientY);
    const hitElement = hitTest(canvasPos);

    if (hitElement) {
      if (hitElement.type === 'text') {
        setEditingTextId(hitElement.id);
      } else if (hitElement.type === 'shape') {
        setEditingTextId(hitElement.id); // Edit shape text
      } else {
        onDoubleClick(hitElement.id);
      }
    }
  }, [screenToCanvas, hitTest, onDoubleClick]);

  // ─── Context menu ────────────────────────────────────────────────

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const canvasPos = screenToCanvas(e.clientX, e.clientY);
    const hitElement = hitTest(canvasPos);

    if (hitElement && !interaction.selectedIds.has(hitElement.id)) {
      wb.selectElements([hitElement.id]);
    }

    onContextMenu(e, hitElement?.id);
  }, [screenToCanvas, hitTest, interaction.selectedIds, wb, onContextMenu]);

  // ─── Keyboard shortcuts ──────────────────────────────────────────

  // Helper: recompute shape-creation selectionBox from last known canvas pos + shift state
  const recomputeShapePreview = useCallback((isShift: boolean) => {
    const state = pointerState.current;
    if (!state.isDown || !state.hasDragged) return;
    const tool = interaction.tool;
    if (!['rectangle', 'ellipse', 'triangle', 'hexagon', 'star', 'diamond', 'cylinder', 'cloud', 'parallelogram', 'trapezoid', 'cross', 'heart', 'document'].includes(tool)) return;
    const start = interaction.dragStart;
    if (!start) return;

    state.shiftHeld = isShift;
    setShiftConstraint(isShift);

    let endX = state.lastCanvasPos.x;
    let endY = state.lastCanvasPos.y;

    if (isShift && (tool === 'rectangle' || tool === 'ellipse')) {
      const rawW = Math.abs(endX - start.x);
      const rawH = Math.abs(endY - start.y);
      const size = Math.min(rawW, rawH);
      endX = start.x + Math.sign(endX - start.x || 1) * size;
      endY = start.y + Math.sign(endY - start.y || 1) * size;
    }

    setInteraction(prev => ({
      ...prev,
      selectionBox: {
        x: Math.min(start.x, endX),
        y: Math.min(start.y, endY),
        width: Math.abs(endX - start.x),
        height: Math.abs(endY - start.y),
      },
    }));
  }, [interaction.tool, interaction.dragStart, setInteraction]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept shortcuts when any editable element (input, textarea,
      // or contenteditable Lexical editor) has focus — let those handle their
      // own undo/redo and text input.
      const active = document.activeElement;
      const isEditingText =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable);

      if (isEditingText) {
        // Still allow Escape to exit whiteboard text editing mode
        if (e.key === 'Escape') setEditingTextId(null);
        return;
      }

      switch (e.key) {
        case 'Delete':
        case 'Backspace':
          if (interaction.selectedIds.size > 0) {
            e.preventDefault();
            wb.removeElements([...interaction.selectedIds]);
          }
          break;
        case 'Escape':
          if (isSearchOpen) { setIsSearchOpen(false); setSearchQuery(''); }
          if (showShortcuts) setShowShortcuts(false);
          wb.clearSelection();
          wb.setTool('select');
          break;
        case 'z':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            if (e.shiftKey) wb.redo(); else wb.undo();
          }
          break;
        case 'y':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            wb.redo();
          }
          break;
        case 'a':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            wb.selectElements(data.elements.map(el => el.id));
          }
          break;
        case 'd':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            wb.duplicateElements([...interaction.selectedIds]);
          }
          break;
        case 'c':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            if (interaction.selectedIds.size > 0) {
              wb.copySelectedElements([...interaction.selectedIds]);
            }
          }
          break;
        case 'v':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            wb.pasteElements();
          } else {
            wb.setTool('select');
          }
          break;
        case 'r': case 'R': if (!e.ctrlKey) wb.setTool('rectangle'); break;
        case 'o': case 'O': wb.setTool('ellipse'); break;
        case 'p': case 'P': wb.setTool('pen'); break;
        case 't': case 'T': wb.setTool('text'); break;
        case 'l': case 'L': wb.setTool('connector'); break;
        case 'e': case 'E': wb.setTool('eraser'); break;
        case 'g': case 'G':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            const selIds = [...interaction.selectedIds];
            if (selIds.length >= 2) {
              // Check if all selected elements are already in the same group
              const existingGroup = data.groups.find(g =>
                selIds.every(id => g.elementIds.includes(id))
              );
              if (existingGroup) {
                wb.ungroupElements(selIds);
              } else {
                wb.groupElements(selIds);
              }
            }
          } else {
            wb.toggleGrid();
          }
          break;
        case ']':
          if (interaction.selectedIds.size > 0) wb.bringToFront([...interaction.selectedIds]);
          break;
        case '[':
          if (interaction.selectedIds.size > 0) wb.sendToBack([...interaction.selectedIds]);
          break;
        case '+': case '=':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            wb.setViewport({ ...viewport, zoom: Math.min(MAX_ZOOM, viewport.zoom + ZOOM_STEP) });
          }
          break;
        case '-':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            wb.setViewport({ ...viewport, zoom: Math.max(MIN_ZOOM, viewport.zoom - ZOOM_STEP) });
          }
          break;
        case '0':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            wb.setViewport({ x: 0, y: 0, zoom: 1 });
          }
          break;
        case '1':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            wb.zoomToFit();
          }
          break;
        case 'f': case 'F':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            setIsSearchOpen(prev => !prev);
          }
          break;
        case '?':
          if (!e.ctrlKey && !e.metaKey) {
            setShowShortcuts(prev => !prev);
          }
          break;
        case 'Shift':
          recomputeShapePreview(true);
          break;
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') recomputeShapePreview(false);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interaction, data.elements, viewport, wb, recomputeShapePreview, isSearchOpen, showShortcuts]);

  // ─── Sorted elements ─────────────────────────────────────────────

  // ─── Sorted elements ─────────────────────────────────────────────

  const sortedElements = useMemo(() =>
    [...data.elements].sort((a, b) => a.zIndex - b.zIndex),
    [data.elements]
  );

  // Search matches
  const searchMatchIds = useMemo(() => {
    if (!searchQuery.trim()) return new Set<string>();
    const q = searchQuery.toLowerCase();
    return new Set(
      data.elements.filter(el => {
        if (el.type === 'card') return (el as WhiteboardCardElement).nodeUuid?.toLowerCase().includes(q) ?? false;
        if (el.type === 'shape') return (el as WhiteboardShapeElement).text?.toLowerCase().includes(q) ?? false;
        if (el.type === 'text') return (el as WhiteboardTextElement).text?.toLowerCase().includes(q) ?? false;
        return false;
      }).map(el => el.id)
    );
  }, [searchQuery, data.elements]);

  // ─── Cursor ───────────────────────────────────────────────────────

  const cursorClass = useMemo(() => {
    if (interaction.isPanning || isEmptyPanning) return 'whiteboard-view--panning-active';
    if (interaction.tool === 'eraser') return 'whiteboard-view--drawing whiteboard-view--eraser';
    if (['pen', 'highlighter', 'rectangle', 'ellipse', 'triangle', 'hexagon', 'star', 'diamond', 'cylinder', 'cloud', 'parallelogram', 'trapezoid', 'cross', 'heart', 'document'].includes(interaction.tool)) return 'whiteboard-view--drawing';
    return '';
  }, [interaction.tool, interaction.isPanning, isEmptyPanning]);

  // ─── Selection bounding card ──────────────────────────────────────
  // Computes the union bounding box (canvas coords) of all selected elements.

  const selectionCardBounds = useMemo(() => {
    if (interaction.selectedIds.size === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let found = false;
    for (const el of data.elements) {
      if (!interaction.selectedIds.has(el.id)) continue;
      found = true;
      minX = Math.min(minX, el.x);
      minY = Math.min(minY, el.y);
      maxX = Math.max(maxX, el.x + el.width);
      maxY = Math.max(maxY, el.y + el.height);
    }
    if (!found) return null;
    // Padding in canvas units (stays visually proportional)
    const pad = 10 / viewport.zoom;
    return {
      left: (minX - pad) * viewport.zoom + viewport.x,
      top: (minY - pad) * viewport.zoom + viewport.y,
      width: (maxX - minX + 2 * pad) * viewport.zoom,
      height: (maxY - minY + 2 * pad) * viewport.zoom,
    };
  }, [data.elements, interaction.selectedIds, viewport]);

  // ─── Group bounding boxes ─────────────────────────────────────────
  // Rendered as faint bounding-box cards behind group member elements.

  const renderGroups = useMemo(() =>
    data.groups.map(group => {
      const memberEls = data.elements.filter(el => group.elementIds.includes(el.id));
      if (memberEls.length === 0) return null;
      const bounds = getBounds(memberEls);
      if (!bounds) return null;
      const pad = 12;
      const allSelected = group.elementIds.every(id => interaction.selectedIds.has(id));
      return (
        <div
          key={group.id}
          className={`whiteboard-group${allSelected ? ' whiteboard-group--selected' : ''}`}
          style={{
            left: (bounds.x - pad) * viewport.zoom + viewport.x,
            top: (bounds.y - pad) * viewport.zoom + viewport.y,
            width: (bounds.width + 2 * pad) * viewport.zoom,
            height: (bounds.height + 2 * pad) * viewport.zoom,
            zIndex: Math.min(...memberEls.map(el => el.zIndex)) - 1,
          }}
        />
      );
    }),
    [data.groups, data.elements, interaction.selectedIds, viewport]
  );

  // ─── Render element ───────────────────────────────────────────────

  const renderElement = useCallback((el: WhiteboardElement) => {
    const isSelected = interaction.selectedIds.has(el.id);
    const isHovered = interaction.hoveredId === el.id;
    const hasSelection = interaction.selectedIds.size > 0;
    const isEraserMode = interaction.isDrawing && interaction.tool === 'eraser';
    const isMarkedForDeletion = isEraserMode && interaction.eraserMarkedIds.has(el.id);
    const dimmedBySelection = hasSelection && !isSelected;
    const dimmedByEraser = isEraserMode && !isMarkedForDeletion;
    const dimmed = dimmedBySelection || dimmedByEraser;

    const style: React.CSSProperties = {
      left: el.x * viewport.zoom + viewport.x,
      top: el.y * viewport.zoom + viewport.y,
      width: el.width * viewport.zoom,
      height: el.height * viewport.zoom,
      transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
      opacity: isSelected || isMarkedForDeletion ? 1 : dimmed ? el.opacity * 0.35 : el.opacity,
      transition: 'opacity var(--motion-duration-medium) var(--motion-easing-standard)',
      zIndex: el.zIndex,
    };

    const isSearchMatch = searchMatchIds.has(el.id);
    const className = [
      'whiteboard-element',
      isSelected && interaction.selectedIds.size === 1 && 'whiteboard-element--selected',
      isHovered && 'whiteboard-element--hovered',
      el.locked && 'whiteboard-element--locked',
      interaction.isDragging && isSelected && 'whiteboard-element--dragging',
      isSearchMatch && 'whiteboard-element--search-match',
    ].filter(Boolean).join(' ');

    return (
      <div
        key={el.id}
        className={className}
        style={style}
        data-element-id={el.id}
        onDoubleClick={(e) => {
          e.stopPropagation();
          if (el.type === 'text' || el.type === 'shape') {
            setEditingTextId(el.id);
          } else {
            onDoubleClick(el.id);
          }
        }}
      >
        {/* Element content */}
        {el.type === 'card' && (
          <WhiteboardCardRenderer element={el as WhiteboardCardElement} zoom={viewport.zoom} />
        )}
        {el.type === 'shape' && (
          <WhiteboardShapeRenderer
            element={el as WhiteboardShapeElement}
            isEditing={editingTextId === el.id}
            onTextChange={(text: string) => {
              wb.updateElement(el.id, { text } as Partial<WhiteboardShapeElement>);
            }}
            onBlur={() => setEditingTextId(null)}
          />
        )}
        {el.type === 'text' && (
          <div
            className={`whiteboard-text ${editingTextId === el.id ? 'whiteboard-text--editing' : ''}`}
            style={{
              color: (el as WhiteboardTextElement).color,
              fontSize: (el as WhiteboardTextElement).fontSize * viewport.zoom,
              fontWeight: (el as WhiteboardTextElement).fontWeight,
              fontStyle: (el as WhiteboardTextElement).fontStyle,
              textAlign: (el as WhiteboardTextElement).textAlign,
            }}
          >
            {editingTextId === el.id ? (
              <textarea
                autoFocus
                value={(el as WhiteboardTextElement).text}
                onChange={(e) => wb.updateElement(el.id, { text: e.target.value } as Partial<WhiteboardTextElement>)}
                onBlur={() => setEditingTextId(null)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setEditingTextId(null);
                  e.stopPropagation();
                }}
              />
            ) : (
              <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {(el as WhiteboardTextElement).text || 'Double-click to edit'}
              </span>
            )}
          </div>
        )}
        {el.type === 'image' && (
          <div className="whiteboard-image" style={{ borderRadius: (el as WhiteboardImageElement).borderRadius }}>
            <img
              src={(el as WhiteboardImageElement).src}
              style={{ objectFit: (el as WhiteboardImageElement).objectFit }}
              alt=""
              draggable={false}
            />
          </div>
        )}

        {/* Connector anchor points */}
        {(isHovered || isSelected) && interaction.tool === 'connector' && (
          <div className="whiteboard-element__anchor-points">
            {['top', 'right', 'bottom', 'left'].map(anchor => (
              <div key={anchor} className={`whiteboard-element__anchor whiteboard-element__anchor--${anchor} hover-reveal`} />
            ))}
          </div>
        )}
      </div>
    );
  }, [interaction, viewport, editingTextId, wb, onDoubleClick]);

  // ─── Render strokes SVG ───────────────────────────────────────────

  const renderStrokes = useMemo(() => {
    const strokeElements = data.elements.filter(el => el.type === 'stroke') as WhiteboardStrokeElement[];
    const lineElements = data.elements.filter(el => el.type === 'line') as WhiteboardLineElement[];
    const isEraserMode = interaction.isDrawing && interaction.tool === 'eraser';
    return (
      <svg className="whiteboard-view__strokes-svg">
        <g transform={`translate(${viewport.x}, ${viewport.y}) scale(${viewport.zoom})`}>
          {/* Completed line elements */}
          {lineElements.map(line => {
            const isSelected = interaction.selectedIds.has(line.id);
            const isMarkedForDeletion = isEraserMode && interaction.eraserMarkedIds.has(line.id);
            const dimmed = (interaction.selectedIds.size > 0 && !isSelected) || (isEraserMode && !isMarkedForDeletion);
            const ssLineClass = line.strokeStyle === 'dashed' ? 'wb-ss-dashed' : line.strokeStyle === 'dotted' ? 'wb-ss-dotted' : '';
            return (
              <line
                key={line.id}
                x1={line.lineFlipped ? line.x + line.width : line.x}
                y1={line.y}
                x2={line.lineFlipped ? line.x : line.x + line.width}
                y2={line.y + line.height}
                stroke={isMarkedForDeletion ? 'var(--color-error)' : line.stroke}
                strokeWidth={line.strokeWidth}
                className={ssLineClass || undefined}
                strokeLinecap="round"
                opacity={dimmed ? 0.35 : line.opacity}
                style={{ transition: 'opacity var(--motion-duration-medium) var(--motion-easing-standard)' }}
              />
            );
          })}
          {strokeElements.map(stroke => {
            const isStrokeSelected = interaction.selectedIds.has(stroke.id);
            const isMarkedForDeletion = isEraserMode && interaction.eraserMarkedIds.has(stroke.id);
            const isStrokeDimmed =
              (interaction.selectedIds.size > 0 && !isStrokeSelected) ||
              (isEraserMode && !isMarkedForDeletion);
            return (
              <WhiteboardStrokeRenderer
                key={stroke.id}
                element={stroke}
                isSelected={isStrokeSelected}
                dimmed={isStrokeDimmed}
              />
            );
          })}
          {/* Live pen/highlighter stroke is rendered imperatively via livePathRef (see JSX below) */}
        </g>
      </svg>
    );
  }, [data.elements, viewport, interaction, wb.settings]);

  // ─── Render connectors SVG ────────────────────────────────────────

  const renderConnectors = useMemo(() => {
    const connectors = data.elements.filter(el => el.type === 'connector') as WhiteboardConnectorElement[];
    const isEraserMode = interaction.isDrawing && interaction.tool === 'eraser';

    const getEndpointPos = (endpoint: ConnectorEndpoint): Point => {
      if (endpoint.type === 'point') return { x: endpoint.x, y: endpoint.y };
      const el = data.elements.find(e => e.id === endpoint.elementId);
      if (!el) return { x: 0, y: 0 };
      switch (endpoint.anchor) {
        case 'top': return { x: el.x + el.width / 2, y: el.y };
        case 'right': return { x: el.x + el.width, y: el.y + el.height / 2 };
        case 'bottom': return { x: el.x + el.width / 2, y: el.y + el.height };
        case 'left': return { x: el.x, y: el.y + el.height / 2 };
        default: return { x: el.x + el.width / 2, y: el.y + el.height / 2 };
      }
    };

    return (
      <svg className="whiteboard-view__strokes-svg" style={{ zIndex: 3 }}>
        <defs>
          <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">
            <polygon points="0 0, 10 3.5, 0 7" fill="var(--text-primary)" />
          </marker>
          <marker id="arrowhead-start" markerWidth="10" markerHeight="7" refX="0" refY="3.5" orient="auto-start-reverse">
            <polygon points="0 0, 10 3.5, 0 7" fill="var(--text-primary)" />
          </marker>
        </defs>
        <g transform={`translate(${viewport.x}, ${viewport.y}) scale(${viewport.zoom})`}>
          {connectors.map(conn => {
            const start = getEndpointPos(conn.start);
            const end = getEndpointPos(conn.end);
            const isSelected = interaction.selectedIds.has(conn.id);

            let pathD: string;
            if (conn.pathType === 'curved') {
              const dx = end.x - start.x;
              const cx1 = start.x + dx * 0.25;
              const cy1 = start.y;
              const cx2 = end.x - dx * 0.25;
              const cy2 = end.y;
              pathD = `M ${start.x} ${start.y} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${end.x} ${end.y}`;
            } else if (conn.pathType === 'elbow') {
              const mx = (start.x + end.x) / 2;
              pathD = `M ${start.x} ${start.y} L ${mx} ${start.y} L ${mx} ${end.y} L ${end.x} ${end.y}`;
            } else {
              pathD = `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
            }

            const ssConnClass = conn.strokeStyle === 'dashed' ? 'wb-ss-dashed' : conn.strokeStyle === 'dotted' ? 'wb-ss-dotted' : '';

            const isMarkedForDeletion = isEraserMode && interaction.eraserMarkedIds.has(conn.id);
            const dimmed = (interaction.selectedIds.size > 0 && !isSelected) || (isEraserMode && !isMarkedForDeletion);
            const connColor = isMarkedForDeletion ? 'var(--color-error)' : isSelected ? 'var(--accent-primary)' : conn.stroke;
            const showStartDot = conn.start.type === 'element' && conn.start.anchor !== 'center';
            const showEndDot = conn.end.type === 'element' && conn.end.anchor !== 'center';
            const dotR = Math.max(3, conn.strokeWidth + 1);

            return (
              <g key={conn.id} opacity={dimmed ? 0.35 : 1} style={{ transition: 'opacity var(--motion-duration-medium) var(--motion-easing-standard)' }}>
                {/* Hit target (wider invisible stroke) */}
                <path
                  d={pathD}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={Math.max(conn.strokeWidth + 10, 15)}
                  style={{ pointerEvents: isEraserMode ? 'none' : 'stroke', cursor: 'pointer' }}
                  onClick={() => wb.selectElements([conn.id])}
                />
                <path
                  d={pathD}
                  fill="none"
                  stroke={connColor}
                  strokeWidth={conn.strokeWidth}
                  className={ssConnClass || undefined}
                  markerEnd={conn.endArrowhead !== 'none' ? 'url(#arrowhead)' : undefined}
                  markerStart={conn.startArrowhead !== 'none' ? 'url(#arrowhead-start)' : undefined}
                />
                {/* Border attachment circles */}
                {showStartDot && (
                  <circle cx={start.x} cy={start.y} r={dotR} fill={connColor} style={{ pointerEvents: 'none' }} />
                )}
                {showEndDot && (
                  <circle cx={end.x} cy={end.y} r={dotR} fill={connColor} style={{ pointerEvents: 'none' }} />
                )}
                {conn.label && (
                  <text
                    x={(start.x + end.x) / 2}
                    y={(start.y + end.y) / 2 - 8}
                    textAnchor="middle"
                    fill="var(--text-secondary)"
                    fontSize="12"
                    style={{ pointerEvents: 'none' }}
                  >
                    {conn.label}
                  </text>
                )}
              </g>
            );
          })}
          {/* Connector being created — rendered imperatively via liveConnectorRef above */}
        </g>
      </svg>
    );
  }, [data.elements, viewport, interaction, wb, screenToCanvas]);

  // ─── Render ───────────────────────────────────────────────────────

  return (
    <div
      ref={containerRef}
      className={`whiteboard-view__canvas ${cursorClass}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onWheel={handleWheel}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      onPointerLeave={() => { if (eraserCursorRef.current) eraserCursorRef.current.setAttribute('r', '0'); }}
      tabIndex={0}
    >
      {/* Search bar */}
      {isSearchOpen && (
        <div className="wb-search-bar" style={{ position: 'absolute', top: 12, right: 12, zIndex: 'var(--wb-z-overlay)' }}>
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search canvas..."
            className="wb-search-bar__input"
            autoFocus
          />
          <span className="wb-search-bar__count">
            {searchMatchIds.size} match{searchMatchIds.size !== 1 ? 'es' : ''}
          </span>
        </div>
      )}

      {/* Keyboard shortcuts modal */}
      {showShortcuts && (
        <div className="wb-shortcuts-modal" style={{ position: 'absolute', inset: 0, zIndex: 'var(--wb-z-overlay)', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.3)' }} onClick={() => setShowShortcuts(false)}>
          <div className="wb-shortcuts-modal__content" style={{ background: 'var(--color-surface)', borderRadius: 'var(--shape-large)', padding: 24, maxWidth: 480, width: '90%', boxShadow: 'var(--shadow-3)' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Keyboard Shortcuts</h3>
              <Button variant="ghost" size="xs" icon="mdi mdi-close" aria-label="Close shortcuts panel" className="wb-align-panel__btn" onClick={() => setShowShortcuts(false)} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 24px', fontSize: 14 }}>
              <ShortcutRow keys="V" action="Select tool" />
              <ShortcutRow keys="R" action="Rectangle" />
              <ShortcutRow keys="O" action="Ellipse" />
              <ShortcutRow keys="P" action="Pen" />
              <ShortcutRow keys="T" action="Text" />
              <ShortcutRow keys="L" action="Connector" />
              <ShortcutRow keys="E" action="Eraser" />
              <ShortcutRow keys="G" action="Toggle grid" />
              <ShortcutRow keys="Ctrl + D" action="Duplicate" />
              <ShortcutRow keys="Ctrl + G" action="Group / Ungroup" />
              <ShortcutRow keys="Ctrl + C" action="Copy" />
              <ShortcutRow keys="Ctrl + V" action="Paste" />
              <ShortcutRow keys="Ctrl + F" action="Search canvas" />
              <ShortcutRow keys="Ctrl + +" action="Zoom in" />
              <ShortcutRow keys="Ctrl + -" action="Zoom out" />
              <ShortcutRow keys="Ctrl + 0" action="Reset zoom" />
              <ShortcutRow keys="Ctrl + 1" action="Zoom to fit" />
              <ShortcutRow keys="]" action="Bring to front" />
              <ShortcutRow keys="[" action="Send to back" />
              <ShortcutRow keys="Delete" action="Delete selection" />
              <ShortcutRow keys="Esc" action="Clear selection / close" />
              <ShortcutRow keys="?" action="This help" />
            </div>
          </div>
        </div>
      )}

      {/* Strokes SVG layer */}
      {renderStrokes}

      {/* Live pen/highlighter stroke and line — updated imperatively via RAF, bypassing React re-renders */}
      <svg className="whiteboard-view__strokes-svg" style={{ pointerEvents: 'none' }}>
        <g transform={`translate(${viewport.x}, ${viewport.y}) scale(${viewport.zoom})`}>
          <path
            ref={livePathRef}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <line
            ref={liveLineRef}
            x1="0" y1="0" x2="0" y2="0"
            strokeLinecap="round"
          />
          {/* Live connector line during creation — updated imperatively */}
          <line
            ref={liveConnectorRef}
            x1="0" y1="0" x2="0" y2="0"
            stroke="var(--accent-primary)"
            strokeWidth="2"
            strokeDasharray="5 3"
            strokeLinecap="round"
          />
          {/* Connector anchor hover indicator — updated imperatively */}
          <circle
            ref={connectorHoverCircleRef}
            cx="0" cy="0" r="0"
            fill="var(--accent-primary)"
            opacity="0.85"
          />
          {/* Eraser cursor circle — always visible, unaffected by element opacity dimming */}
          <circle
            ref={eraserCursorRef}
            cx="0" cy="0" r="0"
            fill="none"
            stroke="var(--color-on-surface)"
            strokeWidth="1.5"
            opacity="0.6"
          />
        </g>
      </svg>

      {/* Connectors SVG layer */}
      {renderConnectors}

      {/* Elements layer (DOM elements) */}
      <div className="whiteboard-view__elements">
        {/* Group bounding boxes — rendered below elements */}
        {renderGroups}
        {sortedElements
          .filter(el => el.type !== 'stroke' && el.type !== 'connector' && el.type !== 'line')
          .map(renderElement)}
      </div>

      {/* Selection bounds card — encompasses all selected items (including strokes) */}
      {selectionCardBounds && !interaction.isSelectionBox && (
        <div
          className="whiteboard-view__selection-card"
          style={{
            left: selectionCardBounds.left,
            top: selectionCardBounds.top,
            width: selectionCardBounds.width,
            height: selectionCardBounds.height,
          }}
        >
          {/* Resize handles — shown for any non-locked selection */}
          {(() => {
            const allLocked = [...interaction.selectedIds].every(id => data.elements.find(e => e.id === id)?.locked);
            return !allLocked && (
              <div className="whiteboard-element__resize-handles" style={{ inset: 0 }}>
                {['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map(handle => (
                  <div key={handle} className={`whiteboard-element__resize-handle whiteboard-element__resize-handle--${handle}`} />
                ))}
              </div>
            );
          })()}
          {/* Rotation handle — single element only */}
          {interaction.selectedIds.size === 1 && (() => {
            const id = [...interaction.selectedIds][0];
            const el = data.elements.find(e => e.id === id);
            if (!el || el.locked) return null;
            return (
              <div
                className="whiteboard-element__rotation-handle"
                style={{
                  left: '50%',
                  top: -30,
                  transform: 'translateX(-50%)',
                }}
              />
            );
          })()}
        </div>
      )}

      {/* Align / Distribute panel — 2+ selected elements */}
      {selectionCardBounds && interaction.selectedIds.size >= 2 && !interaction.isSelectionBox && (
        <div
          className="wb-align-panel"
          style={{
            left: selectionCardBounds.left + selectionCardBounds.width + 12,
            top: selectionCardBounds.top,
          }}
        >
          <div className="wb-align-panel__row">
            <Button variant="ghost" size="xs" icon="mdi mdi-align-horizontal-left" aria-label="Align left" className="wb-align-panel__btn" title="Align left" onClick={() => wb.alignElements([...interaction.selectedIds], 'left')} />
            <Button variant="ghost" size="xs" icon="mdi mdi-align-horizontal-center" aria-label="Align center" className="wb-align-panel__btn" title="Align center" onClick={() => wb.alignElements([...interaction.selectedIds], 'center')} />
            <Button variant="ghost" size="xs" icon="mdi mdi-align-horizontal-right" aria-label="Align right" className="wb-align-panel__btn" title="Align right" onClick={() => wb.alignElements([...interaction.selectedIds], 'right')} />
          </div>
          <div className="wb-align-panel__row">
            <Button variant="ghost" size="xs" icon="mdi mdi-align-vertical-top" aria-label="Align top" className="wb-align-panel__btn" title="Align top" onClick={() => wb.alignElements([...interaction.selectedIds], 'top')} />
            <Button variant="ghost" size="xs" icon="mdi mdi-align-vertical-center" aria-label="Align middle" className="wb-align-panel__btn" title="Align middle" onClick={() => wb.alignElements([...interaction.selectedIds], 'middle')} />
            <Button variant="ghost" size="xs" icon="mdi mdi-align-vertical-bottom" aria-label="Align bottom" className="wb-align-panel__btn" title="Align bottom" onClick={() => wb.alignElements([...interaction.selectedIds], 'bottom')} />
          </div>
          <div className="wb-align-panel__divider" />
          <div className="wb-align-panel__row">
            <Button variant="ghost" size="xs" icon="mdi mdi-distribute-horizontal-center" aria-label="Distribute horizontal" className="wb-align-panel__btn" title="Distribute horizontal" onClick={() => wb.distributeElements([...interaction.selectedIds], 'horizontal')} />
            <Button variant="ghost" size="xs" icon="mdi mdi-distribute-vertical-center" aria-label="Distribute vertical" className="wb-align-panel__btn" title="Distribute vertical" onClick={() => wb.distributeElements([...interaction.selectedIds], 'vertical')} />
          </div>
        </div>
      )}

      {/* Selection box */}
      {interaction.selectionBox && interaction.isSelectionBox && (
        <div
          className="whiteboard-view__selection-box"
          style={{
            left: interaction.selectionBox.x * viewport.zoom + viewport.x,
            top: interaction.selectionBox.y * viewport.zoom + viewport.y,
            width: interaction.selectionBox.width * viewport.zoom,
            height: interaction.selectionBox.height * viewport.zoom,
          }}
        />
      )}

      {/* Shape creation preview — live fainted shape */}
      {interaction.selectionBox && interaction.isDragging && !interaction.isSelectionBox && (() => {
        const isShift = shiftConstraint;
        const shapeMap: Record<string, string> = {
          rectangle: 'rectangle',
          ellipse: 'ellipse',
          triangle: isShift ? 'triangle-right' : 'triangle',
          hexagon: isShift ? 'hexagon-pointy' : 'hexagon',
          star: 'star',
          diamond: 'diamond',
          cylinder: 'cylinder',
          cloud: 'cloud',
          parallelogram: 'parallelogram',
          trapezoid: 'trapezoid',
          cross: 'cross',
          heart: 'heart',
          document: 'document',
        };
        const shapeType = shapeMap[interaction.tool];
        if (!shapeType) return null;
        const box = interaction.selectionBox;
        const sw = box.width * viewport.zoom;
        const sh = box.height * viewport.zoom;
        const sl = box.x * viewport.zoom + viewport.x;
        const st = box.y * viewport.zoom + viewport.y;
        const { fill, stroke, strokeWidth, strokeStyle, borderRadius } = wb.settings.shape;
        const ssPreviewClass = strokeStyle === 'dashed' ? 'wb-ss-dashed' : strokeStyle === 'dotted' ? 'wb-ss-dotted' : '';
        // Rectangle + Shift → rotate 45° in preview
        const previewRotation = isShift && interaction.tool === 'rectangle' ? 45 :
                                isShift && interaction.tool === 'diamond' ? 45 : 0;
        return (
          <div
            style={{
              position: 'absolute',
              left: sl,
              top: st,
              width: sw,
              height: sh,
              opacity: 0.45,
              pointerEvents: 'none',
              zIndex: 'var(--wb-z-overlay)' as any,
              transform: previewRotation ? `rotate(${previewRotation}deg)` : undefined,
            }}
          >
            <svg
              viewBox={`0 0 ${sw} ${sh}`}
              width={sw}
              height={sh}
              style={{ display: 'block', overflow: 'visible' }}
            >
              {shapeType === 'rectangle' ? (
                <rect
                  x={strokeWidth / 2}
                  y={strokeWidth / 2}
                  width={Math.max(0, sw - strokeWidth)}
                  height={Math.max(0, sh - strokeWidth)}
                  rx={borderRadius}
                  ry={borderRadius}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={strokeWidth}
                  className={ssPreviewClass || undefined}
                />
              ) : shapeType === 'ellipse' ? (
                <ellipse
                  cx={sw / 2}
                  cy={sh / 2}
                  rx={Math.max(0, (sw - strokeWidth) / 2)}
                  ry={Math.max(0, (sh - strokeWidth) / 2)}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={strokeWidth}
                  className={ssPreviewClass || undefined}
                />
              ) : (
                <path
                  d={getShapePath(shapeType as any, sw, sh)}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={strokeWidth}
                  className={ssPreviewClass || undefined}
                  strokeLinejoin="round"
                />
              )}
            </svg>
          </div>
        );
      })()}
    </div>
  );
};
