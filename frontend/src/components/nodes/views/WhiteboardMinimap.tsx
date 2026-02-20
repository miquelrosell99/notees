/**
 * WhiteboardMinimap — Small overview of the entire whiteboard showing
 * element positions and the current viewport.
 *
 * The map always represents the full elements bounding box.
 * The viewport rectangle reflects the currently visible canvas portion.
 * Scrolling on the minimap zooms the viewport centered on the pointer's
 * world position.
 */
import React, { useMemo, useCallback, useRef, useState, useEffect } from 'react';
import type { UseWhiteboardReturn } from '@/hooks/useWhiteboard';
import type {
  Bounds,
  WhiteboardElement,
  WhiteboardShapeElement,
  WhiteboardStrokeElement,
  WhiteboardTextElement,
  WhiteboardConnectorElement,
  WhiteboardLineElement,
} from '@/types/whiteboard';
import './WhiteboardView.css';

interface WhiteboardMinimapProps {
  wb: UseWhiteboardReturn;
}

const MINIMAP_WIDTH = 240;
const MINIMAP_HEIGHT = 150;
const MINIMAP_PADDING = 8;
const DRAG_THRESHOLD = 4;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 5;

// Canvas renders at very low resolution → displayed large → chunky blob-of-pixels look
const CANVAS_W = 20;
const CANVAS_H = 12;
const CANVAS_PADDING = 1;

/** Resolve a CSS variable string to a hex/rgb color. */
function resolveCssVar(value: string): string {
  const m = value.match(/var\((--[\w-]+)\)/);
  if (!m) return value;
  return getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim() || value;
}

