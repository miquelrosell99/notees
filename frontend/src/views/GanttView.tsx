/**
 * GanttView - Gantt chart for timeline visualization
 * 
 * Displays nodes on a timeline with start and end dates.
 * Supports grouping and different time scales.
 * 
 * Features:
 * - Selectable start/end date properties
 * - Multiple time scales (day, week, month)
 * - Grouping by property
 * - Today marker
 * - Navigation controls
 * - Progress indicators
 */
import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import './GanttView.css';
import type { Node, Property } from '@/types/api';
import type { GanttItem, GanttViewConfig } from '@/types/views';
import { NodeIcon } from '../components/icons';

export interface GanttViewProps {
  /** Nodes to display */
  nodes: Node[];
  /** Available properties */
  properties?: Property[];
  /** Initial config */
  config?: Partial<GanttViewConfig>;
  /** Pre-selected start date property ID (for embedded usage) */
  startDatePropertyId?: number | null;
  /** Pre-selected end date property ID (for embedded usage) */
  endDatePropertyId?: number | null;
  /** Hide the property selectors (when properties are pre-configured) */
  hidePropertySelectors?: boolean;
  /** Callback when config changes */
  onConfigChange?: (config: GanttViewConfig) => void;
  /** Callback when a node is clicked */
  onNodeClick?: (nodeId: number) => void;
  /** Extra CSS class */
  className?: string;
  /** Title */
  title?: string;
}

type TimeScale = 'day' | 'week' | 'month';

const TIME_SCALES: { value: TimeScale; label: string }[] = [
  { value: 'day', label: 'Days' },
  { value: 'week', label: 'Weeks' },
  { value: 'month', label: 'Months' },
];

/**
 * Get date property value from node
 */
function getDateValue(node: Node, propertyId: number | null, properties: Property[]): Date | null {
  if (!propertyId || !node.properties) return null;
  
  const prop = properties.find(p => p.id === propertyId);
  if (!prop || prop.type !== 'date') return null;
  
  const propKey = prop.name.toLowerCase().replace(/\s+/g, '_');
  const value = (node.properties as Record<string, unknown>)[propKey];
  
  if (!value) return null;
  
  const dateStr = String(value);
  const parts = dateStr.split(/[-/]/);
  if (parts.length !== 3) return null;
  
  // Assume YYYY-MM-DD or similar
  const nums = parts.map(p => parseInt(p, 10));
  if (nums.some(isNaN)) return null;
  
  if (nums[0] > 31) {
    return new Date(nums[0], nums[1] - 1, nums[2]);
  } else if (nums[2] > 31) {
    return new Date(nums[2], nums[1] - 1, nums[0]);
  }
  
  return null;
}

/**
 * Get string property value from node for grouping
 */
function getGroupValue(node: Node, propertyId: number | null, properties: Property[]): string {
  if (!propertyId || !node.properties) return 'Ungrouped';
  
  const prop = properties.find(p => p.id === propertyId);
  if (!prop) return 'Ungrouped';
  
  const propKey = prop.name.toLowerCase().replace(/\s+/g, '_');
  const value = (node.properties as Record<string, unknown>)[propKey];
  
  if (value === null || value === undefined) return 'Ungrouped';
  return String(value);
}

/**
 * Get date properties
 */
function getDateProperties(properties: Property[]): Property[] {
  return properties.filter(p => p.type === 'date');
}

/**
 * Get groupable properties
 */
function getGroupableProperties(properties: Property[]): Property[] {
  return properties.filter(p => 
    p.type === 'text' || p.type === 'selection' || p.type === 'boolean'
  );
}

/**
 * Calculate date range for the timeline
 */
function calculateDateRange(items: GanttItem[]): { start: Date; end: Date } {
  if (items.length === 0) {
    const today = new Date();
    return {
      start: new Date(today.getFullYear(), today.getMonth(), 1),
      end: new Date(today.getFullYear(), today.getMonth() + 1, 0),
    };
  }
  
  let minDate = items[0].startDate;
  let maxDate = items[0].endDate;
  
  for (const item of items) {
    if (item.startDate < minDate) minDate = item.startDate;
    if (item.endDate > maxDate) maxDate = item.endDate;
  }
  
  // Add some padding
  const start = new Date(minDate);
  start.setDate(start.getDate() - 7);
  
  const end = new Date(maxDate);
  end.setDate(end.getDate() + 7);
  
  return { start, end };
}

