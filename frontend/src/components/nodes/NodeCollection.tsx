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
import type { CardSizeMode } from '@/stores/nodesStore';
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
import { DEFAULT_VIEW_MODES_ORDER, VIEW_MODE_ICONS, VIEW_MODE_LABELS } from '@/types/viewModes';
import { GROUP_BY_OPTIONS } from '@/types/nodeCollection';
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
import { SelectionButton, type SelectionButtonOption } from '../core/SelectionButton';
import { ButtonWithPanel } from '../core/ButtonWithPanel';
import { Button } from '../core/Button';
import { PropertyColumnSelector } from '../properties/PropertyColumnSelector';
import './NodeCollectionToolbar.css';
import './NodeCollection.css';

// ==================== Toolbar Constants ====================

// Card layout mode icon mappings
const CARD_LAYOUT_ICONS: Record<string, string> = {
  'no-cover': mdiCardOutline,
  'cover-left': mdiDockLeft,
  'cover-right': mdiDockRight,
  'cover-top': mdiDockTop,
};

// Card layout mode labels
const CARD_LAYOUT_LABELS: Record<string, string> = {
  'no-cover': 'No cover',
  'cover-left': 'Cover left',
  'cover-right': 'Cover right',
  'cover-top': 'Cover top',
};

// ==================== Toolbar Props Interface ====================

export interface NodeCollectionToolbarProps {
  /** Current view mode */
  viewMode: NodeCollectionViewMode;
  /** Available view modes */
  availableViewModes?: NodeCollectionViewMode[];
  /** Callback when view mode changes */
  onViewModeChange?: (mode: NodeCollectionViewMode) => void;
  /** Whether to show group by selector */
  showGroupBy?: boolean;
  /** Current group by value */
  groupBy?: NodeCollectionGroupBy;
  /** Callback when group by changes */
  onGroupByChange?: (value: NodeCollectionGroupBy) => void;
  /** Whether to show add button */
  showAddButton?: boolean;
  /** Callback when add button is clicked */
  onAdd?: () => void;
  /** Current card layout mode */
  cardLayout?: string;
  /** Callback when card layout changes */
  onCardLayoutChange?: (layout: string) => void;
  /** Selected property UUIDs for table columns */
  selectedPropertyUuids?: string[];
  /** Callback when property column selection changes */
  onPropertyColumnsChange?: (propertyUuids: string[]) => void;
  /** Callback when reset views button is clicked */
  onResetViews?: () => void;
  /** Custom content to render at the start of the toolbar (after leftElement) */
  toolbarPrefix?: React.ReactNode;
  /** Element to render at the very left of the toolbar (e.g., block element, collapsible header) */
  leftElement?: React.ReactNode;
  /** Hide toolbar controls while keeping leftElement visible */
  hideToolbarControls?: boolean;
  /** Additional CSS class */
  className?: string;
}

// ==================== Toolbar Component ====================

/**
 * NodeCollectionToolbar - Standalone toolbar for NodeCollection controls
 * 
 * Can be rendered inside NodeCollection or externally (e.g., in NodeViewSection header)
 */
