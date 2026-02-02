/**
 * TableBlock Component
 * 
 * Renders a block with the "table" class as an editable table.
 * 
 * Data Structure:
 * - The block itself is the table (its name is the table title)
 * - Direct children are columns (their names are column headers)
 * - Each column's children are row cells
 * 
 * Example structure:
 * Table Block (name: "Inventory")
 *   └─ Column 1 (name: "Item")
 *   │    └─ Cell 1 (name: "Apple")
 *   │    └─ Cell 2 (name: "Banana")
 *   └─ Column 2 (name: "Quantity")
 *        └─ Cell 1 (name: "10")
 *        └─ Cell 2 (name: "5")
 * 
 * Renders as:
 * | Item   | Quantity |
 * |--------|----------|
 * | Apple  | 10       |
 * | Banana | 5        |
 * 
 * Special Behaviors:
 * - Deleting a column: Normal delete (removes column and all cells)
 * - Deleting a cell: Deletes the cell but creates a new empty block to maintain layout
 * - Adding a cell to a column: Adds empty cells to other columns at the same row
 * - Box selection: Select entire rows for bulk operations
 * - Row deletion: Removes corresponding cells from all columns
 */
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useCreateNode, useUpdateNode, useDeleteNode } from '@/hooks';
import type { Node } from '@/types';
import './TableBlock.css';

interface TableBlockProps {
  /** The table block node */
  block: Node;
  /** Column blocks (direct children of the table block) */
  columns: Node[];
  /** Whether the table is editable */
  editable?: boolean;
  /** Called when table structure changes */
  onStructureChange?: () => void;
}

interface CellPosition {
  rowIndex: number;
  colIndex: number;
}

/**
 * Get the maximum number of rows across all columns
 */
function getRowCount(columns: Node[]): number {
  return Math.max(0, ...columns.map(col => col.children?.length ?? 0));
}

/**
 * Get cell node at a specific position
 */
function getCellNode(columns: Node[], colIndex: number, rowIndex: number): Node | null {
  const column = columns[colIndex];
  if (!column?.children) return null;
  return column.children[rowIndex] ?? null;
}

