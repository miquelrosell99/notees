/**
 * NodeCollectionToolbar Component
 * 
 * Extracted toolbar from NodeCollection that can be rendered separately.
 * Used to place view mode switcher and group-by controls in NodeViewSection headers.
 * 
 * Usage:
 * - Inside NodeCollection: Rendered automatically unless hideToolbar is true
 * - In NodeViewSection: Pass as headerActions to move buttons to section header
 */
import { useMemo } from 'react';
import { useNodesStore } from '@/stores';
import type { CardSizeMode } from '@/stores/nodesStore';
import { 
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
} from '@mdi/js';
import type { NodeCollectionViewMode, NodeCollectionGroupBy } from '@/types/nodeCollection';
import { DEFAULT_VIEW_MODES_ORDER, VIEW_MODE_ICONS, VIEW_MODE_LABELS } from '@/types/viewModes';
import { GROUP_BY_OPTIONS } from '@/types/nodeCollection';
import { SelectionButton, type SelectionButtonOption } from '../core/SelectionButton';
import { ButtonWithPanel } from '../core/ButtonWithPanel';
import { Button } from '../core/Button';
import { PropertyColumnSelector } from '../properties/PropertyColumnSelector';
import './NodeCollectionToolbar.css';

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
  /** Additional CSS class */
  className?: string;
}

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

  // Don't render if nothing to show
  if (!showViewSwitcher && !showGroupByButton && !showAdd && !showPropertyColumnSelector) {
    return null;
  }

  return (
    <div className={`node-collection-toolbar ${className}`}>
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
    </div>
  );
}

export default NodeCollectionToolbar;
