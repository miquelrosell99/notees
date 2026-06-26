/**
 * GanttRenderer – Imperative canvas renderer for GanttView.
 *
 * Encapsulates all 2D canvas drawing logic:
 * - Grid lines (vertical day/week/month/quarter/year)
 * - Row backgrounds + horizontal separators
 * - Bars (rounded rects) and milestones (diamonds)
 * - Today indicator line
 * - Hit-testable bar rectangles
 *
 * Kept as a plain class (not a React component) so it can be called
 * imperatively from a rAF loop or scroll handler without re-renders.
 */

import type { Node } from '@/types';
import type { Property } from '@/types/api';
import { getPropertyValueRenderer } from '@/features/properties';
import '@/features/properties';
import { dateFromUuid } from '@/types/api';

// ==================== Constants ====================

export const ROW_HEIGHT = 36;
export const GROUP_HEADER_HEIGHT = 28;
export const BAR_HEIGHT = 20;
export const BAR_RADIUS = 4;
export const MILESTONE_SIZE = 10;
export const RESIZE_HANDLE = 8; // px on right edge that triggers resize-end mode

/** Initial pixels per day for each named zoom level (used as starting point) */
export const PX_PER_DAY_INITIAL: Record<'day' | 'week' | 'month', number> = {
  day: 40,
  week: 12,
  month: 4,
};

export const PX_PER_DAY_MIN = 0.3;
export const PX_PER_DAY_MAX = 80;
export const ZOOM_FACTOR = 1.12; // per scroll step

// ==================== Internal types ====================

export interface GanttNodeItem {
  node: Node;
  startDate: Date;
  endDate: Date | null;
}

export type GanttRow =
  | { type: 'node'; item: GanttNodeItem }
  | { type: 'group-header'; label: string; count: number; icon: string | null };

export interface DragState {
  nodeUuid: string;
  mode: 'move' | 'resize-end';
  startX: number; // canvas-space X at mousedown
  origStart: Date;
  origEnd: Date | null;
  deltaDays: number; // current live delta
}

export interface BarRect {
  nodeUuid: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  isMilestone: boolean;
}

export interface CanvasColors {
  surface: string;
  surfaceContainer: string;
  outlineVariant: string;
  primary: string;
  danger: string;
}

// ==================== Pure helpers ====================

export function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

