/**
 * NodeList Component
 * 
 * A reusable, flexible component for displaying lists of nodes in various view modes.
 * 
 * Features:
 * - Multiple view modes: table, list, kanban/grid, calendar
 * - Configurable columns for table view
 * - Click handlers for navigation
 * - Optional create button
 * - Loading and empty states
 * 
 * Used by:
 * - TypedNodesView (nodes with a specific type)
 * - PropertyView (nodes with a specific property)
 * - LinkedReferences (backlinks and property references)
 * - QueryView (query results)
 */
import { useState, useMemo, useCallback } from 'react';
import type { Node } from '@/types/api';
import { useTypes } from '@/hooks';
import { getEffectiveIcon } from '@/utils/nodeIcon';
import { NodeIcon, ChevronRightIcon } from './icons';
import { Button } from './core/Button';
import { ButtonAdd } from './core/ButtonAdd';
import { Bullet } from './Bullet';
import './NodeList.css';

// ==================== Types ====================

export type NodeListViewMode = 'table' | 'list' | 'kanban' | 'calendar';

export interface NodeListColumn {
  /** Unique key for the column */
  key: string;
  /** Header label */
  label: string;
  /** Icon for the header (optional) */
  icon?: string;
  /** Property ID if this column shows a property value */
  propertyId?: number;
  /** Width (optional, CSS value) */
  width?: string;
  /** Custom render function */
  render?: (node: Node, value: unknown) => React.ReactNode;
}

export interface NodeListItem {
  /** The node to display */
  node: Node;
  /** Property values if available */
  propertyValues?: Record<string, unknown>;
  /** Group key for kanban view */
  groupKey?: string;
  /** Date for calendar view */
  date?: string;
}

export interface NodeListProps {
  /** Items to display */
  items: NodeListItem[];
  /** Current view mode */
  viewMode?: NodeListViewMode;
  /** Default view mode (used if viewMode is not controlled) */
  defaultViewMode?: NodeListViewMode;
  /** Columns for table view */
  columns?: NodeListColumn[];
  /** Show view mode toggle */
  showViewToggle?: boolean;
  /** Title for the list */
  title?: string;
  /** Title icon */
  titleIcon?: React.ReactNode;
  /** Show create button */
  showCreate?: boolean;
  /** Create button label */
  createLabel?: string;
  /** Create handler */
  onCreate?: () => void;
  /** Item click handler */
  onItemClick?: (node: Node) => void;
  /** Item shift-click handler (e.g., open in sidebar) */
  onItemShiftClick?: (node: Node) => void;
  /** Loading state */
  isLoading?: boolean;
  /** Empty message */
  emptyMessage?: string;
  /** Extra CSS class */
  className?: string;
  /** Groups for kanban view */
  kanbanGroups?: { key: string; label: string; icon?: string }[];
  /** Group key accessor for kanban */
  getGroupKey?: (item: NodeListItem) => string;
  /** Date accessor for calendar */
  getDate?: (item: NodeListItem) => string | undefined;
  /** Collapsed state */
  defaultCollapsed?: boolean;
  /** Whether the section is collapsible */
  collapsible?: boolean;
}

// ==================== View Mode Icons ====================

function ListIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  );
}

function TableIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="3" y1="15" x2="21" y2="15" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
    </svg>
  );
}

function CalendarViewIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

// ==================== View Mode Toggle ====================

interface ViewModeToggleProps {
  mode: NodeListViewMode;
  onChange: (mode: NodeListViewMode) => void;
  availableModes?: NodeListViewMode[];
}

