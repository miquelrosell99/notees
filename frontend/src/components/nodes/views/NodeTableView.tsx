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
import { mdiArrowRight, mdiDockRight } from '@mdi/js';
import type { Node } from '@/types';
import type { NodeTableViewProps } from '@/types/nodeCollection';
import { Table, type TableColumn, type ExpandableConfig, type ReorderableConfig } from '../../core/Table';
import { Button } from '../../core/Button';
import { Block } from '../../blocks/Block';
import { useBlockCallbacks } from '../../blocks/BlockCallbacksContext';
import { ChevronRightIcon, ChevronDownIcon, DragHandleIcon } from '../../icons';
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
 * Note: 'name' column uses a special marker - actual rendering happens in NodeTableView
 */
function getDefaultColumns(): NodeTableColumn[] {
  return [
    {
      key: 'name',
      label: 'Name',
      width: '40%',
      // Render function is provided dynamically by NodeTableView to access callbacks
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
  editable = false,
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
  onContentChange,
  className = '',
}: NodeTableViewProps) {
  // Get block callbacks from context (for editable mode)
  const blockCallbacks = useBlockCallbacks();

  // Handler for content changes
  const handleContentChange = useCallback((blockId: number, content: string) => {
    onContentChange?.(blockId, content);
  }, [onContentChange]);

  // Create name column renderer that uses Block component
  const nameColumnRenderer = useCallback((node: Node) => {
    // Build block-specific callbacks from context
    const blockProps = blockCallbacks && editable ? {
      onAddType: blockCallbacks.onAddType 
        ? (typeNodeId: number, keepInline: boolean, typeName: string) => 
            blockCallbacks.onAddType!(node.id, typeNodeId, keepInline, typeName)
        : undefined,
      onAddTag: blockCallbacks.onAddTag
        ? (tagNodeId: number, keepInline: boolean, tagName: string) =>
            blockCallbacks.onAddTag!(node.id, tagNodeId, keepInline, tagName)
        : undefined,
      onCreateType: blockCallbacks.onCreateType
        ? (name: string, keepInline: boolean) =>
            blockCallbacks.onCreateType!(node.id, name, keepInline)
        : undefined,
      onCreateTag: blockCallbacks.onCreateTag
        ? (name: string, keepInline: boolean) =>
            blockCallbacks.onCreateTag!(node.id, name, keepInline)
        : undefined,
      onCreatePageLink: blockCallbacks.onCreatePageLink,
      onOpenComments: blockCallbacks.onOpenComments
        ? () => blockCallbacks.onOpenComments!(node.id)
        : undefined,
      onAssetUpload: blockCallbacks.onAssetUpload
        ? (assetTypesOrFile?: ('image' | 'audio' | 'file')[] | File) =>
            blockCallbacks.onAssetUpload!(node.id, assetTypesOrFile)
        : undefined,
      onOpenBacklinks: blockCallbacks.onOpenBacklinks
        ? () => blockCallbacks.onOpenBacklinks!(node.id)
        : undefined,
      commentCount: blockCallbacks.getCommentCount?.(node) ?? node.comment_count ?? 0,
      backlinkCount: blockCallbacks.getBacklinkCount?.(node) ?? node.backlink_count ?? 0,
    } : {};

    return (
      <div className="node-table__name-cell">
        <div className="node-table__block-wrapper">
          <Block
            block={node}
            children={[]}
            siblings={[]}
            depth={0}
            parentId={node.parent_id}
            onContentChange={handleContentChange}
            showBullet={false}
            readOnly={!editable}
            {...blockProps}
          />
        </div>
        <div className="node-table__actions">
          <Button
            icon={mdiDockRight}
            variant="ghost"
            size="xs"
            title="Open in sidebar"
            onClick={(e) => {
              e.stopPropagation();
              onNodeShiftClick?.(node);
            }}
          />
          <Button
            icon={mdiArrowRight}
            variant="ghost"
            size="xs"
            title="Open page"
            onClick={(e) => {
              e.stopPropagation();
              onNodeClick?.(node);
            }}
          />
        </div>
      </div>
    );
  }, [editable, blockCallbacks, handleContentChange, onNodeClick, onNodeShiftClick]);

  // Convert node columns to Table columns, injecting name column renderer
  const nodeColumns = useMemo(() => {
    const cols = customColumns ?? getDefaultColumns();
    // Inject the name column renderer for the 'name' key
    return cols.map(col => 
      col.key === 'name' && !col.render
        ? { ...col, render: nameColumnRenderer }
        : col
    );
  }, [customColumns, nameColumnRenderer]);
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
