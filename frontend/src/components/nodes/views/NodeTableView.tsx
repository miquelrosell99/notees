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
import React, { useMemo, useCallback, useState, type ReactNode } from 'react';
import { mdiArrowRight, mdiDockRight } from '@mdi/js';
import type { Node } from '@/types';
import type { NodeTableViewProps } from '@/types/nodeCollection';
import { useNodesStore, useSettingsStore } from '@/stores';
import { formatDate as formatDateWithFormat } from '@/stores/settingsStore';
import * as nodesApi from '@/api/nodes';
import { useProperties } from '@/hooks';
import type { TableColumn, ExpandableConfig, ReorderableConfig } from '../../core/Table';
import { Table } from '../../core/Table';
import { Button } from '../../core/Button';
import { Block } from '../../blocks/Block';
import { useBlockCallbacks } from '../../blocks/BlockCallbacksContext';
import { DragHandleIcon } from '../../icons';
import { PropertyCell } from '../../properties/PropertyCell';
import './NodeTableView.css';

// Custom column definition for node tables (external API)
interface NodeTableColumn {
  key: string;
  label: string;
  width?: string;
  render?: (node: Node) => ReactNode;
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
    // Disable automatic node cell rendering for name column since it uses Block component
    renderNodeCell: col.key !== 'name',
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
  propertyUuids = [],
  className = '',
  customContextMenu,
}: NodeTableViewProps) {
  // Get block callbacks from context (for editable mode)
  const blockCallbacks = useBlockCallbacks();
  
  // Get openNode and addSidebarCard from store for navigation
  const { openNode, addSidebarCard } = useNodesStore();
  
  // Get user's date format preference
  const dateFormat = useSettingsStore((state) => state.dateFormat);
  
  // Internal selection state (used when not controlled)
  const [internalSelectedIds, setInternalSelectedIds] = useState<Set<number>>(new Set());
  
  // Context menu state
  const [contextMenuNode, setContextMenuNode] = useState<Node | null>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 });
  
  // Use controlled or internal selection state
  const selectedIds = controlledSelectedIds ?? internalSelectedIds;
  const handleSelectionChange = useCallback((keys: Set<string | number>) => {
    const numericKeys = keys as Set<number>;
    if (onSelectionChange) {
      onSelectionChange(numericKeys);
    } else {
      setInternalSelectedIds(numericKeys);
    }
  }, [onSelectionChange]);

  // Handler for content changes
  const handleContentChange = useCallback((blockId: number, content: string) => {
    onContentChange?.(blockId, content);
  }, [onContentChange]);

  // Create name column renderer that uses Block component
  const nameColumnRenderer = useCallback((node: Node) => {
    // Build block-specific callbacks from context
    const blockProps = blockCallbacks && editable ? {
      onAddClass: blockCallbacks.onAddClass 
        ? (classNodeId: number, keepInline: boolean, className: string) => 
            blockCallbacks.onAddClass!(node.id, classNodeId, keepInline, className)
        : undefined,
      onAddTag: blockCallbacks.onAddTag
        ? (tagNodeId: number, keepInline: boolean, tagName: string) =>
            blockCallbacks.onAddTag!(node.id, tagNodeId, keepInline, tagName)
        : undefined,
      onCreateClass: blockCallbacks.onCreateClass
        ? (name: string, keepInline: boolean) =>
            blockCallbacks.onCreateClass!(node.id, name, keepInline)
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
        <div className="node-table__name-content">
          <Block
            block={node}
            children={[]}
            siblings={[]}
            depth={0}
            parentId={node.parent_id}
            onContentChange={handleContentChange}
            showBullet={false}
            showTypes={false}
            showQueryResults={false}
            canEdit={editable}
            canMove={false}
            canSelect={false}
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
  const dateColumnRenderer = useCallback((dateField: 'create_date' | 'write_date') => (node: Node): ReactNode => {
    const dateStr = node[dateField];
    if (!dateStr || dateStr === '') return '—';
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return '—';
    const formattedDate = formatDateWithFormat(date, dateFormat as any);
    
    return (
      <div className="node-table__date-cell">
        <span className="node-table__date">
          {formattedDate}
        </span>
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
      </div>
    );
  }, [openDailyPage, dateFormat]);

  // Fetch property definitions
  const { data: allProperties = [] } = useProperties();
  
  // Generate property columns from propertyUuids
  const propertyColumns = useMemo<NodeTableColumn[]>(() => {
    if (!propertyUuids.length) return [];
    
    return propertyUuids
      .map((uuid: string): NodeTableColumn | null => {
        const property = allProperties.find(p => p.uuid === uuid);
        if (!property) return null;
        
        return {
          key: `property_${property.id}`,
          label: property.icon ? `${property.icon} ${property.name}` : property.name,
          width: '150px',
          render: (node: Node): ReactNode => {
            const value = node.properties?.[property.uuid];
            return (
              <PropertyCell
                node={node}
                property={property}
                value={value}
                editable={editable}
              />
            );
          },
        };
      })
      .filter((col): col is NodeTableColumn => col !== null);
  }, [propertyUuids, allProperties, editable]);
  
  // Convert node columns to Table columns, injecting column renderers
  const nodeColumns = useMemo<NodeTableColumn[]>(() => {
    const cols = customColumns ?? getDefaultColumns();
    // Inject renderers for special columns
    const baseColumns = cols.map(col => {
      if (col.render) return col;
      if (col.key === 'name') return { ...col, render: nameColumnRenderer };
      if (col.key === 'create_date') return { ...col, render: dateColumnRenderer('create_date') };
      if (col.key === 'write_date') return { ...col, render: dateColumnRenderer('write_date') };
      return col;
    });
    
    // Add property columns after base columns
    return [...baseColumns, ...propertyColumns];
  }, [customColumns, nameColumnRenderer, dateColumnRenderer, propertyColumns]);
  
  // Convert NodeTableColumn to TableColumn<Node>
  const tableColumns = useMemo(() => convertColumns(nodeColumns), [nodeColumns]);
  
  // Convert Set<number> to Set<string | number> for Table component
  const selectedKeys = useMemo(() => {
    return selectedIds as Set<string | number>;
  }, [selectedIds]);
  
  // Expandable configuration - uses CollapseArrow by default in Table
  const expandableConfig: ExpandableConfig<Node> | undefined = useMemo(() => {
    if (!expandable) return undefined;
    return {
      getChildren: (node: Node) => node.children ?? [],
      maxDepth: maxDepth,
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
  
  // Context menu handler
  const handleRowContextMenu = useCallback((node: Node, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenuNode(node);
    setContextMenuPosition({ x: event.clientX, y: event.clientY });
  }, []);
  
  // Close context menu
  const handleCloseContextMenu = useCallback(() => {
    setContextMenuNode(null);
  }, []);

  return (
    <>
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
        onRowContextMenu={handleRowContextMenu}
        expandable={expandableConfig}
        reorderable={reorderableConfig}
        depth={depth}
        className={`node-table-view ${className}`}
        getRowClassName={(_, __, rowDepth) => `node-table__row--depth-${rowDepth}`}
        onNodeOpen={openNode}
        onNodeOpenInSidebar={addSidebarCard}
      />
      
      {/* Context menu */}
      {contextMenuNode && customContextMenu && (
        React.createElement(customContextMenu, {
          node: contextMenuNode,
          position: contextMenuPosition,
          onClose: handleCloseContextMenu,
        })
      )}
    </>
  );
}
