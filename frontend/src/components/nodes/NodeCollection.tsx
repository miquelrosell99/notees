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
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { 
  mdiFormatListBulleted, 
  mdiFileDocumentOutline, 
  mdiViewGrid, 
  mdiTable, 
  mdiChartGantt, 
  mdiGraphOutline,
  mdiGroup 
} from '@mdi/js';
import type { 
  NodeCollectionProps, 
  NodeCollectionViewMode, 
  NodeCollectionContextValue,
  NodeCollectionGroupBy 
} from '@/types/nodeCollection';
import { GROUP_BY_OPTIONS } from '@/types/nodeCollection';
import { 
  NodeListView, 
  NodeDocumentView, 
  NodeCardView, 
  NodeTableView, 
  NodeGanttView, 
} from './views';
import { NodeGraphViewSimple } from '@/components/graph';
import { SelectionButton, type SelectionButtonOption } from '../core/SelectionButton';
import { ButtonWithPanel } from '../core/ButtonWithPanel';
import { BlockCallbacksProvider, type BlockCallbacks } from '../blocks/BlockCallbacksContext';
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
};

// ==================== Component ====================

/**
 * NodeCollection - Universal node collection component
 * 
 * Dispatches to view-specific components based on viewMode prop.
 * Includes built-in view mode switcher (hidden when only one mode available).
 */
export function NodeCollection({
  nodes,
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
  showEmpty = true,
  emptyMessage = 'No items',
  maxDepth = Infinity,
  tableColumns,
  provideBlockCallbacks = false,
  blockCallbacks,
  pageMap,
}: NodeCollectionProps) {
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
  
  // Determine which view modes are available
  const effectiveViewModes = availableViewModes ?? ['list', 'document', 'card', 'table', 'gantt', 'graph'];
  const showViewSwitcher = effectiveViewModes.length > 1 && onViewModeChange;
  const showGroupBy = showGroupByProp && viewMode === 'list';
  
  // Build SelectionButton options from available view modes
  const viewModeOptions = useMemo<SelectionButtonOption[]>(() => 
    effectiveViewModes.map(mode => ({
      value: mode,
      icon: VIEW_MODE_OPTIONS[mode].icon,
      label: VIEW_MODE_OPTIONS[mode].label,
    })),
    [effectiveViewModes]
  );

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
            pagesOnly={pagesOnly}
            sortable={sortable}
            onReorder={onReorder}
            renderItemAction={renderItemAction}
            groupBy={groupBy}
            pageMap={pageMap}
            enableGrouping={showGroupByProp}
          />
        );
      
      case 'document':
        return <NodeDocumentView {...viewProps} />;
      
      case 'card':
        return (
          <NodeCardView 
            {...viewProps} 
            sortable={sortable}
            onReorder={onReorder}
          />
        );
      
      case 'table':
        return (
          <NodeTableView 
            {...viewProps} 
            columns={tableColumns}
            sortable={sortable}
            onReorder={onReorder}
          />
        );
      
      case 'gantt':
        return <NodeGanttView {...viewProps} />;
      
      case 'graph':
        // Graph only shows pages - convert Node to GraphNode format
        const graphNodes = nodes
          .filter(n => n.is_page)
          .map(n => ({
            id: n.id,
            title: n.name || 'Untitled',
            type: 'page' as const,
            tags: [],
            types: [],
            properties: {},
            is_daily: n.is_daily || false,
          }));
        return <NodeGraphViewSimple nodes={graphNodes} links={[]} className="node-collection__graph" />;
      
      default:
        // Fallback to list view
        return <NodeListView {...viewProps} showBullets={true} showIndentation={true} pagesOnly={pagesOnly} />;
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
          {/* Header with GroupBy and View Mode Switcher */}
          {(showGroupBy || showViewSwitcher) && (
            <div className="node-collection__header">
              {/* GroupBy selector - only shown in list view */}
              {showGroupBy && (
                <ButtonWithPanel
                  icon={mdiGroup}
                  variant="ghost"
                  size="sm"
                  panelPosition="bottom"
                  panelAlignment="start"
                  panelWidth={160}
                  className="node-collection__group-by"
                  tooltip="Group by"
                >
                  {(closePanel) => (
                    <div className="node-collection__group-by-options">
                      {GROUP_BY_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          className={`node-collection__group-by-option ${
                            groupBy === option.value ? 'node-collection__group-by-option--active' : ''
                          }`}
                          onClick={() => {
                            handleGroupByChange(option.value);
                            closePanel();
                          }}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  )}
                </ButtonWithPanel>
              )}
              
              {/* View Mode Switcher */}
              {showViewSwitcher && (
                <SelectionButton
                  options={viewModeOptions}
                  value={viewMode}
                  onChange={(val) => onViewModeChange?.(val as NodeCollectionViewMode)}
                  size="sm"
                  className="node-collection__view-switcher"
                />
              )}
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

// Re-export types
export type { NodeCollectionProps, NodeCollectionViewMode } from '@/types/nodeCollection';
