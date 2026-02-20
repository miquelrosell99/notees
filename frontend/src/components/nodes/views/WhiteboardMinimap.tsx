/**
 * WhiteboardMinimap — Small overview of the entire whiteboard showing
 * element positions and the current viewport.
 */
import React, { useMemo, useCallback, useRef } from 'react';
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

export const WhiteboardMinimap: React.FC<WhiteboardMinimapProps> = ({ wb }) => {
  const { data } = wb;
  const containerRef = useRef<HTMLDivElement>(null);

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

  // Viewport rectangle in minimap coords
  const viewportRect = useMemo(() => {
    const canvasW = window.innerWidth - 300;
    const canvasH = window.innerHeight - 100;
    const worldX = -data.viewport.x / data.viewport.zoom;
    const worldY = -data.viewport.y / data.viewport.zoom;
    const worldW = canvasW / data.viewport.zoom;
    const worldH = canvasH / data.viewport.zoom;
    const topLeft = worldToMinimap(worldX, worldY);
    return {
      left: topLeft.x,
      top: topLeft.y,
      width: worldW * scale,
      height: worldH * scale,
    };
  }, [data.viewport, worldToMinimap, scale]);

  /** Center viewport on a minimap pixel position */
  const centerOnMinimapPos = useCallback((mx: number, my: number) => {
    const worldX = (mx - MINIMAP_PADDING) / scale + contentBounds.x;
    const worldY = (my - MINIMAP_PADDING) / scale + contentBounds.y;
    const canvasW = window.innerWidth - 300;
    const canvasH = window.innerHeight - 100;
    wb.setViewport({
      x: -worldX * data.viewport.zoom + canvasW / 2,
      y: -worldY * data.viewport.zoom + canvasH / 2,
      zoom: data.viewport.zoom,
    });
  }, [scale, contentBounds, data.viewport, wb]);

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

    const worldDx = dmx / scale;
    const worldDy = dmy / scale;
    const vp = wb.data.viewport;
    wb.setViewport({
      ...vp,
      x: vp.x - worldDx * vp.zoom,
      y: vp.y - worldDy * vp.zoom,
    });
  }, [scale, wb]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const ds = dragState.current;
    if (e.pointerId !== ds.pointerId) return;
    ds.isDown = false;
    e.currentTarget.releasePointerCapture(e.pointerId);

    if (!ds.hasDragged) {
      // Pure click → center viewport
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      centerOnMinimapPos(e.clientX - rect.left, e.clientY - rect.top);
    }
  }, [centerOnMinimapPos]);

  if (data.elements.length === 0) return null;

  return (
    <div
      ref={containerRef}
      className="whiteboard-minimap"
      style={{ cursor: 'crosshair' }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
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
