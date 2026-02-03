/**
 * TableCreationModal Component
 * 
 * Modal that shows a table size selector when adding the "table" class to a block.
 * Allows user to select the number of rows and columns before creating the table structure.
 * 
 * Features:
 * - Clickable grid for size selection (like CKEditor)
 * - Cancel option removes the table class
 * - Creates column and row structure on confirm
 * - Supports adapting existing children to table layout
 */
import { useCallback, useEffect, useState } from 'react';
import { TableSizeSelector, type TableSize } from './TableSizeSelector';
import { Button } from './Button';
import './TableSizeSelector.css';

export interface TableCreationModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Number of existing children blocks (if any) */
  existingChildCount?: number;
  /** Called when user selects a size for new table */
  onConfirm: (size: TableSize) => void;
  /** Called when user wants to adapt existing children to table */
  onAdaptExisting: (columns: number) => void;
  /** Called when user cancels */
  onCancel: () => void;
}

/**
 * Modal for selecting table dimensions when adding table class to a block
 */
export function TableCreationModal({
  isOpen,
  existingChildCount = 0,
  onConfirm,
  onAdaptExisting,
  onCancel,
}: TableCreationModalProps) {
  // Track which mode is active: 'select' for new table, 'adapt' for adapting existing
  const [mode, setMode] = useState<'select' | 'adapt'>('select');
  // Track number of columns for adapt mode
  const [adaptColumns, setAdaptColumns] = useState(1);

  // Reset state when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      // Default to adapt mode if there are existing children
      setMode(existingChildCount > 0 ? 'adapt' : 'select');
      setAdaptColumns(1);
    }
  }, [isOpen, existingChildCount]);

  // Handle escape key to cancel
  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onCancel]);

  // Handle backdrop click
  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onCancel();
    }
  }, [onCancel]);

  // Handle size selection for new table
  const handleSelect = useCallback((size: TableSize) => {
    onConfirm(size);
  }, [onConfirm]);

  // Handle adapt existing children confirmation
  const handleAdaptConfirm = useCallback(() => {
    onAdaptExisting(adaptColumns);
  }, [onAdaptExisting, adaptColumns]);

  if (!isOpen) return null;

  // Calculate rows that would result from adapting existing children
  const adaptedRows = existingChildCount > 0 ? Math.ceil(existingChildCount / adaptColumns) : 0;

  return (
    <div 
      className="table-size-modal" 
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="table-size-modal-title"
    >
      <div className="table-size-modal__content" onClick={(e) => e.stopPropagation()}>
        <h3 id="table-size-modal-title" className="table-size-modal__title">
          {existingChildCount > 0 ? 'Convert to Table' : 'Insert Table'}
        </h3>
        
        {/* Mode toggle when there are existing children */}
        {existingChildCount > 0 && (
          <div className="table-size-modal__mode-toggle">
            <Button
              variant={mode === 'adapt' ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => setMode('adapt')}
            >
              Adapt existing ({existingChildCount} blocks)
            </Button>
            <Button
              variant={mode === 'select' ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => setMode('select')}
            >
              Create new table
            </Button>
          </div>
        )}
        
        {mode === 'adapt' && existingChildCount > 0 ? (
          <>
            <p className="table-size-modal__hint">
              Convert {existingChildCount} existing blocks into table cells
            </p>
            <div className="table-size-modal__adapt-options">
              <label className="table-size-modal__adapt-label">
                Number of columns:
                <select 
                  className="table-size-modal__adapt-select"
                  value={adaptColumns}
                  onChange={(e) => setAdaptColumns(Number(e.target.value))}
                >
                  {Array.from({ length: Math.min(existingChildCount, 10) }, (_, i) => i + 1).map(n => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </label>
              <p className="table-size-modal__adapt-preview">
                This will create a {adaptColumns} × {adaptedRows} table
              </p>
            </div>
            <div className="table-size-modal__actions">
              <Button
                variant="ghost"
                size="sm"
                onClick={onCancel}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleAdaptConfirm}
              >
                Convert
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="table-size-modal__hint">
              Select the number of columns and rows
            </p>
            <TableSizeSelector
              maxRows={10}
              maxColumns={10}
              onSelect={handleSelect}
              hintText="Hover to preview, click to insert"
            />
            <div className="table-size-modal__actions">
              <Button
                variant="ghost"
                size="sm"
                onClick={onCancel}
              >
                Cancel
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Re-export TableSize for consumers
export type { TableSize } from './TableSizeSelector';

export default TableCreationModal;
