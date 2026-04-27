/**
 * GanttView – Canvas-based Gantt/timeline view for NodeCollection
 *
 * Architecture:
 *  - Left pane (DOM):    node label list, synced vertically via CSS transform
 *  - Right pane (Canvas): imperative timeline rendering via canvas 2D API
 *  - Scroll sync:        gantt-right-pane drives both axes; left pane syncs via transform
 *
 * Interactions:
 *  - Drag bar body      → moves start + end dates proportionally
 *  - Drag right edge    → resizes end date only
 *  - Mouse-up after drag → API mutation persists new date(s) to server
 *  - Click bar          → onNodeClick; shift-click → onNodeShiftClick
 *  - Right-click bar    → context menu
 */
import { useRef, useEffect, useCallback, useMemo, useState, memo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Node } from '@/types';
import type { Property } from '@/types/api';
import type { NodeGanttViewProps } from '@/types/nodeCollection';
import { dateFromUuid } from '@/types/api';
import { getNode, setProperty, getOrCreateDaily } from '@/api/nodes';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from '@/hooks/useNodeViews';
import { NodeInline } from '../../blocks/NodeInline';
import { NodeIcon } from '../../core/icons';
import { PageContextMenu, BlockContextMenu } from '../NodeContextMenu';
import './GanttView.css';

// ==================== Constants ====================

const ROW_HEIGHT = 36;
const GROUP_HEADER_HEIGHT = 28;
const BAR_HEIGHT = 20;
const BAR_RADIUS = 4;
const MILESTONE_SIZE = 10;
const RESIZE_HANDLE = 8; // px on right edge that triggers resize-end mode
/** Initial pixels per day for each named zoom level (used as starting point) */
const PX_PER_DAY_INITIAL: Record<'day' | 'week' | 'month', number> = {
  day:   40,
  week:  12,
  month:  4,
};
const PX_PER_DAY_MIN = 0.3;
const PX_PER_DAY_MAX = 80;
const ZOOM_FACTOR    = 1.12; // per scroll step

// ==================== Internal types ====================

interface GanttNodeItem {
  node: Node;
  startDate: Date;
  endDate: Date | null;
}

type GanttRow =
  | { type: 'node'; item: GanttNodeItem }
  | { type: 'group-header'; label: string; count: number; icon: string | null };

interface DragState {
  nodeId: number;
  mode: 'move' | 'resize-end';
  startX: number;       // canvas-space X at mousedown
  origStart: Date;
  origEnd: Date | null;
  deltaDays: number;    // current live delta
}

interface BarRect {
  nodeId: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  isMilestone: boolean;
}

interface CanvasColors {
  surface: string;
  surfaceContainer: string;
  outlineVariant: string;
  primary: string;
  danger: string;
}

// ==================== Pure helpers ====================

