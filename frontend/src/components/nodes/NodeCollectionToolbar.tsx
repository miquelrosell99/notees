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
import { 
  mdiGroup,
  mdiPlus,
  mdiCardOutline,
  mdiDockLeft,
  mdiDockRight,
  mdiDockTop,
  mdiDockBottom,
} from '@mdi/js';
import type { NodeCollectionViewMode, NodeCollectionGroupBy } from '@/types/nodeCollection';
import { DEFAULT_VIEW_MODES_ORDER, VIEW_MODE_ICONS, VIEW_MODE_LABELS } from '@/types/viewModes';
import { GROUP_BY_OPTIONS } from '@/types/nodeCollection';
import { SelectionButton, type SelectionButtonOption } from '../core/SelectionButton';
import { ButtonWithPanel } from '../core/ButtonWithPanel';
import { Button } from '../core/Button';
import { Slider } from '../core/Slider';
import './NodeCollectionToolbar.css';

// Card layout mode icon mappings
const CARD_LAYOUT_ICONS: Record<string, string> = {
  'no-cover': mdiCardOutline,
  'cover-left': mdiDockLeft,
  'cover-right': mdiDockRight,
  'cover-top': mdiDockTop,
  'cover-bottom': mdiDockBottom,
};

// Card layout mode labels
const CARD_LAYOUT_LABELS: Record<string, string> = {
  'no-cover': 'No cover',
  'cover-left': 'Cover left',
  'cover-right': 'Cover right',
  'cover-top': 'Cover top',
  'cover-bottom': 'Cover bottom',
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
  className = '',
}: NodeCollectionToolbarProps) {
  // Use store for card layout if not controlled
  const storeCardLayout = useNodesStore(state => state.cardLayout);
  const storeSetCardLayout = useNodesStore(state => state.setCardLayout);
  const storeCardSize = useNodesStore(state => state.cardSize);
  const storeSetCardSize = useNodesStore(state => state.setCardSize);
  
  const effectiveCardLayout = cardLayout ?? storeCardLayout;
  const effectiveOnCardLayoutChange = onCardLayoutChange ?? ((layout: string) => {
    storeSetCardLayout(layout as 'no-cover' | 'cover-top' | 'cover-bottom' | 'cover-left' | 'cover-right');
  });
  
  const showViewSwitcher = availableViewModes.length > 1 && onViewModeChange;
  const showGroupByButton = showGroupBy && viewMode === 'list';
  const showAdd = showAddButton && onAdd;
  const showCardLayoutSelector = viewMode === 'card';
  const showCardSizeSlider = viewMode === 'card';
  
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
    ['no-cover', 'cover-left', 'cover-right', 'cover-top', 'cover-bottom'].map(layout => ({
      value: layout,
      icon: CARD_LAYOUT_ICONS[layout],
      label: CARD_LAYOUT_LABELS[layout],
    })),
    []
  );

  // Don't render if nothing to show
  if (!showViewSwitcher && !showGroupByButton && !showAdd) {
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
      
      {/* Card Size Slider - only shown in card view */}
      {showCardSizeSlider && (
        <div className="node-collection-toolbar__card-size-slider">
          <Slider
            value={storeCardSize}
            onChange={(val) => storeSetCardSize(val as 'xs' | 's' | 'm' | 'l' | 'xl')}
            options={[
              { value: 'xs', label: 'XS' },
              { value: 's', label: 'S' },
              { value: 'm', label: 'M' },
              { value: 'l', label: 'L' },
              { value: 'xl', label: 'XL' },
            ]}
            showLabels={false}
            size="sm"
          />
        </div>
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
