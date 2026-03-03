/**
 * NodeGanttView Component
 *
 * Gantt/timeline view for NodeCollection.
 * Displays nodes as bars on a timeline, using two date properties for
 * the start and end of each bar.
 *
 * Features:
 * - Two configurable date properties: start and end
 * - Configurable time scale (day, week, month)
 * - Nodes without a start date are hidden
 * - Nodes with only a start date shown as a milestone (thin bar)
 */
import { useMemo, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Node } from '@/types';
import type { Property } from '@/types/api';
import type { NodeGanttViewProps } from '@/types/nodeCollection';
import { dateFromUuid } from '@/types/api';
import { getNode } from '@/api/nodes';
import { NodeIcon } from '../../core/icons';
import './GanttView.css';

// ==================== Internal types ====================

interface GanttItem {
  node: Node;
  startDate: Date;
  endDate: Date | null;
}

interface GanttGroup {
  label: string;
  headerIcon?: string | null;
  items: GanttItem[];
}

// ==================== Grouping helpers ====================

function getPropertyGroupInfo(property: Property, rawValue: unknown): { label: string; icon: string | null } {
  if (rawValue === null || rawValue === undefined) return { label: '(No value)', icon: null };
  switch (property.type) {
    case 'boolean': return { label: rawValue ? 'Yes' : 'No', icon: null };
    case 'integer':
    case 'float': return { label: String(rawValue), icon: null };
    case 'selection': {
      const resolveId = (v: unknown): number | null => {
        if (typeof v === 'number') return v;
        if (typeof v === 'object' && v !== null && 'id' in v) return (v as { id: number }).id;
        return null;
      };
      if (Array.isArray(rawValue)) {
        const opts = rawValue
          .map(resolveId)
          .filter((id): id is number => id !== null)
          .map(id => property.options?.find(o => o.id === id));
        const names = opts.map(o => o?.name ?? '?').join(', ');
        const icon = opts.length === 1 ? (opts[0]?.icon ?? null) : null;
        return { label: names || '(No value)', icon };
      }
      const optId = resolveId(rawValue);
      if (optId === null) return { label: String(rawValue), icon: null };
      const opt = property.options?.find(o => o.id === optId);
      return { label: opt?.name ?? String(optId), icon: opt?.icon ?? null };
    }
    default: return { label: String(rawValue), icon: null };
  }
}

// ==================== Date helpers ====================

/**
 * Resolve a day-page node ID to a Date by reading the node's UUID.
 */
function resolveDate(nodeId: unknown, dayNodeMap: Map<number, Node>): Date | null {
  if (typeof nodeId !== 'number') return null;
  const dayNode = dayNodeMap.get(nodeId);
  if (!dayNode) return null;
  return dateFromUuid(dayNode.uuid);
}

/**
 * Compute the date range (with padding) for the entire chart.
 */
function getDateRange(items: GanttItem[]): { start: Date; end: Date } {
  if (items.length === 0) {
    const now = new Date();
    return {
      start: new Date(now.getFullYear(), now.getMonth(), 1),
      end: new Date(now.getFullYear(), now.getMonth() + 1, 0),
    };
  }

  let minDate = items[0].startDate;
  let maxDate = items[0].endDate ?? items[0].startDate;

  for (const item of items) {
    if (item.startDate < minDate) minDate = item.startDate;
    const end = item.endDate ?? item.startDate;
    if (end > maxDate) maxDate = end;
  }

  const start = new Date(minDate);
  start.setDate(start.getDate() - 3);
  const end = new Date(maxDate);
  end.setDate(end.getDate() + 3);

  return { start, end };
}

/** Position a date as a percentage within [rangeStart, rangeEnd]. */
function pct(date: Date, rangeStart: Date, rangeEnd: Date): number {
  const total = rangeEnd.getTime() - rangeStart.getTime();
  if (total === 0) return 0;
  return ((date.getTime() - rangeStart.getTime()) / total) * 100;
}

// ==================== Header helpers ====================

function formatHeaderLabel(date: Date, scale: 'day' | 'week' | 'month'): string {
  if (scale === 'day') {
    return date.toLocaleDateString('default', { weekday: 'short', month: 'short', day: 'numeric' });
  }
  if (scale === 'week') {
    return date.toLocaleDateString('default', { month: 'short', day: 'numeric' });
  }
  return date.toLocaleDateString('default', { month: 'short', year: 'numeric' });
}

