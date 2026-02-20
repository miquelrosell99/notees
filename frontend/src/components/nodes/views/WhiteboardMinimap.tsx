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
import type { Bounds } from '@/types/whiteboard';
import './WhiteboardView.css';

interface WhiteboardMinimapProps {
  wb: UseWhiteboardReturn;
}

const MINIMAP_WIDTH = 160;
const MINIMAP_HEIGHT = 100;
const MINIMAP_PADDING = 8;
const DRAG_THRESHOLD = 4;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 5;

export const WhiteboardMinimap: React.FC<WhiteboardMinimapProps> = ({ wb }) => {
  const { data } = wb;
  const containerRef = useRef<HTMLDivElement>(null);

  // Track the actual pixel size of the whiteboard canvas container
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const canvas = document.querySelector('.whiteboard-view__canvas');
    if (!canvas) return;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        setCanvasSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    ro.observe(canvas);
    // Capture initial size immediately
    const rect = canvas.getBoundingClientRect();
    setCanvasSize({ width: rect.width, height: rect.height });
    return () => ro.disconnect();
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
    const innerW = MINIMAP_WIDTH - MINIMAP_PADDING * 2;
    const innerH = MINIMAP_HEIGHT - MINIMAP_PADDING * 2;
    return Math.min(innerW / contentBounds.width, innerH / contentBounds.height);
  }, [contentBounds]);

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
    return {
      left:   topLeft.x,
      top:    topLeft.y,
      width:  worldW * scale,
      height: worldH * scale,
    };
  }, [data.viewport, worldToMinimap, scale, effectiveCanvas]);

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
      {/* Element dots */}
      {data.elements.map(el => {
        const pos = worldToMinimap(el.x, el.y);
        const w = el.width * scale;
        const h = el.height * scale;
        return (
          <div
            key={el.id}
            className="whiteboard-minimap__element"
            style={{
              left: pos.x,
              top: pos.y,
              width: Math.max(2, w),
              height: Math.max(2, h),
              backgroundColor: el.type === 'card' ? 'var(--accent-primary)' :
                               el.type === 'stroke' ? 'var(--text-primary)' :
                               'var(--text-tertiary)',
            }}
          />
        );
      })}

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
