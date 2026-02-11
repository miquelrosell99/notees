/**
 * Table Component
 * 
 * A flexible table component with sorting, selection, and styling options.
 * 
 * Features:
 * - Configurable columns with custom renderers
 * - Row selection (single/multi)
 * - Sorting (client-side or custom)
 * - Expandable rows with nested children
 * - Drag-and-drop row reordering
 * - Depth-based row indentation
 * - Automatic Node cell rendering with Block component and navigation buttons
 */
import { useState, useCallback, useRef, useEffect, Fragment, type ReactNode } from 'react';
import { mdiArrowRight, mdiDockRight } from '@mdi/js';
import type { Node } from '@/types';
import { Block } from '../blocks/Block';
import { ASTBlockContent } from '../blocks/ASTBlockContent';
import { Checkbox } from './Checkbox';
import { Button } from './Button';
import './Table.css';

export type TableSize = 'sm' | 'md' | 'lg';
export type TableVariant = 'default' | 'striped' | 'bordered';
export type SortDirection = 'asc' | 'desc';

/**
 * Helper to detect if a value is a Node object
 */
function isNode(value: unknown): value is { id: number; uuid: string; name: string; is_page?: boolean; parent_id?: number | null } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'uuid' in value &&
    'name' in value &&
    typeof (value as any).id === 'number' &&
    typeof (value as any).uuid === 'string'
  );
}

/** Entry for multi-column sorting */
export interface SortEntry {
  key: string;
  direction: SortDirection;
}

export interface TableColumn<T> {
  /** Unique key for the column */
  key: string;
  /** Column header text */
  header: string | ReactNode;
  /** Optional Node object for rendering header with Block component (for icons) */
  headerNode?: { id: number; uuid: string; name: string; icon: string | null };
  /** Accessor function to get cell value */
  accessor: (row: T) => ReactNode;
  /** Column width (CSS value) */
  width?: string;
  /** Whether the column is sortable */
  sortable?: boolean;
  /** Custom sort function */
  sortFn?: (a: T, b: T) => number;
  /** Text alignment */
  align?: 'left' | 'center' | 'right';
  /** Whether to hide on mobile */
  hideOnMobile?: boolean;
  /** Whether to auto-render Node cells with Block component and navigation buttons (default: true) */
  renderNodeCell?: boolean;
}

/** Configuration for expandable rows */
export interface ExpandableConfig<T> {
  /** Function to get children from a row */
  getChildren: (row: T) => T[];
  /** Whether a row can be expanded (default: has children) */
  canExpand?: (row: T) => boolean;
  /** Custom expand icon renderer */
  renderExpandIcon?: (expanded: boolean) => ReactNode;
  /** Maximum nesting depth (default: unlimited) */
  maxDepth?: number;
}

/** Configuration for row reordering */
export interface ReorderableConfig {
  /** Callback when rows are reordered */
  onReorder: (fromIndex: number, toIndex: number) => void;
  /** Custom drag handle icon renderer */
  renderDragHandle?: () => ReactNode;
}

