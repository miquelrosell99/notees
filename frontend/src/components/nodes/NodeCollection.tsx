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
import { createContext, useContext, useMemo, useState, useEffect, type ReactNode } from 'react';
import { useAppStore } from '@/stores';
import { useUpdateNodeView } from '@/hooks/useNodeViews';
import { useProperties } from '@/hooks';
import { 
  mdiFormatListBulleted, 
  mdiFileDocumentOutline, 
  mdiViewGrid, 
  mdiTable, 
  mdiChartGantt, 
  mdiGraphOutline,
  mdiTimelineClockOutline,
  mdiGroup,
  mdiPlus,
  mdiCardOutline,
  mdiDockLeft,
  mdiDockRight,
  mdiDockTop,
  mdiTableColumn,
  mdiRestore,
} from '@mdi/js';
import type { 
  NodeCollectionProps, 
  NodeCollectionViewMode, 
  NodeCollectionContextValue,
  NodeCollectionGroupBy 
} from '@/types/nodeCollection';
import type { Property } from '@/types';
import { DEFAULT_VIEW_MODES_ORDER, VIEW_MODE_ICONS, VIEW_MODE_LABELS } from '@/constants/viewModes';
import { 
  ListView, 
  DocumentView, 
  CardView, 
  TableView, 
  GanttView,
  GraphView,
  TerrainView,
  TimelineView,
} from './views';
import { NodeCollectionToolbar } from './NodeCollectionToolbar';
import { Card } from '../core/Card';
import './NodeCollection.css';

// ==================== Context ====================

const NodeCollectionContext = createContext<NodeCollectionContextValue | null>(null);

/**
 * Hook to access NodeCollection context
 */
export function useNodeCollectionContext(): NodeCollectionContextValue {
  const context = useContext(NodeCollectionContext);
  if (!context) {
    throw new Error('useNodeCollectionContext must be used within a NodeCollection');
  }
  return context;
}

// ==================== View Mode Mapping ====================

const VIEW_MODE_OPTIONS: Record<NodeCollectionViewMode, { icon: string; label: string }> = {
  list: { icon: mdiFormatListBulleted, label: 'List' },
  document: { icon: mdiFileDocumentOutline, label: 'Document' },
  card: { icon: mdiViewGrid, label: 'Cards' },
  table: { icon: mdiTable, label: 'Table' },
  gantt: { icon: mdiChartGantt, label: 'Gantt' },
  graph: { icon: mdiGraphOutline, label: 'Graph' },
  timeline: { icon: mdiTimelineClockOutline, label: 'Timeline' },
};

// ==================== Component ====================

/**
 * NodeCollection - Universal node collection component
 * 
 * Dispatches to view-specific components based on viewMode prop.
 * Includes built-in view mode switcher (hidden when only one mode available).
 * 
 * Use hideToolbar=true when rendering the toolbar externally via NodeCollectionToolbar.
 */
