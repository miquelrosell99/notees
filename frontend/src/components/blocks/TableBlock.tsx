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
import { Table, type TableColumn } from '../core/Table';
import { Button } from '../core/Button';
import { ContextMenu } from '../core/ContextMenu';
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

/**
 * Row data type for Table component
 */
interface TableRowData {
  rowIndex: number;
  cells: (Node | null)[];
}

/**
 * Transform node structure to Table component data format
 */
function transformToTableData(columns: Node[], rowCount: number): TableRowData[] {
  const rows: TableRowData[] = [];
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    const cells = columns.map((_col, colIndex) => getCellNode(columns, colIndex, rowIndex));
    rows.push({ rowIndex, cells });
  }
  return rows;
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
  
  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; colIndex: number } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [showRenameSubmenu, setShowRenameSubmenu] = useState(false);
  
  // Cell selection state (selected but not editing)
  const [selectedCell, setSelectedCell] = useState<CellPosition | null>(null);
  
  // Selection state
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  
  // Refs
  const inputRef = useRef<HTMLInputElement>(null);
  const headerInputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Mutations
  const createNode = useCreateNode();
  const updateNode = useUpdateNode();
  const deleteNode = useDeleteNode();

  // Computed values
  const rowCount = useMemo(() => getRowCount(columns), [columns]);
  const colCount = columns.length;

  // Transform node structure to Table data format
  const tableData = useMemo(() => transformToTableData(columns, rowCount), [columns, rowCount]);

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

  // ==================== Save Handlers ====================

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

  // ==================== Context Menu Handlers ====================

  const handleHeaderContextMenu = useCallback((column: TableColumn<TableRowData>, event: React.MouseEvent) => {
    const colIndex = columns.findIndex(col => `col-${col.id}` === column.key);
    if (colIndex === -1) return;

    setContextMenu({ x: event.clientX, y: event.clientY, colIndex });
    setRenameValue(columns[colIndex]?.name || '');
    setShowRenameSubmenu(false);
  }, [columns]);

  const handleRenameColumn = useCallback(async () => {
    if (contextMenu === null) return;
    const column = columns[contextMenu.colIndex];
    if (!column || !renameValue.trim()) return;

    if (column.name !== renameValue) {
      await updateNode.mutateAsync({
        id: column.id,
        data: { name: renameValue },
      });
    }

    setContextMenu(null);
    setShowRenameSubmenu(false);
  }, [contextMenu, columns, renameValue, updateNode]);

  const handleDeleteColumnFromMenu = useCallback(async () => {
    if (contextMenu === null) return;
    await handleDeleteColumn(contextMenu.colIndex);
    setContextMenu(null);
  }, [contextMenu, handleDeleteColumn]);

  // Create column definitions for Table component
  const tableColumns = useMemo<TableColumn<TableRowData>[]>(() => {
    return columns.map((col, colIndex) => ({
      key: `col-${col.id}`,
      header: editable ? (
        <div className="table-editable-header">
          {editingHeader === colIndex ? (
            <input
              ref={headerInputRef}
              type="text"
              className="table-header-input"
              value={editingHeaderValue}
              onChange={(e) => setEditingHeaderValue(e.target.value)}
              onKeyDown={handleHeaderKeyDown}
              onBlur={handleHeaderSave}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <>
              <span 
                className="table-header-text"
                onClick={() => handleHeaderClick(colIndex)}
              >
                {col.name || 'Untitled'}
              </span>
              <Button
                variant="ghost"
                size="xs"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDeleteColumn(colIndex);
                }}
                title="Delete column"
                className="table-delete-col-btn"
              >
                ×
              </Button>
            </>
          )}
        </div>
      ) : (col.name || 'Untitled'),
      accessor: (row) => {
        const cell = row.cells[colIndex];
        const isEditing = editingCell?.rowIndex === row.rowIndex && editingCell?.colIndex === colIndex;
        const isCellSelected = selectedCell?.rowIndex === row.rowIndex && selectedCell?.colIndex === colIndex;
        
        if (!editable) {
          return <span className="table-cell-text">{cell?.name ?? ''}</span>;
        }

        return (
          <div
            className={`table-cell-content ${isCellSelected ? 'table-cell--focused' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              handleCellClick(row.rowIndex, colIndex, e);
            }}
            onDoubleClick={() => handleCellDoubleClick(row.rowIndex, colIndex)}
          >
            {isEditing ? (
              <input
                ref={inputRef}
                type="text"
                className="table-cell-input"
                value={editingValue}
                onChange={(e) => setEditingValue(e.target.value)}
                onKeyDown={handleCellKeyDown}
                onBlur={handleCellSave}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="table-cell-text">
                {cell?.name ?? ''}
              </span>
            )}
          </div>
        );
      },
    }));
  }, [columns, editable, editingHeader, editingHeaderValue, editingCell, editingValue, selectedCell]);

  // Add actions column if editable
  const allColumns = useMemo<TableColumn<TableRowData>[]>(() => {
    if (!editable) return tableColumns;
    
    return [
      ...tableColumns,
      {
        key: 'add-column',
        header: (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleAddColumn}
            title="Add column"
            className="table-add-col-btn"
          >
            +
          </Button>
        ),
        accessor: (row) => (
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              handleDeleteRow(row.rowIndex);
            }}
            title="Delete row"
            className="table-delete-row-btn"
          >
            ×
          </Button>
        ),
        width: '40px',
      },
    ];
  }, [tableColumns, editable]);

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

  // ==================== Render ====================

  // Render empty state if no columns
  if (colCount === 0) {
    return (
      <div className="table-block table-block--empty">
        <div className="table-block__empty-message">
          Empty table
        </div>
        {editable && (
          <Button
            variant="primary"
            size="md"
            onClick={handleAddColumn}
            className="table-block__add-column-btn table-block__add-column-btn--square"
            title="Add Column"
          >
            +
          </Button>
        )}
      </div>
    );
  }

  return (
    <div 
      className="table-block"
      ref={wrapperRef}
    >
      {block.name && (
        <div className="table-block__title">{block.name}</div>
      )}
      
      <Table<TableRowData>
        data={tableData}
        columns={allColumns}
        getRowKey={(row) => `row-${row.rowIndex}`}
        size="md"
        variant="default"
        selectable={editable}
        selectedKeys={new Set(Array.from(selectedRows).map(i => `row-${i}`))}
        onSelectionChange={(keys) => {
          const rowIndices = Array.from(keys)
            .map(k => parseInt(String(k).replace('row-', '')))
            .filter(n => !isNaN(n));
          setSelectedRows(new Set(rowIndices));
        }}
        onHeaderContextMenu={editable ? handleHeaderContextMenu : undefined}
        hoverable={true}
        showHeader={true}
        className="table-block__table"
      />
      
      {/* Add row button */}
      {editable && (
        <div className="table-block__add-row-wrapper">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleAddRow}
            className="table-add-row-btn"
          >
            + Add Row
          </Button>
        </div>
      )}
      
      {/* Selection actions toolbar */}
      {selectedRows.size > 0 && editable && (
        <div className="table-selection-toolbar">
          <span className="table-selection-info">
            {selectedRows.size} row{selectedRows.size !== 1 ? 's' : ''} selected
          </span>
          <div className="table-selection-actions">
            <Button
              variant="danger"
              size="sm"
              onClick={handleDeleteSelectedRows}
              title="Delete selected rows"
              className="table-selection-action table-selection-action--danger"
            >
              Delete
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => setSelectedRows(new Set())}
              title="Clear selection"
              className="table-selection-action"
            >
              Clear
            </Button>
          </div>
        </div>
      )}
      
      {/* Column context menu */}
      {contextMenu && editable && (
        <ContextMenu
          items={[
            {
              id: 'rename',
              label: 'Rename',
              keepOpen: true,
              submenu: showRenameSubmenu ? (
                <div className="table-rename-submenu">
                  <input
                    type="text"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        handleRenameColumn();
                      } else if (e.key === 'Escape') {
                        setShowRenameSubmenu(false);
                      }
                    }}
                    placeholder="Column name"
                    className="table-rename-input"
                    autoFocus
                  />
                  <div className="table-rename-actions">
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={handleRenameColumn}
                    >
                      Confirm
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowRenameSubmenu(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : undefined,
              onClick: () => setShowRenameSubmenu(true),
            },
            {
              id: 'delete',
              label: 'Delete Column',
              danger: true,
              onClick: handleDeleteColumnFromMenu,
            },
          ]}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          onClose={() => {
            setContextMenu(null);
            setShowRenameSubmenu(false);
          }}
        />
      )}
    </div>
  );
}

export default TableBlock;