export interface TableProps<T> {
  /** Array of data items */
  data: T[];
  /** Column definitions */
  columns: TableColumn<T>[];
  /** Get unique key for each row */
  getRowKey: (row: T) => string | number;
  /** Table size */
  size?: TableSize;
  /** Table variant */
  variant?: TableVariant;
  /** Whether rows are selectable */
  selectable?: boolean;
  /** Currently selected row keys */
  selectedKeys?: Set<string | number>;
  /** Selection change handler */
  onSelectionChange?: (keys: Set<string | number>) => void;
  /** Row click handler */
  onRowClick?: (row: T) => void;
  /** Row shift+click handler */
  onRowShiftClick?: (row: T) => void;
  /** Row context menu handler */
  onRowContextMenu?: (row: T, event: React.MouseEvent) => void;
  /** Column header context menu handler */
  onHeaderContextMenu?: (column: TableColumn<T>, event: React.MouseEvent) => void;
  /** Header checkbox context menu handler */
  onHeaderCheckboxContextMenu?: (event: React.MouseEvent) => void;
  /** Whether the table is loading */
  loading?: boolean;
  /** Empty state content */
  emptyContent?: ReactNode;
  /** Table caption (for accessibility) */
  caption?: string;
  /** Whether to show the header */
  showHeader?: boolean;
  /** Whether rows should be hoverable */
  hoverable?: boolean;
  /** Additional className */
  className?: string;
  /** Expandable row configuration */
  expandable?: ExpandableConfig<T>;
  /** Reorderable row configuration */
  reorderable?: ReorderableConfig;
  /** Get custom className for a row */
  getRowClassName?: (row: T, index: number, depth: number) => string;
  /** Current rendering depth (for nested tables) */
  depth?: number;
  /** Controlled expanded keys */
  expandedKeys?: Set<string | number>;
  /** Callback when expanded keys change */
  onExpandedChange?: (keys: Set<string | number>) => void;
  /** Callback when a node should be opened (for Node cell auto-rendering) */
  onNodeOpen?: (nodeId: number, type: 'page' | 'block') => void;
  /** Callback when a node should be opened in sidebar (for Node cell auto-rendering) */
  onNodeOpenInSidebar?: (nodeId: number, type: 'page' | 'block') => void;
}

/** Default drag handle icon */
const DefaultDragHandle = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" className="table-drag-icon">
    <circle cx="5" cy="4" r="1.5" />
    <circle cx="11" cy="4" r="1.5" />
    <circle cx="5" cy="8" r="1.5" />
    <circle cx="11" cy="8" r="1.5" />
    <circle cx="5" cy="12" r="1.5" />
    <circle cx="11" cy="12" r="1.5" />
  </svg>
);

/**
 * Table component for displaying tabular data.
 * Supports sorting, selection, expandable rows, and drag-and-drop reordering.
 */
