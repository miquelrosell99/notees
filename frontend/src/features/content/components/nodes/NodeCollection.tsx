/**
 * NodeCollection Component
 *
 * Universal component for displaying collections of nodes.
 * Dispatches to the correct view component based on viewMode.
 *
 * Features:
 * - Multiple view modes: list, document, card, table, gantt, graph
 * - Built-in view mode switcher (hidden when only one mode available)
 * - All views use BlockEditor internally (Lexical-based)
 * - Recursive children handling
 * - Consistent prop propagation to all view modes
 *
 * Component Hierarchy:
 * NodeCollection
 * ├─ NodeCollectionToolbar
 * ├─ ListView (list) → BlockEditor
 * ├─ DocumentView (document) → BlockEditor
 * ├─ CardView (card) → BlockEditor per card
 * ├─ TableView (table) → BlockEditor per cell
 * ├─ GanttView (gantt)
 * ├─ TimelineView (timeline)
 * └─ GraphView (graph)
 */
import { useMemo, useCallback, useState, useEffect, memo, Suspense } from 'react';
import type { ReactNode } from 'react';
import { useAppStore } from '@/stores';
import { useUpdateNodeView } from '@/features/content/hooks/useNodeViews';
import { useProperties } from '@/features/properties';
import type {
  NodeCollectionProps,
  NodeCollectionContextValue,
  NodeCollectionGroupBy,
  SortEntry,
} from '@/types/nodeCollection';
import type { Property } from '@/types';
import { DEFAULT_VIEW_MODES_ORDER } from '@/constants/viewModes';
import { sortNodesByEntries } from '@/utils/nodeSort';
import { getViewDefinition } from '@/features/views';
import { NodeCollectionToolbar } from './NodeCollectionToolbar';
import { Card } from '@/components/ui/Card';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import './NodeCollection.css';

import { NodeCollectionContext } from './NodeCollectionContext';

// Immersive canvas/aggregation views choke when fed huge node lists.
// Cap them until real server-side pagination is implemented.
const IMMERSIVE_VIEW_NODE_LIMIT = 500;

// ==================== Group-by helpers ====================

/** Normalize a group-by value into an ordered list of level keys. */
function normalizeGroupBy(value: NodeCollectionGroupBy): string[] {
  if (!value || value === 'none') return [];
  if (Array.isArray(value)) return value;
  return [value];
}

/** Whether any grouping level is active. */
function isGroupByActive(value: NodeCollectionGroupBy): boolean {
  return normalizeGroupBy(value).length > 0;
}

// ==================== Component ====================

/**
 * NodeCollection - Universal node collection component
 *
 * Dispatches to view-specific components based on viewMode prop.
 * Includes built-in view mode switcher (hidden when only one mode available).
 *
 * Use hideToolbar=true when rendering the toolbar externally via NodeCollectionToolbar.
 */
