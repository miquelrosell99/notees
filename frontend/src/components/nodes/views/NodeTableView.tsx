/**
 * NodeTableView Component
 * 
 * Table view for NodeCollection.
 * Displays nodes as rows in a table with optional expandable children.
 * 
 * Features:
 * - Configurable columns
 * - Expandable rows for children
 * - Editable: inline editing in cells
 * - Read-only: display-only table
 * - Sorting support
 * - Drag-and-drop reordering with drag handles
 * - Row selection with checkboxes
 */
import { useState, useCallback, useMemo, useRef, useEffect, type ReactNode } from 'react';
import type { Node } from '@/types';
import type { NodeTableViewProps } from '@/types/nodeCollection';
import { NodeIcon, ChevronRightIcon, ChevronDownIcon, DragHandleIcon } from '../../icons';
import { Checkbox } from '../../core/Checkbox';
import './NodeTableView.css';

// Custom column definition for node tables
interface NodeTableColumn {
  key: string;
  label: string;
  width?: string;
  render?: (node: Node) => ReactNode;
}

/**
 * Default columns for the table view
 */
function getDefaultColumns(): NodeTableColumn[] {
  return [
    {
      key: 'name',
      label: 'Name',
      width: '40%',
      render: (node: Node) => (
        <div className="node-table__name-cell">
          <NodeIcon icon={node.icon} isPage={node.is_page} size="sm" />
          <span className="node-table__name">{node.name || 'Untitled'}</span>
        </div>
      ),
    },
    {
      key: 'create_date',
      label: 'Created',
      width: '20%',
      render: (node: Node) => (
        <span className="node-table__date">
          {new Date(node.create_date).toLocaleDateString()}
        </span>
      ),
    },
    {
      key: 'write_date',
      label: 'Modified',
      width: '20%',
      render: (node: Node) => (
        <span className="node-table__date">
          {new Date(node.write_date).toLocaleDateString()}
        </span>
      ),
    },
    {
      key: 'children',
      label: 'Children',
      width: '10%',
      render: (node: Node) => (
        <span className="node-table__count">
          {node.children?.length ?? 0}
        </span>
      ),
    },
  ];
}

interface TableRowProps {
  node: Node;
  index: number;
  depth: number;
  maxDepth: number;
  expandable: boolean;
  expanded: boolean;
  columns: NodeTableColumn[];
  sortable: boolean;
  selectable: boolean;
  selected: boolean;
  isDragging: boolean;
  isDropTarget: boolean;
  onToggleExpand: (nodeId: number) => void;
  onToggleSelect: (nodeId: number) => void;
  onNodeClick?: (node: Node) => void;
  onNodeShiftClick?: (node: Node) => void;
  onDragStart?: (index: number, e: React.MouseEvent) => void;
}

function TableRow({
  node,
  index,
  depth,
  maxDepth,
  expandable,
  expanded,
  columns,
  sortable,
  selectable,
  selected,
  isDragging,
  isDropTarget,
  onToggleExpand,
  onToggleSelect,
  onNodeClick,
  onNodeShiftClick,
  onDragStart,
}: TableRowProps) {
  const children = node.children ?? [];
  const hasChildren = children.length > 0;
  const shouldRenderChildren = expandable && expanded && depth < maxDepth && hasChildren;

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (e.shiftKey && onNodeShiftClick) {
      e.preventDefault();
      onNodeShiftClick(node);
    } else if (onNodeClick) {
      onNodeClick(node);
    }
  }, [node, onNodeClick, onNodeShiftClick]);

  const handleExpandClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleExpand(node.id);
  }, [node.id, onToggleExpand]);

  const handleCheckboxChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation();
    onToggleSelect(node.id);
  }, [node.id, onToggleSelect]);

  const handleCheckboxClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  const rowClassName = [
    'node-table__row',
    `node-table__row--depth-${depth}`,
    isDragging && 'node-table__row--dragging',
    isDropTarget && 'node-table__row--drop-target',
    selected && 'node-table__row--selected',
  ].filter(Boolean).join(' ');

  return (
    <>
      <tr 
        className={rowClassName}
        onClick={handleClick}
      >
        {/* Checkbox column */}
        {selectable && (
          <td className="node-table__checkbox-cell" onClick={handleCheckboxClick}>
            <Checkbox
              size="sm"
              checked={selected}
              onChange={handleCheckboxChange}
            />
          </td>
        )}
        
        {/* Drag handle column */}
        {sortable && (
          <td className="node-table__drag-cell">
            <button
              className="node-table__drag-handle"
              onMouseDown={(e) => onDragStart?.(index, e)}
              onClick={(e) => e.stopPropagation()}
              title="Drag to reorder"
            >
              <DragHandleIcon size="xs" />
            </button>
          </td>
        )}
        
        {/* Expand column */}
        {expandable && (
          <td className="node-table__expand-cell">
            {hasChildren ? (
              <button 
                className="node-table__expand-btn"
                onClick={handleExpandClick}
              >
                {expanded ? <ChevronDownIcon size="xs" /> : <ChevronRightIcon size="xs" />}
              </button>
            ) : (
              <span className="node-table__expand-placeholder" />
            )}
          </td>
        )}
        
        {/* Data columns */}
        {columns.map((col) => (
          <td key={col.key} style={{ width: col.width }}>
            {col.render ? col.render(node) : String((node as unknown as Record<string, unknown>)[col.key] ?? '')}
          </td>
        ))}
      </tr>
      
      {/* Expanded children */}
      {shouldRenderChildren && children.map((child, childIndex) => (
        <TableRowWithExpansion
          key={child.id}
          node={child}
          index={childIndex}
          depth={depth + 1}
          maxDepth={maxDepth}
          expandable={expandable}
          columns={columns}
          sortable={false}
          selectable={selectable}
          selected={false}
          isDragging={false}
          isDropTarget={false}
          onNodeClick={onNodeClick}
          onNodeShiftClick={onNodeShiftClick}
          onToggleSelect={onToggleSelect}
        />
      ))}
    </>
  );
}

