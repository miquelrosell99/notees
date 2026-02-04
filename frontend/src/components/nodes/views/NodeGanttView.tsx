/**
 * NodeGanttView Component
 * 
 * Gantt/timeline view for NodeCollection.
 * Displays nodes on a timeline based on their dates.
 * 
 * Features:
 * - Timeline visualization
 * - Configurable time scale (day, week, month)
 * - Node positioning based on date properties
 * - Editable: allows interaction
 * - Read-only: display-only timeline
 */
import { useMemo, useCallback } from 'react';
import type { Node } from '@/types';
import type { NodeGanttViewProps } from '@/types/nodeCollection';
import { NodeIcon } from '../../icons';
import './NodeGanttView.css';

interface TimelineNode {
  node: Node;
  startDate: Date;
  endDate?: Date;
}

/**
 * Extract date from node for timeline positioning
 */
function getNodeDate(node: Node, dateProperty?: string): Date | null {
  // Check custom property first
  if (dateProperty && node.properties) {
    const propValue = (node.properties as Record<string, unknown>)[dateProperty];
    if (propValue && typeof propValue === 'string') {
      const date = new Date(propValue);
      if (!isNaN(date.getTime())) return date;
    }
  }
  
  // Fall back to create_date
  if (node.create_date) {
    return new Date(node.create_date);
  }
  
  return null;
}

/**
 * Get date range for timeline
 */
function getDateRange(nodes: TimelineNode[]): { start: Date; end: Date } {
  if (nodes.length === 0) {
    const now = new Date();
    return {
      start: new Date(now.getFullYear(), now.getMonth(), 1),
      end: new Date(now.getFullYear(), now.getMonth() + 1, 0),
    };
  }
  
  let minDate = nodes[0].startDate;
  let maxDate = nodes[0].endDate ?? nodes[0].startDate;
  
  for (const item of nodes) {
    if (item.startDate < minDate) minDate = item.startDate;
    const endDate = item.endDate ?? item.startDate;
    if (endDate > maxDate) maxDate = endDate;
  }
  
  // Add padding
  const start = new Date(minDate);
  start.setDate(start.getDate() - 7);
  const end = new Date(maxDate);
  end.setDate(end.getDate() + 7);
  
  return { start, end };
}

/**
 * Calculate position percentage for a date within a range
 */
function getDatePosition(date: Date, start: Date, end: Date): number {
  const total = end.getTime() - start.getTime();
  const offset = date.getTime() - start.getTime();
  return (offset / total) * 100;
}

/**
 * Format date header
 */
function formatDateHeader(date: Date, scale: 'day' | 'week' | 'month'): string {
  switch (scale) {
    case 'day':
      return date.toLocaleDateString('default', { weekday: 'short', day: 'numeric' });
    case 'week':
      return `Week ${Math.ceil(date.getDate() / 7)}`;
    case 'month':
      return date.toLocaleDateString('default', { month: 'short', year: 'numeric' });
    default:
      return date.toLocaleDateString();
  }
}

/**
 * Generate timeline headers based on scale
 */
function generateHeaders(start: Date, end: Date, scale: 'day' | 'week' | 'month'): { date: Date; label: string; position: number }[] {
  const headers: { date: Date; label: string; position: number }[] = [];
  const current = new Date(start);
  
  const increment = scale === 'day' ? 1 : scale === 'week' ? 7 : 30;
  
  while (current <= end) {
    headers.push({
      date: new Date(current),
      label: formatDateHeader(current, scale),
      position: getDatePosition(current, start, end),
    });
    current.setDate(current.getDate() + increment);
  }
  
  return headers;
}

interface GanttRowProps {
  item: TimelineNode;
  dateRange: { start: Date; end: Date };
  onNodeClick?: (node: Node) => void;
  onNodeShiftClick?: (node: Node) => void;
}

function GanttRow({
  item,
  dateRange,
  onNodeClick,
  onNodeShiftClick,
}: GanttRowProps) {
  const position = getDatePosition(item.startDate, dateRange.start, dateRange.end);
  const endPosition = item.endDate 
    ? getDatePosition(item.endDate, dateRange.start, dateRange.end)
    : position + 2; // Minimum width for single-day items
  
  const handleClick = useCallback((e: React.MouseEvent) => {
    if (e.shiftKey && onNodeShiftClick) {
      e.preventDefault();
      onNodeShiftClick(item.node);
    } else if (onNodeClick) {
      onNodeClick(item.node);
    }
  }, [item.node, onNodeClick, onNodeShiftClick]);
  
  const barStyle = useMemo(() => ({
    left: `${position}%`,
    width: `${Math.max(endPosition - position, 2)}%`,
    backgroundColor: item.node.color || 'var(--accent)',
  }), [position, endPosition, item.node.color]);

  return (
    <div className="gantt-row">
      <div className="gantt-row__label">
        <NodeIcon icon={item.node.icon} isPage={item.node.is_page} size="sm" />
        <span className="gantt-row__name">{item.node.name || 'Untitled'}</span>
      </div>
      <div className="gantt-row__timeline">
        <div 
          className="gantt-row__bar"
          style={barStyle}
          onClick={handleClick}
          title={item.node.name || 'Untitled'}
        />
      </div>
    </div>
  );
}

/**
 * NodeGanttView - Gantt/timeline view for NodeCollection
 */
export function NodeGanttView({
  nodes,
  // editable,  // Not used in this view
  dateProperty,
  timeScale = 'week',
  onNodeClick,
  onNodeShiftClick,
  // onContentChange,  // Not used in this view
  className = '',
}: NodeGanttViewProps) {
  // Convert nodes to timeline items
  const timelineNodes = useMemo<TimelineNode[]>(() => {
    return nodes
      .map(node => {
        const startDate = getNodeDate(node, dateProperty);
        if (!startDate) return null;
        return { node, startDate };
      })
      .filter((item): item is TimelineNode => item !== null)
      .sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
  }, [nodes, dateProperty]);
  
  // Calculate date range
  const dateRange = useMemo(() => getDateRange(timelineNodes), [timelineNodes]);
  
  // Generate timeline headers
  const headers = useMemo(() => generateHeaders(dateRange.start, dateRange.end, timeScale), [dateRange, timeScale]);
  
  if (timelineNodes.length === 0) {
    return (
      <div className={`node-gantt-view node-gantt-view--empty ${className}`}>
        <div className="node-gantt-view__empty-message">
          No nodes with dates to display
        </div>
      </div>
    );
  }

  return (
    <div className={`node-gantt-view ${className}`}>
      {/* Timeline header */}
      <div className="gantt-header">
        <div className="gantt-header__label">Node</div>
        <div className="gantt-header__timeline">
          {headers.map((header, index) => (
            <div 
              key={index}
              className="gantt-header__marker"
              style={{ left: `${header.position}%` }}
            >
              {header.label}
            </div>
          ))}
        </div>
      </div>
      
      {/* Timeline rows */}
      <div className="gantt-body">
        {timelineNodes.map((item) => (
          <GanttRow
            key={item.node.id}
            item={item}
            dateRange={dateRange}
            onNodeClick={onNodeClick}
            onNodeShiftClick={onNodeShiftClick}
          />
        ))}
      </div>
    </div>
  );
}
