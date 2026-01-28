/**
 * NodeCollection Component
 * 
 * Universal component for displaying collections of nodes.
 * Dispatches to the correct view component based on viewMode.
 * 
 * Features:
 * - Multiple view modes: list, document, card, table, gantt, graph
 * - Built-in view mode switcher (hidden when only one mode available)
 * - Editable toggle (Block vs BlockPreview)
 * - Recursive children handling
 * - Consistent prop propagation to all view modes
 * - Optional block callbacks via context (provideBlockCallbacks)
 * 
 * Component Hierarchy:
 * NodeCollection
 * ├─ ViewModeSwitcher (SelectionButton)
 * ├─ BlockCallbacksProvider (optional, when provideBlockCallbacks=true)
 * ├─ NodeListView (list)
 * │   └─ recursive nodes → Block / BlockPreview
 * ├─ NodeDocumentView (document)
 * │   └─ recursive nodes → Block / BlockPreview
 * ├─ NodeCardView (card)
 * │   └─ NodeCard
 * │       └─ recursive children → Block / BlockPreview
 * ├─ NodeTableView (table)
 * │   └─ rows → Block / BlockPreview
 * ├─ NodeGanttView (gantt)
 * │   └─ timeline nodes → Block / BlockPreview
 * └─ NodeGraphView (graph)
 *     └─ GraphRenderer → nodes only with is_page = true
 */
