/**
 * TimelineRenderer – Imperative canvas renderer for TimelineView.
 *
 * Encapsulates all 2D canvas drawing logic:
 * - Time markers (day / week / month / quarter / year / decade)
 * - Timeline center line
 * - Event circles with connector lines and hover/selected halos
 * - Node-count labels on hover
 * - Minimap with view zone and resize handles
 *
 * Keeps the React component thin: this class is pure rendering,
 * the component owns animation state (marker opacity fade, rAF loop).
 */

import type { TimeEvent, TimelineTransform } from './timelineTypes';

export const EVENT_RADIUS_MIN = 4;
export const EVENT_RADIUS_MAX = 12;
export const EVENT_STACK_SPACING = 18;
export const EVENT_OFFSET = 25;
export const MINIMAP_HEIGHT = 60;

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 10;
export const ZOOM_SPEED_WHEEL = 0.002;
export const ZOOM_SPEED_PINCH = 0.01;

export interface TimelineMarker {
  x: number;
  date: Date;
  interval: number;
}

export interface TimelineDrawResult {
  markers: TimelineMarker[];
  visibleDays: number;
}

export interface TimelineColors {
  text: string;
  textSecondary: string;
  outline: string;
  onSurface: string;
}

function readColors(el: Element): TimelineColors {
  const st = getComputedStyle(el);
  const g = (v: string) => st.getPropertyValue(v).trim();
  return {
    text: g('--color-on-surface-variant') || '#a3a3a3',
    textSecondary: g('--color-on-surface-variant') || '#a3a3a3',
    outline: g('--color-outline') || '#a3a3a3',
    onSurface: g('--color-on-surface') || '#e5e5e5',
  };
}