function generateHeaders(
  start: Date,
  end: Date,
  scale: 'day' | 'week' | 'month'
): { date: Date; label: string; position: number }[] {
  const headers: { date: Date; label: string; position: number }[] = [];
  const current = new Date(start);
  const increment = scale === 'day' ? 1 : scale === 'week' ? 7 : 30;

  while (current <= end) {
    headers.push({
      date: new Date(current),
      label: formatHeaderLabel(current, scale),
      position: pct(current, start, end),
    });
    current.setDate(current.getDate() + increment);
  }

  return headers;
}

// ==================== GanttBar ====================

interface GanttBarProps {
  item: GanttItem;
  dateRange: { start: Date; end: Date };
  onNodeClick?: (node: Node) => void;
  onNodeShiftClick?: (node: Node) => void;
}

function GanttBar({ item, dateRange, onNodeClick, onNodeShiftClick }: GanttBarProps) {
  const startPct = pct(item.startDate, dateRange.start, dateRange.end);
  const endDate = item.endDate ?? item.startDate;
  const endPct = pct(endDate, dateRange.start, dateRange.end);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.shiftKey && onNodeShiftClick) {
        e.preventDefault();
        onNodeShiftClick(item.node);
      } else if (onNodeClick) {
        onNodeClick(item.node);
      }
    },
    [item.node, onNodeClick, onNodeShiftClick]
  );

  const barStyle = useMemo(
    () => ({
      left: `${startPct}%`,
      width: `${Math.max(endPct - startPct, 1.5)}%`,
      backgroundColor: item.node.color || 'var(--color-primary)',
    }),
    [startPct, endPct, item.node.color]
  );

  const isMilestone = !item.endDate;

  return (
    <div className="gantt-row">
      <div className="gantt-row__label" title={item.node.name || 'Untitled'}>
        <NodeIcon icon={item.node.icon} isPage={item.node.is_page} size="sm" />
        <span className="gantt-row__name">{item.node.name || 'Untitled'}</span>
      </div>
      <div className="gantt-row__timeline">
        <div
          className={`gantt-row__bar ${isMilestone ? 'gantt-row__bar--milestone' : ''}`}
          style={barStyle}
          onClick={handleClick}
          title={`${item.node.name || 'Untitled'}: ${item.startDate.toLocaleDateString()}${item.endDate ? ' → ' + item.endDate.toLocaleDateString() : ''}`}
        />
      </div>
    </div>
  );
}

// ==================== Main component ====================

/**
 * GanttView – timeline/Gantt view for NodeCollection
 */
