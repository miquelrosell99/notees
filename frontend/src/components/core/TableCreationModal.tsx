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
import { TableSizeSelector, type TableGridSize } from './TableSizeSelector';
import { Button } from './Button';
import { Modal } from './Modal';
import { SelectionButton } from './SelectionButton';

export interface TableCreationModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Number of existing children blocks (if any) */
  existingChildCount?: number;
  /** Called when user selects a size for new table */
  onConfirm: (size: TableGridSize) => void;
  /** Called when user wants to adapt existing children to table */
  onAdaptExisting: () => void;
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

  // Reset state when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      // Default to adapt mode if there are existing children
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Initialize modal state based on prop when opened
      setMode(existingChildCount > 0 ? 'adapt' : 'select');
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

  // Handle size selection for new table
  const handleSelect = useCallback((size: TableGridSize) => {
    onConfirm(size);
  }, [onConfirm]);

  // Handle adapt existing children confirmation
  const handleAdaptConfirm = useCallback(() => {
    onAdaptExisting();
  }, [onAdaptExisting]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title={mode === 'adapt' ? 'Convert to Table' : 'Insert Table'}
      size="sm"
      closeOnBackdrop={true}
      closeOnEscape={true}
      showCloseButton={true}
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
          {existingChildCount > 0 && (
            <SelectionButton
              value={mode}
              onChange={(value) => setMode(value as 'select' | 'adapt')}
              size="sm"
              options={[
                { value: 'adapt', icon: "mdi mdi-auto-fix", label: 'Adapt existing blocks' },
                { value: 'select', icon: "mdi mdi-table-plus", label: 'Create new table' },
              ]}
            />
          )}
          {mode === 'adapt' && existingChildCount > 0 && (
            <Button
              variant="primary"
              size="sm"
              onClick={handleAdaptConfirm}
              style={{ marginLeft: 'auto' }}
            >
              Convert
            </Button>
          )}
        </div>
      }
    >
      {mode === 'adapt' && existingChildCount > 0 ? (
        <p className="table-size-modal__hint">
          Convert {existingChildCount} existing {existingChildCount === 1 ? 'block' : 'blocks'} into table columns.
          Their children will become cells, balanced across all columns.
        </p>
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
        </>
      )}
    </Modal>
  );
}

// Re-export TableGridSize for consumers
export type { TableGridSize } from './TableSizeSelector';

