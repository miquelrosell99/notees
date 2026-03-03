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
import { useAppStore } from '@/stores';
import { 
  mdiGroup,
  mdiPlus,
  mdiCardOutline,
  mdiDockLeft,
  mdiDockRight,
  mdiDockTop,
  mdiTableColumn,
  mdiRestore,
  mdiChartGantt,
} from '@mdi/js';
import type { NodeCollectionViewMode, NodeCollectionGroupBy } from '@/types/nodeCollection';
import { DEFAULT_VIEW_MODES_ORDER, VIEW_MODE_ICONS, VIEW_MODE_LABELS } from '@/constants/viewModes';
import { SelectionButton, type SelectionButtonOption } from '../core/SelectionButton';
import { ButtonWithPanel } from '../core/ButtonWithPanel';
import { Button } from '../core/Button';
import { PropertyColumnSelector } from '../properties/PropertyColumnSelector';
import { GroupBySelector } from '../properties/GroupBySelector';
import { GanttPropertySelector } from '../properties/GanttPropertySelector';
import type { GanttTimeScale } from '../properties/GanttPropertySelector';
import type { Property } from '@/types';
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
  /** Callback when reset views button is clicked */
  onResetViews?: () => void;
  /** Start date property for gantt view */
  ganttStartDateProperty?: Property;
  /** End date property for gantt view */
  ganttEndDateProperty?: Property;
  /** Called when gantt start date property changes */
  onGanttStartDatePropertyChange?: (property: Property | undefined) => void;
  /** Called when gantt end date property changes */
  onGanttEndDatePropertyChange?: (property: Property | undefined) => void;
  /** Active time scale for gantt view */
  ganttTimeScale?: GanttTimeScale;
  /** Called when gantt time scale changes */
  onGanttTimeScaleChange?: (scale: GanttTimeScale) => void;
  /** Custom content to render at the start of the toolbar (after leftElement) */
  toolbarPrefix?: React.ReactNode;
  /** Element to render at the very left of the toolbar (e.g., block element, collapsible header) */
  leftElement?: React.ReactNode;
  /** Hide toolbar controls while keeping leftElement visible */
  hideToolbarControls?: boolean;
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
  onResetViews,
  ganttStartDateProperty,
  ganttEndDateProperty,
  onGanttStartDatePropertyChange,
  onGanttEndDatePropertyChange,
  ganttTimeScale,
  onGanttTimeScaleChange,
  toolbarPrefix,
  leftElement,
  hideToolbarControls = false,
  className = '',
}: NodeCollectionToolbarProps) {
  // Use store for card layout if not controlled
  const storeCardLayout = useAppStore(state => state.cardLayout);
  const storeSetCardLayout = useAppStore(state => state.setCardLayout);
  
  const effectiveCardLayout = cardLayout ?? storeCardLayout;
  const effectiveOnCardLayoutChange = onCardLayoutChange ?? ((layout: string) => {
    storeSetCardLayout(layout as 'no-cover' | 'cover-top' | 'cover-left' | 'cover-right');
  });
  
  const showViewSwitcher = availableViewModes.length > 1 && onViewModeChange;
  const showGroupByButton = showGroupBy && (viewMode === 'list' || viewMode === 'card' || viewMode === 'gantt');
  const showAdd = showAddButton && onAdd;
  const showCardLayoutSelector = viewMode === 'card';
  // Show property column selector in table view when callback is provided
  const showPropertyColumnSelector = viewMode === 'table' && onPropertyColumnsChange;
  // Show gantt property selector in gantt view when callbacks are provided
  const showGanttPropertySelector = viewMode === 'gantt' && (onGanttStartDatePropertyChange || onGanttEndDatePropertyChange);
  
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
  const hasToolbarContent = !hideToolbarControls && (showViewSwitcher || showGroupByButton || showAdd || showPropertyColumnSelector || showGanttPropertySelector || toolbarPrefix);

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
          usePortal={true}
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

      {/* Gantt Property Selector - only shown in gantt view */}
      {showGanttPropertySelector && (
        <ButtonWithPanel
          icon={mdiChartGantt}
          variant="ghost"
          size="sm"
          panelPosition="bottom"
          panelAlignment="start"
          panelWidth={240}
          usePortal={true}
          className="node-collection-toolbar__gantt-config"
          tooltip="Configure Gantt"
        >
          {() => (
            <GanttPropertySelector
              startDateProperty={ganttStartDateProperty}
              endDateProperty={ganttEndDateProperty}
              onStartDatePropertyChange={onGanttStartDatePropertyChange ?? (() => {})}
              onEndDatePropertyChange={onGanttEndDatePropertyChange ?? (() => {})}
              timeScale={ganttTimeScale}
              onTimeScaleChange={onGanttTimeScaleChange}
            />
          )}
        </ButtonWithPanel>
      )}
      
      {/* GroupBy selector - only shown in list/card view */}
      {showGroupByButton && onGroupByChange && (
        <ButtonWithPanel
          icon={mdiGroup}
          variant="ghost"
          size="sm"
          panelPosition="bottom"
          panelAlignment="start"
          panelWidth={280}
          usePortal={true}
          className="node-collection-toolbar__group-by"
          tooltip="Group by"
        >
          {(closePanel) => (
            <GroupBySelector
              value={groupBy ?? 'page'}
              onChange={onGroupByChange}
              onClose={closePanel}
            />
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

export default NodeCollectionToolbar;