/**
 * Generate time columns based on scale
 */
function generateTimeColumns(start: Date, end: Date, scale: TimeScale): Date[] {
  const columns: Date[] = [];
  const current = new Date(start);
  
  while (current <= end) {
    columns.push(new Date(current));
    
    switch (scale) {
      case 'day':
        current.setDate(current.getDate() + 1);
        break;
      case 'week':
        current.setDate(current.getDate() + 7);
        break;
      case 'month':
        current.setMonth(current.getMonth() + 1);
        break;
    }
  }
  
  return columns;
}

/**
 * Format date for column header
 */
function formatColumnHeader(date: Date, scale: TimeScale): string {
  switch (scale) {
    case 'day':
      return `${date.getDate()}`;
    case 'week':
      return `W${getWeekNumber(date)}`;
    case 'month':
      return date.toLocaleDateString('en-US', { month: 'short' });
  }
}

/**
 * Get week number
 */
function getWeekNumber(date: Date): number {
  const firstDayOfYear = new Date(date.getFullYear(), 0, 1);
  const pastDaysOfYear = (date.getTime() - firstDayOfYear.getTime()) / 86400000;
  return Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
}

/**
 * Calculate bar position and width
 */
function calculateBarStyle(
  item: GanttItem,
  rangeStart: Date,
  rangeEnd: Date
): { left: string; width: string } {
  const totalDays = (rangeEnd.getTime() - rangeStart.getTime()) / 86400000;
  const startOffset = (item.startDate.getTime() - rangeStart.getTime()) / 86400000;
  const duration = Math.max(1, (item.endDate.getTime() - item.startDate.getTime()) / 86400000);
  
  const left = Math.max(0, (startOffset / totalDays) * 100);
  const width = Math.min(100 - left, (duration / totalDays) * 100);
  
  return {
    left: `${left}%`,
    width: `${Math.max(width, 1)}%`,
  };
}

/**
 * Get bar color based on progress or custom color
 */
function getBarColor(item: GanttItem): string | undefined {
  if (item.color) return item.color;
  
  // Color based on progress if available
  if (item.progress !== undefined) {
    if (item.progress >= 100) return 'var(--color-success)';
    if (item.progress >= 50) return 'var(--color-primary)';
    if (item.progress > 0) return 'var(--color-warning)';
  }
  
  return undefined;
}

/**
 * Format date range for display
 */
function formatDateRange(start: Date, end: Date): string {
  const sameDay = start.toDateString() === end.toDateString();
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  
  if (sameDay) {
    return start.toLocaleDateString('en-US', opts);
  }
  
  return `${start.toLocaleDateString('en-US', opts)} – ${end.toLocaleDateString('en-US', opts)}`;
}

/**
 * Calculate duration in days
 */
function getDuration(start: Date, end: Date): number {
  return Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 86400000));
}

/**
 * Property selector
 */
