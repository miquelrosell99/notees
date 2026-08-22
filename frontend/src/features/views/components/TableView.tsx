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
import { useShallow } from 'zustand/react/shallow';
import type { Node } from '@/types';
import type { NodeTableViewProps } from '@/types/nodeCollection';
import { getPropertyValueRenderer } from '@/features/properties';
import '@/features/properties';
import { useNavigationStore, useSettingsStore } from '@/stores';
import { formatDate as formatDateWithFormat } from '@/stores/settingsStore';
import { getOrCreateDailyNoteClient } from '@/features/content';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { getWorkspaceStoreClient } from '@/core/adapters/workspaceStoreClientAdapter';
import { useProperties } from '@/features/properties';
import { useClasses, useAddClass, useRemoveClass } from '@/features/content';
import type { TableColumn, ExpandableConfig, ReorderableConfig, SortEntry } from './NodeTable';
import { NodeTable } from './NodeTable';
import { DragHandleIcon } from '@/components/ui/icons';
import { PropertyCell } from '@/features/properties';
import { NodeSelector } from '@/features/content';
import { NodeRef } from '@/features/content';
import { CollapsiblePillRow } from '@/features/content';
import { Button } from '@/components/ui/Button';
import { isNonRemovableClass } from '@/constants';
import { compareBySequence, compareByWriteDateDesc, compareByCreateDateDesc, compareDateFirstAlpha } from '@/utils/nodeSort';
import { VIRTUAL_FIELD_IDS } from '@/types/viewFields';
import './TableView.css';
import { registerView } from './registry';

// Custom column definition for node tables (external API)
interface NodeTableColumn {
  key: string;
  label: string;
  width?: string;
  headerNode?: { nodeUuid: string; uuid: string; name: string; icon: string | null };
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
      width: 'var(--layout-size-7xl)',
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
  const { openNode, addSidebarCard } = useNavigationStore(
    useShallow((state) => ({ openNode: state.openNode, addSidebarCard: state.addSidebarCard })),
  );
  const workspaceUuid = useCurrentWorkspaceUuid();

  // Get user's date format preference
  const dateFormat = useSettingsStore((state) => state.dateFormat);

  // Get classes for rendering class pills in Classes column
  const { data: allClasses = [] } = useClasses();

  // Mutations for class operations in Classes column
  const addClass = useAddClass();
  const removeClass = useRemoveClass();

  // Internal selection state (used when not controlled)
  const [internalSelectedIds, setInternalSelectedIds] = useState<Set<string>>(new Set());

