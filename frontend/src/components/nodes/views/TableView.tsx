/**
 * TableView Component
 *
 * Table view for NodeCollection.
 * Uses the core Table component with node-specific configuration.
 *
 * Features:
 * - Configurable columns via propertyUuids
 * - Expandable rows for children
 * - Sorting support
 * - Drag-and-drop reordering with drag handles
 * - Row selection with checkboxes
 * - Property columns via PropertyCell
 * - Virtual columns: Classes, Created, Modified
 * - Date columns with daily page navigation
 */
import React, { useMemo, useCallback, useState, memo, type ReactNode } from 'react';
import type { Node } from '@/types';
import type { NodeTableViewProps } from '@/types/nodeCollection';
import { useNavigationStore, useSettingsStore } from '@/stores';
import { formatDate as formatDateWithFormat } from '@/stores/settingsStore';
import * as nodesApi from '@/api/nodes';
import { useProperties, useClasses, useAddClass, useRemoveClass } from '@/hooks';
import type { TableColumn, ExpandableConfig, ReorderableConfig, SortEntry } from '../../core/Table';
import { Table } from '../../core/Table';
import { DragHandleIcon } from '../../core/icons';
import { PropertyCell } from '../../properties/PropertyCell';
import { NodeSelector } from '../NodeSelector';
import { NodeRef } from '../NodeRef';
import { CollapsiblePillRow } from '../CollapsiblePillRow';
import { Button } from '../../core/Button';
import { isNonRemovableClass, SYSTEM_CLASS_UUIDS } from '@/constants';
import { compareBySequence, compareByWriteDateDesc, compareByCreateDateDesc, compareDateFirstAlpha } from '@/utils/nodeSort';
import { VIRTUAL_FIELD_IDS } from '@/types/viewFields';
import './TableView.css';
import { registerView } from './registry';

// Custom column definition for node tables (external API)
interface NodeTableColumn {
  key: string;
  label: string;
  width?: string;
  headerNode?: { id: number; uuid: string; name: string; icon: string | null };
  render?: (node: Node) => ReactNode;
  sortable?: boolean;
  sortFn?: (a: Node, b: Node) => number;
}

/**
 * Default columns for the table view
 * Only includes Name column - date columns are virtual columns controlled by propertyUuids
 */
function getDefaultColumns(): NodeTableColumn[] {
  return [
    {
      key: 'name',
      label: 'Name',
      width: '300px',
    },
  ];
}

/**
 * Convert NodeTableColumn to TableColumn<Node>
 * Adds sorting support for known column keys and property columns.
 */
function convertColumns(nodeColumns: NodeTableColumn[]): TableColumn<Node>[] {
  return nodeColumns.map(col => ({
    key: col.key,
    header: col.label,
    headerNode: col.headerNode,
    width: col.width,
    accessor: col.render
      ? col.render
      : col.key === 'name'
        ? (node: Node) => node as unknown as ReactNode
        : (node: Node) => String((node as unknown as Record<string, unknown>)[col.key] ?? ''),
    // Enable automatic node cell rendering for name column
    renderNodeCell: col.key === 'name',
    // Column-specific sort config
    sortable: col.sortable ?? (col.key === 'name' || col.key === 'write_date' || col.key === 'create_date' || col.key === 'sequence'),
    sortFn: col.sortFn ?? getSortFnForColumn(col.key),
  }));
}

/** Return the appropriate sort comparator for a known column key. */
function getSortFnForColumn(key: string): ((a: Node, b: Node) => number) | undefined {
  switch (key) {
    case 'name': return compareDateFirstAlpha;
    case 'write_date': return compareByWriteDateDesc;
    case 'create_date': return compareByCreateDateDesc;
    case 'sequence': return compareBySequence;
    default: return undefined;
  }
}

/**
 * TableView - Table view for NodeCollection
 *
 * Uses the core Table<Node> component with property columns,
 * expandable rows, selection, sorting, and drag-and-drop reordering.
 */