/** Draw all whiteboard elements to a canvas at the minimap's low resolution. */
function drawMinimapCanvas(
  ctx: CanvasRenderingContext2D,
  elements: WhiteboardElement[],
  contentBounds: Bounds,
) {
  const drawScale = Math.min(
    (CANVAS_W - CANVAS_PADDING * 2) / contentBounds.width,
    (CANVAS_H - CANVAS_PADDING * 2) / contentBounds.height,
  );

  const toX = (wx: number) => (wx - contentBounds.x) * drawScale + CANVAS_PADDING;
  const toY = (wy: number) => (wy - contentBounds.y) * drawScale + CANVAS_PADDING;
  const toW = (w: number) => w * drawScale;
  const toH = (h: number) => h * drawScale;

  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

  const sorted = [...elements].sort((a, b) => a.zIndex - b.zIndex);

  for (const el of sorted) {
    const x = toX(el.x);
    const y = toY(el.y);
    const w = Math.max(1, toW(el.width));
    const h = Math.max(1, toH(el.height));

    ctx.save();
    ctx.globalAlpha = el.opacity ?? 1;

    if (el.type === 'card') {
      ctx.fillStyle = el.color ? resolveCssVar(el.color) : resolveCssVar('var(--color-surface-container)');
      ctx.strokeStyle = resolveCssVar('var(--color-outline-variant)');
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      const r = Math.min(2, w / 4, h / 4);
      ctx.roundRect(x, y, w, h, r);
      ctx.fill();
      ctx.stroke();

    } else if (el.type === 'shape') {
      const shape = el as WhiteboardShapeElement;
      ctx.fillStyle = shape.fill === 'transparent' ? 'transparent' : resolveCssVar(shape.fill);
      ctx.strokeStyle = resolveCssVar(shape.stroke);
      ctx.lineWidth = Math.max(0.5, shape.strokeWidth * drawScale * 0.3);
      ctx.beginPath();
      switch (shape.shapeType) {
        case 'ellipse':
          ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
          break;
        case 'triangle':
          ctx.moveTo(x + w / 2, y);
          ctx.lineTo(x + w, y + h);
          ctx.lineTo(x, y + h);
          ctx.closePath();
          break;
        case 'triangle-right':
          ctx.moveTo(x, y);
          ctx.lineTo(x + w, y + h);
          ctx.lineTo(x, y + h);
          ctx.closePath();
          break;
        case 'hexagon': {
          const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2;
          for (let i = 0; i < 6; i++) {
            const a = (Math.PI / 3) * i - Math.PI / 6;
            i === 0 ? ctx.moveTo(cx + rx * Math.cos(a), cy + ry * Math.sin(a))
                    : ctx.lineTo(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
          }
          ctx.closePath();
          break;
        }
        case 'star': {
          const cx = x + w / 2, cy = y + h / 2, or = w / 2, ir = or * 0.4;
          for (let i = 0; i < 10; i++) {
            const a = (Math.PI / 5) * i - Math.PI / 2;
            const r2 = i % 2 === 0 ? or : ir;
            i === 0 ? ctx.moveTo(cx + r2 * Math.cos(a), cy + r2 * Math.sin(a))
                    : ctx.lineTo(cx + r2 * Math.cos(a), cy + r2 * Math.sin(a));
          }
          ctx.closePath();
          break;
        }
        default: {
          const br = Math.min(shape.borderRadius * drawScale * 0.3, w / 4, h / 4);
          ctx.roundRect(x, y, w, h, br);
        }
      }
      if (shape.fill !== 'transparent') ctx.fill();
      ctx.stroke();

    } else if (el.type === 'stroke') {
      const stroke = el as WhiteboardStrokeElement;
      if (stroke.points.length < 2) { ctx.restore(); continue; }
      ctx.strokeStyle = resolveCssVar(stroke.color);
      ctx.lineWidth = Math.max(0.5, stroke.strokeWidth * drawScale * 0.4);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.globalAlpha = (el.opacity ?? 1) * (stroke.tool === 'highlighter' ? 0.5 : 1);
      ctx.beginPath();
      const p0 = stroke.points[0];
      ctx.moveTo(toX(el.x + p0.x), toY(el.y + p0.y));
      for (let i = 1; i < stroke.points.length; i++) {
        const p = stroke.points[i];
        ctx.lineTo(toX(el.x + p.x), toY(el.y + p.y));
      }
      ctx.stroke();

    } else if (el.type === 'text') {
      const text = el as WhiteboardTextElement;
      ctx.fillStyle = resolveCssVar(text.color || 'var(--color-on-surface)');
      // Draw tiny text-block lines suggestion
      const lineH = Math.max(1, toH(text.fontSize * 1.4));
      const lines = Math.max(1, Math.round(h / lineH));
      for (let i = 0; i < lines; i++) {
        const ly = y + i * lineH;
        const lw = i === lines - 1 ? w * 0.6 : w;
        ctx.fillRect(x, ly, lw, Math.max(0.5, lineH * 0.5));
      }

    } else if (el.type === 'connector') {
      const conn = el as WhiteboardConnectorElement;
      ctx.strokeStyle = resolveCssVar(conn.stroke);
      ctx.lineWidth = Math.max(0.5, conn.strokeWidth * drawScale * 0.3);
      ctx.lineCap = 'round';
      ctx.beginPath();
      // For the minimap just draw bounding-box diagonal
      ctx.moveTo(x, y);
      ctx.lineTo(x + w, y + h);
      ctx.stroke();

    } else if (el.type === 'line') {
      const line = el as WhiteboardLineElement;
      ctx.strokeStyle = resolveCssVar(line.stroke);
      ctx.lineWidth = Math.max(0.5, line.strokeWidth * drawScale * 0.3);
      ctx.lineCap = 'round';
      ctx.beginPath();
      if (line.lineFlipped) {
        ctx.moveTo(x + w, y);
        ctx.lineTo(x, y + h);
      } else {
        ctx.moveTo(x, y);
        ctx.lineTo(x + w, y + h);
      }
      ctx.stroke();

    } else if (el.type === 'image') {
      // Checkered placeholder
      ctx.fillStyle = resolveCssVar('var(--color-surface-variant)');
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = resolveCssVar('var(--color-outline-variant)');
      const tileSize = Math.max(1, Math.min(w, h) / 4);
      for (let ty = 0; ty * tileSize < h; ty++) {
        for (let tx = 0; tx * tileSize < w; tx++) {
          if ((tx + ty) % 2 === 0) {
            ctx.fillRect(
              x + tx * tileSize, y + ty * tileSize,
              Math.min(tileSize, w - tx * tileSize),
              Math.min(tileSize, h - ty * tileSize),
            );
          }
        }
      }
    }

    ctx.restore();
  }
}

export const WhiteboardMinimap: React.FC<WhiteboardMinimapProps> = ({ wb }) => {
  const { data } = wb;
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Track the actual pixel size of the minimap container itself
  const [minimapSize, setMinimapSize] = useState({ width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT });

  // Track the actual pixel size of the whiteboard canvas container
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  // One effect: observe both the minimap widget and its ancestor whiteboard view.
  // Using containerRef for both avoids document.querySelector, which can find
  // elements from other whiteboard instances and returns stale sizes after resizes.
  useEffect(() => {
    const minimapEl = containerRef.current;
    if (!minimapEl) return;

    // The minimap is inside .whiteboard-view — use that as the canvas size source
    const viewEl = minimapEl.closest('.whiteboard-view') as HTMLElement | null;

    const roMinimap = new ResizeObserver(entries => {
      for (const entry of entries) {
        setMinimapSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    roMinimap.observe(minimapEl);
    // Capture initial sizes synchronously before the browser paints again
    const mmRect = minimapEl.getBoundingClientRect();
    if (mmRect.width > 0) setMinimapSize({ width: mmRect.width, height: mmRect.height });

    const roCanvas = viewEl ? new ResizeObserver(entries => {
      for (const entry of entries) {
        setCanvasSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    }) : null;
    if (viewEl) {
      roCanvas!.observe(viewEl);
      const vRect = viewEl.getBoundingClientRect();
      if (vRect.width > 0) setCanvasSize({ width: vRect.width, height: vRect.height });
    }

    return () => {
      roMinimap.disconnect();
      roCanvas?.disconnect();
    };
  }, []);

  // Tracks pointer state for click-vs-drag distinction
  const dragState = useRef({
    isDown: false,
    hasDragged: false,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    pointerId: -1,
  });

  // Compute content bounds
  const contentBounds = useMemo((): Bounds => {
    if (data.elements.length === 0) {
      return { x: -500, y: -300, width: 1000, height: 600 };
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of data.elements) {
      minX = Math.min(minX, el.x);
      minY = Math.min(minY, el.y);
      maxX = Math.max(maxX, el.x + el.width);
      maxY = Math.max(maxY, el.y + el.height);
    }
    const pad = 100;
    return {
      x: minX - pad,
      y: minY - pad,
      width: maxX - minX + pad * 2,
      height: maxY - minY + pad * 2,
    };
  }, [data.elements]);

  // Scale from world coordinates to minimap coordinates
  const scale = useMemo(() => {
    const innerW = minimapSize.width - MINIMAP_PADDING * 2;
    const innerH = minimapSize.height - MINIMAP_PADDING * 2;
    return Math.min(innerW / contentBounds.width, innerH / contentBounds.height);
  }, [contentBounds, minimapSize]);

  // Re-render the low-res canvas preview whenever elements or bounds change
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    drawMinimapCanvas(ctx, data.elements, contentBounds);
  }, [data.elements, contentBounds]);

  // Convert world coord to minimap coord
  const worldToMinimap = useCallback((wx: number, wy: number) => ({
    x: (wx - contentBounds.x) * scale + MINIMAP_PADDING,
    y: (wy - contentBounds.y) * scale + MINIMAP_PADDING,
  }), [contentBounds, scale]);

  // Convert minimap coord to world coord
  const minimapToWorld = useCallback((mx: number, my: number) => ({
    x: (mx - MINIMAP_PADDING) / scale + contentBounds.x,
    y: (my - MINIMAP_PADDING) / scale + contentBounds.y,
  }), [contentBounds, scale]);

  // Effective canvas size (fallback if ResizeObserver hasn't fired yet)
  const effectiveCanvas = useMemo(() => ({
    width:  canvasSize.width  > 0 ? canvasSize.width  : window.innerWidth  - 240,
    height: canvasSize.height > 0 ? canvasSize.height : window.innerHeight - 60,
  }), [canvasSize]);

  // Viewport rectangle in minimap coords — size adapts to the currently visible portion
  const viewportRect = useMemo(() => {
    const { width: canvasW, height: canvasH } = effectiveCanvas;
    const vp = data.viewport;
    const worldX = -vp.x / vp.zoom;
    const worldY = -vp.y / vp.zoom;
    const worldW = canvasW / vp.zoom;
    const worldH = canvasH / vp.zoom;
    const topLeft = worldToMinimap(worldX, worldY);

    // Keep a gap between the viewport rect and the minimap border
    const BORDER = 3;
    const minLeft = BORDER;
    const minTop = BORDER;
    const maxRight = minimapSize.width - BORDER;
    const maxBottom = minimapSize.height - BORDER;

    const rawLeft = topLeft.x;
    const rawTop  = topLeft.y;
    const rawRight  = rawLeft + worldW * scale;
    const rawBottom = rawTop  + worldH * scale;

    const left   = Math.max(minLeft, rawLeft);
    const top    = Math.max(minTop,  rawTop);
    const right  = Math.min(maxRight,  rawRight);
    const bottom = Math.min(maxBottom, rawBottom);

    return {
      left,
      top,
      width:  Math.max(0, right  - left),
      height: Math.max(0, bottom - top),
    };
  }, [data.viewport, worldToMinimap, scale, effectiveCanvas, minimapSize]);

  /** Pan the viewport so that a world point is centered in the canvas. */
  const centerOnMinimapPos = useCallback((mx: number, my: number) => {
    const { x: worldX, y: worldY } = minimapToWorld(mx, my);
    const { width: canvasW, height: canvasH } = effectiveCanvas;
    const vp = data.viewport;
    wb.setViewport({
      x: -worldX * vp.zoom + canvasW / 2,
      y: -worldY * vp.zoom + canvasH / 2,
      zoom: vp.zoom,
    });
  }, [minimapToWorld, data.viewport, wb, effectiveCanvas]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    dragState.current = {
      isDown: true,
      hasDragged: false,
      startX: mx,
      startY: my,
      lastX: mx,
      lastY: my,
      pointerId: e.pointerId,
    };
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const ds = dragState.current;
    if (!ds.isDown || e.pointerId !== ds.pointerId) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const totalDx = mx - ds.startX;
    const totalDy = my - ds.startY;
    if (!ds.hasDragged && Math.sqrt(totalDx * totalDx + totalDy * totalDy) < DRAG_THRESHOLD) return;
    ds.hasDragged = true;

    // Delta since last move → pan in world space
    const dmx = mx - ds.lastX;
    const dmy = my - ds.lastY;
    ds.lastX = mx;
    ds.lastY = my;

    const vp = wb.data.viewport;
    wb.setViewport({
      ...vp,
      x: vp.x - (dmx / scale) * vp.zoom,
      y: vp.y - (dmy / scale) * vp.zoom,
    });
  }, [scale, wb]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const ds = dragState.current;
    if (e.pointerId !== ds.pointerId) return;
    ds.isDown = false;
    e.currentTarget.releasePointerCapture(e.pointerId);

    if (!ds.hasDragged) {
      // Pure click → center viewport on clicked world position
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      centerOnMinimapPos(e.clientX - rect.left, e.clientY - rect.top);
    }
  }, [centerOnMinimapPos]);

  /**
   * Zoom the viewport centered on the world point under the minimap pointer.
   *
   * Derivation: viewport maps world → screen as: screen = world * zoom + vp
   * To keep the hovered world point at the same screen pos after zoom change:
   *   newVp = vp + worldPos * (oldZoom - newZoom)
   */
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const { x: worldX, y: worldY } = minimapToWorld(mx, my);

    const vp = wb.data.viewport;
    const zoomFactor = Math.pow(0.999, e.deltaY);
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, vp.zoom * zoomFactor));

    wb.setViewport({
      x: vp.x + worldX * (vp.zoom - newZoom),
      y: vp.y + worldY * (vp.zoom - newZoom),
      zoom: newZoom,
    });
  }, [minimapToWorld, wb]);

  if (data.elements.length === 0) return null;

  return (
    <div
      ref={containerRef}
      className="whiteboard-minimap"
      style={{ cursor: 'crosshair' }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onWheel={handleWheel}
    >
      {/* Low-res pixelated canvas preview */}
      <canvas
        ref={canvasRef}
        width={CANVAS_W}
        height={CANVAS_H}
        className="whiteboard-minimap__canvas"
      />

      {/* Viewport indicator */}
      <div
        className="whiteboard-minimap__viewport"
        style={{
          left: viewportRect.left,
          top: viewportRect.top,
          width: viewportRect.width,
          height: viewportRect.height,
        }}
      />
    </div>
  );
};