export function GanttView({
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
  // Collect all unique day-page node IDs referenced by the selected properties
  const dayNodeIds = useMemo<number[]>(() => {
    const ids = new Set<number>();
    for (const node of nodes) {
      const props = node.properties as Record<number, unknown> | undefined;
      if (!props) continue;
      if (startDateProperty) {
        const v = props[startDateProperty.id];
        if (typeof v === 'number') ids.add(v);
      }
      if (endDateProperty) {
        const v = props[endDateProperty.id];
        if (typeof v === 'number') ids.add(v);
      }
    }
    return Array.from(ids);
  }, [nodes, startDateProperty, endDateProperty]);

  // Batch-fetch the day-page nodes so we can read their UUIDs
  const { data: dayNodeMap = new Map<number, Node>() } = useQuery({
    queryKey: ['gantt-day-nodes', dayNodeIds],
    queryFn: async (): Promise<Map<number, Node>> => {
      const fetched = await Promise.all(dayNodeIds.map((id) => getNode(id)));
      return new Map(fetched.map((n) => [n.id, n]));
    },
    enabled: dayNodeIds.length > 0,
    staleTime: 5 * 60 * 1000,
  });

  // Build gantt items
  const ganttItems = useMemo<GanttItem[]>(() => {
    if (!startDateProperty) return [];

    return nodes
      .map((node) => {
        const props = node.properties as Record<number, unknown> | undefined;
        const startNodeId = props?.[startDateProperty.id];
        const startDate = resolveDate(startNodeId, dayNodeMap);
        if (!startDate) return null;

        const endDate = endDateProperty
          ? resolveDate(props?.[endDateProperty.id], dayNodeMap)
          : null;

        return { node, startDate, endDate } as GanttItem;
      })
      .filter((item): item is GanttItem => item !== null)
      .sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
  }, [nodes, startDateProperty, endDateProperty, dayNodeMap]);

  // Compute groups when groupBy is active
  const groups = useMemo<GanttGroup[] | null>(() => {
    if (!groupBy || groupBy === 'none') return null;

    if (groupBy === 'page') {
      // Group items by their page_id; try to find page name from nodes array
      const pageMap = new Map<number, Node>(
        nodes.filter(n => n.is_page).map(n => [n.id, n])
      );
      const groupMap = new Map<string, GanttGroup>();
      for (const item of ganttItems) {
        const pageId = (item.node as any).page_id as number | undefined;
        const key = pageId != null ? String(pageId) : 'no-page';
        if (!groupMap.has(key)) {
          const pageName = pageId != null
            ? (pageMap.get(pageId)?.name ?? `Page ${pageId}`)
            : '(No page)';
          groupMap.set(key, { label: pageName, items: [] });
        }
        groupMap.get(key)!.items.push(item);
      }
      return Array.from(groupMap.values());
    }

    if (groupByProperty) {
      const propId = String(groupByProperty.id);
      const groupMap = new Map<string, GanttGroup>();
      for (const item of ganttItems) {
        const rawValue = (item.node.properties as Record<string, unknown> | undefined)?.[propId] ?? null;
        const { label, icon } = getPropertyGroupInfo(groupByProperty, rawValue);
        if (!groupMap.has(label)) {
          groupMap.set(label, { label, headerIcon: icon, items: [] });
        }
        groupMap.get(label)!.items.push(item);
      }
      return Array.from(groupMap.values());
    }

    return null;
  }, [ganttItems, groupBy, groupByProperty, nodes]);

  const dateRange = useMemo(() => getDateRange(ganttItems), [ganttItems]);
  const headers = useMemo(
    () => generateHeaders(dateRange.start, dateRange.end, timeScale),
    [dateRange, timeScale]
  );

  // No properties configured
  if (!startDateProperty) {
    return (
      <div className={`node-gantt-view node-gantt-view--empty ${className}`}>
        <div className="node-gantt-view__empty-message">
          Select a start date property to display the Gantt chart.
          Use the <strong>Configure Gantt</strong> button in the toolbar.
        </div>
      </div>
    );
  }

  // Properties configured but no items have matching dates
  if (ganttItems.length === 0) {
    return (
      <div className={`node-gantt-view node-gantt-view--empty ${className}`}>
        <div className="node-gantt-view__empty-message">
          No nodes have a value for <em>{startDateProperty.name}</em>.
        </div>
      </div>
    );
  }

  return (
    <div className={`node-gantt-view ${className}`}>
      {/* Header row */}
      <div className="gantt-header">
        <div className="gantt-header__label">Node</div>
        <div className="gantt-header__timeline">
          {headers.map((h, i) => (
            <div
              key={i}
              className="gantt-header__marker"
              style={{ left: `${h.position}%` }}
            >
              {h.label}
            </div>
          ))}
        </div>
      </div>

      {/* Rows */}
      <div className="gantt-body">
        {groups ? (
          groups.map((group, gi) => (
            <div key={gi} className="gantt-group">
              <div className="gantt-group__header">
                {group.headerIcon && (
                  <NodeIcon icon={group.headerIcon} isPage={false} size="sm" />
                )}
                <span className="gantt-group__label">{group.label}</span>
                <span className="gantt-group__count">{group.items.length}</span>
              </div>
              {group.items.map((item) => (
                <GanttBar
                  key={item.node.id}
                  item={item}
                  dateRange={dateRange}
                  onNodeClick={onNodeClick}
                  onNodeShiftClick={onNodeShiftClick}
                />
              ))}
            </div>
          ))
        ) : (
          ganttItems.map((item) => (
            <GanttBar
              key={item.node.id}
              item={item}
              dateRange={dateRange}
              onNodeClick={onNodeClick}
              onNodeShiftClick={onNodeShiftClick}
            />
          ))
        )}
      </div>
    </div>
  );
}