function TableRowWithExpansion(props: Omit<TableRowProps, 'expanded' | 'onToggleExpand'> & { onDragStart?: (index: number, e: React.MouseEvent) => void }) {
  const [expanded, setExpanded] = useState(false);
  
  const handleToggleExpand = useCallback(() => {
    setExpanded(prev => !prev);
  }, []);

  return (
    <TableRow
      {...props}
      expanded={expanded}
      onToggleExpand={handleToggleExpand}
      onDragStart={props.onDragStart}
    />
  );
}

/**
 * NodeTableView - Table view for NodeCollection
 */
export function NodeTableView({
  nodes,
  depth = 0,
  maxDepth = 3,
  columns: customColumns,
  expandable = true,
  sortable = false,
  selectable = true,
  selectedIds: controlledSelectedIds,
  onSelectionChange,
  onReorder,
  onNodeClick,
  onNodeShiftClick,
  className = '',
}: NodeTableViewProps) {
  const columns = useMemo(() => customColumns ?? getDefaultColumns(), [customColumns]);
  
  // Selection state (internal or controlled)
  const [internalSelectedIds, setInternalSelectedIds] = useState<Set<number>>(new Set());
  const selectedIds = controlledSelectedIds ?? internalSelectedIds;
  
  // Handle selection toggle
  const handleToggleSelect = useCallback((nodeId: number) => {
    const newSelection = new Set(selectedIds);
    if (newSelection.has(nodeId)) {
      newSelection.delete(nodeId);
    } else {
      newSelection.add(nodeId);
    }
    
    if (onSelectionChange) {
      onSelectionChange(newSelection);
    } else {
      setInternalSelectedIds(newSelection);
    }
  }, [selectedIds, onSelectionChange]);
  
  // Handle select all toggle
  const handleSelectAll = useCallback(() => {
    const allSelected = nodes.every(n => selectedIds.has(n.id));
    const newSelection = allSelected ? new Set<number>() : new Set(nodes.map(n => n.id));
    
    if (onSelectionChange) {
      onSelectionChange(newSelection);
    } else {
      setInternalSelectedIds(newSelection);
    }
  }, [nodes, selectedIds, onSelectionChange]);
  
  // Check if all are selected (for header checkbox)
  const allSelected = nodes.length > 0 && nodes.every(n => selectedIds.has(n.id));
  const someSelected = nodes.some(n => selectedIds.has(n.id)) && !allSelected;
  
  // Drag state for sortable mode
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rowHeightRef = useRef(40);

  // Measure row height
  useEffect(() => {
    if (containerRef.current && sortable) {
      const firstRow = containerRef.current.querySelector('.node-table__row') as HTMLElement;
      if (firstRow) {
        rowHeightRef.current = firstRow.offsetHeight;
      }
    }
  }, [nodes.length, sortable]);

  // Handle drag start
  const handleDragStart = useCallback((index: number, e: React.MouseEvent) => {
    if (!sortable || !onReorder) return;
    e.preventDefault();
    setDragIndex(index);
    setDropTargetIndex(index);
  }, [sortable, onReorder]);

  // Handle drag move and end
  useEffect(() => {
    if (dragIndex === null || !sortable) return;

    const container = containerRef.current;
    if (!container) return;

    const handleMouseMove = (e: MouseEvent) => {
      const tbody = container.querySelector('tbody');
      if (!tbody) return;
      
      const tbodyRect = tbody.getBoundingClientRect();
      const mouseY = e.clientY - tbodyRect.top;
      const rowHeight = rowHeightRef.current;
      const targetIndex = Math.max(0, Math.min(nodes.length - 1, Math.floor(mouseY / rowHeight)));
      setDropTargetIndex(targetIndex);
    };

    const handleMouseUp = () => {
      if (dragIndex !== null && dropTargetIndex !== null && dragIndex !== dropTargetIndex) {
        onReorder?.(dragIndex, dropTargetIndex);
      }
      setDragIndex(null);
      setDropTargetIndex(null);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragIndex, dropTargetIndex, nodes.length, sortable, onReorder]);

  return (
    <div className={`node-table-view ${sortable ? 'node-table-view--sortable' : ''} ${className}`} ref={containerRef}>
      <table className="node-table">
        <thead>
          <tr>
            {selectable && (
              <th className="node-table__checkbox-header">
                <Checkbox
                  size="sm"
                  checked={allSelected}
                  indeterminate={someSelected}
                  onChange={handleSelectAll}
                />
              </th>
            )}
            {sortable && <th className="node-table__drag-header" />}
            {expandable && <th className="node-table__expand-header" />}
            {columns.map((col) => (
              <th key={col.key} style={{ width: col.width }}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {nodes.map((node, index) => (
            <TableRowWithExpansion
              key={node.id}
              node={node}
              index={index}
              depth={depth}
              maxDepth={maxDepth}
              expandable={expandable}
              columns={columns}
              sortable={sortable}
              selectable={selectable}
              selected={selectedIds.has(node.id)}
              isDragging={dragIndex === index}
              isDropTarget={dropTargetIndex === index && dragIndex !== null && dragIndex !== index}
              onNodeClick={onNodeClick}
              onNodeShiftClick={onNodeShiftClick}
              onToggleSelect={handleToggleSelect}
              onDragStart={handleDragStart}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
