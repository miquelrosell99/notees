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
 * ├─ NodeCardGrid (card)
 * │   └─ NodeCard
 * │       └─ recursive children → Block / BlockPreview
 * ├─ NodeTableView (table)
 * │   └─ rows → Block / BlockPreview
 * ├─ NodeGanttView (gantt)
 * │   └─ timeline nodes → Block / BlockPreview
 * └─ NodeGraphView (graph)
 *     └─ GraphRenderer → nodes only with is_page = true
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { 
  mdiFormatListBulleted, 
  mdiFileDocumentOutline, 
  mdiViewGrid, 
  mdiTable, 
  mdiChartGantt, 
  mdiGraphOutline 
} from '@mdi/js';
import type { 
  NodeCollectionProps, 
  NodeCollectionViewMode, 
  NodeCollectionContextValue 
} from '@/types/nodeCollection';
import { 
  NodeListView, 
  NodeDocumentView, 
  NodeCardGrid, 
  NodeTableView, 
  NodeGanttView, 
} from './views';
import { NodeGraphViewSimple } from '@/components/graph';
import { SelectionButton, type SelectionButtonOption } from '../core/SelectionButton';
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
  groupBy: _groupBy = 'none', // Reserved for future grouping support
  pagesOnly = false,
  showEmpty = true,
  emptyMessage = 'No items',
  maxDepth = Infinity,
  tableColumns,
  provideBlockCallbacks = false,
  blockCallbacks,
}: NodeCollectionProps) {
  // Determine which view modes are available
  const effectiveViewModes = availableViewModes ?? ['list', 'document', 'card', 'table', 'gantt', 'graph'];
  const showViewSwitcher = effectiveViewModes.length > 1 && onViewModeChange;
  
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
          />
        );
      
      case 'document':
        return <NodeDocumentView {...viewProps} />;
      
      case 'card':
        return (
          <NodeCardGrid 
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
          {/* View Mode Switcher - only shown when multiple modes available */}
          {showViewSwitcher && (
            <div className="node-collection__header">
              <SelectionButton
                options={viewModeOptions}
                value={viewMode}
                onChange={(val) => onViewModeChange?.(val as NodeCollectionViewMode)}
                size="sm"
                className="node-collection__view-switcher"
              />
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
