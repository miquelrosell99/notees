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
 */
import { useCallback, useEffect } from 'react';
import { TableSizeSelector, type TableSize } from './TableSizeSelector';
import { Button } from './Button';
import './TableSizeSelector.css';

export interface TableCreationModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Called when user selects a size */
  onConfirm: (size: TableSize) => void;
  /** Called when user cancels */
  onCancel: () => void;
}

/**
 * Modal for selecting table dimensions when adding table class to a block
 */
export function TableCreationModal({
  isOpen,
  onConfirm,
  onCancel,
}: TableCreationModalProps) {
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

  // Handle size selection
  const handleSelect = useCallback((size: TableSize) => {
    onConfirm(size);
  }, [onConfirm]);

  if (!isOpen) return null;

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
          Insert Table
        </h3>
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
      </div>
    </div>
  );
}

// Re-export TableSize for consumers
export type { TableSize } from './TableSizeSelector';

export default TableCreationModal;
