/**
 * NodeTableView Component
 * 
 * Table view for NodeCollection.
 * Uses the core Table component with node-specific configuration.
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
import { useMemo, useCallback, type ReactNode } from 'react';
import type { Node } from '@/types';
import type { NodeTableViewProps } from '@/types/nodeCollection';
import { Table, type TableColumn, type ExpandableConfig, type ReorderableConfig } from '../../core/Table';
import { NodeIcon, ChevronRightIcon, ChevronDownIcon, DragHandleIcon } from '../../icons';
import './NodeTableView.css';

// Custom column definition for node tables (external API)
interface NodeTableColumn {
  key: string;
  label: string;
  width?: string;
  render?: (node: Node) => ReactNode;
}

/**
 * Safely format a date string, returning fallback if invalid
 */
function formatDate(dateStr: string | undefined | null): string {
  if (!dateStr) return '—';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '—';
  return date.toLocaleDateString();
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
          {formatDate(node.create_date)}
        </span>
      ),
    },
    {
      key: 'write_date',
      label: 'Modified',
      width: '20%',
      render: (node: Node) => (
        <span className="node-table__date">
          {formatDate(node.write_date)}
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

/**
 * Convert NodeTableColumn to TableColumn<Node>
 */
function convertColumns(nodeColumns: NodeTableColumn[]): TableColumn<Node>[] {
  return nodeColumns.map(col => ({
    key: col.key,
    header: col.label,
    width: col.width,
    accessor: col.render 
      ? col.render 
      : (node: Node) => String((node as unknown as Record<string, unknown>)[col.key] ?? ''),
  }));
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
  // Convert node columns to Table columns
  const nodeColumns = useMemo(() => customColumns ?? getDefaultColumns(), [customColumns]);
  const tableColumns = useMemo(() => convertColumns(nodeColumns), [nodeColumns]);
  
  // Convert Set<number> to Set<string | number> for Table component
  const selectedKeys = useMemo(() => {
    if (!controlledSelectedIds) return undefined;
    return controlledSelectedIds as Set<string | number>;
  }, [controlledSelectedIds]);
  
  // Handle selection change - convert back to Set<number>
  const handleSelectionChange = useCallback((keys: Set<string | number>) => {
    if (onSelectionChange) {
      onSelectionChange(keys as Set<number>);
    }
  }, [onSelectionChange]);
  
  // Expandable configuration
  const expandableConfig: ExpandableConfig<Node> | undefined = useMemo(() => {
    if (!expandable) return undefined;
    return {
      getChildren: (node: Node) => node.children ?? [],
      maxDepth: maxDepth,
      renderExpandIcon: (isExpanded: boolean) => 
        isExpanded ? <ChevronDownIcon size="xs" /> : <ChevronRightIcon size="xs" />,
    };
  }, [expandable, maxDepth]);
  
  // Reorderable configuration
  const reorderableConfig: ReorderableConfig | undefined = useMemo(() => {
    if (!sortable || !onReorder) return undefined;
    return {
      onReorder,
      renderDragHandle: () => <DragHandleIcon size="xs" />,
    };
  }, [sortable, onReorder]);

  return (
    <Table<Node>
      data={nodes}
      columns={tableColumns}
      getRowKey={(node) => node.id}
      size="md"
      variant="bordered"
      selectable={selectable}
      selectedKeys={selectedKeys}
      onSelectionChange={handleSelectionChange}
      onRowClick={onNodeClick}
      onRowShiftClick={onNodeShiftClick}
      expandable={expandableConfig}
      reorderable={reorderableConfig}
      depth={depth}
      className={`node-table-view ${className}`}
      getRowClassName={(_, __, rowDepth) => `node-table__row--depth-${rowDepth}`}
    />
  );
}
