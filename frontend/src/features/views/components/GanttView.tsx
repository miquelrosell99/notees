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
import type { Node } from '@/types';

import type { NodeGanttViewProps } from '@/types/nodeCollection';

import { useGanttDateMutation } from '@/features/views';
import { NodeInline, useClasses } from '@/features/content';
import { NodeIcon } from '@/components/ui/icons';
import { PageContextMenu, BlockContextMenu } from '@/features/content';
import { getEffectiveIcon } from '@/utils/nodeIcon';
import { useGanttData } from '../hooks/useGanttData';
import {
  ROW_HEIGHT,
  GROUP_HEADER_HEIGHT,
  RESIZE_HANDLE,
  PX_PER_DAY_INITIAL,
  PX_PER_DAY_MIN,
  PX_PER_DAY_MAX,
  ZOOM_FACTOR,
  GanttRenderer,
  addDays,
  daysBetween,
  getHeaderTier,
  readColors,
} from '../renderers/GanttRenderer';
import type { DragState } from '../renderers/GanttRenderer';
import './GanttView.css';
import { registerView } from './registry';

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
  // ── Data hook (extracts day-node resolution, grouping, date math) ───────
  const {
    ganttNodeItems,
    rows,
    dateRange,
    totalContentHeight,
    setOptimisticOverride,
  } = useGanttData(nodes, startDateProperty, endDateProperty, groupBy, groupByProperty);

  const { data: allClasses } = useClasses();

  // Resolve inherited class icons for Gantt label rows.
  const effectiveIconMap = useMemo(() => {
    const map = new Map<string, string | null>();
    if (!allClasses) return map;
    for (const item of ganttNodeItems) {
      map.set(item.node.uuid, getEffectiveIcon(item.node, allClasses) ?? null);
    }
    return map;
  }, [ganttNodeItems, allClasses]);

  // ── DOM refs (declared early so virtualization can measure the left pane) ─
  const canvasRef      = useRef<HTMLCanvasElement>(null);
  const rightPaneRef   = useRef<HTMLDivElement>(null);
  const leftPaneRef    = useRef<HTMLDivElement>(null);
  const leftInnerRef   = useRef<HTMLDivElement>(null);
  const headerInnerRef = useRef<HTMLDivElement>(null);
  const extentRef      = useRef<HTMLDivElement>(null);
  const rendererRef    = useRef(new GanttRenderer());

  // ── Left label pane virtualization ──────────────────────────────────────
  const [virtualScrollTop, setVirtualScrollTop] = useState(0);
  const [leftPaneHeight, setLeftPaneHeight] = useState(0);

  useEffect(() => {
    const el = leftPaneRef.current;
    if (!el) return;
    const sync = () => setLeftPaneHeight(el.clientHeight);
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    sync();
    return () => ro.disconnect();
  }, []);

  // ── Continuous zoom (px per day) ────────────────────────────────────────
  const [pxPerDay, setPxPerDay] = useState(() => PX_PER_DAY_INITIAL[timeScale]);
  const pxPerDayRef = useRef(PX_PER_DAY_INITIAL[timeScale]);

  useEffect(() => {
    const v = PX_PER_DAY_INITIAL[timeScale];
    pxPerDayRef.current = v;
    setPxPerDay(v);
  }, [timeScale]);

  const totalTimelineWidth = Math.max((daysBetween(dateRange.start, dateRange.end) + 1) * pxPerDay, 600);

  // Offsets for each row in the left label pane (used for virtualization).
  const { rowOffsets, totalRowHeight } = useMemo(() => {
    const offsets: number[] = [0];
    let total = 0;
    for (const row of rows) {
      total += row.type === 'group-header' ? GROUP_HEADER_HEIGHT : ROW_HEIGHT;
      offsets.push(total);
    }
    return { rowOffsets: offsets, totalRowHeight: total };
  }, [rows]);

  const { visibleStartIndex, visibleEndIndex, topSpacerHeight } = useMemo(() => {
    if (leftPaneHeight <= 0) {
      return { visibleStartIndex: 0, visibleEndIndex: rows.length, topSpacerHeight: 0 };
    }
    const overscan = 5;
    let start = 0;
    while (start < rows.length && rowOffsets[start + 1] <= virtualScrollTop) {
      start++;
    }
    let end = start;
    while (end < rows.length && rowOffsets[end] < virtualScrollTop + leftPaneHeight) {
      end++;
    }
    return {
      visibleStartIndex: Math.max(0, start - overscan),
      visibleEndIndex: Math.min(rows.length, end + overscan),
      topSpacerHeight: rowOffsets[Math.max(0, start - overscan)],
    };
  }, [rows.length, rowOffsets, virtualScrollTop, leftPaneHeight]);

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

      const rect = el.getBoundingClientRect();
      const cursorX = e.clientX - rect.left;
      const pivotDays = (el.scrollLeft + cursorX) / pxPerDayRef.current;
      const newScrollLeft = Math.max(0, pivotDays * next - cursorX);

      pxPerDayRef.current = next;

      if (extentRef.current) {
        const dr = dateRangeRef.current;
        const newWidth = Math.max((daysBetween(dr.start, dr.end) + 1) * next, 600);
        extentRef.current.style.width = `${newWidth}px`;
      }

      el.scrollLeft = newScrollLeft;
      scrollLeftRef.current = el.scrollLeft;

      if (canvasRef.current) {
        canvasRef.current.style.left = `${el.scrollLeft}px`;
      }

      if (headerInnerRef.current) {
        headerInnerRef.current.style.width = `${Math.max((daysBetween(dateRangeRef.current.start, dateRangeRef.current.end) + 1) * next, 600)}px`;
        headerInnerRef.current.style.transform = `translateX(${-el.scrollLeft}px)`;

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

      drawRef.current();
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

  // Stable refs so the wheel handler always has the latest draw + dateRange
  const drawRef      = useRef<() => void>(() => {});
  const dateRangeRef = useRef(dateRange);
  dateRangeRef.current = dateRange;

  // ── Persist bar dates after drag ────────────────────────────────────────
  const { mutate: persistDates } = useGanttDateMutation(
    startDateProperty,
    endDateProperty,
    {
      onMutate: ({ nodeUuid, newStart, newEnd }) => {
        setOptimisticOverride(nodeUuid, { startDate: newStart, endDate: newEnd });
      },
      onSettled: (nodeUuid) => {
        setOptimisticOverride(nodeUuid, null);
      },
    }
  );

  // ── Canvas draw ─────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    rendererRef.current.draw(canvas, {
      rows,
      rangeStart: dateRange.start,
      scrollLeft: scrollLeftRef.current,
      scrollTop:  scrollTopRef.current,
      pxPerDay: pxPerDayRef.current,
      today,
      dragState: dragStateRef.current,
      colors: readColors(canvas),
    });
  }, [rows, dateRange, today]);

  drawRef.current = draw;
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
    setVirtualScrollTop(el.scrollTop);

    if (leftInnerRef.current) {
      leftInnerRef.current.style.transform = `translateY(${-el.scrollTop}px)`;
    }
    if (headerInnerRef.current) {
      headerInnerRef.current.style.transform = `translateX(${-el.scrollLeft}px)`;
    }
    if (canvasRef.current) {
      canvasRef.current.style.top  = `${el.scrollTop}px`;
      canvasRef.current.style.left = `${el.scrollLeft}px`;
    }
    draw();
  }, [draw]);

  // ── Bar hit-testing ─────────────────────────────────────────────────────
  const getHitMode = useCallback((
    mx: number, my: number,
  ): { mode: 'move' | 'resize-end'; nodeUuid: string } | null => {
    for (const br of rendererRef.current.getBarRects()) {
      if (my >= br.top && my <= br.bottom && mx >= br.left && mx <= br.right) {
        const mode = !br.isMilestone && mx >= br.right - RESIZE_HANDLE ? 'resize-end' : 'move';
        return { mode, nodeUuid: br.nodeUuid };
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
  }, [draw, getHitMode]);

  const handleCanvasMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const hit = getHitMode(mx, my);
    if (!hit) return;

    const item = ganttNodeItems.find(it => it.node.uuid === hit.nodeUuid);
    if (!item) return;

    e.preventDefault();
    const drag: DragState = {
      nodeUuid: hit.nodeUuid,
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
        : drag.origStart;
      const newEnd = drag.origEnd
        ? addDays(drag.origEnd, drag.deltaDays)
        : null;
      persistDates({ nodeUuid: drag.nodeUuid, mode: drag.mode, newStart, newEnd });
    } else {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      for (const br of rendererRef.current.getBarRects()) {
        if (my >= br.top && my <= br.bottom && mx >= br.left && mx <= br.right) {
          const item = ganttNodeItems.find(it => it.node.uuid === br.nodeUuid);
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
        const item = ganttNodeItems.find(it => it.node.uuid === br.nodeUuid);
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
          Choose a start date property to see items on the Gantt chart.
        </div>
      </div>
    );
  }

  if (ganttNodeItems.length === 0) {
    return (
      <div className={`gantt-view gantt-view--empty ${className}`}>
        <div className="gantt-view__empty-msg">
          No items have a date in <em>{startDateProperty.name}</em>.
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
        <div ref={leftPaneRef} className="gantt-left-pane">
          <div
            ref={leftInnerRef}
            className="gantt-left-pane__inner"
            style={{ height: totalRowHeight }}
          >
            <div style={{ height: topSpacerHeight }} />
            {rows.slice(visibleStartIndex, visibleEndIndex).map((row, i) => {
              const index = visibleStartIndex + i;
              return row.type === 'group-header' ? (
                <div key={`gh-${index}`} className="gantt-group-header" style={{ height: GROUP_HEADER_HEIGHT }}>
                  {row.icon && <NodeIcon icon={row.icon} isPage={false} size="sm" />}
                  <span className="gantt-group-header__label">{row.label}</span>
                  <span className="gantt-group-header__count">{row.count}</span>
                </div>
              ) : (
                <div key={`row-${index}`} className="gantt-label-row" style={{ height: ROW_HEIGHT }}>
                  <NodeInline
                    name={row.item.node.name}
                    icon={effectiveIconMap.get(row.item.node.uuid) ?? row.item.node.icon}
                    isPage={row.item.node.is_page}
                    nodeUuid={row.item.node.uuid}
                    showBullet={true}
                    onClick={() => onNodeClick?.(row.item.node)}
                    onShiftClick={() => onNodeShiftClick?.(row.item.node)}
                    className="gantt-label-row__inline"
                  />
                </div>
              );
            })}
            <div style={{ height: totalRowHeight - rowOffsets[visibleEndIndex] }} />
          </div>
        </div>

        <div
          ref={rightPaneRef}
          className="gantt-right-pane"
          onScroll={handleScroll}
        >
          <div
            ref={extentRef}
            className="gantt-scroll-extent"
            style={{ width: totalTimelineWidth, height: totalContentHeight }}
          >
            <canvas
              ref={canvasRef}
              className="gantt-canvas"
              role="img"
              aria-label={`Gantt timeline of nodes by ${startDateProperty?.name ?? 'date'}`}
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

registerView({
  id: 'gantt',
  label: 'Gantt',
  icon: 'mdi mdi-chart-gantt',
  component: GanttView,
  capabilities: { groupBy: true, ganttConfig: true },
});