function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function formatDateForApi(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function resolveDate(val: unknown, map: Map<number, Node>): Date | null {
  if (typeof val !== 'number') return null;
  const n = map.get(val);
  return n ? dateFromUuid(n.uuid) : null;
}

function getDateRange(items: GanttNodeItem[]): { start: Date; end: Date } {
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

function rowHeights(rows: GanttRow[]): number {
  return rows.reduce((s, r) => s + (r.type === 'group-header' ? GROUP_HEADER_HEIGHT : ROW_HEIGHT), 0);
}

function groupPropertyLabel(
  prop: Property,
  rawValue: unknown,
): { label: string; icon: string | null } {
  if (rawValue == null) return { label: '(No value)', icon: null };
  switch (prop.type) {
    case 'boolean':
      return { label: rawValue ? 'Yes' : 'No', icon: null };
    case 'integer':
    case 'float':
      return { label: String(rawValue), icon: null };
    case 'selection': {
      const getId = (v: unknown): number | null =>
        typeof v === 'number' ? v
        : (v && typeof v === 'object' && 'id' in v ? (v as { id: number }).id : null);
      const ids = (Array.isArray(rawValue) ? rawValue : [rawValue])
        .map(getId)
        .filter((x): x is number => x !== null);
      const opts = ids.map(id => prop.options?.find(o => o.id === id));
      return {
        label: opts.map(o => o?.name ?? '?').join(', ') || '(No value)',
        icon: opts.length === 1 ? (opts[0]?.icon ?? null) : null,
      };
    }
    default:
      return { label: String(rawValue), icon: null };
  }
}

function buildRows(
  items: GanttNodeItem[],
  groupBy: string | undefined,
  groupByProp: Property | undefined,
  pageMap: Map<number, Node>,
): GanttRow[] {
  if (!groupBy || groupBy === 'none') {
    return items.map(item => ({ type: 'node', item }));
  }

  const buckets = new Map<string, { label: string; icon: string | null; items: GanttNodeItem[] }>();

  for (const item of items) {
    let label: string;
    let icon: string | null = null;

    if (groupBy === 'page') {
      const pid = (item.node as unknown as Record<string, unknown>).page_id as number | undefined;
      label = pid != null ? (pageMap.get(pid)?.name ?? `Page ${pid}`) : '(No page)';
    } else if (groupByProp) {
      const raw = ((item.node as unknown as Record<string, unknown>).properties as Record<string, unknown>)?.[String(groupByProp.id)] ?? null;
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

function readColors(el: Element): CanvasColors {
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
function getHeaderTier(pxPerDay: number): {
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
function getGridIntervals(pxPerDay: number): { minor: number; major: number } {
  if (pxPerDay >= 25) return { minor: 1,   major: 7   };
  if (pxPerDay >= 6)  return { minor: 7,   major: 30  };
  if (pxPerDay >= 1.5) return { minor: 30,  major: 91  };
  if (pxPerDay >= 0.4) return { minor: 91,  major: 365 };
  return                       { minor: 365, major: 1825 };
}

// ==================== Canvas Renderer ====================

class GanttRenderer {
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
        const dragged = dragState?.nodeId === item.node.id;

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
            nodeId: item.node.id,
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
            nodeId: item.node.id,
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

// ==================== GanttView ====================

/**
 * GanttView – canvas-based Gantt/timeline view for NodeCollection.
 * Uses "Node" naming throughout (not "Task") since this view is generic.
 */
export const GanttView = memo(function GanttView({
  nodes,
  startDateProperty,
  endDateProperty,
  timeScale = 'week',
  groupBy,
  groupByProperty,
  onNodeClick,
  onNodeShiftClick,
  className = '',
}: NodeGanttViewProps) {
  // ── Day-node fetch ──────────────────────────────────────────────────────
  const dayNodeIds = useMemo<number[]>(() => {
    const ids = new Set<number>();
    for (const node of nodes) {
      const props = node.properties as Record<number, unknown> | undefined;
      if (!props) continue;
      if (startDateProperty) { const v = props[startDateProperty.id]; if (typeof v === 'number') ids.add(v); }
      if (endDateProperty)   { const v = props[endDateProperty.id];   if (typeof v === 'number') ids.add(v); }
    }
    return Array.from(ids);
  }, [nodes, startDateProperty, endDateProperty]);

  const { data: dayNodeMap = new Map<number, Node>() } = useQuery({
    queryKey: ['gantt-day-nodes', dayNodeIds],
    queryFn: async (): Promise<Map<number, Node>> => {
      const fetched = await Promise.all(dayNodeIds.map(id => getNode(id)));
      return new Map(fetched.map(n => [n.id, n]));
    },
    enabled: dayNodeIds.length > 0,
    staleTime: 5 * 60 * 1000,
  });

  // ── Optimistic date overrides (hold new dates while API call is in-flight) ──
  const [optimisticOverrides, setOptimisticOverrides] = useState<
    Map<number, { startDate: Date; endDate: Date | null }>
  >(new Map());

  // ── Data derivation ─────────────────────────────────────────────────────
  const ganttNodeItems = useMemo<GanttNodeItem[]>(() => {
    if (!startDateProperty) return [];
    return nodes
      .flatMap(node => {
        const override = optimisticOverrides.get(node.id);
        const props = node.properties as Record<number, unknown> | undefined;
        const startDate = override?.startDate ?? resolveDate(props?.[startDateProperty.id], dayNodeMap);
        if (!startDate) return [];
        const endDate = override
          ? override.endDate
          : (endDateProperty ? resolveDate(props?.[endDateProperty.id], dayNodeMap) : null);
        return [{ node, startDate, endDate }];
      })
      .sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
  }, [nodes, startDateProperty, endDateProperty, dayNodeMap, optimisticOverrides]);

  const pageMap = useMemo(
    () => new Map(nodes.filter(n => n.is_page).map(n => [n.id, n])),
    [nodes],
  );

  const rows = useMemo(
    () => buildRows(ganttNodeItems, groupBy, groupByProperty, pageMap),
    [ganttNodeItems, groupBy, groupByProperty, pageMap],
  );

  const dateRange = useMemo(() => getDateRange(ganttNodeItems), [ganttNodeItems]);

  // ── Continuous zoom (px per day) ────────────────────────────────────────
  // Initialised from the `timeScale` prop; Ctrl+scroll updates it live.
  const [pxPerDay, setPxPerDay] = useState(() => PX_PER_DAY_INITIAL[timeScale]);
  const pxPerDayRef = useRef(PX_PER_DAY_INITIAL[timeScale]);

  // Re-snap to prop when the user changes it from the toolbar
  useEffect(() => {
    const v = PX_PER_DAY_INITIAL[timeScale];
    pxPerDayRef.current = v;
    setPxPerDay(v);
  }, [timeScale]);

  const totalTimelineWidth = Math.max((daysBetween(dateRange.start, dateRange.end) + 1) * pxPerDay, 600);
  const totalContentHeight = rowHeights(rows);

  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  // Header labels for the full date range (translated on horizontal scroll)
  const allHeaderLabels = useMemo(() => {
    const { dayStep, format } = getHeaderTier(pxPerDay);
    const totalDays = daysBetween(dateRange.start, dateRange.end) + 1;
    const labels: { key: number; x: number; label: string }[] = [];
    for (let d = 0; d < totalDays; d += dayStep) {
      labels.push({
        key: d,
        x: d * pxPerDay,
        label: format(addDays(dateRange.start, d)),
      });
    }
    return labels;
  }, [dateRange, pxPerDay]);

  // ── Scroll refs (avoid re-renders on every scroll event) ────────────────
  const scrollLeftRef = useRef(0);
  const scrollTopRef  = useRef(0);

  // ── Ctrl+scroll zoom ────────────────────────────────────────────────────
  useEffect(() => {
    const el = rightPaneRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const direction = e.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
      const next = Math.max(PX_PER_DAY_MIN, Math.min(PX_PER_DAY_MAX, pxPerDayRef.current * direction));
      if (next === pxPerDayRef.current) return;

      // Keep the date under the cursor stationary
      const rect = el.getBoundingClientRect();
      const cursorX = e.clientX - rect.left;
      const pivotDays = (el.scrollLeft + cursorX) / pxPerDayRef.current;
      const newScrollLeft = Math.max(0, pivotDays * next - cursorX);

      pxPerDayRef.current = next;

      // Synchronously widen the scroll extent so scrollLeft won't be clamped
      if (extentRef.current) {
        const dr = dateRangeRef.current;
        const newWidth = Math.max((daysBetween(dr.start, dr.end) + 1) * next, 600);
        extentRef.current.style.width = `${newWidth}px`;
      }

      // Set scroll position now (extent is already wide enough)
      el.scrollLeft = newScrollLeft;
      scrollLeftRef.current = el.scrollLeft;

      // Sync canvas position & header immediately
      if (canvasRef.current) {
        canvasRef.current.style.left = `${el.scrollLeft}px`;
      }

      // Synchronously reposition header markers so they don't jitter
      if (headerInnerRef.current) {
        headerInnerRef.current.style.width = `${Math.max((daysBetween(dateRangeRef.current.start, dateRangeRef.current.end) + 1) * next, 600)}px`;
        headerInnerRef.current.style.transform = `translateX(${-el.scrollLeft}px)`;

        // Reposition existing marker spans and regenerate text if tier changed
        const oldTier = getHeaderTier(pxPerDayRef.current / (e.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR));
        const newTier = getHeaderTier(next);
        const tierChanged = oldTier.dayStep !== newTier.dayStep;

        const markers = headerInnerRef.current.children;
        for (let i = 0; i < markers.length; i++) {
          const span = markers[i] as HTMLSpanElement;
          const dayOffset = Number(span.dataset.day);
          if (!isNaN(dayOffset)) {
            span.style.left = `${dayOffset * next}px`;
            if (tierChanged) {
              span.textContent = newTier.format(addDays(dateRangeRef.current.start, dayOffset));
            }
          }
        }
      }

      // Immediate redraw with fresh ref values — no frame delay
      drawRef.current();

      // Queue React state update for header labels, extent width etc.
      setPxPerDay(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []); // intentionally empty – uses refs only

  // ── Drag state ──────────────────────────────────────────────────────────
  const [_dragState, setDragState] = useState<DragState | null>(null);
  const dragStateRef = useRef<DragState | null>(null);

  // ── Context menu ────────────────────────────────────────────────────────
  const [contextMenu, setContextMenu] = useState<{ node: Node; x: number; y: number } | null>(null);

  // ── DOM refs ────────────────────────────────────────────────────────────
  const canvasRef      = useRef<HTMLCanvasElement>(null);
  const rightPaneRef   = useRef<HTMLDivElement>(null);
  const leftInnerRef   = useRef<HTMLDivElement>(null);
  const headerInnerRef = useRef<HTMLDivElement>(null);
  const extentRef      = useRef<HTMLDivElement>(null);
  const rendererRef    = useRef(new GanttRenderer());

  // Stable refs so the wheel handler always has the latest draw + dateRange
  const drawRef      = useRef<() => void>(() => {});
  const dateRangeRef = useRef(dateRange);
  dateRangeRef.current = dateRange;

  // ── Persist bar dates after drag ────────────────────────────────────────
  const queryClient = useQueryClient();
  const { mutate: persistDates } = useMutation({
    mutationFn: async ({
      nodeId, mode, newStart, newEnd,
    }: { nodeId: number; mode: 'move' | 'resize-end'; newStart: Date; newEnd: Date | null }) => {
      if (!startDateProperty) return;
      if (mode === 'move') {
        const startDayNode = await getOrCreateDaily(formatDateForApi(newStart));
        await setProperty(nodeId, startDateProperty.id, startDayNode.id);
      }
      if (newEnd && endDateProperty) {
        const endDayNode = await getOrCreateDaily(formatDateForApi(newEnd));
        await setProperty(nodeId, endDateProperty.id, endDayNode.id);
      }
    },
    onMutate: ({ nodeId, newStart, newEnd }) => {
      setOptimisticOverrides(prev => {
        const next = new Map(prev);
        next.set(nodeId, { startDate: newStart, endDate: newEnd });
        return next;
      });
    },
    onSuccess: async (_, { nodeId }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(nodeId) }),
        queryClient.invalidateQueries({ queryKey: ['gantt-day-nodes'] }),
        queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() }),
      ]);
      // Refetches done — safe to drop the optimistic override
      setOptimisticOverrides(prev => {
        const next = new Map(prev);
        next.delete(nodeId);
        return next;
      });
    },
  });

  // ── Canvas draw ─────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    rendererRef.current.draw(canvas, {
      rows,
      rangeStart: dateRange.start,
      scrollLeft: scrollLeftRef.current,
      scrollTop:  scrollTopRef.current,
      pxPerDay: pxPerDayRef.current, // always fresh – avoids stale-closure glitch during Ctrl+scroll
      today,
      dragState: dragStateRef.current,
      colors: readColors(canvas),
    });
  }, [rows, dateRange, today]); // pxPerDay intentionally omitted – read from ref

  // Keep drawRef current so the wheel handler can call the latest version
  drawRef.current = draw;

  // Trigger a redraw whenever rows/range/today change OR when pxPerDay state changes
  // (the latter handles toolbar timeScale changes without re-capturing the value in draw).
  useEffect(() => { draw(); }, [draw, pxPerDay]);

  // Canvas size follows the right pane's visible area
  useEffect(() => {
    const el = rightPaneRef.current;
    const canvas = canvasRef.current;
    if (!el || !canvas) return;

    const sync = () => {
      canvas.style.width  = `${el.clientWidth}px`;
      canvas.style.height = `${el.clientHeight}px`;
      draw();
    };

    const ro = new ResizeObserver(sync);
    ro.observe(el);
    sync();
    return () => ro.disconnect();
  }, [draw]);

  // ── Scroll sync ─────────────────────────────────────────────────────────
  const handleScroll = useCallback(() => {
    const el = rightPaneRef.current;
    if (!el) return;
    scrollLeftRef.current = el.scrollLeft;
    scrollTopRef.current  = el.scrollTop;

    if (leftInnerRef.current) {
      leftInnerRef.current.style.transform = `translateY(${-el.scrollTop}px)`;
    }
    if (headerInnerRef.current) {
      headerInnerRef.current.style.transform = `translateX(${-el.scrollLeft}px)`;
    }
    // Move canvas to stay at the visible top-left of the right pane
    if (canvasRef.current) {
      canvasRef.current.style.top  = `${el.scrollTop}px`;
      canvasRef.current.style.left = `${el.scrollLeft}px`;
    }
    draw();
  }, [draw]);

  // ── Bar hit-testing ─────────────────────────────────────────────────────
  const getHitMode = useCallback((
    mx: number, my: number,
  ): { mode: 'move' | 'resize-end'; nodeId: number } | null => {
    for (const br of rendererRef.current.getBarRects()) {
      if (my >= br.top && my <= br.bottom && mx >= br.left && mx <= br.right) {
        const mode = !br.isMilestone && mx >= br.right - RESIZE_HANDLE ? 'resize-end' : 'move';
        return { mode, nodeId: br.nodeId };
      }
    }
    return null;
  }, []);

  // ── Canvas mouse handlers ───────────────────────────────────────────────
  const handleCanvasMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    if (dragStateRef.current) {
      const deltaDays = Math.round((mx - dragStateRef.current.startX) / pxPerDayRef.current);
      const updated = { ...dragStateRef.current, deltaDays };
      dragStateRef.current = updated;
      setDragState(updated);
      draw();
      return;
    }

    const hit = getHitMode(mx, my);
    canvas.style.cursor = hit
      ? (hit.mode === 'resize-end' ? 'ew-resize' : 'grab')
      : 'default';
  }, [pxPerDay, draw, getHitMode]);

  const handleCanvasMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const hit = getHitMode(mx, my);
    if (!hit) return;

    const item = ganttNodeItems.find(it => it.node.id === hit.nodeId);
    if (!item) return;

    e.preventDefault();
    const drag: DragState = {
      nodeId: hit.nodeId,
      mode: hit.mode,
      startX: mx,
      origStart: item.startDate,
      origEnd: item.endDate,
      deltaDays: 0,
    };
    dragStateRef.current = drag;
    setDragState(drag);
    canvas.style.cursor = hit.mode === 'resize-end' ? 'ew-resize' : 'grabbing';
  }, [ganttNodeItems, getHitMode]);

  const handleCanvasMouseUp = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const drag = dragStateRef.current;
    dragStateRef.current = null;
    setDragState(null);
    canvas.style.cursor = 'default';

    if (!drag) return;

    if (drag.deltaDays !== 0) {
      const newStart = drag.mode === 'move'
        ? addDays(drag.origStart, drag.deltaDays)
        : drag.origStart; // resize-end keeps start unchanged
      const newEnd = drag.origEnd
        ? addDays(drag.origEnd, drag.deltaDays)
        : null;
      persistDates({ nodeId: drag.nodeId, mode: drag.mode, newStart, newEnd });
    } else {
      // No movement → treat as click
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      for (const br of rendererRef.current.getBarRects()) {
        if (my >= br.top && my <= br.bottom && mx >= br.left && mx <= br.right) {
          const item = ganttNodeItems.find(it => it.node.id === br.nodeId);
          if (item) {
            if (e.shiftKey) onNodeShiftClick?.(item.node);
            else onNodeClick?.(item.node);
          }
          break;
        }
      }
    }
    draw();
  }, [ganttNodeItems, onNodeClick, onNodeShiftClick, persistDates, draw]);

  const handleCanvasMouseLeave = useCallback(() => {
    if (dragStateRef.current) {
      dragStateRef.current = null;
      setDragState(null);
      draw();
    }
  }, [draw]);

  const handleCanvasContextMenu = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    for (const br of rendererRef.current.getBarRects()) {
      if (my >= br.top && my <= br.bottom && mx >= br.left && mx <= br.right) {
        const item = ganttNodeItems.find(it => it.node.id === br.nodeId);
        if (item) setContextMenu({ node: item.node, x: e.clientX, y: e.clientY });
        break;
      }
    }
  }, [ganttNodeItems]);

  // ── Empty states ────────────────────────────────────────────────────────
  if (!startDateProperty) {
    return (
      <div className={`gantt-view gantt-view--empty ${className}`}>
        <div className="gantt-view__empty-msg">
          Select a start date property via <strong>Configure Gantt</strong> in the toolbar.
        </div>
      </div>
    );
  }

  if (ganttNodeItems.length === 0) {
    return (
      <div className={`gantt-view gantt-view--empty ${className}`}>
        <div className="gantt-view__empty-msg">
          No nodes have a value for <em>{startDateProperty.name}</em>.
        </div>
      </div>
    );
  }

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className={`gantt-view ${className}`}>

      {/* Header */}
      <div className="gantt-header">
        <div className="gantt-header__label">Node</div>
        <div className="gantt-header__timeline">
          <div
            ref={headerInnerRef}
            className="gantt-header__inner"
            style={{ width: totalTimelineWidth }}
          >
            {allHeaderLabels.map(hl => (
              <span key={hl.key} className="gantt-header__marker" data-day={hl.key} style={{ left: hl.x }}>
                {hl.label}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="gantt-body">

        {/* Left label pane – overflow hidden, scrolled via CSS transform */}
        <div className="gantt-left-pane">
          <div
            ref={leftInnerRef}
            className="gantt-left-pane__inner"
            style={{ height: totalContentHeight }}
          >
            {rows.map((row, i) =>
              row.type === 'group-header' ? (
                <div key={i} className="gantt-group-header" style={{ height: GROUP_HEADER_HEIGHT }}>
                  {row.icon && <NodeIcon icon={row.icon} isPage={false} size="sm" />}
                  <span className="gantt-group-header__label">{row.label}</span>
                  <span className="gantt-group-header__count">{row.count}</span>
                </div>
              ) : (
                <div key={i} className="gantt-label-row" style={{ height: ROW_HEIGHT }}>
                  <NodeInline
                    name={row.item.node.name}
                    icon={row.item.node.icon}
                    isPage={row.item.node.is_page}
                    nodeId={row.item.node.id}
                    showBullet={true}
                    onClick={() => onNodeClick?.(row.item.node)}
                    onShiftClick={() => onNodeShiftClick?.(row.item.node)}
                    className="gantt-label-row__inline"
                  />
                </div>
              )
            )}
          </div>
        </div>

        {/*
          Right pane: overflow scroll drives both axes.
          - gantt-scroll-extent is the invisible spacer that creates the scrollable area.
          - canvas is position:sticky so it stays in the visible top-left corner while
            still receiving mouse events; draw() renders bars offset by scrollLeft/scrollTop.
        */}
        <div
          ref={rightPaneRef}
          className="gantt-right-pane"
          onScroll={handleScroll}
        >
          {/*
            gantt-scroll-extent drives the scroll container's scrollable area.
            The canvas is absolutely positioned inside it and moved by the
            scroll handler to always appear at the visible top-left corner.
            pointer-events:none on the extent lets wheel events reach the
            scroll container; canvas has pointer-events:auto for drag/click.
          */}
          <div
            ref={extentRef}
            className="gantt-scroll-extent"
            style={{ width: totalTimelineWidth, height: totalContentHeight }}
          >
            <canvas
              ref={canvasRef}
              className="gantt-canvas"
              onMouseDown={handleCanvasMouseDown}
              onMouseMove={handleCanvasMouseMove}
              onMouseUp={handleCanvasMouseUp}
              onMouseLeave={handleCanvasMouseLeave}
              onContextMenu={handleCanvasContextMenu}
            />
          </div>
        </div>
      </div>

      {/* Context menu */}
      {contextMenu && (
        contextMenu.node.is_page ? (
          <PageContextMenu
            node={contextMenu.node}
            position={{ x: contextMenu.x, y: contextMenu.y }}
            onClose={() => setContextMenu(null)}
          />
        ) : (
          <BlockContextMenu
            node={contextMenu.node}
            position={{ x: contextMenu.x, y: contextMenu.y }}
            onClose={() => setContextMenu(null)}
          />
        )
      )}
    </div>
  );
});
