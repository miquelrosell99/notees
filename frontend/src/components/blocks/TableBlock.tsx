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
import { mdiClose, mdiArrowRight, mdiDockRight, mdiPlus } from '@mdi/js';
import { useCreateNode, useUpdateNode, useDeleteNode } from '@/hooks';
import { useNodesStore } from '@/stores';
import type { Node } from '@/types';
import { Table, type TableColumn } from '../core/Table';
import { Button } from '../core/Button';
import { Block } from './Block';
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
  // Editing state (only for headers now - cells edited via Block)
  const [editingHeader, setEditingHeader] = useState<number | null>(null);
  const [editingHeaderValue, setEditingHeaderValue] = useState('');
  
  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; colIndex: number } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [showRenameSubmenu, setShowRenameSubmenu] = useState(false);
  
  // Selection state
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  
  // Refs
  const headerInputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Mutations
  const createNode = useCreateNode();
  const updateNode = useUpdateNode();
  const deleteNode = useDeleteNode();
  const { openNode, addSidebarCard } = useNodesStore();

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

  // Header editing
  const handleHeaderClick = useCallback((colIndex: number) => {
    if (!editable) return;
    
    const column = columns[colIndex];
    setEditingHeader(colIndex);
    setEditingHeaderValue(column?.name ?? '');
  }, [columns, editable]);

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
                icon={mdiClose}
                variant="ghost"
                size="xs"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDeleteColumn(colIndex);
                }}
                title="Delete column"
                className="table-delete-col-btn"
              />
            </>
          )}
        </div>
      ) : (col.name || 'Untitled'),
      accessor: (row) => {
        const cell = row.cells[colIndex];
        
        // If no cell exists, return empty
        if (!cell) return '';

        // Always render Block component with navigation buttons
        return (
          <div 
            className="table-block__cell"
          >
            <div className="table-block__cell-content">
              <Block
                block={cell}
                children={[]}
                siblings={[]}
                depth={0}
                parentId={cell.parent_id}
                showBullet={false}
                showTypes={false}
                showQueryResults={false}
                canEdit={editable}
                canMove={false}
                canSelect={false}
              />
            </div>
            <div className="table-block__cell-actions">
              <Button
                icon={mdiDockRight}
                variant="ghost"
                size="xs"
                title="Open in sidebar"
                onClick={(e) => {
                  e.stopPropagation();
                  addSidebarCard(cell.id, cell.is_page ? 'page' : 'block');
                }}
              />
              <Button
                icon={mdiArrowRight}
                variant="ghost"
                size="xs"
                title="Open node"
                onClick={(e) => {
                  e.stopPropagation();
                  openNode(cell.id, cell.is_page ? 'page' : 'block');
                }}
              />
            </div>
          </div>
        );
      },
    }));
  }, [columns, editable, editingHeader, editingHeaderValue, openNode, addSidebarCard]);

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
            icon={mdiClose}
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              handleDeleteRow(row.rowIndex);
            }}
            title="Delete row"
            className="table-delete-row-btn"
          />
        ),
        width: '40px',
      },
    ];
  }, [tableColumns, editable, handleAddColumn, handleDeleteRow]);

  // Focus input when editing starts (only for headers now)
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
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // ==================== Cell Editing ====================
  // Cell editing is now handled directly by Block component (canEdit={editable})
  // Only keep row selection for multi-row operations

  // ==================== Keyboard Navigation ====================
  // No longer needed - Block handles editing internally

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
            icon={mdiPlus}
            variant="primary"
            size="md"
            onClick={handleAddColumn}
            className="table-block__add-column-btn table-block__add-column-btn--square"
            title="Add Column"
          />
        )}
      </div>
    );
  }

  return (
    <div 
      className="table-block"
      ref={wrapperRef}
    >
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
        onNodeOpen={openNode}
        onNodeOpenInSidebar={addSidebarCard}
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
