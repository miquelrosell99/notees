/**
 * TableSizeSelector Component
 * 
 * A clickable grid for selecting table dimensions (rows x columns).
 * Similar to the table size selectors in CKEditor and other rich text editors.
 * 
 * Features:
 * - Hover to preview selection
 * - Click to confirm selection
 * - Visual feedback showing selected area
 * - Column headers don't count towards row count (handled by consumer)
 */
import { useState, useCallback, type MouseEvent } from 'react';
import './TableSizeSelector.css';

export interface TableSize {
  rows: number;
  columns: number;
}

export interface TableSizeSelectorProps {
  /** Maximum number of rows in the grid */
  maxRows?: number;
  /** Maximum number of columns in the grid */
  maxColumns?: number;
  /** Called when user clicks to confirm selection */
  onSelect: (size: TableSize) => void;
  /** Called when selection is cancelled (e.g., click outside) */
  onCancel?: () => void;
  /** Initial hint text shown below grid */
  hintText?: string;
}

/**
 * Interactive grid for selecting table dimensions
 */
export function TableSizeSelector({
  maxRows = 10,
  maxColumns = 10,
  onSelect,
  onCancel,
  hintText = 'Select table size',
}: TableSizeSelectorProps) {
  // Currently hovered cell position (1-indexed for display)
  const [hoveredSize, setHoveredSize] = useState<TableSize | null>(null);

  // Handle mouse enter on a cell
  const handleCellMouseEnter = useCallback((row: number, col: number) => {
    setHoveredSize({ rows: row, columns: col });
  }, []);

  // Handle mouse leave from the grid
  const handleGridMouseLeave = useCallback(() => {
    setHoveredSize(null);
  }, []);

  // Handle cell click
  const handleCellClick = useCallback((row: number, col: number, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onSelect({ rows: row, columns: col });
  }, [onSelect]);

  // Handle click outside the grid
  const handleBackdropClick = useCallback((e: MouseEvent) => {
    if (e.target === e.currentTarget) {
      onCancel?.();
    }
  }, [onCancel]);

  // Generate the grid cells
  const renderGrid = () => {
    const cells = [];
    for (let row = 1; row <= maxRows; row++) {
      for (let col = 1; col <= maxColumns; col++) {
        const isSelected = hoveredSize !== null && 
          row <= hoveredSize.rows && 
          col <= hoveredSize.columns;
        
        cells.push(
          <button
            key={`${row}-${col}`}
            type="button"
            className={`table-size-selector__cell ${isSelected ? 'table-size-selector__cell--selected' : ''}`}
            onMouseEnter={() => handleCellMouseEnter(row, col)}
            onClick={(e) => handleCellClick(row, col, e)}
            role="gridcell"
            aria-selected={isSelected}
            aria-label={`Select ${col} columns by ${row} rows`}
            data-row={row}
            data-col={col}
          />
        );
      }
    }
    return cells;
  };

  // Display text showing current selection or hint
  const displayText = hoveredSize 
    ? `${hoveredSize.columns} × ${hoveredSize.rows} table`
    : hintText;

  return (
    <div 
      className="table-size-selector"
      onClick={handleBackdropClick}
    >
      <div className="table-size-selector__content">
        <div 
          className="table-size-selector__grid"
          onMouseLeave={handleGridMouseLeave}
          role="grid"
          aria-label="Table size selector"
          style={{
            gridTemplateColumns: `repeat(${maxColumns}, 1fr)`,
            gridTemplateRows: `repeat(${maxRows}, 1fr)`,
          }}
        >
          {renderGrid()}
        </div>
        <div className="table-size-selector__label">
          {displayText}
        </div>
      </div>
    </div>
  );
}

export default TableSizeSelector;