export function TableBlock({
  block,
  columns,
  editable = true,
  onStructureChange,
}: TableBlockProps) {
  // Editing state
  const [editingCell, setEditingCell] = useState<CellPosition | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [editingHeader, setEditingHeader] = useState<number | null>(null);
  const [editingHeaderValue, setEditingHeaderValue] = useState('');
  
  // Cell selection state (selected but not editing)
  const [selectedCell, setSelectedCell] = useState<CellPosition | null>(null);
  
  // Selection state
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [isBoxSelecting, setIsBoxSelecting] = useState(false);
  const [boxSelectStart, setBoxSelectStart] = useState<{ x: number; y: number } | null>(null);
  const [boxSelectCurrent, setBoxSelectCurrent] = useState<{ x: number; y: number } | null>(null);
  
  // Refs
  const inputRef = useRef<HTMLInputElement>(null);
  const headerInputRef = useRef<HTMLInputElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Mutations
  const createNode = useCreateNode();
  const updateNode = useUpdateNode();
  const deleteNode = useDeleteNode();

  // Computed values
  const rowCount = useMemo(() => getRowCount(columns), [columns]);
  const colCount = columns.length;

  // Focus input when editing starts
  useEffect(() => {
    if (editingCell && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingCell]);

  useEffect(() => {
    if (editingHeader !== null && headerInputRef.current) {
      headerInputRef.current.focus();
      headerInputRef.current.select();
    }
  }, [editingHeader]);

  // Clear selection when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as globalThis.Node)) {
        setSelectedRows(new Set());
        setSelectedCell(null);
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // ==================== Cell Editing ====================

  const handleCellClick = useCallback((rowIndex: number, colIndex: number, e: React.MouseEvent) => {
    if (!editable) return;
    
    // If shift-clicking and we have selected rows, extend selection
    if (e.shiftKey && selectedRows.size > 0) {
      const minRow = Math.min(...selectedRows, rowIndex);
      const maxRow = Math.max(...selectedRows, rowIndex);
      const newSelection = new Set<number>();
      for (let i = minRow; i <= maxRow; i++) {
        newSelection.add(i);
      }
      setSelectedRows(newSelection);
      setSelectedCell(null);
      return;
    }
    
    // If ctrl-clicking, toggle row selection
    if (e.ctrlKey || e.metaKey) {
      setSelectedRows(prev => {
        const newSet = new Set(prev);
        if (newSet.has(rowIndex)) {
          newSet.delete(rowIndex);
        } else {
          newSet.add(rowIndex);
        }
        return newSet;
      });
      setSelectedCell(null);
      return;
    }
    
    // Clear row selection
    setSelectedRows(new Set());
    
    // If clicking on already selected cell, start editing
    if (selectedCell?.rowIndex === rowIndex && selectedCell?.colIndex === colIndex) {
      const cellNode = getCellNode(columns, colIndex, rowIndex);
      setEditingCell({ rowIndex, colIndex });
      setEditingValue(cellNode?.name ?? '');
      setSelectedCell(null);
      return;
    }
    
    // Otherwise, select the cell
    setSelectedCell({ rowIndex, colIndex });
    setEditingCell(null);
  }, [columns, editable, selectedRows, selectedCell]);

  // Double-click to directly edit
  const handleCellDoubleClick = useCallback((rowIndex: number, colIndex: number) => {
    if (!editable) return;
    
    setSelectedRows(new Set());
    setSelectedCell(null);
    const cellNode = getCellNode(columns, colIndex, rowIndex);
    setEditingCell({ rowIndex, colIndex });
    setEditingValue(cellNode?.name ?? '');
  }, [columns, editable]);

  const handleHeaderClick = useCallback((colIndex: number) => {
    if (!editable) return;
    
    const column = columns[colIndex];
    setEditingHeader(colIndex);
    setEditingHeaderValue(column?.name ?? '');
  }, [columns, editable]);

  // Add cell to column with row sync
  const handleAddCellToColumn = useCallback(async (
    columnId: number,
    rowIndex: number,
    content: string = ''
  ) => {
    if (!editable) return;

    // Create the cell in the target column
    await createNode.mutateAsync({
      name: content,
      parent_id: columnId,
      sequence: rowIndex,
    });

    // Check if we need to sync other columns (if this row is beyond their current length)
    for (const column of columns) {
      if (column.id === columnId) continue;
      
      const columnRowCount = column.children?.length ?? 0;
      
      // If this column has fewer rows, add empty cells to fill up
      if (columnRowCount <= rowIndex) {
        for (let i = columnRowCount; i <= rowIndex; i++) {
          await createNode.mutateAsync({
            name: '',
            parent_id: column.id,
            sequence: i,
          });
        }
      }
    }

    onStructureChange?.();
  }, [editable, createNode, columns, onStructureChange]);

  const handleCellSave = useCallback(async () => {
    if (!editingCell) return;

    const { rowIndex, colIndex } = editingCell;
    const column = columns[colIndex];
    if (!column) return;

    const existingCell = getCellNode(columns, colIndex, rowIndex);

    if (existingCell) {
      // Update existing cell
      if (existingCell.name !== editingValue) {
        await updateNode.mutateAsync({
          id: existingCell.id,
          data: { name: editingValue },
        });
      }
    } else if (editingValue.trim()) {
      // Create new cell - this will trigger row sync
      await handleAddCellToColumn(column.id, rowIndex, editingValue);
    }

    setEditingCell(null);
    setEditingValue('');
  }, [editingCell, columns, editingValue, updateNode, handleAddCellToColumn]);

  const handleHeaderSave = useCallback(async () => {
    if (editingHeader === null) return;

    const column = columns[editingHeader];
    if (!column) return;

    if (column.name !== editingHeaderValue) {
      await updateNode.mutateAsync({
        id: column.id,
        data: { name: editingHeaderValue },
      });
    }

    setEditingHeader(null);
    setEditingHeaderValue('');
  }, [editingHeader, columns, editingHeaderValue, updateNode]);

  // ==================== Keyboard Navigation ====================

  const handleCellKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!editingCell) return;

    switch (e.key) {
      case 'Enter':
        e.preventDefault();
        handleCellSave();
        break;
      case 'Escape':
        e.preventDefault();
        setEditingCell(null);
        setEditingValue('');
        break;
      case 'Tab':
        e.preventDefault();
        handleCellSave().then(() => {
          const nextCol = e.shiftKey ? editingCell.colIndex - 1 : editingCell.colIndex + 1;
          if (nextCol >= 0 && nextCol < colCount) {
            const cellNode = getCellNode(columns, nextCol, editingCell.rowIndex);
            setEditingCell({ rowIndex: editingCell.rowIndex, colIndex: nextCol });
            setEditingValue(cellNode?.name ?? '');
          } else if (!e.shiftKey && editingCell.rowIndex < rowCount - 1) {
            const cellNode = getCellNode(columns, 0, editingCell.rowIndex + 1);
            setEditingCell({ rowIndex: editingCell.rowIndex + 1, colIndex: 0 });
            setEditingValue(cellNode?.name ?? '');
          }
        });
        break;
    }
  }, [editingCell, handleCellSave, colCount, rowCount, columns]);

  const handleHeaderKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (editingHeader === null) return;

    switch (e.key) {
      case 'Enter':
        e.preventDefault();
        handleHeaderSave();
        break;
      case 'Escape':
        e.preventDefault();
        setEditingHeader(null);
        setEditingHeaderValue('');
        break;
      case 'Tab':
        e.preventDefault();
        handleHeaderSave().then(() => {
          const nextCol = e.shiftKey ? editingHeader - 1 : editingHeader + 1;
          if (nextCol >= 0 && nextCol < colCount) {
            const column = columns[nextCol];
            setEditingHeader(nextCol);
            setEditingHeaderValue(column?.name ?? '');
          }
        });
        break;
    }
  }, [editingHeader, handleHeaderSave, colCount, columns]);

  // Delete selected rows handler (defined early for use in effect)
  const handleDeleteSelectedRows = useCallback(async () => {
    if (!editable || selectedRows.size === 0) return;

    // Sort rows in descending order to delete from bottom to top
    // This prevents index shifting issues
    const sortedRows = Array.from(selectedRows).sort((a, b) => b - a);

    for (const rowIndex of sortedRows) {
      for (const column of columns) {
        const cell = column.children?.[rowIndex];
        if (cell) {
          await deleteNode.mutateAsync(cell.id);
        }
      }
    }

    setSelectedRows(new Set());
    onStructureChange?.();
  }, [editable, selectedRows, columns, deleteNode, onStructureChange]);

  // Delete cell with replacement (defined early for use in effect)
  const handleDeleteCell = useCallback(async (rowIndex: number, colIndex: number) => {
    if (!editable) return;

    const column = columns[colIndex];
    if (!column) return;

    const cell = getCellNode(columns, colIndex, rowIndex);
    if (!cell) return;

    // Delete the cell
    await deleteNode.mutateAsync(cell.id);

    // Create a new empty cell in its place
    await createNode.mutateAsync({
      name: '',
      parent_id: column.id,
      sequence: rowIndex,
    });

    onStructureChange?.();
  }, [editable, columns, deleteNode, createNode, onStructureChange]);

  // Global keyboard handler for selected rows and cells
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle if editing
      if (editingCell || editingHeader !== null) return;
      
      // Handle selected cell
      if (selectedCell) {
        switch (e.key) {
          case 'Delete':
          case 'Backspace':
            e.preventDefault();
            handleDeleteCell(selectedCell.rowIndex, selectedCell.colIndex);
            setSelectedCell(null);
            break;
          case 'Escape':
            e.preventDefault();
            setSelectedCell(null);
            break;
          case 'Enter':
            e.preventDefault();
            // Start editing the selected cell
            const cellNode = getCellNode(columns, selectedCell.colIndex, selectedCell.rowIndex);
            setEditingCell({ rowIndex: selectedCell.rowIndex, colIndex: selectedCell.colIndex });
            setEditingValue(cellNode?.name ?? '');
            setSelectedCell(null);
            break;
          case 'ArrowUp':
            e.preventDefault();
            if (selectedCell.rowIndex > 0) {
              setSelectedCell({ rowIndex: selectedCell.rowIndex - 1, colIndex: selectedCell.colIndex });
            }
            break;
          case 'ArrowDown':
            e.preventDefault();
            if (selectedCell.rowIndex < rowCount - 1) {
              setSelectedCell({ rowIndex: selectedCell.rowIndex + 1, colIndex: selectedCell.colIndex });
            }
            break;
          case 'ArrowLeft':
            e.preventDefault();
            if (selectedCell.colIndex > 0) {
              setSelectedCell({ rowIndex: selectedCell.rowIndex, colIndex: selectedCell.colIndex - 1 });
            }
            break;
          case 'ArrowRight':
            e.preventDefault();
            if (selectedCell.colIndex < colCount - 1) {
              setSelectedCell({ rowIndex: selectedCell.rowIndex, colIndex: selectedCell.colIndex + 1 });
            }
            break;
        }
        return;
      }
      
      // Handle selected rows
      if (selectedRows.size > 0) {
        switch (e.key) {
          case 'Delete':
          case 'Backspace':
            e.preventDefault();
            handleDeleteSelectedRows();
            break;
          case 'Escape':
            e.preventDefault();
            setSelectedRows(new Set());
            break;
        }
      }
    };
    
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectedRows, selectedCell, editingCell, editingHeader, handleDeleteSelectedRows, handleDeleteCell, columns, rowCount, colCount]);

  // ==================== Column Operations ====================

  const handleAddColumn = useCallback(async () => {
    if (!editable) return;

    // Create the column
    const newColumn = await createNode.mutateAsync({
      name: `Column ${colCount + 1}`,
      parent_id: block.id,
      sequence: colCount,
    });

    // Add empty cells to match existing row count
    for (let i = 0; i < rowCount; i++) {
      await createNode.mutateAsync({
        name: '',
        parent_id: newColumn.id,
        sequence: i,
      });
    }

    onStructureChange?.();
  }, [editable, createNode, block.id, colCount, rowCount, onStructureChange]);

  const handleDeleteColumn = useCallback(async (colIndex: number) => {
    if (!editable) return;

    const column = columns[colIndex];
    if (!column) return;

    // Normal delete - deletes column and all its cells automatically
    await deleteNode.mutateAsync(column.id);
    onStructureChange?.();
  }, [editable, columns, deleteNode, onStructureChange]);

  // ==================== Row Operations ====================

  /**
   * Add a new row (add empty cell to each column)
   */
  const handleAddRow = useCallback(async () => {
    if (!editable || colCount === 0) return;

    // Add an empty cell to each column
    for (const column of columns) {
      await createNode.mutateAsync({
        name: '',
        parent_id: column.id,
        sequence: rowCount,
      });
    }
    onStructureChange?.();
  }, [editable, colCount, columns, rowCount, createNode, onStructureChange]);

  /**
   * Delete a row (delete cell from each column at that row index)
   */
  const handleDeleteRow = useCallback(async (rowIndex: number) => {
    if (!editable) return;

    for (const column of columns) {
      const cell = column.children?.[rowIndex];
      if (cell) {
        await deleteNode.mutateAsync(cell.id);
      }
    }
    onStructureChange?.();
  }, [editable, columns, deleteNode, onStructureChange]);

  // ==================== Box Selection ====================

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!editable) return;
    if (e.button !== 0) return; // Only left click
    
    // Don't start box select if clicking on interactive elements
    const target = e.target as HTMLElement;
    if (target.closest('input, button, textarea')) return;
    
    // Check if clicking on a cell content area (but not header)
    const cell = target.closest('.table-block__cell');
    
    if (!cell) {
      // Clicking on empty area - start box select
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (!rect) return;
      
      setIsBoxSelecting(true);
      setBoxSelectStart({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      setBoxSelectCurrent({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      setSelectedRows(new Set());
    }
  }, [editable]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isBoxSelecting || !boxSelectStart) return;
    
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    const currentPos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    setBoxSelectCurrent(currentPos);
    
    // Calculate which rows intersect with the selection box
    if (tableRef.current) {
      const rows = tableRef.current.querySelectorAll('tbody tr:not(.table-block__add-row)');
      const newSelection = new Set<number>();
      
      const selectionRect = {
        left: Math.min(boxSelectStart.x, currentPos.x),
        right: Math.max(boxSelectStart.x, currentPos.x),
        top: Math.min(boxSelectStart.y, currentPos.y),
        bottom: Math.max(boxSelectStart.y, currentPos.y),
      };
      
      rows.forEach((row, index) => {
        const rowRect = row.getBoundingClientRect();
        const relativeRowRect = {
          left: rowRect.left - rect.left,
          right: rowRect.right - rect.left,
          top: rowRect.top - rect.top,
          bottom: rowRect.bottom - rect.top,
        };
        
        // Check if selection box intersects with row
        if (
          selectionRect.left < relativeRowRect.right &&
          selectionRect.right > relativeRowRect.left &&
          selectionRect.top < relativeRowRect.bottom &&
          selectionRect.bottom > relativeRowRect.top
        ) {
          newSelection.add(index);
        }
      });
      
      setSelectedRows(newSelection);
    }
  }, [isBoxSelecting, boxSelectStart]);

  const handleMouseUp = useCallback(() => {
    setIsBoxSelecting(false);
    setBoxSelectStart(null);
    setBoxSelectCurrent(null);
  }, []);

  // Register global mouse handlers for box select
  useEffect(() => {
    if (isBoxSelecting) {
      const handleGlobalMouseMove = (e: MouseEvent) => {
        const rect = wrapperRef.current?.getBoundingClientRect();
        if (!rect || !boxSelectStart) return;
        
        const currentPos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        setBoxSelectCurrent(currentPos);
        
        // Calculate which rows intersect
        if (tableRef.current) {
          const rows = tableRef.current.querySelectorAll('tbody tr:not(.table-block__add-row)');
          const newSelection = new Set<number>();
          
          const selectionRect = {
            left: Math.min(boxSelectStart.x, currentPos.x),
            right: Math.max(boxSelectStart.x, currentPos.x),
            top: Math.min(boxSelectStart.y, currentPos.y),
            bottom: Math.max(boxSelectStart.y, currentPos.y),
          };
          
          rows.forEach((row, index) => {
            const rowRect = row.getBoundingClientRect();
            const relativeRowRect = {
              left: rowRect.left - rect.left,
              right: rowRect.right - rect.left,
              top: rowRect.top - rect.top,
              bottom: rowRect.bottom - rect.top,
            };
            
            if (
              selectionRect.left < relativeRowRect.right &&
              selectionRect.right > relativeRowRect.left &&
              selectionRect.top < relativeRowRect.bottom &&
              selectionRect.bottom > relativeRowRect.top
            ) {
              newSelection.add(index);
            }
          });
          
          setSelectedRows(newSelection);
        }
      };
      
      const handleGlobalMouseUp = () => {
        setIsBoxSelecting(false);
        setBoxSelectStart(null);
        setBoxSelectCurrent(null);
      };
      
      document.addEventListener('mousemove', handleGlobalMouseMove);
      document.addEventListener('mouseup', handleGlobalMouseUp);
      
      return () => {
        document.removeEventListener('mousemove', handleGlobalMouseMove);
        document.removeEventListener('mouseup', handleGlobalMouseUp);
      };
    }
  }, [isBoxSelecting, boxSelectStart]);

  // ==================== Row Click Handler ====================

  const handleRowClick = useCallback((rowIndex: number, e: React.MouseEvent) => {
    if (!editable) return;
    
    // If clicking on row action buttons, don't select
    const target = e.target as HTMLElement;
    if (target.closest('.table-block__row-actions')) return;
    
    // Shift-click: extend selection
    if (e.shiftKey && selectedRows.size > 0) {
      const minRow = Math.min(...selectedRows, rowIndex);
      const maxRow = Math.max(...selectedRows, rowIndex);
      const newSelection = new Set<number>();
      for (let i = minRow; i <= maxRow; i++) {
        newSelection.add(i);
      }
      setSelectedRows(newSelection);
      return;
    }
    
    // Ctrl/Cmd-click: toggle row in selection
    if (e.ctrlKey || e.metaKey) {
      setSelectedRows(prev => {
        const newSet = new Set(prev);
        if (newSet.has(rowIndex)) {
          newSet.delete(rowIndex);
        } else {
          newSet.add(rowIndex);
        }
        return newSet;
      });
      return;
    }
  }, [editable, selectedRows]);

  // ==================== Selection Box Rendering ====================

  const selectionBoxStyle = useMemo(() => {
    if (!isBoxSelecting || !boxSelectStart || !boxSelectCurrent) return null;
    
    const left = Math.min(boxSelectStart.x, boxSelectCurrent.x);
    const top = Math.min(boxSelectStart.y, boxSelectCurrent.y);
    const width = Math.abs(boxSelectCurrent.x - boxSelectStart.x);
    const height = Math.abs(boxSelectCurrent.y - boxSelectStart.y);
    
    return { left, top, width, height };
  }, [isBoxSelecting, boxSelectStart, boxSelectCurrent]);

  // ==================== Render ====================

  // Render empty state if no columns
  if (colCount === 0) {
    return (
      <div className="table-block table-block--empty">
        <div className="table-block__empty-message">
          Empty table
        </div>
        {editable && (
          <button
            className="table-block__add-column-btn"
            onClick={handleAddColumn}
          >
            + Add Column
          </button>
        )}
      </div>
    );
  }

  return (
    <div 
      className="table-block"
      ref={wrapperRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {block.name && (
        <div className="table-block__title">{block.name}</div>
      )}
      
      <div className="table-block__wrapper">
        <table ref={tableRef} className="table-block__table">
          <thead>
            <tr>
              {/* Row selection checkbox column */}
              {editable && (
                <th className="table-block__select-col">
                  <input
                    type="checkbox"
                    checked={selectedRows.size === rowCount && rowCount > 0}
                    onChange={(e) => {
                      if (e.target.checked) {
                        const allRows = new Set<number>();
                        for (let i = 0; i < rowCount; i++) {
                          allRows.add(i);
                        }
                        setSelectedRows(allRows);
                      } else {
                        setSelectedRows(new Set());
                      }
                    }}
                    title="Select all rows"
                  />
                </th>
              )}
              {columns.map((col, colIndex) => (
                <th
                  key={col.id}
                  className={`table-block__header ${editingHeader === colIndex ? 'table-block__header--editing' : ''}`}
                  onClick={() => handleHeaderClick(colIndex)}
                >
                  {editingHeader === colIndex ? (
                    <input
                      ref={headerInputRef}
                      type="text"
                      className="table-block__header-input"
                      value={editingHeaderValue}
                      onChange={(e) => setEditingHeaderValue(e.target.value)}
                      onKeyDown={handleHeaderKeyDown}
                      onBlur={handleHeaderSave}
                    />
                  ) : (
                    <span className="table-block__header-text">
                      {col.name || 'Untitled'}
                    </span>
                  )}
                  {editable && (
                    <button
                      className="table-block__delete-col-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteColumn(colIndex);
                      }}
                      title="Delete column"
                    >
                      ×
                    </button>
                  )}
                </th>
              ))}
              {editable && (
                <th className="table-block__add-col">
                  <button
                    className="table-block__add-col-btn"
                    onClick={handleAddColumn}
                    title="Add column"
                  >
                    +
                  </button>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rowCount }).map((_, rowIndex) => {
              const isRowSelected = selectedRows.has(rowIndex);
              
              return (
                <tr 
                  key={rowIndex}
                  className={isRowSelected ? 'table-block__row--selected' : ''}
                  onClick={(e) => handleRowClick(rowIndex, e)}
                >
                  {/* Row selection checkbox */}
                  {editable && (
                    <td className="table-block__select-cell">
                      <input
                        type="checkbox"
                        checked={isRowSelected}
                        onChange={(e) => {
                          e.stopPropagation();
                          setSelectedRows(prev => {
                            const newSet = new Set(prev);
                            if (e.target.checked) {
                              newSet.add(rowIndex);
                            } else {
                              newSet.delete(rowIndex);
                            }
                            return newSet;
                          });
                        }}
                      />
                    </td>
                  )}
                  {columns.map((col, colIndex) => {
                    const cell = getCellNode(columns, colIndex, rowIndex);
                    const isEditing = editingCell?.rowIndex === rowIndex && editingCell?.colIndex === colIndex;
                    const isCellSelected = selectedCell?.rowIndex === rowIndex && selectedCell?.colIndex === colIndex;
                    
                    return (
                      <td
                        key={`${col.id}-${rowIndex}`}
                        className={`table-block__cell ${isEditing ? 'table-block__cell--editing' : ''} ${isRowSelected ? 'table-block__cell--selected' : ''} ${isCellSelected ? 'table-block__cell--focused' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCellClick(rowIndex, colIndex, e);
                        }}
                        onDoubleClick={() => handleCellDoubleClick(rowIndex, colIndex)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          // Could add context menu here for cell operations
                        }}
                      >
                        {isEditing ? (
                          <input
                            ref={inputRef}
                            type="text"
                            className="table-block__cell-input"
                            value={editingValue}
                            onChange={(e) => setEditingValue(e.target.value)}
                            onKeyDown={handleCellKeyDown}
                            onBlur={handleCellSave}
                          />
                        ) : (
                          <span className="table-block__cell-text">
                            {cell?.name ?? ''}
                          </span>
                        )}
                      </td>
                    );
                  })}
                  {editable && (
                    <td className="table-block__row-actions">
                      <button
                        className="table-block__delete-row-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteRow(rowIndex);
                        }}
                        title="Delete row"
                      >
                        ×
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
            {editable && (
              <tr className="table-block__add-row">
                <td colSpan={colCount + 2}>
                  <button
                    className="table-block__add-row-btn"
                    onClick={handleAddRow}
                  >
                    + Add Row
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
        
        {/* Box selection overlay */}
        {isBoxSelecting && selectionBoxStyle && (
          <div
            className="table-block__selection-box"
            style={{
              left: selectionBoxStyle.left,
              top: selectionBoxStyle.top,
              width: selectionBoxStyle.width,
              height: selectionBoxStyle.height,
            }}
          />
        )}
      </div>
      
      {/* Selection actions toolbar */}
      {selectedRows.size > 0 && editable && (
        <div className="table-block__selection-toolbar">
          <span className="table-block__selection-count">
            {selectedRows.size} row{selectedRows.size !== 1 ? 's' : ''} selected
          </span>
          <button
            className="table-block__selection-action"
            onClick={handleDeleteSelectedRows}
            title="Delete selected rows"
          >
            Delete
          </button>
          <button
            className="table-block__selection-action"
            onClick={() => setSelectedRows(new Set())}
            title="Clear selection"
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

export default TableBlock;