  // Context menu state
  const [contextMenuNode, setContextMenuNode] = useState<Node | null>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 });

  // Use controlled or internal selection state
  const selectedIds = controlledSelectedIds ?? internalSelectedIds;
  const handleSelectionChange = useCallback((keys: Set<string>) => {
    if (onSelectionChange) {
      onSelectionChange(keys);
    } else {
      setInternalSelectedIds(keys);
    }
  }, [onSelectionChange]);

  // Helper to open daily page for a date
  const openDailyPage = useCallback(async (dateStr: string, inSidebar: boolean) => {
    if (!dateStr || dateStr === '') return;
    if (!workspaceUuid) return;
    const client = getWorkspaceStoreClient(workspaceUuid);
    if (!client) return;
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return;
    const formattedDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

    try {
      const dailyNode = await getOrCreateDailyNoteClient(client, formattedDate);
      if (inSidebar) {
        addSidebarCard(dailyNode.uuid, 'page');
      } else {
        openNode(dailyNode.uuid);
      }
    } catch (error) {
      console.error('Failed to open daily page:', error);
    }
  }, [openNode, addSidebarCard, workspaceUuid]);

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
          <Button aria-label="Open day in sidebar"
            icon={"mdi mdi-dock-right"}
            variant="ghost"
            size="xs"
            title="Open day in sidebar"
            onClick={(e) => {
              e.stopPropagation();
              openDailyPage(dateStr, true);
            }}
          />
          <Button aria-label="Open day"
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
  const effectivePropertyUuids = useMemo(
    () =>
      propertyUuids.length > 0
        ? propertyUuids
        : [VIRTUAL_FIELD_IDS.classes, VIRTUAL_FIELD_IDS.created, VIRTUAL_FIELD_IDS.modified],
    [propertyUuids]
  );

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
            width: 'var(--layout-size-2xl)',
            render: (node: Node): ReactNode => {
              const classNodes = (node.classes_uuid || [])
                .map(classId => allClasses.find(c => c.uuid === classId))
                .filter((c): c is Node => c !== undefined);

              return (
                <CollapsiblePillRow
                  items={classNodes}
                  getKey={(classNode) => classNode.uuid}
                  renderPill={(classNode) => (
                    <NodeRef
                      node={classNode}
                      onClick={() => openNode(classNode.uuid)}
                      onRemove={
                        editable && !isNonRemovableClass(classNode.uuid)
                          ? () => removeClass.mutate({ nodeUuid: node.uuid, classId: classNode.uuid })
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
                            emptyText=""
                            searchPlaceholder="Search classes..."
                            onAdd={(classNode) => {
                              addClass.mutate({ nodeUuid: node.uuid, classId: classNode.uuid });
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
            width: 'var(--layout-size-lg)',
            render: dateColumnRenderer('create_date'),
          };
        }

        // Handle virtual Modified column
        if (uuid === VIRTUAL_FIELD_IDS.modified) {
          return {
            key: 'write_date',
            label: 'Modified',
            width: 'var(--layout-size-lg)',
            render: dateColumnRenderer('write_date'),
          };
        }

        // Handle regular property columns
        const property = allProperties.find(p => p.uuid === uuid);
        if (!property) return null;

        return {
          key: `property_${property.uuid}`,
          label: property.name,
          width: 'var(--layout-size-lg)',
          headerNode: {
            nodeUuid: property.uuid,
            uuid: property.uuid,
            name: property.name,
            icon: property.icon,
          },
          sortable: true,
          sortFn: (a: Node, b: Node): number => {
            const aVal = a.properties_uuid?.[property.uuid];
            const bVal = b.properties_uuid?.[property.uuid];
            // Handle nulls
            if (aVal == null && bVal == null) return 0;
            if (aVal == null) return 1;
            if (bVal == null) return -1;
            // Type-aware comparison
            const renderer = getPropertyValueRenderer(property.type);
            if (renderer) {
              return renderer.compareValues(aVal, bVal, property);
            }
            return String(aVal).localeCompare(String(bVal));
          },
          render: (node: Node): ReactNode => {
            const value = node.properties_uuid?.[property.uuid];
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

  const selectedKeys = selectedIds;

  // Virtualization is required for large tables, but the current NodeTable
  // implementation only supports it for flat tables (no expandable rows, no
  // reordering). For large datasets we trade row expansion/reordering for
  // render performance.
  const enableVirtualization = nodes.length > 100;

  // Expandable configuration
  const expandableConfig: ExpandableConfig<Node> | undefined = useMemo(() => {
    if (!expandable || enableVirtualization) return undefined;
    return {
      getChildren: (node: Node) => node.children ?? [],
      maxDepth: maxDepth,
    };
  }, [expandable, maxDepth, enableVirtualization]);

  // Reorderable configuration
  const reorderableConfig: ReorderableConfig | undefined = useMemo(() => {
    if (!sortable || !onReorder || enableVirtualization) return undefined;
    return {
      onReorder,
      renderDragHandle: () => <DragHandleIcon size="xs" />,
    };
  }, [sortable, onReorder, enableVirtualization]);

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
        <NodeTable<Node>
          data={nodes}
          columns={tableColumns}
          getRowKey={(node) => node.uuid}
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
          onNodeOpen={(nodeUuid) => openNode(nodeUuid)}
          onNodeOpenInSidebar={(nodeUuid) => addSidebarCard(nodeUuid, 'block')}
          nodeEditable={editable}
          defaultSort={defaultSort}
          sort={sort}
          onSortChange={onSortChange}
          virtualized={enableVirtualization}
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
