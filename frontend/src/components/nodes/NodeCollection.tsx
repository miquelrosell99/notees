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
import type { CardSizeMode } from '@/stores/appStore';
import { useUpdateNodeView } from '@/hooks/useNodeViews';
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
  mdiNumeric1,
  mdiNumeric2,
  mdiNumeric3,
  mdiNumeric4,
  mdiNumeric5,
  mdiTableColumn,
  mdiRestore,
} from '@mdi/js';
import type { 
  NodeCollectionProps, 
  NodeCollectionViewMode, 
  NodeCollectionContextValue,
  NodeCollectionGroupBy 
} from '@/types/nodeCollection';
import { DEFAULT_VIEW_MODES_ORDER, VIEW_MODE_ICONS, VIEW_MODE_LABELS } from '@/constants/viewModes';
import { GROUP_BY_OPTIONS } from '@/types/nodeCollection';
import { 
  ListView, 
  DocumentView, 
  CardView, 
  TableView, 
  GanttView,
  GraphView,
  TimelineView,
} from './views';
import { NodeCollectionToolbar } from './NodeCollectionToolbar';
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
  hideToolbar = false,
  toolbarPrefix,
  leftElement,
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
  pageId,
  pageUuid,
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
  
  // Property column selection state (for table view)
  // Use controlled props if provided, otherwise manage internally
  // Default to Created and Modified columns (matches default table columns)
  const [internalPropertyUuids, setInternalPropertyUuids] = useState<string[]>([]);
  const selectedPropertyUuids = selectedPropertyUuidsProp ?? internalPropertyUuids;
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
  const showGroupByInToolbar = showGroupByProp && viewMode === 'list';
  const effectiveShowAdd = showAddButton && onAdd && can_create;
  
  // Whether to show the internal toolbar (show if we have leftElement OR toolbar controls)
  const showInternalToolbar = !hideToolbar && (leftElement || showGroupByInToolbar || showViewSwitcher || effectiveShowAdd);
  
  // Enable grouping when groupBy is set (regardless of toolbar visibility)
  const enableGrouping = showGroupByProp && viewMode === 'list';

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
            onContentChange={onContentChange}
            pageId={pageId}
            pageUuid={pageUuid}
            className={viewProps.className}
            groupBy={groupBy}
            enableGrouping={enableGrouping}
          />
        );
      
      case 'document':
        return (
          <DocumentView
            nodes={nodes}
            editable={editable}
            maxDepth={maxDepth}
            onNodeClick={onNodeClick}
            onContentChange={onContentChange}
            pageId={pageId}
            pageUuid={pageUuid}
            className={viewProps.className}
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
          />
        );
      
      case 'gantt':
        return <GanttView {...viewProps} />;
      
      case 'timeline':
        return <TimelineView nodes={nodes} />;
      
      case 'graph':
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
        return <GraphView nodes={graphNodes} className="node-collection__graph" />;
      
      default:
        // Fallback to list view
        return (
          <ListView 
            nodes={nodes}
            editable={editable}
            pagesOnly={pagesOnly}
            onNodeClick={onNodeClick}
            onContentChange={onContentChange}
          />
        );
    }
  };

  return (
    <NodeCollectionContext.Provider value={contextValue}>
      <div className={`node-collection node-collection--${viewMode} ${isEmpty ? 'node-collection--empty' : ''} ${className}`}>
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
                toolbarPrefix={toolbarPrefix}
                leftElement={typeof leftElement === 'function' ? leftElement(nodes.length) : leftElement}
                hideToolbarControls={hideToolbarControls}
              />
            </div>
          )}
          
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
