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
import { mdiArrowRight, mdiDockRight, mdiPlus } from '@mdi/js';
import { useCreateNode, useDeleteNode } from '@/hooks';
import { useNodesStore } from '@/stores';
import type { Node } from '@/types';
import { Table, type TableColumn } from '../core/Table';
import { Button } from '../core/Button';
import { Block } from './Block';
import { ContextMenu } from '../core/ContextMenu';
import { ConfirmationModal } from '../core/ConfirmationModal';
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
  // Context menu state
  const [headerContextMenu, setHeaderContextMenu] = useState<{ x: number; y: number; colIndex: number } | null>(null);
  const [rowContextMenu, setRowContextMenu] = useState<{ x: number; y: number; rowIndex: number } | null>(null);
  const [headerRowContextMenu, setHeaderRowContextMenu] = useState<{ x: number; y: number } | null>(null);
  
  // Confirmation modal state
  const [deleteConfirm, setDeleteConfirm] = useState<{ type: 'column' | 'rows' | 'allRows'; index?: number; rows?: Set<number> } | null>(null);
  
  // Selection state
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  
  // Refs
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Mutations
  const createNode = useCreateNode();
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

  const handleAddColumnLeft = useCallback(async (colIndex: number) => {
    if (!editable) return;

    // Create the column with the target sequence
    const newColumn = await createNode.mutateAsync({
      name: `Column ${colCount + 1}`,
      parent_id: block.id,
      sequence: colIndex,
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

  const handleAddColumnRight = useCallback(async (colIndex: number) => {
    if (!editable) return;

    // Create the column after the target
    const newColumn = await createNode.mutateAsync({
      name: `Column ${colCount + 1}`,
      parent_id: block.id,
      sequence: colIndex + 1,
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

    // Show confirmation modal
    setDeleteConfirm({ type: 'column', index: colIndex });
  }, [editable, columns]);

  // ==================== Row Operations ====================

  const handleAddRowAbove = useCallback(async (rowIndex: number) => {
    if (!editable || colCount === 0) return;

    // Add an empty cell to each column at the specified position
    for (const column of columns) {
      await createNode.mutateAsync({
        name: '',
        parent_id: column.id,
        sequence: rowIndex,
      });
    }
    onStructureChange?.();
  }, [editable, colCount, columns, createNode, onStructureChange]);

  const handleAddRowBelow = useCallback(async (rowIndex: number) => {
    if (!editable || colCount === 0) return;

    // Add an empty cell to each column after the specified position
    for (const column of columns) {
      await createNode.mutateAsync({
        name: '',
        parent_id: column.id,
        sequence: rowIndex + 1,
      });
    }
    onStructureChange?.();
  }, [editable, colCount, columns, createNode, onStructureChange]);

  const handleAddRowBelowHeader = useCallback(async () => {
    if (!editable) return;
    await handleAddRowAbove(0);
  }, [editable, handleAddRowAbove]);

  const handleDeleteAllRows = useCallback(async () => {
    if (!editable || rowCount === 0) return;
    
    // Show confirmation modal for all rows
    setDeleteConfirm({ type: 'allRows' });
  }, [editable, rowCount]);

  // ==================== Save Handlers ====================
  // Headers are now readonly Block components - no editing needed

  // Create column definitions for Table component
  const tableColumns = useMemo<TableColumn<TableRowData>[]>(() => {
    return columns.map((col, colIndex) => ({
      key: `col-${col.id}`,
      header: (
        <div className="table-block__header">
          <div className="table-block__header-content">
            <Block
              block={col}
              children={[]}
              siblings={[]}
              depth={0}
              parentId={col.parent_id}
              showBullet={false}
              showTypes={false}
              showQueryResults={false}
              canEdit={false}
              canMove={false}
              canSelect={false}
            />
          </div>
          <div className="table-block__header-actions">
            <Button
              icon={mdiDockRight}
              variant="ghost"
              size="xs"
              title="Open in sidebar"
              onClick={(e) => {
                e.stopPropagation();
                addSidebarCard(col.id, col.is_page ? 'page' : 'block');
              }}
            />
            <Button
              icon={mdiArrowRight}
              variant="ghost"
              size="xs"
              title="Open node"
              onClick={(e) => {
                e.stopPropagation();
                openNode(col.id, col.is_page ? 'page' : 'block');
              }}
            />
          </div>
        </div>
      ),
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
  }, [columns, editable, openNode, addSidebarCard, handleDeleteColumn]);

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

    // Show confirmation modal
    setDeleteConfirm({ type: 'rows', rows: new Set(selectedRows) });
  }, [editable, selectedRows]);

  const confirmDelete = useCallback(async () => {
    if (!deleteConfirm) return;

    if (deleteConfirm.type === 'column' && deleteConfirm.index !== undefined) {
      const column = columns[deleteConfirm.index];
      if (column) {
        await deleteNode.mutateAsync(column.id);
        onStructureChange?.();
      }
    } else if (deleteConfirm.type === 'allRows') {
      // Delete all cells in all rows
      for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
        for (const column of columns) {
          const cell = column.children?.[rowIndex];
          if (cell) {
            await deleteNode.mutateAsync(cell.id);
          }
        }
      }
      
      setSelectedRows(new Set());
      onStructureChange?.();
    } else if (deleteConfirm.type === 'rows' && deleteConfirm.rows) {
      // Sort rows in descending order to delete from bottom to top
      const sortedRows = Array.from(deleteConfirm.rows).sort((a, b) => b - a);

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
    }

    setDeleteConfirm(null);
  }, [deleteConfirm, columns, deleteNode, rowCount, onStructureChange]);

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
        key={`table-${columns.length}-${columns.map(c => c.id).join('-')}`}
        data={tableData}
        columns={tableColumns}
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
        onHeaderContextMenu={editable ? (column, event) => {
          const colIndex = columns.findIndex(col => `col-${col.id}` === column.key);
          if (colIndex !== -1) {
            event.preventDefault();
            setHeaderContextMenu({ x: event.clientX, y: event.clientY, colIndex });
          }
        } : undefined}
        onHeaderCheckboxContextMenu={editable ? (event) => {
          setHeaderRowContextMenu({ x: event.clientX, y: event.clientY });
        } : undefined}
        onRowContextMenu={editable ? (row, event) => {
          event.preventDefault();
          setRowContextMenu({ x: event.clientX, y: event.clientY, rowIndex: row.rowIndex });
        } : undefined}
        hoverable={true}
        showHeader={true}
        className="table-block__table"
        onNodeOpen={openNode}
        onNodeOpenInSidebar={addSidebarCard}
      />
      
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

      {/* Header context menu */}
      {headerContextMenu && editable && (
        <ContextMenu
          items={[
            {
              id: 'add-left',
              label: 'Add Column Left',
              onClick: () => {
                handleAddColumnLeft(headerContextMenu.colIndex);
                setHeaderContextMenu(null);
              },
            },
            {
              id: 'add-right',
              label: 'Add Column Right',
              onClick: () => {
                handleAddColumnRight(headerContextMenu.colIndex);
                setHeaderContextMenu(null);
              },
            },
            {
              id: 'delete',
              label: 'Delete Column',
              danger: true,
              onClick: () => {
                handleDeleteColumn(headerContextMenu.colIndex);
                setHeaderContextMenu(null);
              },
            },
          ]}
          position={{ x: headerContextMenu.x, y: headerContextMenu.y }}
          onClose={() => setHeaderContextMenu(null)}
        />
      )}

      {/* Row context menu */}
      {rowContextMenu && editable && (
        <ContextMenu
          items={[
            {
              id: 'add-above',
              label: 'Add Row Above',
              onClick: () => {
                handleAddRowAbove(rowContextMenu.rowIndex);
                setRowContextMenu(null);
              },
            },
            {
              id: 'add-below',
              label: 'Add Row Below',
              onClick: () => {
                handleAddRowBelow(rowContextMenu.rowIndex);
                setRowContextMenu(null);
              },
            },
            {
              id: 'delete',
              label: 'Delete Row',
              danger: true,
              onClick: () => {
                setDeleteConfirm({ type: 'rows', rows: new Set([rowContextMenu.rowIndex]) });
                setRowContextMenu(null);
              },
            },
          ]}
          position={{ x: rowContextMenu.x, y: rowContextMenu.y }}
          onClose={() => setRowContextMenu(null)}
        />
      )}

      {/* Header row context menu */}
      {headerRowContextMenu && editable && (
        <ContextMenu
          items={[
            {
              id: 'add-row',
              label: 'Add Row Below',
              onClick: () => {
                handleAddRowBelowHeader();
                setHeaderRowContextMenu(null);
              },
            },
            {
              id: 'delete-all',
              label: 'Delete All Rows',
              danger: true,
              onClick: () => {
                handleDeleteAllRows();
                setHeaderRowContextMenu(null);
              },
            },
          ]}
          position={{ x: headerRowContextMenu.x, y: headerRowContextMenu.y }}
          onClose={() => setHeaderRowContextMenu(null)}
        />
      )}

      {/* Delete confirmation modal */}
      {deleteConfirm && (
        <ConfirmationModal
          isOpen={true}
          title={
            deleteConfirm.type === 'column'
              ? 'Delete Column'
              : deleteConfirm.type === 'allRows'
              ? 'Delete All Rows'
              : 'Delete Rows'
          }
          message={
            deleteConfirm.type === 'column'
              ? 'Are you sure you want to delete this column and all its cells?'
              : deleteConfirm.type === 'allRows'
              ? `Are you sure you want to delete all ${rowCount} row${rowCount === 1 ? '' : 's'}?`
              : `Are you sure you want to delete ${deleteConfirm.rows?.size} row${deleteConfirm.rows?.size === 1 ? '' : 's'}?`
          }
          confirmLabel="Delete"
          cancelLabel="Cancel"
          variant="danger"
          onConfirm={confirmDelete}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}
    </div>
  );
}

export default TableBlock;
