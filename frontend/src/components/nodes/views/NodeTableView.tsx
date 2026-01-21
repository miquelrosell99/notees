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
 */
import { useState, useCallback, useMemo, type ReactNode } from 'react';
import type { Node } from '@/types';
import type { NodeTableViewProps } from '@/types/nodeCollection';
import { NodeIcon, ChevronRightIcon, ChevronDownIcon } from '../../icons';
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
  depth: number;
  maxDepth: number;
  expandable: boolean;
  expanded: boolean;
  columns: NodeTableColumn[];
  onToggleExpand: (nodeId: number) => void;
  onNodeClick?: (node: Node) => void;
  onNodeShiftClick?: (node: Node) => void;
}

function TableRow({
  node,
  depth,
  maxDepth,
  expandable,
  expanded,
  columns,
  onToggleExpand,
  onNodeClick,
  onNodeShiftClick,
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

  return (
    <>
      <tr 
        className={`node-table__row node-table__row--depth-${depth}`}
        onClick={handleClick}
      >
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
      {shouldRenderChildren && children.map((child) => (
        <TableRowWithExpansion
          key={child.id}
          node={child}
          depth={depth + 1}
          maxDepth={maxDepth}
          expandable={expandable}
          columns={columns}
          onNodeClick={onNodeClick}
          onNodeShiftClick={onNodeShiftClick}
        />
      ))}
    </>
  );
}

function TableRowWithExpansion(props: Omit<TableRowProps, 'expanded' | 'onToggleExpand'>) {
  const [expanded, setExpanded] = useState(false);
  
  const handleToggleExpand = useCallback(() => {
    setExpanded(prev => !prev);
  }, []);

  return (
    <TableRow
      {...props}
      expanded={expanded}
      onToggleExpand={handleToggleExpand}
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
  onNodeClick,
  onNodeShiftClick,
  className = '',
}: NodeTableViewProps) {
  const columns = useMemo(() => customColumns ?? getDefaultColumns(), [customColumns]);

  return (
    <div className={`node-table-view ${className}`}>
      <table className="node-table">
        <thead>
          <tr>
            {expandable && <th className="node-table__expand-header" />}
            {columns.map((col) => (
              <th key={col.key} style={{ width: col.width }}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {nodes.map((node) => (
            <TableRowWithExpansion
              key={node.id}
              node={node}
              depth={depth}
              maxDepth={maxDepth}
              expandable={expandable}
              columns={columns}
              onNodeClick={onNodeClick}
              onNodeShiftClick={onNodeShiftClick}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
