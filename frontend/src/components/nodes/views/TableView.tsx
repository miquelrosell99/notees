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
import { Button } from '../../core/Button';
import { isNonRemovableClass, SYSTEM_CLASS_UUIDS } from '@/constants';
import { mdiDockRight, mdiArrowRight } from '@mdi/js';
import { compareBySequence, compareByWriteDateDesc, compareByCreateDateDesc, compareDateFirstAlpha } from '@/utils/nodeSort';
import './TableView.css';

// Virtual column UUIDs (match PropertyColumnSelector)
const CLASSES_VIRTUAL_UUID = '__classes__';
const CREATED_VIRTUAL_UUID = '__created__';
const MODIFIED_VIRTUAL_UUID = '__modified__';

// Custom column definition for node tables (external API)
interface NodeTableColumn {
  key: string;
  label: string;
  width?: string;
  headerNode?: { id: number; uuid: string; name: string; icon: string | null };
  render?: (node: Node) => ReactNode;
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
      width: '100%',
    },
  ];
}

/**
 * Convert NodeTableColumn to TableColumn<Node>
 * Adds sorting support for known column keys.
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
    sortable: col.key === 'name' || col.key === 'write_date' || col.key === 'create_date' || col.key === 'sequence',
    sortFn: getSortFnForColumn(col.key),
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
  onNodeClick,
  onNodeShiftClick,
  propertyUuids = [],
  className = '',
  customContextMenu,
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
        // Handle virtual Classes column
        if (uuid === CLASSES_VIRTUAL_UUID) {
          return {
            key: 'classes',
            label: 'Classes',
            width: '200px',
            render: (node: Node): ReactNode => {
              const classNodes = (node.classes || [])
                .map(classId => allClasses.find(c => c.id === classId))
                .filter((c): c is Node => c !== undefined && c.uuid !== SYSTEM_CLASS_UUIDS.page);

              return (
                <NodeSelector
                  nodes={classNodes}
                  searchMode="classes"
                  emptyText="Add class"
                  searchPlaceholder="Search classes..."
                  onNodeClick={(classNode) => {
                    openNode(classNode.id);
                  }}
                  onAdd={editable ? (classNode) => {
                    addClass.mutate({ nodeId: node.id, classId: classNode.id });
                  } : undefined}
                  onRemove={editable ? (classNode) => {
                    removeClass.mutate({ nodeId: node.id, classId: classNode.id });
                  } : undefined}
                  canRemove={(classNode) => !isNonRemovableClass(classNode.uuid)}
                  readOnly={!editable}
                />
              );
            },
          };
        }

        // Handle virtual Created column
        if (uuid === CREATED_VIRTUAL_UUID) {
          return {
            key: 'create_date',
            label: 'Created',
            width: '150px',
            render: dateColumnRenderer('create_date'),
          };
        }

        // Handle virtual Modified column
        if (uuid === MODIFIED_VIRTUAL_UUID) {
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
          label: property.icon ? `${property.icon} ${property.name}` : property.name,
          width: '150px',
          headerNode: {
            id: property.id,
            uuid: property.uuid,
            name: property.name,
            icon: property.icon,
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
  }, [propertyUuids, allProperties, allClasses, editable, openNode, addClass, removeClass, dateColumnRenderer]);

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
          onNodeOpen={openNode}
          onNodeOpenInSidebar={addSidebarCard}
          nodeEditable={editable}
          defaultSort={defaultSort}
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