export function NodeCollectionToolbar({
  viewMode,
  availableViewModes = DEFAULT_VIEW_MODES_ORDER,
  onViewModeChange,
  showGroupBy = false,
  groupBy = 'page',
  onGroupByChange,
  showAddButton = false,
  onAdd,
  cardLayout,
  onCardLayoutChange,
  selectedPropertyUuids = [],
  onPropertyColumnsChange,
  onResetViews,
  toolbarPrefix,
  leftElement,
  hideToolbarControls = false,
  className = '',
}: NodeCollectionToolbarProps) {
  // Use store for card layout if not controlled
  const storeCardLayout = useNodesStore(state => state.cardLayout);
  const storeSetCardLayout = useNodesStore(state => state.setCardLayout);
  const storeCardSize = useNodesStore(state => state.cardSize);
  const storeSetCardSize = useNodesStore(state => state.setCardSize);
  
  const effectiveCardLayout = cardLayout ?? storeCardLayout;
  const effectiveOnCardLayoutChange = onCardLayoutChange ?? ((layout: string) => {
    storeSetCardLayout(layout as 'no-cover' | 'cover-top' | 'cover-left' | 'cover-right');
  });
  
  const showViewSwitcher = availableViewModes.length > 1 && onViewModeChange;
  const showGroupByButton = showGroupBy && viewMode === 'list';
  const showAdd = showAddButton && onAdd;
  const showCardLayoutSelector = viewMode === 'card';
  const showCardSizeSelector = viewMode === 'card';
  // Show property column selector in table view when callback is provided
  const showPropertyColumnSelector = viewMode === 'table' && onPropertyColumnsChange;
  
  // Determine if using horizontal layout
  const isHorizontalLayout = effectiveCardLayout === 'cover-left' || effectiveCardLayout === 'cover-right';
  
  // SelectionButton options based on layout type
  const cardSizeOptions = useMemo<SelectionButtonOption[]>(() => {
    const allOptions = [
      { value: '1', icon: mdiNumeric1, label: '1 column' },
      { value: '2', icon: mdiNumeric2, label: '2 columns' },
      { value: '3', icon: mdiNumeric3, label: '3 columns' },
      { value: '4', icon: mdiNumeric4, label: '4 columns' },
      { value: '5', icon: mdiNumeric5, label: '5 columns' },
    ];
    
    return isHorizontalLayout ? allOptions.slice(0, 2) : allOptions;
  }, [isHorizontalLayout]);
  
  // Clamp card size for horizontal layouts
  const effectiveCardSize = isHorizontalLayout && storeCardSize > 2 ? 2 : storeCardSize;
  
  // Build SelectionButton options from available view modes
  const viewModeOptions = useMemo<SelectionButtonOption[]>(() => 
    availableViewModes.map(mode => ({
      value: mode,
      icon: VIEW_MODE_ICONS[mode],
      label: VIEW_MODE_LABELS[mode],
    })),
    [availableViewModes]
  );

  // Build SelectionButton options for card layouts
  const cardLayoutOptions = useMemo<SelectionButtonOption[]>(() => 
    ['no-cover', 'cover-left', 'cover-right', 'cover-top'].map(layout => ({
      value: layout,
      icon: CARD_LAYOUT_ICONS[layout],
      label: CARD_LAYOUT_LABELS[layout],
    })),
    []
  );

  // Check if we have any toolbar content (excluding leftElement)
  const hasToolbarContent = !hideToolbarControls && (showViewSwitcher || showGroupByButton || showAdd || showPropertyColumnSelector || toolbarPrefix);

  // Don't render if nothing to show
  if (!leftElement && !hasToolbarContent) {
    return null;
  }

  return (
    <div className={`node-collection-toolbar ${className}`}>
      {/* Left section - always visible when leftElement exists */}
      {leftElement && (
        <div className="node-collection-toolbar__left">
          {leftElement}
        </div>
      )}
      
      {/* Right section - toolbar controls */}
      {hasToolbarContent && (
        <div className="node-collection-toolbar__right">
          {/* Custom prefix content */}
          {toolbarPrefix}
          
          {/* Add Button */}
          {showAdd && (
            <Button
              icon={mdiPlus}
              variant="ghost"
              size="sm"
              onClick={onAdd}
              title="Add"
              className="node-collection-toolbar__add"
            />
          )}
          
          {/* Property Column Selector - only shown in table view */}
          {showPropertyColumnSelector && (
        <ButtonWithPanel
          icon={mdiTableColumn}
          variant="ghost"
          size="sm"
          panelPosition="bottom"
          panelAlignment="start"
          panelWidth={350}
          className="node-collection-toolbar__property-columns"
          tooltip="Select columns"
        >
          {(closePanel) => (
            <PropertyColumnSelector
              selectedPropertyUuids={selectedPropertyUuids}
              onSelectionChange={onPropertyColumnsChange!}
              onClose={closePanel}
            />
          )}
        </ButtonWithPanel>
      )}
      
      {/* GroupBy selector - only shown in list view */}
      {showGroupByButton && onGroupByChange && (
        <ButtonWithPanel
          icon={mdiGroup}
          variant="ghost"
          size="sm"
          panelPosition="bottom"
          panelAlignment="start"
          panelWidth={160}
          className="node-collection-toolbar__group-by"
          tooltip="Group by"
        >
          {(closePanel) => (
            <div className="node-collection-toolbar__group-by-options">
              {GROUP_BY_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  className={`node-collection-toolbar__group-by-option ${
                    groupBy === option.value ? 'node-collection-toolbar__group-by-option--active' : ''
                  }`}
                  onClick={() => {
                    onGroupByChange(option.value);
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
      
      {/* Card Layout Selector - only shown in card view */}
      {showCardLayoutSelector && (
        <SelectionButton
          options={cardLayoutOptions}
          value={effectiveCardLayout}
          onChange={(val) => effectiveOnCardLayoutChange(val)}
          size="sm"
          className="node-collection-toolbar__card-layout-selector"
        />
      )}
      
      {/* Card Size Selector - only shown in card view */}
      {showCardSizeSelector && (
        <SelectionButton
          options={cardSizeOptions}
          value={effectiveCardSize.toString()}
          onChange={(val) => storeSetCardSize(parseInt(val) as CardSizeMode)}
          size="sm"
          className="node-collection-toolbar__card-size-selector"
        />
      )}
      
      {/* View Mode Switcher */}
      {showViewSwitcher && (
        <SelectionButton
          options={viewModeOptions}
          value={viewMode}
          onChange={(val) => onViewModeChange?.(val as NodeCollectionViewMode)}
          size="sm"
          className="node-collection-toolbar__view-switcher"
        />
      )}
      
      {/* Reset Views Button */}
      {onResetViews && (
        <Button
          icon={mdiRestore}
          iconOnly
          variant="ghost"
          size="sm"
          onClick={onResetViews}
          title="Reset all views to defaults"
          className="node-collection-toolbar__reset-views"
        />
      )}
        </div>
      )}
    </div>
  );
}

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
  showClasses = false,
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
          <NodeListView 
            {...viewProps} 
            showBullets={true} 
            showIndentation={true}
            showClasses={showClasses}
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
            onAdd={can_create ? onAdd : undefined}
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
            customContextMenu={customContextMenu}
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
        return <NodeListView {...viewProps} showBullets={true} showIndentation={true} showClasses={showClasses} pagesOnly={pagesOnly} />;
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