import { createContext, useContext, useMemo, useState, useEffect, type ReactNode } from 'react';
import { useNodesStore } from '@/stores';
import { useUpdateNodeView } from '@/hooks/useNodeViews';
import { 
  mdiFormatListBulleted, 
  mdiFileDocumentOutline, 
  mdiViewGrid, 
  mdiTable, 
  mdiChartGantt, 
  mdiGraphOutline,
  mdiTimelineClockOutline,
} from '@mdi/js';
import type { 
  NodeCollectionProps, 
  NodeCollectionViewMode, 
  NodeCollectionContextValue,
  NodeCollectionGroupBy 
} from '@/types/nodeCollection';
import { DEFAULT_VIEW_MODES_ORDER } from '@/types/viewModes';
import { 
  NodeListView, 
  NodeDocumentView, 
  NodeCardView, 
  NodeTableView, 
  NodeGanttView,
} from './views';
import { NodeGraphViewSimple } from '@/components/graph';
import { NodeTimelineRenderer } from '@/components/timeline';
import { BlockCallbacksProvider, type BlockCallbacks } from '../blocks/BlockCallbacksContext';
import { NodeCollectionToolbar } from './NodeCollectionToolbar';
import './NodeCollectionToolbar.css';
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
  groupBy: groupByProp = 'page',
  onGroupByChange,
  showGroupBy: showGroupByProp = false,
  pagesOnly = false,
  showTypes = false,
  showEmpty = true,
  emptyMessage = 'No items',
  maxDepth = Infinity,
  tableColumns,
  provideBlockCallbacks = false,
  blockCallbacks,
  pageMap,
  isolatedBlockState = false,
  suppressRootColor = false,
  hideToolbar = false,
  showAddButton = false,
  onAdd,
  cardLayout,
  onCardLayoutChange,
  selectedPropertyUuids: selectedPropertyUuidsProp,
  onPropertyColumnsChange,
}: NodeCollectionProps) {
  // Always use store for card layout to ensure reactivity
  // Components can still pass cardLayout to override if needed for specific cases
  const storeCardLayout = useNodesStore(state => state.cardLayout);
  const rawCardLayout = cardLayout ?? storeCardLayout;
  // Filter out invalid 'cover-bottom' from old persisted state
  const effectiveCardLayout: 'no-cover' | 'cover-top' | 'cover-left' | 'cover-right' = 
    (rawCardLayout === 'cover-bottom' ? 'no-cover' : rawCardLayout);
  
  // Internal groupBy state (controlled or uncontrolled)
  const [internalGroupBy, setInternalGroupBy] = useState<NodeCollectionGroupBy>(groupByProp);
  const groupBy = onGroupByChange ? groupByProp : internalGroupBy;
  const handleGroupByChange = (value: NodeCollectionGroupBy) => {
    if (onGroupByChange) {
      onGroupByChange(value);
    } else {
      setInternalGroupBy(value);
    }
  };
  
  // Property column selection state (for table view)
  // Use controlled props if provided, otherwise manage internally
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
  const showAdd = showAddButton && onAdd;
  
  // Whether to show the internal toolbar
  const showInternalToolbar = !hideToolbar && (showGroupByInToolbar || showViewSwitcher || showAdd);
  
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
  };

  // Empty state
  if (nodes.length === 0 && showEmpty) {
    return (
      <div className={`node-collection node-collection--empty ${className}`}>
        <div className="node-collection__empty-message">{emptyMessage}</div>
      </div>
    );
  }

  // Render based on view mode
  const renderViewMode = () => {
    switch (viewMode) {
      case 'list':
        return (
          <NodeListView 
            {...viewProps} 
            showBullets={true} 
            showIndentation={true}
            showTypes={showTypes}
            pagesOnly={pagesOnly}
            sortable={sortable}
            onReorder={onReorder}
            renderItemAction={renderItemAction}
            groupBy={groupBy}
            pageMap={pageMap}
            enableGrouping={enableGrouping}
          />
        );
      
      case 'document':
        return <NodeDocumentView {...viewProps} />;
      
      case 'card':
        return (
          <NodeCardView 
            {...viewProps} 
            layout={effectiveCardLayout}
            sortable={sortable}
            onReorder={onReorder}
            onAdd={onAdd}
          />
        );
      
      case 'table':
        return (
          <NodeTableView 
            {...viewProps} 
            columns={tableColumns}
            sortable={sortable}
            onReorder={onReorder}
            propertyUuids={selectedPropertyUuids}
          />
        );
      
      case 'gantt':
        return <NodeGanttView {...viewProps} />;
      
      case 'timeline':
        return <NodeTimelineRenderer nodes={nodes} />;
      
      case 'graph':
        // Graph only shows pages - convert Node to GraphNode format
        const graphNodes = nodes
          .filter(n => n.is_page)
          .map(n => ({
            id: n.id,
            title: n.name || 'Untitled',
            type: 'page' as const,
            name: n.name || 'Untitled',
            tags: [],
            types: [],
            properties: {},
            is_daily: n.is_daily || false,
          }));
        return <NodeGraphViewSimple nodes={graphNodes} links={[]} className="node-collection__graph" />;
      
      default:
        // Fallback to list view
        return <NodeListView {...viewProps} showBullets={true} showIndentation={true} showTypes={showTypes} pagesOnly={pagesOnly} />;
    }
  };

  // Wrapper for optional BlockCallbacksProvider
  const wrapWithCallbacks = (content: ReactNode): ReactNode => {
    if (provideBlockCallbacks && blockCallbacks) {
      return (
        <BlockCallbacksProvider callbacks={blockCallbacks as BlockCallbacks}>
          {content}
        </BlockCallbacksProvider>
      );
    }
    return content;
  };

  return (
    <NodeCollectionContext.Provider value={contextValue}>
      {wrapWithCallbacks(
        <div className={`node-collection node-collection--${viewMode} ${className}`}>
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
                showAddButton={showAddButton}
                onAdd={onAdd}
                cardLayout={effectiveCardLayout}
                onCardLayoutChange={onCardLayoutChange}                selectedPropertyUuids={selectedPropertyUuids}
                onPropertyColumnsChange={handlePropertyColumnsChange}              />
            </div>
          )}
          
          {/* Content */}
          <div className="node-collection__content">
            {renderViewMode()}
          </div>
        </div>
      )}
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
export { NodeCollectionToolbar } from './NodeCollectionToolbar';
export type { NodeCollectionToolbarProps } from './NodeCollectionToolbar';