export function NodeCollection({
  nodes,
  viewId,
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
  showClasses = false,
  showEmpty = true,
  emptyMessage = 'No items',
  maxDepth = Infinity,
  tableColumns,
  pageMap,
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
  // can_edit = true,  // Not currently used
  // can_delete = true,  // Not currently used
  cardLayout,
  onCardLayoutChange,
  selectedPropertyUuids: selectedPropertyUuidsProp,
  onPropertyColumnsChange,
  customContextMenu,
  customContextMenuItems,
  autoCollapse = false,
  containerCard = false,
  activeNode,
  pageId,
  pageUuid,
  onAddClass,
  onSlashCommand,
  onPasteImage,
  onEnterAtRoot,
  hideProperties = false,
  ganttStartDateProperty: ganttStartDatePropertyProp,
  ganttEndDateProperty: ganttEndDatePropertyProp,
  onGanttStartDatePropertyChange,
  onGanttEndDatePropertyChange,
}: NodeCollectionProps) {
  // Always use store for card layout to ensure reactivity
  // Components can still pass cardLayout to override if needed for specific cases
  const storeCardLayout = useAppStore(state => state.cardLayout);
  const rawCardLayout = cardLayout ?? storeCardLayout;
  // Filter out invalid 'cover-bottom' from old persisted state
  const effectiveCardLayout: 'no-cover' | 'cover-top' | 'cover-left' | 'cover-right' = 
    (rawCardLayout === 'cover-bottom' ? 'no-cover' : rawCardLayout);
  
  // Default groupBy: 'none' for card mode, 'page' for others
  const defaultGroupBy: NodeCollectionGroupBy = viewMode === 'card' ? 'none' : 'page';
  
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

  // Resolve groupByProperty when groupBy is a property UUID
  const { data: allProperties = [] } = useProperties();
  const groupByProperty = useMemo(() => {
    if (!groupBy || groupBy === 'none' || groupBy === 'page') return undefined;
    return allProperties.find(p => p.uuid === groupBy);
  }, [groupBy, allProperties]);
  
  // Property column selection state (for table view)
  // Use controlled props if provided, otherwise manage internally
  // Default to Created and Modified columns (matches default table columns)
  const [internalPropertyUuids, setInternalPropertyUuids] = useState<string[]>([]);
  const selectedPropertyUuids = selectedPropertyUuidsProp ?? internalPropertyUuids;

  // Gantt date property state (controlled or uncontrolled)
  // In uncontrolled mode: drive from the persisted store UUIDs
  const storeGanttStartUuid = useAppStore(state => state.ganttStartDatePropertyUuid);
  const storeGanttEndUuid = useAppStore(state => state.ganttEndDatePropertyUuid);
  const setStoreGanttStartUuid = useAppStore(state => state.setGanttStartDatePropertyUuid);
  const setStoreGanttEndUuid = useAppStore(state => state.setGanttEndDatePropertyUuid);
  const ganttTimeScale = useAppStore(state => state.ganttTimeScale);
  const setGanttTimeScale = useAppStore(state => state.setGanttTimeScale);

  // Resolve UUIDs → Property objects (works once allProperties is loaded)
  const storeGanttStartProperty = useMemo(
    () => allProperties.find(p => p.uuid === storeGanttStartUuid),
    [allProperties, storeGanttStartUuid]
  );
  const storeGanttEndProperty = useMemo(
    () => allProperties.find(p => p.uuid === storeGanttEndUuid),
    [allProperties, storeGanttEndUuid]
  );

  const ganttStartDateProperty = onGanttStartDatePropertyChange
    ? ganttStartDatePropertyProp
    : (ganttStartDatePropertyProp ?? storeGanttStartProperty);
  const ganttEndDateProperty = onGanttEndDatePropertyChange
    ? ganttEndDatePropertyProp
    : (ganttEndDatePropertyProp ?? storeGanttEndProperty);
  const handleGanttStartDatePropertyChange = (property: Property | undefined) => {
    if (onGanttStartDatePropertyChange) {
      onGanttStartDatePropertyChange(property);
    } else {
      setStoreGanttStartUuid(property?.uuid ?? '');
    }
  };
  const handleGanttEndDatePropertyChange = (property: Property | undefined) => {
    if (onGanttEndDatePropertyChange) {
      onGanttEndDatePropertyChange(property);
    } else {
      setStoreGanttEndUuid(property?.uuid ?? '');
    }
  };
  const updateNodeView = useUpdateNodeView();
  
  // Load property columns from view configuration (only for uncontrolled mode)
  useEffect(() => {
    if (!selectedPropertyUuidsProp && view?.shown_properties) {
      // Sort by sequence and extract UUIDs
      const sortedProperties = [...view.shown_properties]
        .sort((a, b) => a.sequence - b.sequence)
        .map(p => p.uuid);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Sync internal state with view properties on view change
      setInternalPropertyUuids(sortedProperties);
    }
  }, [view, selectedPropertyUuidsProp]);
  
  const handlePropertyColumnsChange = (propertyUuids: string[]) => {
    // If controlled, call the callback
    if (onPropertyColumnsChange) {
      onPropertyColumnsChange(propertyUuids);
      return;
    }
    
    // Otherwise, update internal state and persist
    setInternalPropertyUuids(propertyUuids);
    
    // Save to view configuration via API
    if (viewId) {
      const shown_properties = propertyUuids.map((uuid, index) => ({
        uuid,
        sequence: index + 1,
      }));
      
      updateNodeView.mutate({
        viewId,
        data: { shown_properties },
      });
    }
  };
  
  // Determine which view modes are available
  const effectiveViewModes = availableViewModes ?? DEFAULT_VIEW_MODES_ORDER;
  const showViewSwitcher = effectiveViewModes.length > 1 && onViewModeChange;
  const showGroupByInToolbar = showGroupByProp && (viewMode === 'list' || viewMode === 'card' || viewMode === 'gantt');
  const effectiveShowAdd = showAddButton && onAdd && can_create;
  
  // Whether to show the internal toolbar (show if we have leftElement OR toolbar controls)
  const showInternalToolbar = !hideToolbar && (leftElement || showGroupByInToolbar || showViewSwitcher || effectiveShowAdd || viewMode === 'gantt');
  
  // Enable grouping for list view when groupBy is not 'none'
  const enableGrouping = showGroupByProp && viewMode === 'list' && groupBy !== 'none';

  // Create context value
  const contextValue = useMemo<NodeCollectionContextValue>(() => ({
    editable,
    onNodeClick,
    onNodeShiftClick,
    onContentChange,
    depth: 0,
    maxDepth,
  }), [editable, onNodeClick, onNodeShiftClick, onContentChange, maxDepth]);

  // Common props for all view components
  const viewProps = {
    nodes,
    editable,
    onNodeClick,
    onNodeShiftClick,
    onContentChange,
    renderNode,
    maxDepth,
    className: '',
    isolatedBlockState,
    suppressRootColor,
    customContextMenu,
    customContextMenuItems,
    autoCollapse,
  };

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
    
    switch (viewMode) {
      case 'list':
        return (
          <ListView 
            nodes={nodes}
            editable={editable}
            pagesOnly={pagesOnly}
            sortable={sortable}
            onReorder={onReorder}
            renderItemAction={renderItemAction}
            onNodeClick={onNodeClick}
            onNodeShiftClick={onNodeShiftClick}
            onContentChange={onContentChange}
            pageId={pageId}
            pageUuid={pageUuid}
            className={viewProps.className}
            groupBy={groupBy}
            groupByProperty={groupByProperty}
            enableGrouping={enableGrouping}
            showBreadcrumbs={showBreadcrumbs}
            onAddClass={onAddClass}
            onSlashCommand={onSlashCommand}
            onPasteImage={onPasteImage}
            onEnterAtRoot={onEnterAtRoot}
            hideProperties={hideProperties}
          />
        );
      
      case 'document':
        return (
          <DocumentView
            nodes={nodes}
            editable={editable}
            maxDepth={maxDepth}
            onNodeClick={onNodeClick}
            onNodeShiftClick={onNodeShiftClick}
            onContentChange={onContentChange}
            pageId={pageId}
            pageUuid={pageUuid}
            className={viewProps.className}
            onAddClass={onAddClass}
            onSlashCommand={onSlashCommand}
            onPasteImage={onPasteImage}
          />
        );
      
      case 'card':
        return (
          <CardView 
            nodes={nodes}
            editable={editable}
            layout={effectiveCardLayout}
            sortable={sortable}
            onReorder={onReorder}
            onNodeClick={onNodeClick}
            onNodeShiftClick={onNodeShiftClick}
            onContentChange={onContentChange}
            onAdd={onAdd}
            customContextMenu={customContextMenu}
            className={viewProps.className}
            groupBy={groupBy}
            groupByProperty={groupByProperty}
            onAddClass={onAddClass}
            onSlashCommand={onSlashCommand}
            onPasteImage={onPasteImage}
          />
        );
      
      case 'table':
        return (
          <TableView 
            nodes={nodes}
            editable={editable}
            columns={tableColumns}
            propertyUuids={selectedPropertyUuids}
            sortable={sortable}
            onReorder={onReorder}
            onNodeClick={onNodeClick}
            onNodeShiftClick={onNodeShiftClick}
            onContentChange={onContentChange}
            customContextMenu={customContextMenu}
            className={viewProps.className}
            onAddClass={onAddClass}
            onSlashCommand={onSlashCommand}
            onPasteImage={onPasteImage}
          />
        );
      
      case 'gantt': {
        // Pre-filter to only nodes that have the start date property set,
        // so the view shows no "load more" noise and GanttView fetches fewer day-nodes.
        const ganttNodes = ganttStartDateProperty
          ? nodes.filter(n => {
              const val = (n.properties as Record<number, unknown> | undefined)?.[ganttStartDateProperty.id];
              return val != null;
            })
          : nodes;
        return (
          <GanttView
            {...viewProps}
            nodes={ganttNodes}
            startDateProperty={ganttStartDateProperty}
            endDateProperty={ganttEndDateProperty}
            timeScale={ganttTimeScale}
            groupBy={groupBy}
            groupByProperty={groupByProperty}
          />
        );
      }
      
      case 'timeline':
        return <TimelineView nodes={nodes} />;
      
      case 'graph': {
        // Graph only shows pages - convert Node to API GraphNode format
        const graphNodes = nodes
          .filter(n => n.is_page)
          .map(n => ({
            id: n.id,
            uuid: n.uuid || '',
            name: n.name || 'Untitled',
            type: 'page' as const,
            tags: [],
            class_ids: [],
            properties: {},
            is_daily: n.is_daily || false,
          }));
        // Include active node if provided and not already in the list
        if (activeNode && !graphNodes.some(n => n.id === activeNode.id)) {
          graphNodes.unshift({
            id: activeNode.id,
            uuid: activeNode.uuid,
            name: activeNode.name || 'Untitled',
            type: 'page' as const,
            tags: [],
            class_ids: [],
            properties: {},
            is_daily: false,
          });
        }
        const graphContent = <GraphView nodes={graphNodes} currentNodeId={activeNode?.id ?? null} className="node-collection__graph" />;
        return containerCard ? <Card variant="default" padding paddingSize="sm" radius="md">{graphContent}</Card> : graphContent;
      }
      
      case 'terrain': {
        // Terrain mode - similar to graph but uses contour visualization
        const terrainNodes = nodes
          .filter(n => n.is_page)
          .map(n => ({
            id: n.id,
            uuid: n.uuid || '',
            name: n.name || 'Untitled',
            type: 'page' as const,
            tags: [],
            class_ids: [],
            properties: {},
            is_daily: n.is_daily || false,
          }));
        // Include active node if provided and not already in the list
        if (activeNode && !terrainNodes.some(n => n.id === activeNode.id)) {
          terrainNodes.unshift({
            id: activeNode.id,
            uuid: activeNode.uuid,
            name: activeNode.name || 'Untitled',
            type: 'page' as const,
            tags: [],
            class_ids: [],
            properties: {},
            is_daily: false,
          });
        }
        const terrainContent = <TerrainView nodes={terrainNodes} currentNodeId={activeNode?.id ?? null} className="node-collection__terrain" />;
        return containerCard ? <Card variant="default" padding paddingSize="sm" radius="md">{terrainContent}</Card> : terrainContent;
      }
      
      default:
        // Fallback to list view
        return (
          <ListView 
            nodes={nodes}
            editable={editable}
            pagesOnly={pagesOnly}
            onNodeClick={onNodeClick}
            onContentChange={onContentChange}
            onAddClass={onAddClass}
          />
        );
    }
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
                ganttStartDateProperty={ganttStartDateProperty}
                ganttEndDateProperty={ganttEndDateProperty}
                onGanttStartDatePropertyChange={handleGanttStartDatePropertyChange}
                onGanttEndDatePropertyChange={handleGanttEndDatePropertyChange}
                ganttTimeScale={ganttTimeScale}
                onGanttTimeScaleChange={setGanttTimeScale}
                toolbarPrefix={toolbarPrefix}
                leftElement={typeof leftElement === 'function' ? leftElement(nodes.length) : leftElement}
                hideToolbarControls={hideToolbarControls}
              />
            </div>
          )}
          
          {/* Before Content Element (e.g., property references) */}
          {!hideContent && beforeContent}
          
          {/* Content */}
          {!hideContent && (
            <div className="node-collection__content">
              {renderViewMode()}
            </div>
          )}
        </div>
    </NodeCollectionContext.Provider>
  );
}

// ==================== View Mode Helpers ====================

/**
 * Get available view modes with icons and labels
 */
export function getViewModeOptions(): { mode: NodeCollectionViewMode; icon: string; label: string }[] {
  return Object.entries(VIEW_MODE_OPTIONS).map(([mode, { icon, label }]) => ({
    mode: mode as NodeCollectionViewMode,
    icon,
    label,
  }));
}

// Re-export types and toolbar
export type { NodeCollectionProps, NodeCollectionViewMode } from '@/types/nodeCollection';
