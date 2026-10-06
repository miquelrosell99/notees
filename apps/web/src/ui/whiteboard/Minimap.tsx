/**
 * WhiteboardMinimap — the overview/navigation surface of the fullscreen
 * canvas. Always shows the full element bounding box
 * plus a rectangle for the visible world region; click or drag navigates by
 * centering the viewport on the pointed world position. Pure view state —
 * the minimap never writes geometry (device state is never an op).
 */

import type { PointerEvent as ReactPointerEvent } from "react";

import type { WhiteboardLayout } from "../whiteboard-layout.js";
import { layoutBounds, strokeBounds, type WorldRect } from "./geometry.js";

export const MINIMAP_W = 160;
export const MINIMAP_H = 110;
const MINIMAP_PADDING = 48;
const MIN_VIEWPORT = 40;

export interface WhiteboardMinimapProps {
  layout: WhiteboardLayout;
  /** Card ids currently rendered on the canvas (geometry hit keys). */
  renderedCardIds: readonly string[];
  /** Current viewport: screen offset (x, y) and zoom k. */
  viewport: { x: number; y: number; k: number };
  /** Visible surface size in screen px (0×0 in jsdom — math guards below). */
  surfaceW: number;
  surfaceH: number;
  /** Center the viewport on a world point. */
  onNavigate: (world: { x: number; y: number }) => void;
}

function scaleFor(bounds: WorldRect): number {
  const w = bounds.w <= 0 ? MIN_VIEWPORT : bounds.w;
  const h = bounds.h <= 0 ? MIN_VIEWPORT : bounds.h;
  return Math.min(
    MINIMAP_W / (w + MINIMAP_PADDING * 2),
    MINIMAP_H / (h + MINIMAP_PADDING * 2),
  );
}

export function WhiteboardMinimap({
  layout,
  renderedCardIds,
  viewport,
  surfaceW,
  surfaceH,
  onNavigate,
}: WhiteboardMinimapProps) {
  const rawBounds = layoutBounds(layout, renderedCardIds);
  const bounds: WorldRect = rawBounds ?? { x: -MINIMAP_PADDING, y: -MINIMAP_PADDING, w: MIN_VIEWPORT, h: MIN_VIEWPORT };
  const scale = scaleFor(bounds);
  const originX = bounds.x - MINIMAP_PADDING;
  const originY = bounds.y - MINIMAP_PADDING;
  const toMapX = (worldX: number) => (worldX - originX) * scale;
  const toMapY = (worldY: number) => (worldY - originY) * scale;

  // Visible world region: the surface rect expressed in world units.
  const viewWorldW = surfaceW > 0 ? surfaceW / viewport.k : MIN_VIEWPORT;
  const viewWorldH = surfaceH > 0 ? surfaceH / viewport.k : MIN_VIEWPORT;
  const viewX = -viewport.x / viewport.k;
  const viewY = -viewport.y / viewport.k;

  const navigate = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const worldX = originX + (event.clientX - rect.left) / scale;
    const worldY = originY + (event.clientY - rect.top) / scale;
    onNavigate({ x: worldX, y: worldY });
  };

  return (
    <div
      className="nt-wb-minimap"
      style={{ width: MINIMAP_W, height: MINIMAP_H }}
      data-testid="whiteboard-minimap"
      role="presentation"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        try {
          event.currentTarget.setPointerCapture?.(event.pointerId);
        } catch {
          // jsdom has no PointerEvent capture
        }
        navigate(event);
      }}
      onPointerMove={(event) => {
        // Drag navigates (pointer capture keeps the events flowing).
        if (event.buttons !== 1) return;
        navigate(event);
      }}
    >
      <svg width={MINIMAP_W} height={MINIMAP_H} aria-hidden="true">
        {renderedCardIds.map((id) => {
          const geometry = layout.cards[id];
          if (geometry === undefined) return null;
          return (
            <rect
              key={id}
              className="nt-wb-minimap-card"
              x={toMapX(geometry.x)}
              y={toMapY(geometry.y)}
              width={Math.max(geometry.w * scale, 2)}
              height={Math.max(geometry.h * scale, 2)}
            />
          );
        })}
        {layout.shapes.map((shape) =>
          shape.kind === "ellipse" ? (
            <ellipse
              key={shape.id}
              className="nt-wb-minimap-shape"
              cx={toMapX(shape.x + shape.w / 2)}
              cy={toMapY(shape.y + shape.h / 2)}
              rx={Math.max(Math.abs(shape.w / 2) * scale, 1)}
              ry={Math.max(Math.abs(shape.h / 2) * scale, 1)}
            />
          ) : (
            <rect
              key={shape.id}
              className="nt-wb-minimap-shape"
              x={toMapX(Math.min(shape.x, shape.x + shape.w))}
              y={toMapY(Math.min(shape.y, shape.y + shape.h))}
              width={Math.max(Math.abs(shape.w) * scale, 1)}
              height={Math.max(Math.abs(shape.h) * scale, 1)}
            />
          ),
        )}
        {layout.strokes.map((stroke) => {
          const b = strokeBounds(stroke.points);
          if (b === null) return null;
          return (
            <rect
              key={stroke.id}
              className="nt-wb-minimap-shape"
              x={toMapX(b.x)}
              y={toMapY(b.y)}
              width={Math.max(b.w * scale, 1)}
              height={Math.max(b.h * scale, 1)}
            />
          );
        })}
        <rect
          className="nt-wb-minimap-viewport"
          x={toMapX(viewX)}
          y={toMapY(viewY)}
          width={Math.max(viewWorldW * scale, 3)}
          height={Math.max(viewWorldH * scale, 3)}
        />
      </svg>
    </div>
  );
}