function PropertySelector({
  label,
  properties,
  selectedId,
  onChange,
}: {
  label: string;
  properties: Property[];
  selectedId: number | null;
  onChange: (id: number | null) => void;
}) {
  return (
    <div className="gantt-view__prop-select">
      <label className="gantt-view__prop-label">{label}</label>
      <select
        className="gantt-view__select"
        value={selectedId ?? ''}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
      >
        <option value="">Select...</option>
        {properties.map(p => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
    </div>
  );
}

/**
 * Gantt bar tooltip
 */
function GanttTooltip({
  item,
  visible,
  position,
}: {
  item: GanttItem;
  visible: boolean;
  position: { x: number; y: number };
}) {
  if (!visible) return null;
  
  const duration = getDuration(item.startDate, item.endDate);
  
  return (
    <div 
      className="gantt-view__tooltip"
      style={{ 
        left: position.x, 
        top: position.y,
        transform: 'translate(-50%, -100%)',
      }}
    >
      <div className="gantt-view__tooltip-title">{item.label}</div>
      <div className="gantt-view__tooltip-dates">
        {formatDateRange(item.startDate, item.endDate)}
      </div>
      <div className="gantt-view__tooltip-duration">
        {duration} day{duration !== 1 ? 's' : ''}
      </div>
      {item.progress !== undefined && (
        <div className="gantt-view__tooltip-progress">
          Progress: {item.progress}%
        </div>
      )}
    </div>
  );
}

/**
 * Gantt row component
 */
function GanttRow({
  item,
  rangeStart,
  rangeEnd,
  onClick,
  onHover,
}: {
  item: GanttItem;
  rangeStart: Date;
  rangeEnd: Date;
  onClick?: () => void;
  onHover?: (item: GanttItem | null, e: React.MouseEvent) => void;
}) {
  const barStyle = calculateBarStyle(item, rangeStart, rangeEnd);
  const barColor = getBarColor(item);
  const duration = getDuration(item.startDate, item.endDate);
  
  return (
    <div className="gantt-view__row">
      <div className="gantt-view__row-label" onClick={onClick}>
        <NodeIcon icon={item.node.icon} isPage={true} isDaily={item.node.is_daily} isMonthly={item.node.is_monthly} isYearly={item.node.is_yearly} size="xs" />
        <span className="gantt-view__row-name">{item.label}</span>
      </div>
      <div className="gantt-view__row-timeline">
        <div 
          className="gantt-view__bar"
          style={{ 
            left: barStyle.left, 
            width: barStyle.width,
            backgroundColor: barColor,
          }}
          onClick={onClick}
          onMouseEnter={(e) => onHover?.(item, e)}
          onMouseLeave={() => onHover?.(null, {} as React.MouseEvent)}
          title={`${item.label}: ${formatDateRange(item.startDate, item.endDate)} (${duration} day${duration !== 1 ? 's' : ''})`}
        >
          {item.progress !== undefined && item.progress > 0 && (
            <div 
              className="gantt-view__bar-progress"
              style={{ width: `${Math.min(100, item.progress)}%` }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * GanttView Component
 */
export function GanttView({
  nodes,
  properties = [],
  config: initialConfig,
  startDatePropertyId: externalStartDatePropertyId,
  endDatePropertyId: externalEndDatePropertyId,
  hidePropertySelectors = false,
  onConfigChange,
  onNodeClick,
  className = '',
  title = 'Gantt',
}: GanttViewProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  
  // Use external property IDs if provided, otherwise use config/state
  const [internalStartDatePropertyId, setInternalStartDatePropertyId] = useState<number | null>(
    externalStartDatePropertyId ?? initialConfig?.startDatePropertyId ?? null
  );
  const [internalEndDatePropertyId, setInternalEndDatePropertyId] = useState<number | null>(
    externalEndDatePropertyId ?? initialConfig?.endDatePropertyId ?? null
  );
  
  // Resolve which property IDs to use
  const startDatePropertyId = externalStartDatePropertyId ?? internalStartDatePropertyId;
  const endDatePropertyId = externalEndDatePropertyId ?? internalEndDatePropertyId;
  
  const [groupByPropertyId, setGroupByPropertyId] = useState<number | null>(
    initialConfig?.groupByPropertyId ?? null
  );
  const [timeScale, setTimeScale] = useState<TimeScale>(
    initialConfig?.timeScale ?? 'week'
  );
  const [showTodayMarker] = useState(
    initialConfig?.showTodayMarker ?? true
  );
  
  // Tooltip state
  const [tooltip, setTooltip] = useState<{
    item: GanttItem;
    position: { x: number; y: number };
  } | null>(null);
  
  // Date range navigation offset (in days/weeks/months based on scale)
  const [dateOffset, setDateOffset] = useState(0);
  
  const dateProps = useMemo(() => getDateProperties(properties), [properties]);
  const groupableProps = useMemo(() => getGroupableProperties(properties), [properties]);
  
  // Convert nodes to gantt items
  const ganttItems = useMemo<GanttItem[]>(() => {
    if (!startDatePropertyId) return [];
    
    const items: GanttItem[] = [];
    
    for (const node of nodes) {
      const startDate = getDateValue(node, startDatePropertyId, properties);
      if (!startDate) continue;
      
      // End date defaults to start date if not set
      const endDate = endDatePropertyId 
        ? getDateValue(node, endDatePropertyId, properties) ?? startDate
        : startDate;
      
      // Ensure end is after start
      const finalEnd = endDate >= startDate ? endDate : startDate;
      
      // Extract color from node if available
      const color = node.color ?? undefined;
      
      items.push({
        id: node.id,
        node,
        label: node.name || 'Untitled',
        startDate,
        endDate: finalEnd,
        group: getGroupValue(node, groupByPropertyId, properties),
        color,
      });
    }
    
    // Sort by start date
    return items.sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
  }, [nodes, startDatePropertyId, endDatePropertyId, groupByPropertyId, properties]);
  
  // Group items
  const groupedItems = useMemo(() => {
    if (!groupByPropertyId) {
      return [{ group: 'All', items: ganttItems }];
    }
    
    const groups = new Map<string, GanttItem[]>();
    for (const item of ganttItems) {
      const group = item.group ?? 'Ungrouped';
      const existing = groups.get(group) ?? [];
      existing.push(item);
      groups.set(group, existing);
    }
    
    return Array.from(groups.entries())
      .map(([group, items]) => ({ group, items }))
      .sort((a, b) => {
        if (a.group === 'Ungrouped') return 1;
        if (b.group === 'Ungrouped') return -1;
        return a.group.localeCompare(b.group);
      });
  }, [ganttItems, groupByPropertyId]);
  
  // Calculate date range with offset
  const { start: rangeStart, end: rangeEnd } = useMemo(() => {
    const baseRange = calculateDateRange(ganttItems);
    
    if (dateOffset === 0) return baseRange;
    
    const offsetDays = timeScale === 'day' ? dateOffset * 7 
      : timeScale === 'week' ? dateOffset * 28 
      : dateOffset * 90; // month
    
    return {
      start: new Date(baseRange.start.getTime() + offsetDays * 86400000),
      end: new Date(baseRange.end.getTime() + offsetDays * 86400000),
    };
  }, [ganttItems, dateOffset, timeScale]);
  
  // Generate time columns
  const timeColumns = useMemo(
    () => generateTimeColumns(rangeStart, rangeEnd, timeScale),
    [rangeStart, rangeEnd, timeScale]
  );
  
  // Today marker position
  const todayPosition = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    if (today < rangeStart || today > rangeEnd) return null;
    
    const totalDays = (rangeEnd.getTime() - rangeStart.getTime()) / 86400000;
    const offset = (today.getTime() - rangeStart.getTime()) / 86400000;
    return `${(offset / totalDays) * 100}%`;
  }, [rangeStart, rangeEnd]);
  
  const handleConfigChange = useCallback(() => {
    onConfigChange?.({
      mode: 'gantt',
      startDatePropertyId,
      endDatePropertyId,
      groupByPropertyId,
      timeScale,
      showTodayMarker,
      showDependencies: false,
    });
  }, [startDatePropertyId, endDatePropertyId, groupByPropertyId, timeScale, showTodayMarker, onConfigChange]);
  
  const handleHover = useCallback((item: GanttItem | null, e: React.MouseEvent) => {
    if (item && e.currentTarget) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setTooltip({
        item,
        position: { x: rect.left + rect.width / 2, y: rect.top - 8 },
      });
    } else {
      setTooltip(null);
    }
  }, []);
  
  // Navigation handlers
  const handleNavigatePrev = useCallback(() => {
    setDateOffset(prev => prev - 1);
  }, []);
  
  const handleNavigateNext = useCallback(() => {
    setDateOffset(prev => prev + 1);
  }, []);
  
  const handleNavigateToday = useCallback(() => {
    setDateOffset(0);
  }, []);
  
  // Scroll to today on mount
  useEffect(() => {
    if (contentRef.current && todayPosition) {
      const container = contentRef.current;
      const percentage = parseFloat(todayPosition) / 100;
      const scrollLeft = (container.scrollWidth - 150) * percentage - container.clientWidth / 2;
      container.scrollLeft = Math.max(0, scrollLeft);
    }
  }, [todayPosition]);
  
  // Show empty state if no date properties
  if (dateProps.length === 0 && !hidePropertySelectors) {
    return (
      <div className={`gantt-view gantt-view--empty ${className}`}>
        <p className="gantt-view__empty">No date properties available. Create a date property to use Gantt view.</p>
      </div>
    );
  }
  
  // Show config required state when property selectors are visible but not configured
  const needsConfiguration = !hidePropertySelectors && !startDatePropertyId;
  
  return (
    <div className={`gantt-view ${className}`}>
      <div className="gantt-view__header">
        <h3 className="gantt-view__title">{title}</h3>
        <div className="gantt-view__controls">
          {!hidePropertySelectors && (
            <>
              <PropertySelector
                label="Start"
                properties={dateProps}
                selectedId={startDatePropertyId}
                onChange={(id) => { setInternalStartDatePropertyId(id); handleConfigChange(); }}
              />
              <PropertySelector
                label="End"
                properties={dateProps}
                selectedId={endDatePropertyId}
                onChange={(id) => { setInternalEndDatePropertyId(id); handleConfigChange(); }}
              />
              {groupableProps.length > 0 && (
                <PropertySelector
                  label="Group"
                  properties={groupableProps}
                  selectedId={groupByPropertyId}
                  onChange={(id) => { setGroupByPropertyId(id); handleConfigChange(); }}
                />
              )}
            </>
          )}
          
          {/* Time scale selector */}
          <div className="gantt-view__scale-select">
            <select
              className="gantt-view__select"
              value={timeScale}
              onChange={(e) => { setTimeScale(e.target.value as TimeScale); handleConfigChange(); }}
            >
              {TIME_SCALES.map(s => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>
          
          {/* Navigation */}
          <div className="gantt-view__nav">
            <button 
              className="gantt-view__nav-btn" 
              onClick={handleNavigatePrev}
              title="Previous period"
            >
              ‹
            </button>
            <button 
              className="gantt-view__nav-btn gantt-view__nav-btn--today" 
              onClick={handleNavigateToday}
              title="Go to today"
            >
              Today
            </button>
            <button 
              className="gantt-view__nav-btn" 
              onClick={handleNavigateNext}
              title="Next period"
            >
              ›
            </button>
          </div>
        </div>
      </div>
      
      {/* Date range display */}
      {ganttItems.length > 0 && (
        <div className="gantt-view__range-display">
          {rangeStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          {' — '}
          {rangeEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          <span className="gantt-view__item-count">
            ({ganttItems.length} item{ganttItems.length !== 1 ? 's' : ''})
          </span>
        </div>
      )}
      
      {needsConfiguration ? (
        <div className="gantt-view__no-config">
          <p>Select a start date property to display the Gantt chart.</p>
        </div>
      ) : ganttItems.length === 0 ? (
        <div className="gantt-view__no-data">
          <p>No items with dates found.</p>
        </div>
      ) : (
        <div className="gantt-view__content" ref={contentRef}>
          {/* Timeline header */}
          <div className="gantt-view__timeline-header">
            <div className="gantt-view__label-column">Name</div>
            <div className="gantt-view__timeline-columns">
              {timeColumns.map((date, i) => (
                <div 
                  key={i} 
                  className={`gantt-view__timeline-col ${isToday(date, timeScale) ? 'gantt-view__timeline-col--today' : ''}`}
                >
                  {formatColumnHeader(date, timeScale)}
                </div>
              ))}
            </div>
          </div>
          
          {/* Rows */}
          <div className="gantt-view__rows">
            {groupedItems.map(({ group, items }) => (
              <div key={group} className="gantt-view__group">
                {groupByPropertyId && (
                  <div className="gantt-view__group-header">
                    {group}
                    <span className="gantt-view__group-count">{items.length}</span>
                  </div>
                )}
                {items.map(item => (
                  <GanttRow
                    key={item.id}
                    item={item}
                    rangeStart={rangeStart}
                    rangeEnd={rangeEnd}
                    onClick={() => onNodeClick?.(item.id)}
                    onHover={handleHover}
                  />
                ))}
              </div>
            ))}
            
            {/* Today marker */}
            {showTodayMarker && todayPosition && (
              <div 
                className="gantt-view__today-marker"
                style={{ left: `calc(150px + (100% - 150px) * ${parseFloat(todayPosition) / 100})` }}
              />
            )}
          </div>
        </div>
      )}
      
      {/* Tooltip */}
      {tooltip && (
        <GanttTooltip
          item={tooltip.item}
          visible={true}
          position={tooltip.position}
        />
      )}
    </div>
  );
}

/**
 * Check if a date is today (for highlighting)
 */
function isToday(date: Date, scale: TimeScale): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  switch (scale) {
    case 'day':
      return date.toDateString() === today.toDateString();
    case 'week': {
      const weekStart = new Date(date);
      const weekEnd = new Date(date);
      weekEnd.setDate(weekEnd.getDate() + 6);
      return today >= weekStart && today <= weekEnd;
    }
    case 'month':
      return date.getMonth() === today.getMonth() && date.getFullYear() === today.getFullYear();
  }
}

export default GanttView;