export function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatDateForApi(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function resolveDate(val: unknown, map: Map<string, Node>): Date | null {
  if (typeof val !== 'string') return null;
  const n = map.get(val);
  return n ? dateFromUuid(n.uuid) : null;
}

export function getDateRange(items: GanttNodeItem[]): { start: Date; end: Date } {
  if (!items.length) {
    const n = new Date();
    return {
      start: new Date(n.getFullYear(), n.getMonth(), 1),
      end: new Date(n.getFullYear(), n.getMonth() + 2, 0),
    };
  }
  let min = items[0].startDate;
  let max = items[0].endDate ?? items[0].startDate;
  for (const it of items) {
    if (it.startDate < min) min = it.startDate;
    const e = it.endDate ?? it.startDate;
    if (e > max) max = e;
  }
  return { start: addDays(min, -7), end: addDays(max, 7) };
}

export function rowHeights(rows: GanttRow[]): number {
  return rows.reduce((s, r) => s + (r.type === 'group-header' ? GROUP_HEADER_HEIGHT : ROW_HEIGHT), 0);
}

function groupPropertyLabel(
  prop: Property,
  rawValue: unknown,
): { label: string; icon: string | null } {
  if (rawValue == null) return { label: '(No value)', icon: null };
  const renderer = getPropertyValueRenderer(prop.type);
  if (renderer) {
    return renderer.getGroupInfo(prop, rawValue);
  }
  return { label: String(rawValue), icon: null };
}

export function buildRows(
  items: GanttNodeItem[],
  groupBy: string | undefined,
  groupByProp: Property | undefined,
  pageMap: Map<string, Node>,
): GanttRow[] {
  if (!groupBy || groupBy === 'none') {
    return items.map(item => ({ type: 'node', item }));
  }

  const buckets = new Map<string, { label: string; icon: string | null; items: GanttNodeItem[] }>();

  for (const item of items) {
    let label: string;
    let icon: string | null = null;

    if (groupBy === 'page') {
      if (item.node.is_page) {
        label = 'Pages';
      } else {
        const pageUuid = item.node.page_uuid;
        label = pageUuid ? (pageMap.get(pageUuid)?.name ?? 'No page') : 'No page';
      }
    } else if (groupByProp) {
      const raw = ((item.node as unknown as Record<string, unknown>).properties as Record<string, unknown>)?.[String(groupByProp.uuid)] ?? null;
      ({ label, icon } = groupPropertyLabel(groupByProp, raw));
    } else {
      label = '';
    }

    if (!buckets.has(label)) buckets.set(label, { label, icon, items: [] });
    buckets.get(label)!.items.push(item);
  }

  const rows: GanttRow[] = [];
  for (const { label, icon, items: bItems } of buckets.values()) {
    rows.push({ type: 'group-header', label, count: bItems.length, icon });
    for (const item of bItems) rows.push({ type: 'node', item });
  }
  return rows;
}

export function readColors(el: Element): CanvasColors {
  const st = getComputedStyle(el);
  const g = (v: string) => st.getPropertyValue(v).trim();
  return {
    surface: g('--color-surface') || '#ffffff',
    surfaceContainer: g('--color-surface-container') || '#e8e8e8',
    outlineVariant: g('--color-outline-variant') || '#cccccc',
    primary: g('--color-primary') || '#6750a4',
    danger: g('--color-error') || '#b00020',
  };
}

/** Returns the day-step and label formatter for the current zoom level */
export function getHeaderTier(pxPerDay: number): {
  dayStep: number;
  format: (d: Date) => string;
} {
  if (pxPerDay >= 25) return {
    dayStep: 1,
    format: d => d.toLocaleDateString('default', { weekday: 'short', month: 'short', day: 'numeric' }),
  };
  if (pxPerDay >= 6) return {
    dayStep: 7,
    format: d => d.toLocaleDateString('default', { month: 'short', day: 'numeric' }),
  };
  if (pxPerDay >= 1.5) return {
    dayStep: 30,
    format: d => d.toLocaleDateString('default', { month: 'short', year: 'numeric' }),
  };
  if (pxPerDay >= 0.4) return {
    dayStep: 91,
    format: d => `Q${Math.floor(d.getMonth() / 3) + 1}\u2009${d.getFullYear()}`,
  };
  return {
    dayStep: 365,
    format: d => String(d.getFullYear()),
  };
}

/** Returns minor/major grid line intervals (in days) for the current zoom level */
export function getGridIntervals(pxPerDay: number): { minor: number; major: number } {
  if (pxPerDay >= 25) return { minor: 1, major: 7 };
  if (pxPerDay >= 6) return { minor: 7, major: 30 };
  if (pxPerDay >= 1.5) return { minor: 30, major: 91 };
  if (pxPerDay >= 0.4) return { minor: 91, major: 365 };
  return { minor: 365, major: 1825 };
}

// ==================== Canvas Renderer ====================

export class GanttRenderer {
  private barRects: BarRect[] = [];

  getBarRects(): BarRect[] {
    return this.barRects;
  }

  private dateToX(date: Date, rangeStart: Date, pxPerDay: number, scrollLeft: number): number {
    return daysBetween(rangeStart, date) * pxPerDay - scrollLeft;
  }

  private roundedRect(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number, r: number,
  ): void {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  draw(canvas: HTMLCanvasElement, params: {
    rows: GanttRow[];
    rangeStart: Date;
    scrollLeft: number;
    scrollTop: number;
    pxPerDay: number;
    today: Date;
    dragState: DragState | null;
    colors: CanvasColors;
  }): void {
    const { rows, rangeStart, scrollLeft, scrollTop, pxPerDay, today, dragState, colors } = params;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.offsetWidth;
    const h = canvas.offsetHeight;
    if (w === 0 || h === 0) return;

    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = colors.surface;
    ctx.fillRect(0, 0, w, h);

    // Vertical grid lines
    const { minor: gridInterval, major: majorInterval } = getGridIntervals(pxPerDay);
    const firstVisDay = Math.floor(scrollLeft / pxPerDay);
    const startGrid = Math.floor(firstVisDay / gridInterval) * gridInterval;
    const endGrid = startGrid + Math.ceil(w / pxPerDay) + gridInterval * 2;

    for (let d = startGrid; d <= endGrid; d += gridInterval) {
      const x = d * pxPerDay - scrollLeft;
      if (x < -1 || x > w + 1) continue;
      const isMajor = d % majorInterval === 0;
      ctx.strokeStyle = isMajor ? colors.outlineVariant : colors.outlineVariant + '55';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
      ctx.stroke();
    }

    // Row backgrounds + horizontal separators
    let rowY = -scrollTop;
    for (const row of rows) {
      const rh = row.type === 'group-header' ? GROUP_HEADER_HEIGHT : ROW_HEIGHT;
      if (rowY + rh > 0 && rowY < h) {
        if (row.type === 'group-header') {
          ctx.fillStyle = colors.surfaceContainer;
          ctx.fillRect(0, rowY, w, rh);
        }
        ctx.strokeStyle = colors.outlineVariant + '88';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(0, rowY + rh - 0.5);
        ctx.lineTo(w, rowY + rh - 0.5);
        ctx.stroke();
      }
      rowY += rh;
    }

    // Bars
    this.barRects = [];
    rowY = -scrollTop;

    for (const row of rows) {
      const rh = row.type === 'group-header' ? GROUP_HEADER_HEIGHT : ROW_HEIGHT;

      if (row.type === 'node' && rowY + rh > 0 && rowY < h) {
        const { item } = row;
        const dragged = dragState?.nodeUuid === item.node.uuid;

        let dStart = item.startDate;
        let dEnd = item.endDate;

        if (dragged && dragState) {
          if (dragState.mode === 'move') {
            dStart = addDays(dStart, dragState.deltaDays);
          }
          if (dEnd !== null) {
            dEnd = dragState.mode === 'move'
              ? addDays(dEnd, dragState.deltaDays)
              : addDays(item.endDate!, dragState.deltaDays);
          }
        }

        const barX = this.dateToX(dStart, rangeStart, pxPerDay, scrollLeft);
        const barY = rowY + (ROW_HEIGHT - BAR_HEIGHT) / 2;
        const color = item.node.color || colors.primary;

        if (!dEnd) {
          // Milestone diamond
          const cx = barX;
          const cy = rowY + ROW_HEIGHT / 2;
          const s = MILESTONE_SIZE / 2;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.moveTo(cx, cy - s);
          ctx.lineTo(cx + s, cy);
          ctx.lineTo(cx, cy + s);
          ctx.lineTo(cx - s, cy);
          ctx.closePath();
          ctx.fill();
          this.barRects.push({
            nodeUuid: item.node.uuid,
            left: cx - s, top: cy - s, right: cx + s, bottom: cy + s,
            isMilestone: true,
          });
        } else {
          const endX = this.dateToX(dEnd, rangeStart, pxPerDay, scrollLeft);
          const bw = Math.max(endX - barX, 8);

          if (dragged) {
            ctx.shadowColor = 'rgba(0,0,0,0.25)';
            ctx.shadowBlur = 8;
            ctx.shadowOffsetY = 2;
          }

          ctx.fillStyle = color;
          this.roundedRect(ctx, barX, barY, bw, BAR_HEIGHT, BAR_RADIUS);
          ctx.fill();

          if (dragged) {
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;
            ctx.shadowOffsetY = 0;
          }

          this.barRects.push({
            nodeUuid: item.node.uuid,
            left: barX, top: barY, right: barX + bw, bottom: barY + BAR_HEIGHT,
            isMilestone: false,
          });
        }
      }

      rowY += rh;
    }

    // Today line
    const todayX = this.dateToX(today, rangeStart, pxPerDay, scrollLeft);
    if (todayX >= 0 && todayX <= w) {
      ctx.strokeStyle = colors.danger;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(todayX + 0.5, 0);
      ctx.lineTo(todayX + 0.5, h);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();
  }
}