export const TableView = memo(function TableView({
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
  onNodeClick: _onNodeClick,
  onNodeShiftClick: _onNodeShiftClick,
  propertyUuids = [],
  className = '',
  customContextMenu,
  sort,
  onSortChange,
}: NodeTableViewProps) {
  // Get openNode and addSidebarCard from store for navigation
  const { openNode, addSidebarCard } = useNavigationStore();

  // Get user's date format preference
  const dateFormat = useSettingsStore((state) => state.dateFormat);

  // Get classes for rendering class pills in Classes column
  const { data: allClasses = [] } = useClasses();

  // Mutations for class operations in Classes column
  const addClass = useAddClass();
  const removeClass = useRemoveClass();

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

  // Helper to open daily page for a date
  const openDailyPage = useCallback(async (dateStr: string, inSidebar: boolean) => {
    if (!dateStr || dateStr === '') return;
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return;
    const formattedDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

    try {
      const dailyNode = await nodesApi.getOrCreateDaily(formattedDate);
      if (inSidebar) {
        addSidebarCard(dailyNode.id, 'page');
      } else {
        openNode(dailyNode.id);
      }
    } catch (error) {
      console.error('Failed to open daily page:', error);
    }
  }, [openNode, addSidebarCard]);

  // Create date column renderer with action buttons
  const dateColumnRenderer = useCallback((dateField: 'create_date' | 'write_date') => (node: Node): ReactNode => {
    const dateStr = node[dateField];
    if (!dateStr || dateStr === '') return '';
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return '';
    const formattedDate = formatDateWithFormat(date, dateFormat as any);

    return (
      <div className="node-table__date-cell">
        <span className="node-table__date">
          {formattedDate}
        </span>
        <div className="node-table__actions">
          <Button
            icon={"mdi mdi-dock-right"}
            variant="ghost"
            size="xs"
            title="Open day in sidebar"
            onClick={(e) => {
              e.stopPropagation();
              openDailyPage(dateStr, true);
            }}
          />
          <Button
            icon={"mdi mdi-arrow-right"}
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

  // If no columns are explicitly configured, default to useful virtual columns
  const effectivePropertyUuids = propertyUuids.length > 0
    ? propertyUuids
    : [VIRTUAL_FIELD_IDS.classes, VIRTUAL_FIELD_IDS.created, VIRTUAL_FIELD_IDS.modified];

  // Generate property columns from propertyUuids
  const propertyColumns = useMemo<NodeTableColumn[]>(() => {
    if (!effectivePropertyUuids.length) return [];

    return effectivePropertyUuids
      .map((uuid: string): NodeTableColumn | null => {
        // Handle virtual Classes column
        if (uuid === VIRTUAL_FIELD_IDS.classes) {
          return {
            key: 'classes',
            label: 'Classes',
            width: '200px',
            render: (node: Node): ReactNode => {
              const classNodes = (node.classes || [])
                .map(classId => allClasses.find(c => c.id === classId))
                .filter((c): c is Node => c !== undefined && c.uuid !== SYSTEM_CLASS_UUIDS.page);

              return (
                <CollapsiblePillRow
                  items={classNodes}
                  getKey={(classNode) => classNode.id}
                  renderPill={(classNode) => (
                    <NodeRef
                      node={classNode}
                      onClick={() => openNode(classNode.id)}
                      onRemove={
                        editable && !isNonRemovableClass(classNode.uuid)
                          ? () => removeClass.mutate({ nodeId: node.id, classId: classNode.id })
                          : undefined
                      }
                      readOnly={!editable}
                    />
                  )}
                  renderAddButton={
                    editable
                      ? () => (
                          <NodeSelector
                            nodes={[]}
                            searchMode="classes"
                            emptyText="+"
                            searchPlaceholder="Search classes..."
                            onAdd={(classNode) => {
                              addClass.mutate({ nodeId: node.id, classId: classNode.id });
                            }}
                            readOnly={false}
                          />
                        )
                      : undefined
                  }
                  popupTitle="Classes"
                />
              );
            },
          };
        }

        // Handle virtual Created column
        if (uuid === VIRTUAL_FIELD_IDS.created) {
          return {
            key: 'create_date',
            label: 'Created',
            width: '150px',
            render: dateColumnRenderer('create_date'),
          };
        }

        // Handle virtual Modified column
        if (uuid === VIRTUAL_FIELD_IDS.modified) {
          return {
            key: 'write_date',
            label: 'Modified',
            width: '150px',
            render: dateColumnRenderer('write_date'),
          };
        }

        // Handle regular property columns
        const property = allProperties.find(p => p.uuid === uuid);
        if (!property) return null;

        return {
          key: `property_${property.id}`,
          label: property.name,
          width: '150px',
          headerNode: {
            id: property.id,
            uuid: property.uuid,
            name: property.name,
            icon: property.icon,
          },
          sortable: true,
          sortFn: (a: Node, b: Node): number => {
            const aVal = a.properties?.[property.id];
            const bVal = b.properties?.[property.id];
            // Handle nulls
            if (aVal == null && bVal == null) return 0;
            if (aVal == null) return 1;
            if (bVal == null) return -1;
            // Type-aware comparison
            switch (property.type) {
              case 'integer':
              case 'float':
                return (aVal as number) - (bVal as number);
              case 'boolean':
                return (aVal ? 1 : 0) - (bVal ? 1 : 0);
              case 'selection': {
                const getOptionName = (v: unknown): string => {
                  if (typeof v === 'number') {
                    return property.options?.find(o => o.id === v)?.name ?? String(v);
                  }
                  if (v && typeof v === 'object' && 'id' in v) {
                    return property.options?.find(o => o.id === (v as { id: number }).id)?.name ?? String(v);
                  }
                  return String(v);
                };
                return getOptionName(aVal).localeCompare(getOptionName(bVal));
              }
              default:
                return String(aVal).localeCompare(String(bVal));
            }
          },
          render: (node: Node): ReactNode => {
            const value = node.properties?.[property.id];
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
  }, [effectivePropertyUuids, allProperties, allClasses, editable, openNode, addClass, removeClass, dateColumnRenderer]);

  // Convert node columns to Table columns, injecting column renderers
  const nodeColumns = useMemo<NodeTableColumn[]>(() => {
    const cols = customColumns ?? getDefaultColumns();
    const baseColumns = cols.map(col => {
      if (col.render) return col;
      if (col.key === 'create_date') return { ...col, render: dateColumnRenderer('create_date') };
      if (col.key === 'write_date') return { ...col, render: dateColumnRenderer('write_date') };
      return col;
    });

    return [...baseColumns, ...propertyColumns];
  }, [customColumns, dateColumnRenderer, propertyColumns]);

  // Convert NodeTableColumn to TableColumn<Node>
  const tableColumns = useMemo(() => convertColumns(nodeColumns), [nodeColumns]);

  // Default sort: write_date descending (most recently modified first)
  const defaultSort = useMemo<SortEntry[]>(() => {
    // Only apply default if the Modified column is visible
    const hasModifiedCol = nodeColumns.some(c => c.key === 'write_date');
    return hasModifiedCol ? [{ key: 'write_date', direction: 'desc' }] : [];
  }, [nodeColumns]);

  // Convert Set<number> to Set<string | number> for Table component
  const selectedKeys = useMemo(() => {
    return selectedIds as Set<string | number>;
  }, [selectedIds]);

  // Expandable configuration
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
      {nodes.length > 0 && (
        <Table<Node>
          data={nodes}
          columns={tableColumns}
          getRowKey={(node) => node.id}
          size="md"
          variant="bordered"
          selectable={selectable}
          selectedKeys={selectedKeys}
          onSelectionChange={handleSelectionChange}
          onRowContextMenu={handleRowContextMenu}
          expandable={expandableConfig}
          reorderable={reorderableConfig}
          depth={depth}
          className={`node-table-view ${className}`}
          getRowClassName={(_, __, rowDepth) => `node-table__row--depth-${rowDepth}`}
          onNodeOpen={(nodeId) => openNode(nodeId)}
          onNodeOpenInSidebar={(nodeId) => addSidebarCard(nodeId, 'block')}
          nodeEditable={editable}
          defaultSort={defaultSort}
          sort={sort}
          onSortChange={onSortChange}
          virtualized={nodes.length > 200}
        />
      )}

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
});

registerView({
  id: 'table',
  label: 'Table',
  icon: 'mdi mdi-table',
  component: TableView,
  capabilities: { propertyColumns: true, sorting: true },
});