function ViewModeToggle({ 
  mode, 
  onChange, 
  availableModes = ['table', 'list', 'kanban', 'calendar'] 
}: ViewModeToggleProps) {
  const icons: Record<NodeListViewMode, React.ReactNode> = {
    list: <ListIcon />,
    table: <TableIcon />,
    kanban: <GridIcon />,
    calendar: <CalendarViewIcon />,
  };

  const titles: Record<NodeListViewMode, string> = {
    list: 'List view',
    table: 'Table view',
    kanban: 'Kanban view',
    calendar: 'Calendar view',
  };

  return (
    <div className="node-list-view-toggle">
      {availableModes.map((m) => (
        <button
          key={m}
          className={`node-list-view-toggle-btn ${mode === m ? 'active' : ''}`}
          onClick={() => onChange(m)}
          title={titles[m]}
        >
          {icons[m]}
        </button>
      ))}
    </div>
  );
}

// ==================== Default Column Render ====================

function defaultRenderCell(node: Node, column: NodeListColumn, value: unknown, allTypes?: Node[] | null): React.ReactNode {
  if (column.render) {
    return column.render(node, value);
  }
  
  // Handle special column keys
  switch (column.key) {
    case 'name':
    case 'title':
      return (
        <span className="node-list-cell-name">
          <NodeIcon icon={getEffectiveIcon(node, allTypes)} isPage={node.is_page} isDaily={node.is_daily} isMonthly={node.is_monthly} isYearly={node.is_yearly} size="xs" />
          <span>{node.name || 'Untitled'}</span>
        </span>
      );
    
    case 'created':
    case 'create_date':
      return new Date(node.create_date).toLocaleDateString();
    
    case 'updated':
    case 'write_date':
      return new Date(node.write_date).toLocaleDateString();
    
    default:
      // Property value
      if (value === null || value === undefined) {
        return <span className="node-list-cell-empty">—</span>;
      }
      if (typeof value === 'boolean') {
        return <input type="checkbox" checked={value} readOnly className="node-list-cell-checkbox" />;
      }
      return String(value);
  }
}

// ==================== List View ====================

interface ListViewProps {
  items: NodeListItem[];
  allTypes?: Node[] | null;
  onItemClick?: (node: Node) => void;
  onItemShiftClick?: (node: Node) => void;
}

function ListView({ items, allTypes, onItemClick, onItemShiftClick }: ListViewProps) {
  const handleClick = useCallback((e: React.MouseEvent, item: NodeListItem) => {
    if (e.shiftKey && onItemShiftClick) {
      e.preventDefault();
      onItemShiftClick(item.node);
    } else if (onItemClick) {
      onItemClick(item.node);
    }
  }, [onItemClick, onItemShiftClick]);

  return (
    <div className="node-list-view-list">
      {items.map((item) => (
        <button
          key={item.node.id}
          className="node-list-item"
          onClick={(e) => handleClick(e, item)}
        >
          <Bullet 
            nodeId={item.node.id} 
            icon={getEffectiveIcon(item.node, allTypes)} 
            isPage={item.node.is_page}
            interactive={false}
            size="xs"
          />
          <span className="node-list-item-name">
            {item.node.name || 'Untitled'}
          </span>
        </button>
      ))}
    </div>
  );
}

// ==================== Table View ====================

interface TableViewProps {
  items: NodeListItem[];
  columns: NodeListColumn[];
  allTypes?: Node[] | null;
  onItemClick?: (node: Node) => void;
  onItemShiftClick?: (node: Node) => void;
}

