/**
 * Table Component
 * 
 * A flexible table component with sorting, selection, and styling options.
 */
import { useState, useCallback, type ReactNode } from 'react';
import './Table.css';

export type TableSize = 'sm' | 'md' | 'lg';
export type TableVariant = 'default' | 'striped' | 'bordered';
export type SortDirection = 'asc' | 'desc' | null;

export interface TableColumn<T> {
  /** Unique key for the column */
  key: string;
  /** Column header text */
  header: string | ReactNode;
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
}

/**
 * Table component for displaying tabular data.
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
  loading = false,
  emptyContent = 'No data',
  caption,
  showHeader = true,
  hoverable = true,
  className = '',
}: TableProps<T>) {
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>(null);

  const handleSort = useCallback((column: TableColumn<T>) => {
    if (!column.sortable) return;

    if (sortColumn === column.key) {
      if (sortDirection === 'asc') {
        setSortDirection('desc');
      } else if (sortDirection === 'desc') {
        setSortDirection(null);
        setSortColumn(null);
      } else {
        setSortDirection('asc');
      }
    } else {
      setSortColumn(column.key);
      setSortDirection('asc');
    }
  }, [sortColumn, sortDirection]);

  const handleRowSelect = useCallback((key: string | number, event: React.MouseEvent) => {
    if (!selectable || !onSelectionChange) return;

    const newSelection = new Set(selectedKeys);
    
    if (event.shiftKey && selectedKeys) {
      // Range selection - not implemented here for simplicity
    } else if (event.ctrlKey || event.metaKey) {
      // Toggle selection
      if (newSelection.has(key)) {
        newSelection.delete(key);
      } else {
        newSelection.add(key);
      }
    } else {
      // Single selection
      newSelection.clear();
      newSelection.add(key);
    }

    onSelectionChange(newSelection);
  }, [selectable, selectedKeys, onSelectionChange]);

  const handleSelectAll = useCallback(() => {
    if (!selectable || !onSelectionChange) return;

    if (selectedKeys?.size === data.length) {
      onSelectionChange(new Set());
    } else {
      onSelectionChange(new Set(data.map(getRowKey)));
    }
  }, [selectable, selectedKeys, data, getRowKey, onSelectionChange]);

  // Sort data
  const sortedData = [...data];
  if (sortColumn && sortDirection) {
    const column = columns.find(c => c.key === sortColumn);
    if (column) {
      sortedData.sort((a, b) => {
        if (column.sortFn) {
          return sortDirection === 'asc' ? column.sortFn(a, b) : column.sortFn(b, a);
        }
        // Default string comparison
        const aVal = String(column.accessor(a) ?? '');
        const bVal = String(column.accessor(b) ?? '');
        const comparison = aVal.localeCompare(bVal);
        return sortDirection === 'asc' ? comparison : -comparison;
      });
    }
  }

  const containerClasses = [
    'table-container',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const tableClasses = [
    'table',
    `table--${size}`,
    `table--${variant}`,
    hoverable ? 'table--hoverable' : '',
    selectable ? 'table--selectable' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={containerClasses}>
      <table className={tableClasses}>
        {caption && <caption className="table-caption">{caption}</caption>}
        
        {showHeader && (
          <thead className="table-header">
            <tr className="table-row table-row--header">
              {selectable && (
                <th className="table-cell table-cell--checkbox">
                  <input
                    type="checkbox"
                    checked={selectedKeys?.size === data.length && data.length > 0}
                    onChange={handleSelectAll}
                    aria-label="Select all"
                  />
                </th>
              )}
              {columns.map(column => (
                <th
                  key={column.key}
                  className={[
                    'table-cell',
                    'table-cell--header',
                    column.sortable ? 'table-cell--sortable' : '',
                    column.align ? `table-cell--${column.align}` : '',
                    column.hideOnMobile ? 'table-cell--hide-mobile' : '',
                  ].filter(Boolean).join(' ')}
                  style={{ width: column.width }}
                  onClick={() => handleSort(column)}
                  aria-sort={
                    sortColumn === column.key
                      ? sortDirection === 'asc' ? 'ascending' : 'descending'
                      : undefined
                  }
                >
                  <div className="table-header-content">
                    <span>{column.header}</span>
                    {column.sortable && (
                      <span className="table-sort-icon">
                        {sortColumn === column.key && (
                          sortDirection === 'asc' ? '↑' : sortDirection === 'desc' ? '↓' : ''
                        )}
                      </span>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
        )}

        <tbody className="table-body">
          {loading ? (
            <tr className="table-row table-row--loading">
              <td colSpan={columns.length + (selectable ? 1 : 0)} className="table-cell table-cell--loading">
                Loading...
              </td>
            </tr>
          ) : sortedData.length === 0 ? (
            <tr className="table-row table-row--empty">
              <td colSpan={columns.length + (selectable ? 1 : 0)} className="table-cell table-cell--empty">
                {emptyContent}
              </td>
            </tr>
          ) : (
            sortedData.map(row => {
              const key = getRowKey(row);
              const isSelected = selectedKeys?.has(key);

              return (
                <tr
                  key={key}
                  className={[
                    'table-row',
                    isSelected ? 'table-row--selected' : '',
                  ].filter(Boolean).join(' ')}
                  onClick={(e) => {
                    if (selectable) handleRowSelect(key, e);
                    onRowClick?.(row);
                  }}
                >
                  {selectable && (
                    <td className="table-cell table-cell--checkbox">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => {}}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`Select row ${key}`}
                      />
                    </td>
                  )}
                  {columns.map(column => (
                    <td
                      key={column.key}
                      className={[
                        'table-cell',
                        column.align ? `table-cell--${column.align}` : '',
                        column.hideOnMobile ? 'table-cell--hide-mobile' : '',
                      ].filter(Boolean).join(' ')}
                      style={{ width: column.width }}
                    >
                      {column.accessor(row)}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