export const NodeCollection = memo(function NodeCollection({
  nodes,
  viewUuid,
  view,
  viewMode,
  availableViewModes,
  onViewModeChange,
  editable = true,
  sortable = true,
  onReorder,
  renderItemAction,
  renderNode,
  onNodeClick,
  onNodeShiftClick,
  onContentChange,
  className = '',
  groupBy: groupByProp,
  onGroupByChange,
  showGroupBy: showGroupByProp = false,
  pagesOnly = false,
  showEmpty = true,
  emptyMessage = 'Nothing to show',
  maxDepth = Infinity,
  tableColumns,
  isolatedBlockState = false,
  suppressRootColor = false,
  showBreadcrumbs = false,
  hideToolbar = false,
  toolbarPrefix,
  leftElement,
  beforeContent,
  hideToolbarControls = false,
  hideContent = false,
  showAddButton = false,
  onAdd,
  can_create = true,
  cardLayout,
  onCardLayoutChange,
  selectedPropertyUuids: selectedPropertyUuidsProp,
  onPropertyColumnsChange,
  customContextMenu,
  customContextMenuItems,
  autoCollapse = false,
  expandAll = false,
  defaultSort,
  sort: sortProp,
  onSortChange,
  ganttStartDateProperty: ganttStartDatePropertyProp,
  ganttEndDateProperty: ganttEndDatePropertyProp,
  onGanttStartDatePropertyChange,
  onGanttEndDatePropertyChange,
  containerCard = false,
  activeNode,
  pageId,
  nodeUuid,
  onAddClass,
  onSlashCommand,
  onPasteImage,
  onTemplateInstantiate,
  templateClassFilters,
  onEnterAtRoot,
  hideProperties = false,
  size,
  showClasses = false,
  showNewBlock = true,
  hideRootBullet = false,
  rootIsBlock = false,
  queryAst,
  isTransient = false,
  inPropertyEditor = false,
}: NodeCollectionProps) {
  // Use store for card layout unless transient or controlled
  const storeCardLayout = useAppStore((state) => state.cardLayout);
  const rawCardLayout = cardLayout ?? (isTransient ? 'no-cover' : storeCardLayout);
  // Filter out invalid 'cover-bottom' from old persisted state
  const effectiveCardLayout: 'no-cover' | 'cover-top' | 'cover-left' | 'cover-right' =
    rawCardLayout as string === 'cover-bottom' ? 'no-cover' : rawCardLayout;

  // Default groupBy: 'page' — group by page automatically in list view
  const defaultGroupBy: NodeCollectionGroupBy = 'page';

  // Internal groupBy state (controlled or uncontrolled)
  const [internalGroupBy, setInternalGroupBy] = useState<NodeCollectionGroupBy>(groupByProp ?? defaultGroupBy);
  const groupBy = onGroupByChange ? (groupByProp ?? defaultGroupBy) : internalGroupBy;
  const handleGroupByChange = (value: NodeCollectionGroupBy) => {
    if (onGroupByChange) {
      onGroupByChange(value);
    } else {
      setInternalGroupBy(value);
    }
  };

  // Resolve groupBy properties for single and multi-level grouping
  const { data: allProperties = [] } = useProperties();
  const normalizedGroupBy = useMemo(() => normalizeGroupBy(groupBy), [groupBy]);
  const groupByProperty = useMemo(() => {
    const first = normalizedGroupBy.find((g) => g !== 'page' && g !== 'none');
    return first ? allProperties.find((p) => p.uuid === first) : undefined;
  }, [normalizedGroupBy, allProperties]);
  const groupByProperties = useMemo(() => {
    return normalizedGroupBy
      .filter((g) => g !== 'page' && g !== 'none')
      .map((propertyUuid) => allProperties.find((p) => p.uuid === propertyUuid))
      .filter((p): p is Property => p != null);
  }, [normalizedGroupBy, allProperties]);

  // Property column selection state (for table view)
  // Use controlled props if provided, otherwise manage internally
  // Default to Created and Modified columns (matches default table columns)
  const [internalPropertyUuids, setInternalPropertyUuids] = useState<string[]>([]);
  const selectedPropertyUuids = selectedPropertyUuidsProp ?? internalPropertyUuids;

  // Explicit sort columns (empty = no sort; defaultSort seeds initial state)
  const [internalSortColumns, setInternalSortColumns] = useState<SortEntry[]>(defaultSort ?? []);
  const sortColumns = sortProp ?? internalSortColumns;
  const setSortColumns = onSortChange ?? setInternalSortColumns;

  // Available sort columns for the sort popup (all applicable fields)
  const availableSortColumns = useMemo(() => {
    const columns: { key: string; label: string }[] = [];

    // System fields
    columns.push({ key: 'name', label: 'Name' });
    columns.push({ key: 'create_date', label: 'Created' });
    columns.push({ key: 'write_date', label: 'Modified' });
    columns.push({ key: 'sequence', label: 'Sequence' });

    // All properties
    allProperties.forEach((prop) => {
      columns.push({ key: `property_${prop.id}`, label: prop.name });
    });

    return columns;
  }, [allProperties]);

  // Pre-sort nodes for non-table views (table handles its own sorting)
  const sortedNodes = useMemo(() => {
    if (viewMode === 'table' || sortColumns.length === 0) return nodes;
    return sortNodesByEntries(nodes, sortColumns, allProperties);
  }, [nodes, sortColumns, viewMode, allProperties]);

  // Gantt date property state (controlled or uncontrolled)
  // In uncontrolled mode: drive from the persisted store UUIDs unless transient
  const storeGanttStartUuid = useAppStore((state) => state.ganttStartDatePropertyUuid);
  const storeGanttEndUuid = useAppStore((state) => state.ganttEndDatePropertyUuid);
  const setStoreGanttStartUuid = useAppStore((state) => state.setGanttStartDatePropertyUuid);
  const setStoreGanttEndUuid = useAppStore((state) => state.setGanttEndDatePropertyUuid);
  const storeGanttTimeScale = useAppStore((state) => state.ganttTimeScale);
  const setStoreGanttTimeScale = useAppStore((state) => state.setGanttTimeScale);

  const [transientGanttStartUuid, setTransientGanttStartUuid] = useState('');
  const [transientGanttEndUuid, setTransientGanttEndUuid] = useState('');
  const [transientGanttTimeScale, setTransientGanttTimeScale] = useState<'day' | 'week' | 'month'>('month');

  // Resolve UUIDs → Property objects (works once allProperties is loaded)
  const effectiveGanttStartUuid = onGanttStartDatePropertyChange
    ? undefined
    : (isTransient ? transientGanttStartUuid : storeGanttStartUuid);
  const effectiveGanttEndUuid = onGanttEndDatePropertyChange
    ? undefined
    : (isTransient ? transientGanttEndUuid : storeGanttEndUuid);
  const storeGanttStartProperty = useMemo(
    () => allProperties.find((p) => p.uuid === effectiveGanttStartUuid),
    [allProperties, effectiveGanttStartUuid]
  );
  const storeGanttEndProperty = useMemo(
    () => allProperties.find((p) => p.uuid === effectiveGanttEndUuid),
    [allProperties, effectiveGanttEndUuid]
  );

  const ganttStartDateProperty = onGanttStartDatePropertyChange
    ? ganttStartDatePropertyProp
    : (ganttStartDatePropertyProp ?? storeGanttStartProperty);
  const ganttEndDateProperty = onGanttEndDatePropertyChange
    ? ganttEndDatePropertyProp
    : (ganttEndDatePropertyProp ?? storeGanttEndProperty);
  const ganttTimeScale = isTransient ? transientGanttTimeScale : storeGanttTimeScale;
  const handleGanttStartDatePropertyChange = (property: Property | undefined) => {
    if (onGanttStartDatePropertyChange) {
      onGanttStartDatePropertyChange(property);
    } else if (isTransient) {
      setTransientGanttStartUuid(property?.uuid ?? '');
    } else {
      setStoreGanttStartUuid(property?.uuid ?? '');
    }
  };
  const handleGanttEndDatePropertyChange = (property: Property | undefined) => {
    if (onGanttEndDatePropertyChange) {
      onGanttEndDatePropertyChange(property);
    } else if (isTransient) {
      setTransientGanttEndUuid(property?.uuid ?? '');
    } else {
      setStoreGanttEndUuid(property?.uuid ?? '');
    }
  };
  const handleGanttTimeScaleChange = (scale: 'day' | 'week' | 'month') => {
    if (isTransient) {
      setTransientGanttTimeScale(scale);
    } else {
      setStoreGanttTimeScale(scale);
    }
  };
  const updateNodeView = useUpdateNodeView();
  const viewIdForCharts = view?.id;

  // Load property columns from view configuration (only for uncontrolled, non-transient mode)
  useEffect(() => {
    if (!isTransient && !selectedPropertyUuidsProp && view?.shown_properties) {
      // Sort by sequence and extract UUIDs
      const sortedProperties = [...view.shown_properties]
        .sort((a, b) => a.sequence - b.sequence)
        .map((p) => p.uuid);
       
      setInternalPropertyUuids(sortedProperties);
    }
  }, [view, selectedPropertyUuidsProp, isTransient]);

  const handlePropertyColumnsChange = (propertyUuids: string[]) => {
    // If controlled, call the callback
    if (onPropertyColumnsChange) {
      onPropertyColumnsChange(propertyUuids);
      return;
    }

    // Otherwise, update internal state and persist (unless transient)
    setInternalPropertyUuids(propertyUuids);

    // Save to view configuration via API
    if (!isTransient && viewUuid) {
      const shown_properties = propertyUuids.map((propertyUuid, index) => ({
        uuid: propertyUuid,
        sequence: index + 1,
      }));

      updateNodeView.mutate({
        viewId: viewUuid,
        data: { shown_properties },
      });
    }
  };

  // Determine which view modes are available
  // Empty array means "all modes" — only filter when explicit modes are provided
  const effectiveViewModes = availableViewModes?.length ? availableViewModes : DEFAULT_VIEW_MODES_ORDER;
  const showViewSwitcher = effectiveViewModes.length > 1 && onViewModeChange;

  // Look up view definition from registry
  const viewDef = getViewDefinition(viewMode);
  const capabilities = viewDef?.capabilities ?? {};

  const showGroupByInToolbar = showGroupByProp && capabilities.groupBy;
  const effectiveShowAdd = showAddButton && onAdd && can_create;

  // Whether to show the internal toolbar (show if we have leftElement OR toolbar controls)
  const showInternalToolbar = !hideToolbar && (leftElement || showGroupByInToolbar || showViewSwitcher || effectiveShowAdd || capabilities.ganttConfig);

  // Enable grouping for list view when any group-by level is active
  const enableGrouping = showGroupByProp && viewMode === 'list' && isGroupByActive(groupBy);

  // Create context value
  const contextValue = useMemo<NodeCollectionContextValue>(() => ({
    editable,
    onNodeClick,
    onNodeShiftClick,
    onContentChange,
    depth: 0,
    maxDepth,
    inPropertyEditor,
  }), [editable, onNodeClick, onNodeShiftClick, onContentChange, maxDepth, inPropertyEditor]);

  // Memoize callbacks so React.memo on view components is effective
  const stableOnNodeClick = useCallback(
    (node: Parameters<NonNullable<typeof onNodeClick>>[0]) => onNodeClick?.(node),
    [onNodeClick]
  );
  const stableOnNodeShiftClick = useCallback(
    (node: Parameters<NonNullable<typeof onNodeShiftClick>>[0]) => onNodeShiftClick?.(node),
    [onNodeShiftClick]
  );
  const stableOnContentChange = useCallback(
    (...args: Parameters<NonNullable<typeof onContentChange>>) => onContentChange?.(...args),
    [onContentChange]
  );

  // Common props for all view components — memoized so React.memo views can skip
  // re-renders when only unrelated NodeCollection state changes.
  const commonViewProps = useMemo(() => ({
    nodes,
    editable,
    onNodeClick: stableOnNodeClick,
    onNodeShiftClick: stableOnNodeShiftClick,
    onContentChange: stableOnContentChange,
    renderNode,
    maxDepth,
    className: '',
    isolatedBlockState,
    suppressRootColor,
    customContextMenu,
    customContextMenuItems,
    autoCollapse,
  }), [nodes, editable, stableOnNodeClick, stableOnNodeShiftClick, stableOnContentChange, renderNode, maxDepth, isolatedBlockState, suppressRootColor, customContextMenu, customContextMenuItems, autoCollapse]);

  // View-specific props derived from mode — memoized by the values actually used.
  const viewSpecificProps = useMemo(() => {
    switch (viewMode) {
      case 'list':
        return {
          nodes: sortedNodes,
          editable,
          pagesOnly,
          sortable,
          onReorder,
          renderItemAction,
          onNodeClick: stableOnNodeClick,
          onNodeShiftClick: stableOnNodeShiftClick,
          onContentChange: stableOnContentChange,
          pageId,
          nodeUuid,
          className: '',
          groupBy,
          groupByProperty,
          groupByProperties,
          expandAll,
          enableGrouping,
          showBreadcrumbs,
          onAddClass,
          onSlashCommand,
          onPasteImage,
          onTemplateInstantiate,
          templateClassFilters,
          onEnterAtRoot,
          hideProperties,
          size,
          maxDepth,
          showClasses,
          showNewBlock,
          hideRootBullet,
          rootIsBlock,
        };

      case 'document':
        return {
          nodes: sortedNodes,
          editable,
          maxDepth,
          onNodeClick: stableOnNodeClick,
          onNodeShiftClick: stableOnNodeShiftClick,
          onContentChange: stableOnContentChange,
          pageId,
          nodeUuid,
          className: '',
          onAddClass,
          onSlashCommand,
          onPasteImage,
          onTemplateInstantiate,
          templateClassFilters,
          hideProperties,
        };

      case 'kanban':
        return {
          nodes: sortedNodes,
          editable,
          layout: effectiveCardLayout,
          sortable,
          onReorder,
          onNodeClick: stableOnNodeClick,
          onNodeShiftClick: stableOnNodeShiftClick,
          onContentChange: stableOnContentChange,
          onAdd,
          customContextMenu,
          className: '',
          groupBy,
          groupByProperty,
          onAddClass,
          onSlashCommand,
          onPasteImage,
          onTemplateInstantiate,
          templateClassFilters,
          showBreadcrumbs,
        };

      case 'table':
        return {
          nodes,
          editable,
          columns: tableColumns,
          propertyUuids: selectedPropertyUuids,
          sortable,
          onReorder,
          onNodeClick: stableOnNodeClick,
          onNodeShiftClick: stableOnNodeShiftClick,
          onContentChange: stableOnContentChange,
          customContextMenu,
          className: '',
          onAddClass,
          onSlashCommand,
          onPasteImage,
          onTemplateInstantiate,
          templateClassFilters,
          sort: sortColumns,
          onSortChange: setSortColumns,
        };

      case 'gantt': {
        const ganttNodes = (ganttStartDateProperty
          ? nodes.filter((n) => {
              const val = (n.properties as Record<number, unknown> | undefined)?.[ganttStartDateProperty.id];
              return val != null;
            })
          : nodes
        ).slice(0, IMMERSIVE_VIEW_NODE_LIMIT);
        return {
          ...commonViewProps,
          nodes: ganttNodes,
          startDateProperty: ganttStartDateProperty,
          endDateProperty: ganttEndDateProperty,
          timeScale: ganttTimeScale,
          groupBy,
          groupByProperty,
        };
      }

      case 'calendar': {
        const calendarNodes = (ganttStartDateProperty
          ? nodes.filter((n) => {
              const val = (n.properties as Record<number, unknown> | undefined)?.[ganttStartDateProperty.id];
              return val != null;
            })
          : nodes
        ).slice(0, IMMERSIVE_VIEW_NODE_LIMIT);
        return {
          ...commonViewProps,
          nodes: calendarNodes,
          startDateProperty: ganttStartDateProperty,
          endDateProperty: ganttEndDateProperty,
          onAdd,
        };
      }

      case 'chart':
        return {
          ...commonViewProps,
          nodes: nodes.slice(0, IMMERSIVE_VIEW_NODE_LIMIT),
          groupByProperty,
          queryAst,
          viewId: viewIdForCharts,
        };

      case 'pivot':
        return {
          ...commonViewProps,
          nodes: nodes.slice(0, IMMERSIVE_VIEW_NODE_LIMIT),
          queryAst,
          viewId: viewIdForCharts,
        };

      case 'timeline':
        return { nodes: nodes.slice(0, IMMERSIVE_VIEW_NODE_LIMIT), className: 'node-collection__timeline' };

      case 'graph': {
        const graphNodes = nodes.slice(0, IMMERSIVE_VIEW_NODE_LIMIT).map((n) => ({
          id: n.id,
          uuid: n.uuid || '',
          name: n.name || 'Untitled',
          type: (n.is_page ? 'page' : 'block') as 'page' | 'block',
          tags: n.tags?.map(String) ?? [],
          class_ids: n.classes ?? [],
          properties: Object.fromEntries(
            Object.entries(n.properties ?? {}).map(([k, v]) => [String(k), v])
          ),
          is_daily: n.is_daily || false,
          is_class: n.is_class,
          is_monthly: n.is_monthly,
          is_yearly: n.is_yearly,
          icon: n.icon ?? undefined,
          backlink_count: n.backlink_count,
          aliased_id: n.aliased_id,
        }));
        if (activeNode && !graphNodes.some((n) => n.id === activeNode.id)) {
          graphNodes.unshift({
            id: activeNode.id,
            uuid: activeNode.uuid,
            name: activeNode.name || 'Untitled',
            type: 'page' as 'page' | 'block',
            tags: [],
            class_ids: [],
            properties: {},
            is_daily: false,
            is_class: (activeNode as { is_class?: boolean }).is_class,
            is_monthly: (activeNode as { is_monthly?: boolean }).is_monthly,
            is_yearly: (activeNode as { is_yearly?: boolean }).is_yearly,
            icon: (activeNode as { icon?: string }).icon ?? undefined,
            backlink_count: (activeNode as { backlink_count?: number }).backlink_count,
            aliased_id: (activeNode as { aliased_id?: number | null }).aliased_id,
          });
        }
        return {
          nodes: graphNodes,
          currentNodeUuid: activeNode?.uuid ?? null,
          className: 'node-collection__graph',
        };
      }

      default:
        return {
          nodes: sortedNodes,
          editable,
          pagesOnly,
          onNodeClick,
          onContentChange,
          onAddClass,
        };
    }
  }, [
    viewMode,
    commonViewProps,
    sortedNodes,
    editable,
    pagesOnly,
    sortable,
    onReorder,
    renderItemAction,
    pageId,
    nodeUuid,
    groupBy,
    groupByProperty,
    groupByProperties,
    expandAll,
    enableGrouping,
    showBreadcrumbs,
    onAddClass,
    onSlashCommand,
    onPasteImage,
    onTemplateInstantiate,
    templateClassFilters,
    onEnterAtRoot,
    hideProperties,
    size,
    maxDepth,
    showClasses,
    showNewBlock,
    hideRootBullet,
    rootIsBlock,
    nodes,
    tableColumns,
    selectedPropertyUuids,
    stableOnNodeClick,
    stableOnNodeShiftClick,
    stableOnContentChange,
    customContextMenu,
    effectiveCardLayout,
    onAdd,
    onNodeClick,
    onContentChange,
    ganttStartDateProperty,
    ganttEndDateProperty,
    ganttTimeScale,
    queryAst,
    viewIdForCharts,
    activeNode,
    sortColumns,
    setSortColumns,
  ]);

  // Check if empty
  const isEmpty = nodes.length === 0 && showEmpty;

  // Render based on view mode
  const renderViewMode = () => {
    // Empty state content
    if (isEmpty) {
      return (
        <div className="node-collection__empty-message">{emptyMessage}</div>
      );
    }

    if (!viewDef) {
      return (
        <div className="node-collection__empty-message">Unknown view mode: {viewMode}</div>
      );
    }

    const ViewComponent = viewDef.component;
    let content = (
      <Suspense fallback={<div className="node-collection__skeleton">Loading view…</div>}>
        <ViewComponent {...viewSpecificProps} />
      </Suspense>
    );

    if (capabilities.errorBoundary) {
      content = (
        <ErrorBoundary context={`${viewDef.label} View`} showRetry>
          {content}
        </ErrorBoundary>
      );
    }

    if (containerCard && capabilities.containerCard) {
      content = (
        <Card variant="default" padding paddingSize="sm" radius="md" className="node-collection__card">
          {content}
        </Card>
      );
    }

    return content;
  };

  return (
    <NodeCollectionContext.Provider value={contextValue}>
      <div className={`node-collection node-collection--${viewMode} ${isEmpty ? 'node-collection--empty' : ''} ${containerCard ? 'node-collection--contained' : ''} ${className}`}>
        {/* Header with GroupBy and View Mode Switcher - hidden when hideToolbar is true */}
        {showInternalToolbar && (
          <div className="node-collection__header">
            <NodeCollectionToolbar
              viewMode={viewMode}
              availableViewModes={effectiveViewModes}
              onViewModeChange={onViewModeChange}
              showGroupBy={showGroupByInToolbar}
              groupBy={groupBy}
              onGroupByChange={handleGroupByChange}
              showAddButton={effectiveShowAdd}
              onAdd={can_create ? onAdd : undefined}
              cardLayout={effectiveCardLayout}
              onCardLayoutChange={onCardLayoutChange}
              selectedPropertyUuids={selectedPropertyUuids}
              onPropertyColumnsChange={handlePropertyColumnsChange}
              sortColumns={sortColumns}
              onSortChange={setSortColumns}
              availableSortColumns={availableSortColumns}
              ganttStartDateProperty={ganttStartDateProperty}
              ganttEndDateProperty={ganttEndDateProperty}
              onGanttStartDatePropertyChange={handleGanttStartDatePropertyChange}
              onGanttEndDatePropertyChange={handleGanttEndDatePropertyChange}
              ganttTimeScale={ganttTimeScale}
              onGanttTimeScaleChange={handleGanttTimeScaleChange}
              isTransient={isTransient}
              toolbarPrefix={toolbarPrefix}
              leftElement={typeof leftElement === 'function' ? (leftElement as (count: number) => ReactNode)(nodes.length) : leftElement}
              hideToolbarControls={hideToolbarControls}
            />
          </div>
        )}

        {/* Before Content Element (e.g., property references) */}
        {!hideContent && beforeContent}

        {/* Content */}
        {!hideContent && (
          <div className="node-collection__content">
            <div key={viewMode} className="node-collection__view-content">
              {renderViewMode()}
            </div>
          </div>
        )}
      </div>
    </NodeCollectionContext.Provider>
  );
});

// Re-export types and toolbar
export type { NodeCollectionProps, NodeCollectionViewMode } from '@/types/nodeCollection';