function getMarkerConfig(visibleDays: number): {
  interval: number;
  format: (d: Date) => string;
} {
  if (visibleDays <= 10) {
    return {
      interval: 24 * 60 * 60 * 1000,
      format: (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    };
  }
  if (visibleDays <= 90) {
    return {
      interval: 7 * 24 * 60 * 60 * 1000,
      format: (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    };
  }
  if (visibleDays <= 365) {
    return {
      interval: 30 * 24 * 60 * 60 * 1000,
      format: (d) => d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
    };
  }
  if (visibleDays <= 1460) {
    return {
      interval: 90 * 24 * 60 * 60 * 1000,
      format: (d) => d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
    };
  }
  if (visibleDays <= 5475) {
    return {
      interval: 365 * 24 * 60 * 60 * 1000,
      format: (d) => d.getFullYear().toString(),
    };
  }
  return {
    interval: 3650 * 24 * 60 * 60 * 1000,
    format: (d) => d.getFullYear().toString(),
  };
}

export class TimelineRenderer {
  /**
   * Draw the main timeline canvas.
   * Returns computed markers (for hit-testing) and visibleDays (for opacity fade).
   */
  drawMain(
    canvas: HTMLCanvasElement,
    params: {
      dimensions: { width: number; height: number };
      transform: TimelineTransform;
      dateRange: { start: Date; end: Date };
      timeEvents: TimeEvent[];
      eventSizes: Map<string, number>;
      hoveredEvent: TimeEvent | null;
      selectedEvent: TimeEvent | null;
      markerOpacity: number;
    },
  ): TimelineDrawResult {
    const { dimensions, transform, dateRange, timeEvents, eventSizes, hoveredEvent, selectedEvent, markerOpacity } = params;
    const { width, height } = dimensions;
    const { panX, scale } = transform;
    const centerY = height / 2;

    const ctx = canvas.getContext('2d');
    if (!ctx) return { markers: [], visibleDays: 0 };

    ctx.clearRect(0, 0, width, height);

    const colors = readColors(canvas);

    // ── Marker calculation ──────────────────────────────────────────────
    const totalMs = dateRange.end.getTime() - dateRange.start.getTime();
    const totalDays = totalMs / (24 * 60 * 60 * 1000);
    const visibleDays = totalDays / scale;

    const visibleStartRatio = Math.max(0, -panX / (width * scale));
    const visibleEndRatio = Math.min(1, (-panX + width) / (width * scale));
    const visibleStart = new Date(dateRange.start.getTime() + visibleStartRatio * totalMs);
    const visibleEnd = new Date(dateRange.start.getTime() + visibleEndRatio * totalMs);

    const { interval: markerInterval, format: dateFormat } = getMarkerConfig(visibleDays);

    const extendedStart = new Date(visibleStart.getTime() - markerInterval);
    const extendedEnd = new Date(visibleEnd.getTime() + markerInterval);

    const markers: TimelineMarker[] = [];

    // ── Draw markers ────────────────────────────────────────────────────
    ctx.fillStyle = colors.text;
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    const firstMarker = new Date(Math.floor(extendedStart.getTime() / markerInterval) * markerInterval);
    for (let markerDate = firstMarker; markerDate <= extendedEnd; markerDate = new Date(markerDate.getTime() + markerInterval)) {
      const markerPos = (markerDate.getTime() - dateRange.start.getTime()) / totalMs;
      const x = markerPos * width * scale + panX;

      if (x >= -50 && x <= width + 50) {
        markers.push({ x, date: new Date(markerDate), interval: markerInterval });

        // Tick mark
        ctx.globalAlpha = markerOpacity;
        ctx.strokeStyle = colors.text + '80';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, centerY - 5);
        ctx.lineTo(x, centerY + 5);
        ctx.stroke();

        // Label
        ctx.fillStyle = colors.text;
        ctx.fillText(dateFormat(markerDate), x, centerY + 10);
        ctx.globalAlpha = 1;
      }
    }

    // ── Timeline line ───────────────────────────────────────────────────
    ctx.strokeStyle = colors.outline;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, centerY);
    ctx.lineTo(width, centerY);
    ctx.stroke();

    // ── Events ──────────────────────────────────────────────────────────
    for (const event of timeEvents) {
      const x = event.position * width * scale + panX;
      if (x < -50 || x > width + 50) continue;

      const radius = eventSizes.get(event.id) || EVENT_RADIUS_MIN;
      const yOffset = EVENT_OFFSET + (event.stackIndex * EVENT_STACK_SPACING);
      const y = centerY - yOffset;

      const isHovered = hoveredEvent?.id === event.id;
      const isSelected = selectedEvent?.id === event.id;

      // Connector line
      ctx.strokeStyle = event.color + '40';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, centerY);
      ctx.stroke();

      // Event circle (halo)
      if (isSelected || isHovered) {
        ctx.fillStyle = event.color + '40';
        ctx.beginPath();
        ctx.arc(x, y, radius + 4, 0, 2 * Math.PI);
        ctx.fill();
      }

      // Event circle
      ctx.fillStyle = event.color;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, 2 * Math.PI);
      ctx.fill();

      // Count label on hover
      if (isHovered) {
        const label = `${event.nodes.length}`;
        ctx.font = '12px sans-serif';
        ctx.fillStyle = colors.onSurface;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(label, x, y - radius - 6);
      }
    }

    return { markers, visibleDays };
  }

  /**
   * Draw the minimap canvas.
   */
  drawMinimap(
    canvas: HTMLCanvasElement,
    params: {
      timeEvents: TimeEvent[];
      transform: TimelineTransform;
      mainWidth: number;
    },
  ): void {
    const { timeEvents, transform, mainWidth } = params;
    const { panX, scale } = transform;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width / window.devicePixelRatio;
    const height = MINIMAP_HEIGHT;

    const colors = readColors(canvas);

    ctx.clearRect(0, 0, width, height);

    // Background
    ctx.fillStyle = colors.text; // surface color from CSS
    ctx.fillRect(0, 0, width, height);

    // Timeline line
    ctx.strokeStyle = colors.textSecondary + '44';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    // Events (simplified)
    for (const event of timeEvents) {
      const x = event.position * width;
      ctx.fillStyle = event.color;
      ctx.fillRect(x - 1, height / 2 - 8, 2, 16);
    }

    // View zone
    let viewWidth = (mainWidth / scale) * (width / mainWidth);
    let viewX = (-panX / scale) * (width / mainWidth);

    if (viewX < 0) {
      viewWidth += viewX;
      viewX = 0;
    }
    if (viewX + viewWidth > width) {
      viewWidth = width - viewX;
    }
    viewWidth = Math.max(20, viewWidth);

    ctx.strokeStyle = colors.outline;
    ctx.fillStyle = colors.outline + '44';
    ctx.lineWidth = 2;
    ctx.fillRect(viewX, 0, viewWidth, height);
    ctx.strokeRect(viewX, 0, viewWidth, height);

    // Resize handles
    const handleWidth = 8;
    ctx.fillStyle = colors.outline;
    const leftHandleX = Math.max(handleWidth / 2, viewX);
    const rightHandleX = Math.min(width - handleWidth / 2, viewX + viewWidth);
    ctx.fillRect(leftHandleX - handleWidth / 2, height / 2 - 15, handleWidth, 30);
    ctx.fillRect(rightHandleX - handleWidth / 2, height / 2 - 15, handleWidth, 30);
  }
}