function TableView({ items, columns, allTypes, onItemClick, onItemShiftClick }: TableViewProps) {
  const handleClick = useCallback((e: React.MouseEvent, item: NodeListItem) => {
    if (e.shiftKey && onItemShiftClick) {
      e.preventDefault();
      onItemShiftClick(item.node);
    } else if (onItemClick) {
      onItemClick(item.node);
    }
  }, [onItemClick, onItemShiftClick]);

  return (
    <div className="node-list-view-table">
      <table className="node-list-table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} style={col.width ? { width: col.width } : undefined}>
                {col.icon && <span className="node-list-th-icon">{col.icon}</span>}
                <span>{col.label}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr 
              key={item.node.id} 
              onClick={(e) => handleClick(e, item)}
              className="node-list-row"
            >
              {columns.map((col) => {
                const value = col.key === 'name' || col.key === 'title' 
                  ? item.node.name 
                  : item.propertyValues?.[col.key];
                return (
                  <td key={col.key}>
                    {defaultRenderCell(item.node, col, value, allTypes)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ==================== Kanban View ====================

interface KanbanViewProps {
  items: NodeListItem[];
  groups: { key: string; label: string; icon?: string }[];
  getGroupKey: (item: NodeListItem) => string;
  allTypes?: Node[] | null;
  onItemClick?: (node: Node) => void;
  onItemShiftClick?: (node: Node) => void;
}

function KanbanView({ items, groups, getGroupKey, allTypes, onItemClick, onItemShiftClick }: KanbanViewProps) {
  const groupedItems = useMemo(() => {
    const grouped = new Map<string, NodeListItem[]>();
    for (const group of groups) {
      grouped.set(group.key, []);
    }
    // Add 'other' group for unmatched items
    grouped.set('__other__', []);
    
    for (const item of items) {
      const key = getGroupKey(item);
      const arr = grouped.get(key) ?? grouped.get('__other__')!;
      arr.push(item);
    }
    
    return grouped;
  }, [items, groups, getGroupKey]);

  const handleClick = useCallback((e: React.MouseEvent, item: NodeListItem) => {
    if (e.shiftKey && onItemShiftClick) {
      e.preventDefault();
      onItemShiftClick(item.node);
    } else if (onItemClick) {
      onItemClick(item.node);
    }
  }, [onItemClick, onItemShiftClick]);

  return (
    <div className="node-list-view-kanban">
      {groups.map((group) => {
        const groupItems = groupedItems.get(group.key) || [];
        return (
          <div key={group.key} className="node-list-kanban-column">
            <div className="node-list-kanban-header">
              {group.icon && <span className="node-list-kanban-icon">{group.icon}</span>}
              <span className="node-list-kanban-label">{group.label}</span>
              <span className="node-list-kanban-count">{groupItems.length}</span>
            </div>
            <div className="node-list-kanban-items">
              {groupItems.map((item) => (
                <button
                  key={item.node.id}
                  className="node-list-kanban-card"
                  onClick={(e) => handleClick(e, item)}
                >
                  <NodeIcon icon={getEffectiveIcon(item.node, allTypes)} isPage={item.node.is_page} isDaily={item.node.is_daily} isMonthly={item.node.is_monthly} isYearly={item.node.is_yearly} size="xs" />
                  <span>{item.node.name || 'Untitled'}</span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
      {/* Other group if it has items */}
      {(groupedItems.get('__other__')?.length ?? 0) > 0 && (
        <div className="node-list-kanban-column node-list-kanban-other">
          <div className="node-list-kanban-header">
            <span className="node-list-kanban-label">Other</span>
            <span className="node-list-kanban-count">{groupedItems.get('__other__')!.length}</span>
          </div>
          <div className="node-list-kanban-items">
            {groupedItems.get('__other__')!.map((item) => (
              <button
                key={item.node.id}
                className="node-list-kanban-card"
                onClick={(e) => handleClick(e, item)}
              >
                <NodeIcon icon={getEffectiveIcon(item.node, allTypes)} isPage={item.node.is_page} isDaily={item.node.is_daily} isMonthly={item.node.is_monthly} isYearly={item.node.is_yearly} size="xs" />
                <span>{item.node.name || 'Untitled'}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ==================== Calendar View ====================

interface CalendarViewProps {
  items: NodeListItem[];
  getDate: (item: NodeListItem) => string | undefined;
  onItemClick?: (node: Node) => void;
  onItemShiftClick?: (node: Node) => void;
}

function CalendarView({ items, getDate, onItemClick, onItemShiftClick }: CalendarViewProps) {
  const [currentMonth, setCurrentMonth] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });

  const handleClick = useCallback((e: React.MouseEvent, item: NodeListItem) => {
    if (e.shiftKey && onItemShiftClick) {
      e.preventDefault();
      onItemShiftClick(item.node);
    } else if (onItemClick) {
      onItemClick(item.node);
    }
  }, [onItemClick, onItemShiftClick]);

  // Group items by date
  const itemsByDate = useMemo(() => {
    const byDate = new Map<string, NodeListItem[]>();
    for (const item of items) {
      const date = getDate(item);
      if (date) {
        const existing = byDate.get(date) ?? [];
        existing.push(item);
        byDate.set(date, existing);
      }
    }
    return byDate;
  }, [items, getDate]);

  // Generate calendar days
  const calendarDays = useMemo(() => {
    const { year, month } = currentMonth;
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startDay = firstDay.getDay(); // 0 = Sunday
    
    const days: (Date | null)[] = [];
    
    // Empty cells before first day
    for (let i = 0; i < startDay; i++) {
      days.push(null);
    }
    
    // Days of the month
    for (let d = 1; d <= lastDay.getDate(); d++) {
      days.push(new Date(year, month, d));
    }
    
    return days;
  }, [currentMonth]);

  const prevMonth = () => {
    setCurrentMonth(({ year, month }) => {
      if (month === 0) return { year: year - 1, month: 11 };
      return { year, month: month - 1 };
    });
  };

  const nextMonth = () => {
    setCurrentMonth(({ year, month }) => {
      if (month === 11) return { year: year + 1, month: 0 };
      return { year, month: month + 1 };
    });
  };

  const monthName = new Date(currentMonth.year, currentMonth.month).toLocaleDateString('en-US', { 
    month: 'long', 
    year: 'numeric' 
  });

  return (
    <div className="node-list-view-calendar">
      <div className="node-list-calendar-header">
        <Button variant="ghost" size="xs" className="node-list-calendar-nav" onClick={prevMonth}>←</Button>
        <span className="node-list-calendar-month">{monthName}</span>
        <Button variant="ghost" size="xs" className="node-list-calendar-nav" onClick={nextMonth}>→</Button>
      </div>
      
      <div className="node-list-calendar-weekdays">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
          <div key={day} className="node-list-calendar-weekday">{day}</div>
        ))}
      </div>
      
      <div className="node-list-calendar-grid">
        {calendarDays.map((date, idx) => {
          if (!date) {
            return <div key={`empty-${idx}`} className="node-list-calendar-day empty" />;
          }
          
          const dateStr = date.toISOString().split('T')[0];
          const dayItems = itemsByDate.get(dateStr) || [];
          const isToday = dateStr === new Date().toISOString().split('T')[0];
          
          return (
            <div 
              key={dateStr} 
              className={`node-list-calendar-day ${isToday ? 'today' : ''} ${dayItems.length > 0 ? 'has-items' : ''}`}
            >
              <span className="node-list-calendar-day-num">{date.getDate()}</span>
              {dayItems.length > 0 && (
                <div className="node-list-calendar-day-items">
                  {dayItems.slice(0, 3).map((item) => (
                    <Button
                      key={item.node.id}
                      variant="ghost"
                      size="xs"
                      className="node-list-calendar-item"
                      onClick={(e) => handleClick(e, item)}
                      title={item.node.name || 'Untitled'}
                    >
                      {item.node.name || 'Untitled'}
                    </Button>
                  ))}
                  {dayItems.length > 3 && (
                    <span className="node-list-calendar-more">+{dayItems.length - 3} more</span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ==================== Main Component ====================

export function NodeList({
  items,
  viewMode: controlledViewMode,
  defaultViewMode = 'table',
  columns = [{ key: 'name', label: 'Name' }],
  showViewToggle = true,
  title,
  titleIcon,
  showCreate = false,
  createLabel = 'Create',
  onCreate,
  onItemClick,
  onItemShiftClick,
  isLoading = false,
  emptyMessage = 'No items',
  className = '',
  kanbanGroups = [],
  getGroupKey = () => '__other__',
  getDate = () => undefined,
  defaultCollapsed = false,
  collapsible = true,
}: NodeListProps) {
  const [internalViewMode, setInternalViewMode] = useState<NodeListViewMode>(defaultViewMode);
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);
  const { data: allTypes } = useTypes();
  
  const viewMode = controlledViewMode ?? internalViewMode;
  const setViewMode = controlledViewMode ? () => {} : setInternalViewMode;

  // Determine available view modes
  const availableModes = useMemo<NodeListViewMode[]>(() => {
    const modes: NodeListViewMode[] = ['table', 'list'];
    if (kanbanGroups.length > 0) modes.push('kanban');
    modes.push('calendar');
    return modes;
  }, [kanbanGroups]);

  const handleToggleCollapse = useCallback(() => {
    if (collapsible) {
      setIsCollapsed(!isCollapsed);
    }
  }, [collapsible, isCollapsed]);

  // Loading state
  if (isLoading) {
    return (
      <section className={`node-list node-list--loading ${className}`}>
        {title && (
          <header className="node-list-header">
            {titleIcon}
            <h3 className="node-list-title">{title}</h3>
          </header>
        )}
        <div className="node-list-skeleton">Loading...</div>
      </section>
    );
  }

  // Empty state
  if (items.length === 0) {
    return (
      <section className={`node-list node-list--empty ${className}`}>
        {title && (
          <header className="node-list-header">
            {titleIcon}
            <h3 className="node-list-title">{title}</h3>
            {showCreate && onCreate && (
              <ButtonAdd 
                className="node-list-create-btn" 
                onClick={onCreate}
                title={createLabel}
                size="xs"
              >
                {createLabel}
              </ButtonAdd>
            )}
          </header>
        )}
        <div className="node-list-empty-message">
          <p>{emptyMessage}</p>
          {showCreate && onCreate && (
            <ButtonAdd 
              className="node-list-create-btn-large" 
              onClick={onCreate}
              title={createLabel}
              size="xs"
            >
              {createLabel}
            </ButtonAdd>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className={`node-list ${className}`}>
      <header className="node-list-header">
        <div className="node-list-header-left">
          {collapsible && (
            <Button 
              variant="ghost"
              size="xs"
              className={`node-list-collapse-btn ${isCollapsed ? 'collapsed' : ''}`}
              onClick={handleToggleCollapse}
            >
              <ChevronRightIcon size="xs" />
            </Button>
          )}
          {titleIcon}
          <h3 className="node-list-title" onClick={collapsible ? handleToggleCollapse : undefined}>
            {title}
            <span className="node-list-count">({items.length})</span>
          </h3>
        </div>
        
        <div className="node-list-header-right">
          {showViewToggle && !isCollapsed && (
            <ViewModeToggle 
              mode={viewMode} 
              onChange={setViewMode}
              availableModes={availableModes}
            />
          )}
          {showCreate && onCreate && !isCollapsed && (
            <ButtonAdd 
              className="node-list-create-btn" 
              onClick={onCreate} 
              title={createLabel}
              size="xs"
            />
          )}
        </div>
      </header>
      
      {!isCollapsed && (
        <div className="node-list-content">
          {viewMode === 'list' && (
            <ListView 
              items={items}
              allTypes={allTypes}
              onItemClick={onItemClick}
              onItemShiftClick={onItemShiftClick}
            />
          )}
          
          {viewMode === 'table' && (
            <TableView 
              items={items} 
              columns={columns}
              allTypes={allTypes}
              onItemClick={onItemClick}
              onItemShiftClick={onItemShiftClick}
            />
          )}
          
          {viewMode === 'kanban' && (
            <KanbanView 
              items={items}
              groups={kanbanGroups}
              getGroupKey={getGroupKey}
              allTypes={allTypes}
              onItemClick={onItemClick}
              onItemShiftClick={onItemShiftClick}
            />
          )}
          
          {viewMode === 'calendar' && (
            <CalendarView 
              items={items}
              getDate={getDate}
              onItemClick={onItemClick}
              onItemShiftClick={onItemShiftClick}
            />
          )}
        </div>
      )}
    </section>
  );
}

export default NodeList;