export function Table<T>({
  data,
  columns,
  getRowKey,
  size = 'md',
  variant = 'default',
  selectable = false,
  selectedKeys,
  onSelectionChange,
  onRowClick,
  onRowShiftClick,
  onRowContextMenu,
  onHeaderContextMenu,
  onHeaderCheckboxContextMenu,
  loading = false,
  emptyContent = 'No data',
  caption,
  showHeader = true,
  hoverable = true,
  className = '',
  expandable,
  reorderable,
  getRowClassName,
  depth = 0,
  expandedKeys: controlledExpandedKeys,
  onExpandedChange: _onExpandedChange,
  onNodeOpen,
  onNodeOpenInSidebar,
}: TableProps<T>) {
  // Multi-column sort state: array of { key, direction } in sort priority order
  const [sortColumns, setSortColumns] = useState<SortEntry[]>([]);
  
  // Internal expanded state (when uncontrolled) - currently only controlled mode is supported
  // since no internal toggle UI exists
  const [internalExpandedKeys, _setInternalExpandedKeys] = useState<Set<string | number>>(new Set());
  const expandedKeys = controlledExpandedKeys ?? internalExpandedKeys;
  
  // Suppress unused variable warnings for expansion control (kept for API compatibility)
  void _onExpandedChange;
  void _setInternalExpandedKeys;
  
  // Drag state for reorderable rows
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rowHeightRef = useRef(40);

  const handleSort = useCallback((column: TableColumn<T>) => {
    if (!column.sortable) return;

    setSortColumns(prev => {
      const existingIndex = prev.findIndex(s => s.key === column.key);
      
      if (existingIndex === -1) {
        // Column not in sort list - add it with ascending
        return [...prev, { key: column.key, direction: 'asc' }];
      }
      
      const existing = prev[existingIndex];
      
      if (existing.direction === 'asc') {
        // Currently ascending - toggle to descending
        const updated = [...prev];
        updated[existingIndex] = { key: column.key, direction: 'desc' };
        return updated;
      } else {
        // Currently descending - remove from sort list
        return prev.filter(s => s.key !== column.key);
      }
    });
  }, []);

  const handleToggleSelect = useCallback((key: string | number) => {
    if (!selectable || !onSelectionChange) return;

    const newSelection = new Set(selectedKeys);
    if (newSelection.has(key)) {
      newSelection.delete(key);
    } else {
      newSelection.add(key);
    }
    onSelectionChange(newSelection);
  }, [selectable, selectedKeys, onSelectionChange]);

  const handleSelectAll = useCallback(() => {
    if (!selectable || !onSelectionChange) return;

    // Collect all keys including nested children
    const allKeys: (string | number)[] = [];
    const collectKeys = (items: T[]) => {
      items.forEach(item => {
        allKeys.push(getRowKey(item));
        if (expandable) {
          const children = expandable.getChildren(item);
          if (children.length > 0) {
            collectKeys(children);
          }
        }
      });
    };
    collectKeys(data);

    // Check if all keys are selected
    const allKeysSelected = allKeys.length > 0 && allKeys.every(key => selectedKeys?.has(key));
    
    if (allKeysSelected) {
      onSelectionChange(new Set());
    } else {
      onSelectionChange(new Set(allKeys));
    }
  }, [selectable, selectedKeys, data, getRowKey, onSelectionChange, expandable]);

  const handleRowClick = useCallback((row: T, e: React.MouseEvent) => {
    if (e.shiftKey && onRowShiftClick) {
      e.preventDefault();
      onRowShiftClick(row);
    } else {
      onRowClick?.(row);
    }
  }, [onRowClick, onRowShiftClick]);

  const handleRowContextMenu = useCallback((row: T, e: React.MouseEvent) => {
    if (onRowContextMenu) {
      e.preventDefault();
      onRowContextMenu(row, e);
    }
  }, [onRowContextMenu]);

  // Measure row height for drag calculation
  useEffect(() => {
    if (containerRef.current && reorderable) {
      const firstRow = containerRef.current.querySelector('.table-row:not(.table-row--header)') as HTMLElement;
      if (firstRow) {
        rowHeightRef.current = firstRow.offsetHeight;
      }
    }
  }, [data.length, reorderable]);

  // Handle drag start
  const handleDragStart = useCallback((index: number, e: React.MouseEvent) => {
    if (!reorderable) return;
    e.preventDefault();
    setDragIndex(index);
    setDropTargetIndex(index);
  }, [reorderable]);

  // Handle drag move and end
  useEffect(() => {
    if (dragIndex === null || !reorderable) return;

    const container = containerRef.current;
    if (!container) return;

    const handleMouseMove = (e: MouseEvent) => {
      const tbody = container.querySelector('.table-body');
      if (!tbody) return;
      
      const tbodyRect = tbody.getBoundingClientRect();
      const mouseY = e.clientY - tbodyRect.top;
      const rowHeight = rowHeightRef.current;
      const targetIndex = Math.max(0, Math.min(data.length - 1, Math.floor(mouseY / rowHeight)));
      setDropTargetIndex(targetIndex);
    };

    const handleMouseUp = () => {
      if (dragIndex !== null && dropTargetIndex !== null && dragIndex !== dropTargetIndex) {
        reorderable.onReorder(dragIndex, dropTargetIndex);
      }
      setDragIndex(null);
      setDropTargetIndex(null);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragIndex, dropTargetIndex, data.length, reorderable]);

  // Sort data by multiple columns
  const sortedData = [...data];
  if (sortColumns.length > 0) {
    sortedData.sort((a, b) => {
      for (const sortEntry of sortColumns) {
        const column = columns.find(c => c.key === sortEntry.key);
        if (!column) continue;
        
        let comparison: number;
        if (column.sortFn) {
          comparison = column.sortFn(a, b);
        } else {
          // Default string comparison
          const aVal = String(column.accessor(a) ?? '');
          const bVal = String(column.accessor(b) ?? '');
          comparison = aVal.localeCompare(bVal);
        }
        
        if (comparison !== 0) {
          return sortEntry.direction === 'asc' ? comparison : -comparison;
        }
      }
      return 0;
    });
  }

  // Compute selection state including nested children
  const computeAllKeys = (items: T[]): (string | number)[] => {
    const keys: (string | number)[] = [];
    items.forEach(item => {
      keys.push(getRowKey(item));
      if (expandable) {
        const children = expandable.getChildren(item);
        if (children.length > 0) {
          keys.push(...computeAllKeys(children));
        }
      }
    });
    return keys;
  };
  
  const allKeys = computeAllKeys(data);
  const allSelected = allKeys.length > 0 && allKeys.every(key => selectedKeys?.has(key));
  const someSelected = allKeys.some(key => selectedKeys?.has(key)) && !allSelected;

  // Calculate colspan for loading/empty states
  const extraColumns = 
    (selectable ? 1 : 0) + 
    (expandable ? 1 : 0);

  const containerClasses = [
    'table-container',
    reorderable ? 'table-container--reorderable' : '',
    expandable ? 'table-container--expandable' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const tableClasses = [
    'table',
    `table--${size}`,
    `table--${variant}`,
    hoverable ? 'table--hoverable' : '',
    selectable && onRowClick ? 'table--selectable' : '',
  ]
    .filter(Boolean)
    .join(' ');

  // Recursive row renderer for expandable tables
  const renderRow = (row: T, index: number, currentDepth: number): ReactNode => {
    const key = getRowKey(row);
    const isSelected = selectedKeys?.has(key);
    const isExpanded = expandedKeys.has(key);
    const isDragging = dragIndex === index && currentDepth === depth;
    const isDropTarget = dropTargetIndex === index && dragIndex !== null && dragIndex !== index && currentDepth === depth;
    
    // Check if row has children and can be expanded
    const children = expandable?.getChildren(row) ?? [];
    const maxDepth = expandable?.maxDepth ?? Infinity;
    const shouldShowChildren = isExpanded && currentDepth < maxDepth && children.length > 0;

    const customRowClass = getRowClassName?.(row, index, currentDepth) ?? '';
    const rowClasses = [
      'table-row',
      `table-row--depth-${currentDepth}`,
      isSelected ? 'table-row--selected' : '',
      isDragging ? 'table-row--dragging' : '',
      isDropTarget ? 'table-row--drop-target' : '',
      customRowClass,
    ].filter(Boolean).join(' ');

    return (
      <Fragment key={key}>
        <tr
          className={rowClasses}
          onClick={(e) => handleRowClick(row, e)}
          onContextMenu={(e) => handleRowContextMenu(row, e)}
        >
          {/* Drag handle - positioned element to the left of row */}
          {reorderable && currentDepth === depth && (
            <div
              className="table-drag-handle"
              onMouseDown={(e) => handleDragStart(index, e)}
              onClick={(e) => e.stopPropagation()}
              title="Drag to reorder"
            >
              {reorderable.renderDragHandle?.() ?? <DefaultDragHandle />}
            </div>
          )}
          
          {/* Checkbox column */}
          {selectable && (
            <td className="table-cell table-cell--checkbox" onClick={(e) => e.stopPropagation()}>
              <Checkbox
                size={size === 'lg' ? 'md' : 'sm'}
                checked={isSelected}
                onChange={() => handleToggleSelect(key)}
              />
            </td>
          )}
          
          {/* Data columns */}
          {columns.map((column) => {
            const cellValue = column.accessor(row);
            const shouldRenderNodeCell = column.renderNodeCell !== false && isNode(cellValue);
            
            return (
              <td
                key={column.key}
                className={[
                  'table-cell',
                  column.align ? `table-cell--${column.align}` : '',
                  column.hideOnMobile ? 'table-cell--hide-mobile' : '',
                  shouldRenderNodeCell ? 'table-cell--node' : '',
                ].filter(Boolean).join(' ')}
                style={{ width: column.width }}
              >
                {shouldRenderNodeCell ? (
                  <div className="table-node-cell">
                    <span className="table-node-cell__name">
                      <ASTBlockContent content={cellValue.name} />
                    </span>
                    <div className="table-node-cell__actions">
                      {onNodeOpenInSidebar && (
                        <Button
                          icon={mdiDockRight}
                          variant="ghost"
                          size="xs"
                          title="Open in sidebar"
                          onClick={(e) => {
                            e.stopPropagation();
                            onNodeOpenInSidebar(cellValue.id, cellValue.is_page ? 'page' : 'block');
                          }}
                        />
                      )}
                      {onNodeOpen && (
                        <Button
                          icon={mdiArrowRight}
                          variant="ghost"
                          size="xs"
                          title="Open node"
                          onClick={(e) => {
                            e.stopPropagation();
                            onNodeOpen(cellValue.id, cellValue.is_page ? 'page' : 'block');
                          }}
                        />
                      )}
                    </div>
                  </div>
                ) : (
                  cellValue
                )}
              </td>
            );
          })}
        </tr>
        
        {/* Render children if expanded */}
        {shouldShowChildren && children.map((child, childIndex) => 
          renderRow(child, childIndex, currentDepth + 1)
        )}
      </Fragment>
    );
  };

  return (
    <div className={containerClasses} ref={containerRef}>
      <table className={tableClasses}>
        {caption && <caption className="table-caption">{caption}</caption>}
        
        {showHeader && (
          <thead className="table-header">
            <tr className="table-row table-row--header">
              {selectable && (
                <th 
                  className="table-cell table-cell--checkbox" 
                  onClick={(e) => e.stopPropagation()}
                  onContextMenu={onHeaderCheckboxContextMenu ? (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onHeaderCheckboxContextMenu(e);
                  } : undefined}
                >
                  <Checkbox
                    size={size === 'lg' ? 'md' : 'sm'}
                    checked={allSelected}
                    indeterminate={someSelected}
                    onChange={handleSelectAll}
                  />
                </th>
              )}
              {columns.map(column => {
                const sortEntry = sortColumns.find(s => s.key === column.key);
                const sortIndex = sortColumns.findIndex(s => s.key === column.key);
                const showSortIndex = sortColumns.length > 1 && sortIndex !== -1;
                
                return (
                  <th
                    key={column.key}
                    className={[
                      'table-cell',
                      'table-cell--header',
                      column.sortable ? 'table-cell--sortable' : '',
                      sortEntry ? 'table-cell--sorted' : '',
                      column.align ? `table-cell--${column.align}` : '',
                      column.hideOnMobile ? 'table-cell--hide-mobile' : '',
                    ].filter(Boolean).join(' ')}
                    style={{ width: column.width }}
                    onClick={() => handleSort(column)}
                    onContextMenu={(e) => {
                      if (onHeaderContextMenu) {
                        e.preventDefault();
                        e.stopPropagation();
                        onHeaderContextMenu(column, e);
                      }
                    }}
                    aria-sort={
                      sortEntry
                        ? sortEntry.direction === 'asc' ? 'ascending' : 'descending'
                        : undefined
                    }
                  >
                    <div className="table-header-content">
                      {column.headerNode ? (
                        <Block
                          block={column.headerNode as Node}
                          parentId={null}
                          showBullet={!!column.headerNode.icon}
                          showChildren={false}
                          showClasses={false}
                          canMove={false}
                          canEdit={false}
                          canSelect={false}
                          isolatedState={true}
                        />
                      ) : (
                        <span>{column.header}</span>
                      )}
                      {column.sortable && sortEntry && (
                        <span className="table-sort-icon">
                          {sortEntry.direction === 'asc' ? '↑' : '↓'}
                          {showSortIndex && (
                            <span className="table-sort-index">{sortIndex + 1}</span>
                          )}
                        </span>
                      )}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
        )}

        <tbody className="table-body">
          {loading ? (
            <tr className="table-row table-row--loading">
              <td colSpan={columns.length + extraColumns} className="table-cell table-cell--loading">
                Loading...
              </td>
            </tr>
          ) : sortedData.length === 0 ? (
            <tr className="table-row table-row--empty">
              <td colSpan={columns.length + extraColumns} className="table-cell table-cell--empty">
                {emptyContent}
              </td>
            </tr>
          ) : (
            sortedData.map((row, index) => renderRow(row, index, depth))
          )}
        </tbody>
      </table>
    </div>
  );
}
