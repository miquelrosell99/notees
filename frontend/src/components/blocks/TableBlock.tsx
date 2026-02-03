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
import { useCreateNode, useDeleteNode } from '@/hooks';
import { useNodesStore } from '@/stores';
import type { Node } from '@/types';
import { Table, type TableColumn } from '../core/Table';
import { Button } from '../core/Button';
import { Block } from './Block';
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
            {editable && (
              <Button
                icon={mdiClose}
                variant="ghost"
                size="xs"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDeleteColumn(colIndex);
                }}
                title="Delete column"
              />
            )}
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
    </div>
  );
}

export default TableBlock;
