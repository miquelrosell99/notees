/**
 * CalendarView - Calendar view with configurable date property
 * 
 * Displays a monthly calendar with dots indicating days with nodes.
 * Clicking a date opens a sidebar with the list of nodes for that day.
 */
import { useState, useMemo, useCallback } from 'react';
import './CalendarView.css';
import type { Node, Property } from '@/types/api';
import { BulletIcon, NodeIcon } from '../components/icons';
import { SidebarCard } from '../components/SidebarCard';

export interface CalendarViewProps {
  /** Nodes to display */
  nodes: Node[];
  /** Available date properties */
  properties?: Property[];
  /** Currently selected date property ID */
  datePropertyId?: number | null;
  /** Callback when date property changes */
  onDatePropertyChange?: (propertyId: number | null) => void;
  /** Callback when a node is clicked */
  onNodeClick?: (nodeId: number) => void;
  /** Extra CSS class */
  className?: string;
  /** Title for the view */
  title?: string;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

/**
 * Get date property value from node
 */
function getDateValue(node: Node, propertyId: number | null, properties: Property[]): string | null {
  if (!propertyId || !node.properties) return null;
  
  const prop = properties.find(p => p.id === propertyId);
  if (!prop || prop.type !== 'date') return null;
  
  const propKey = prop.name.toLowerCase().replace(/\s+/g, '_');
  const value = (node.properties as Record<string, unknown>)[propKey];
  
  if (!value) return null;
  return String(value);
}

/**
 * Format date to YYYY-MM-DD
 */
function formatDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Generate calendar grid for a month
 */
function generateCalendarGrid(year: number, month: number): Date[] {
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  
  const startOffset = firstDay.getDay();
  const totalDays = lastDay.getDate();
  
  const grid: Date[] = [];
  
  // Add days from previous month
  for (let i = startOffset - 1; i >= 0; i--) {
    grid.push(new Date(year, month, -i));
  }
  
  // Add days from current month
  for (let i = 1; i <= totalDays; i++) {
    grid.push(new Date(year, month, i));
  }
  
  // Add days from next month to fill grid (6 rows)
  const remaining = 42 - grid.length;
  for (let i = 1; i <= remaining; i++) {
    grid.push(new Date(year, month + 1, i));
  }
  
  return grid;
}

/**
 * Map nodes to dates
 */
function mapNodesToDates(
  nodes: Node[],
  propertyId: number | null,
  properties: Property[]
): Map<string, Node[]> {
  const map = new Map<string, Node[]>();
  
  for (const node of nodes) {
    const dateStr = getDateValue(node, propertyId, properties);
    if (!dateStr) continue;
    
    const existing = map.get(dateStr) ?? [];
    existing.push(node);
    map.set(dateStr, existing);
  }
  
  return map;
}

/**
 * Property selector for date property
 */
function DatePropertySelector({
  properties,
  selectedId,
  onChange,
}: {
  properties: Property[];
  selectedId: number | null;
  onChange: (id: number | null) => void;
}) {
  const dateProps = properties.filter(p => p.type === 'date');
  
  if (dateProps.length === 0) {
    return (
      <div className="calendar-view__no-props">
        No date properties available
      </div>
    );
  }
  
  return (
    <div className="calendar-view__date-prop">
      <label className="calendar-view__date-prop-label">Date property</label>
      <select 
        className="calendar-view__date-prop-select"
        value={selectedId ?? ''}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
      >
        <option value="">Select property...</option>
        {dateProps.map(prop => (
          <option key={prop.id} value={prop.id}>
            {prop.icon ? `${prop.icon} ` : ''}{prop.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Day cell component
 */
function DayCell({
  date,
  isCurrentMonth,
  isToday,
  nodes,
  onClick,
}: {
  date: Date;
  isCurrentMonth: boolean;
  isToday: boolean;
  nodes: Node[];
  onClick: () => void;
}) {
  const hasNodes = nodes.length > 0;
  
  return (
    <button
      className={`calendar-view__day ${!isCurrentMonth ? 'calendar-view__day--other-month' : ''} ${isToday ? 'calendar-view__day--today' : ''} ${hasNodes ? 'calendar-view__day--has-nodes' : ''}`}
      onClick={onClick}
    >
      <span className="calendar-view__day-number">{date.getDate()}</span>
      {hasNodes && (
        <span className="calendar-view__day-dot" title={`${nodes.length} item(s)`} />
      )}
    </button>
  );
}

/**
 * Sidebar panel showing nodes for a selected date
 */
function DayDetailsSidebar({
  date,
  nodes,
  onClose,
  onNodeClick,
}: {
  date: Date;
  nodes: Node[];
  onClose: () => void;
  onNodeClick?: (nodeId: number) => void;
}) {
  const formattedDate = date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  
  return (
    <SidebarCard 
      title={formattedDate}
      onClose={onClose}
    >
      <div className="calendar-view__day-details">
        {nodes.length === 0 ? (
          <p className="calendar-view__day-empty">No items for this date</p>
        ) : (
          <ul className="calendar-view__day-nodes">
            {nodes.map(node => (
              <li key={node.id} className="calendar-view__day-node">
                <button
                  className="calendar-view__day-node-btn"
                  onClick={() => onNodeClick?.(node.id)}
                >
                  <span className="calendar-view__day-node-bullet">
                    <BulletIcon size="xs" />
                  </span>
                  <NodeIcon icon={node.icon} isPage={true} isDaily={node.is_daily} isMonthly={node.is_monthly} isYearly={node.is_yearly} size="xs" />
                  <span className="calendar-view__day-node-name">
                    {node.name || 'Untitled'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SidebarCard>
  );
}

/**
 * Calendar View
 */
export function CalendarView({
  nodes,
  properties = [],
  datePropertyId = null,
  onDatePropertyChange,
  onNodeClick,
  className = '',
  title = 'Calendar',
}: CalendarViewProps) {
  const today = new Date();
  const [currentYear, setCurrentYear] = useState(today.getFullYear());
  const [currentMonth, setCurrentMonth] = useState(today.getMonth());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [internalDateProp, setInternalDateProp] = useState<number | null>(datePropertyId);
  
  const effectiveDateProp = onDatePropertyChange ? datePropertyId : internalDateProp;
  const handleDatePropChange = onDatePropertyChange ?? setInternalDateProp;
  
  // Generate calendar grid
  const calendarDays = useMemo(
    () => generateCalendarGrid(currentYear, currentMonth),
    [currentYear, currentMonth]
  );
  
  // Map nodes to dates
  const nodesByDate = useMemo(
    () => mapNodesToDates(nodes, effectiveDateProp, properties),
    [nodes, effectiveDateProp, properties]
  );
  
  // Selected date nodes
  const selectedDateNodes = useMemo(() => {
    if (!selectedDate) return [];
    return nodesByDate.get(formatDateKey(selectedDate)) ?? [];
  }, [selectedDate, nodesByDate]);
  
  const goToPrevMonth = useCallback(() => {
    if (currentMonth === 0) {
      setCurrentMonth(11);
      setCurrentYear(y => y - 1);
    } else {
      setCurrentMonth(m => m - 1);
    }
  }, [currentMonth]);
  
  const goToNextMonth = useCallback(() => {
    if (currentMonth === 11) {
      setCurrentMonth(0);
      setCurrentYear(y => y + 1);
    } else {
      setCurrentMonth(m => m + 1);
    }
  }, [currentMonth]);
  
  const goToToday = useCallback(() => {
    setCurrentYear(today.getFullYear());
    setCurrentMonth(today.getMonth());
  }, [today]);
  
  return (
    <div className={`calendar-view ${className}`}>
      <div className="calendar-view__header">
        <h3 className="calendar-view__title">{title}</h3>
        {properties.length > 0 && (
          <DatePropertySelector
            properties={properties}
            selectedId={effectiveDateProp}
            onChange={handleDatePropChange}
          />
        )}
      </div>
      
      <div className="calendar-view__nav">
        <button className="calendar-view__nav-btn" onClick={goToPrevMonth}>
          ←
        </button>
        <div className="calendar-view__nav-current">
          <span className="calendar-view__nav-month">{MONTHS[currentMonth]}</span>
          <span className="calendar-view__nav-year">{currentYear}</span>
        </div>
        <button className="calendar-view__nav-btn" onClick={goToNextMonth}>
          →
        </button>
        <button className="calendar-view__nav-today" onClick={goToToday}>
          Today
        </button>
      </div>
      
      <div className="calendar-view__grid">
        <div className="calendar-view__weekdays">
          {WEEKDAYS.map(day => (
            <div key={day} className="calendar-view__weekday">{day}</div>
          ))}
        </div>
        
        <div className="calendar-view__days">
          {calendarDays.map((date, idx) => {
            const isCurrentMonth = date.getMonth() === currentMonth;
            const isToday = formatDateKey(date) === formatDateKey(today);
            const dayNodes = nodesByDate.get(formatDateKey(date)) ?? [];
            
            return (
              <DayCell
                key={idx}
                date={date}
                isCurrentMonth={isCurrentMonth}
                isToday={isToday}
                nodes={dayNodes}
                onClick={() => setSelectedDate(date)}
              />
            );
          })}
        </div>
      </div>
      
      {/* Day details sidebar */}
      {selectedDate && (
        <div className="calendar-view__sidebar">
          <DayDetailsSidebar
            date={selectedDate}
            nodes={selectedDateNodes}
            onClose={() => setSelectedDate(null)}
            onNodeClick={onNodeClick}
          />
        </div>
      )}
    </div>
  );
}

export default CalendarView;
