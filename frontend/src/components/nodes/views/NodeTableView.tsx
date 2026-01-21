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
import { useNodesStore } from '@/stores';
import * as nodesApi from '@/api/nodes';
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
  if (!dateStr || dateStr === '') return '—';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '—';
  return date.toLocaleDateString();
}

/**
 * Default columns for the table view
 * Note: 'name' and date columns use special markers - actual rendering happens in NodeTableView
 */
function getDefaultColumns(): NodeTableColumn[] {
  return [
    {
      key: 'name',
      label: 'Name',
      width: '50%',
      // Render function is provided dynamically by NodeTableView to access callbacks
    },
    {
      key: 'create_date',
      label: 'Created',
      width: '25%',
      // Render function is provided dynamically by NodeTableView to access callbacks
    },
    {
      key: 'write_date',
      label: 'Modified',
      width: '25%',
      // Render function is provided dynamically by NodeTableView to access callbacks
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
  
  // Get openNode and addSidebarCard from store for navigation
  const { openNode, addSidebarCard } = useNodesStore();

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
              addSidebarCard(node.id, node.is_page ? 'page' : 'block');
            }}
          />
          <Button
            icon={mdiArrowRight}
            variant="ghost"
            size="xs"
            title="Open node"
            onClick={(e) => {
              e.stopPropagation();
              openNode(node.id, node.is_page ? 'page' : 'block');
            }}
          />
        </div>
      </div>
    );
  }, [editable, blockCallbacks, handleContentChange, openNode, addSidebarCard]);

  // Helper to open daily page for a date
  const openDailyPage = useCallback(async (dateStr: string, inSidebar: boolean) => {
    if (!dateStr || dateStr === '') return;
    // Parse the ISO date string and format as YYYY-MM-DD for the API
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return;
    const formattedDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    
    try {
      const dailyNode = await nodesApi.getOrCreateDaily(formattedDate);
      if (inSidebar) {
        addSidebarCard(dailyNode.id, 'page');
      } else {
        openNode(dailyNode.id, 'page');
      }
    } catch (error) {
      console.error('Failed to open daily page:', error);
    }
  }, [openNode, addSidebarCard]);

  // Create date column renderer with action buttons
  const dateColumnRenderer = useCallback((dateField: 'create_date' | 'write_date') => (node: Node) => {
    const dateStr = node[dateField];
    return (
      <div className="node-table__date-cell">
        <span className="node-table__date">
          {formatDate(dateStr)}
        </span>
        {dateStr && dateStr !== '' && (
          <div className="node-table__actions">
            <Button
              icon={mdiDockRight}
              variant="ghost"
              size="xs"
              title="Open day in sidebar"
              onClick={(e) => {
                e.stopPropagation();
                openDailyPage(dateStr, true);
              }}
            />
            <Button
              icon={mdiArrowRight}
              variant="ghost"
              size="xs"
              title="Open day"
              onClick={(e) => {
                e.stopPropagation();
                openDailyPage(dateStr, false);
              }}
            />
          </div>
        )}
      </div>
    );
  }, [openDailyPage]);

  // Convert node columns to Table columns, injecting column renderers
  const nodeColumns = useMemo(() => {
    const cols = customColumns ?? getDefaultColumns();
    // Inject renderers for special columns
    return cols.map(col => {
      if (col.render) return col;
      if (col.key === 'name') return { ...col, render: nameColumnRenderer };
      if (col.key === 'create_date') return { ...col, render: dateColumnRenderer('create_date') };
      if (col.key === 'write_date') return { ...col, render: dateColumnRenderer('write_date') };
      return col;
    });
  }, [customColumns, nameColumnRenderer, dateColumnRenderer]);
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
