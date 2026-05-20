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

import type { NodeCollectionViewMode, NodeCollectionGroupBy } from '@/types/nodeCollection';
import { DEFAULT_VIEW_MODES_ORDER, VIEW_MODE_ICONS, VIEW_MODE_LABELS } from '@/constants/viewModes';
import { SelectionButton, type SelectionButtonOption } from '@/components/core/SelectionButton';
import { ButtonWithPanel } from '@/components/core/ButtonWithPanel';
import { Button } from '@/components/core/Button';
import { PropertyColumnSelector } from '@/components/properties/PropertyColumnSelector';
import { GroupBySelector } from '@/components/properties/GroupBySelector';
import { GanttPropertySelector } from '@/components/properties/GanttPropertySelector';
import type { GanttTimeScale } from '@/components/properties/GanttPropertySelector';
import type { Property } from '@/types/api';
import { useProperties } from '@/hooks/useProperties';
import './NodeCollectionToolbar.css';
import { Icon } from '@/components/core/icons';

/** Max number of view mode icons shown inline before overflow */
const INLINE_VIEW_COUNT = 4;

// Card layout mode icon mappings
const CARD_LAYOUT_ICONS: Record<string, string> = {
  'no-cover': "mdi mdi-card-outline",
  'cover-left': "mdi mdi-dock-left",
  'cover-right': "mdi mdi-dock-right",
  'cover-top': "mdi mdi-dock-top",
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
  onCardLayoutChange?: (layout: 'no-cover' | 'cover-top' | 'cover-left' | 'cover-right') => void;
  /** Selected property UUIDs for table columns */
  selectedPropertyUuids?: string[];
  /** Callback when property column selection changes */
  onPropertyColumnsChange?: (propertyUuids: string[]) => void;
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
  groupBy = 'none',
  onGroupByChange,
  showAddButton = false,
  onAdd,
  cardLayout,
  onCardLayoutChange,
  selectedPropertyUuids = [],
  onPropertyColumnsChange,
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
  const effectiveOnCardLayoutChange = onCardLayoutChange ?? ((layout: 'no-cover' | 'cover-top' | 'cover-left' | 'cover-right') => {
    storeSetCardLayout(layout);
  });
  
  const showViewSwitcher = availableViewModes.length > 1 && onViewModeChange;
  const showGroupByButton = showGroupBy && (viewMode === 'list' || viewMode === 'card' || viewMode === 'gantt');
  const showAdd = showAddButton && onAdd;
  const showCardLayoutSelector = viewMode === 'card';
  const showPropertyColumnSelector = viewMode === 'table' && onPropertyColumnsChange;
  const showGanttPropertySelector = viewMode === 'gantt' && (onGanttStartDatePropertyChange || onGanttEndDatePropertyChange);

  // Whether we have any view-mode-specific settings to show
  const hasViewSettings = showGroupByButton || showPropertyColumnSelector || showGanttPropertySelector || showCardLayoutSelector;

  // Resolve active group-by label for visible indicator
  const { data: properties } = useProperties();
  const groupByLabel = useMemo(() => {
    if (!groupBy || groupBy === 'none') return null;
    if (groupBy === 'page') return 'Page';
    const prop = properties?.find(p => p.uuid === groupBy);
    return prop?.name ?? 'Property';
  }, [groupBy, properties]);
  
  // ── View mode inline/overflow split ─────────────────────────────────────
  const { inlineModes, overflowModes } = useMemo(() => {
    if (availableViewModes.length <= INLINE_VIEW_COUNT) {
      return { inlineModes: availableViewModes, overflowModes: [] as NodeCollectionViewMode[] };
    }
    const inline = [...availableViewModes.slice(0, INLINE_VIEW_COUNT)];
    const overflow = [...availableViewModes.slice(INLINE_VIEW_COUNT)];
    // If the currently-active mode is in overflow, swap it into view
    const overflowIdx = overflow.indexOf(viewMode);
    if (overflowIdx !== -1) {
      const swapped = inline[inline.length - 1];
      inline[inline.length - 1] = viewMode;
      overflow[overflowIdx] = swapped;
    }
    return { inlineModes: inline, overflowModes: overflow };
  }, [availableViewModes, viewMode]);

  // Build inline SelectionButton options
  const viewModeOptions = useMemo<SelectionButtonOption[]>(() => 
    inlineModes.map(mode => ({
      value: mode,
      icon: VIEW_MODE_ICONS[mode],
      label: VIEW_MODE_LABELS[mode],
    })),
    [inlineModes]
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
  const hasToolbarContent = !hideToolbarControls && (showViewSwitcher || hasViewSettings || showAdd || toolbarPrefix);

  // Don't render if nothing to show
  if (!leftElement && !hasToolbarContent) {
    return null;
  }

  return (
    <div className={`node-collection-toolbar ${className}`}>
      {/* Left section - header title + add/filter controls */}
      <div className="node-collection-toolbar__left">
        {leftElement}
        {/* Custom prefix content (view tabs, filter button, add view) */}
        {toolbarPrefix}
      </div>
      
      {/* Right section - view switcher + settings */}
      {hasToolbarContent && (
        <div className="node-collection-toolbar__right">

      {/* Add Button */}
      {showAdd && (
        <Button
          icon={"mdi mdi-plus"}
          variant="ghost"
          size="sm"
          onClick={onAdd}
          title="Add"
          className="node-collection-toolbar__add"
        />
      )}
      
      {/* View Mode Switcher – inline icons */}
      {showViewSwitcher && (
        <SelectionButton
          options={viewModeOptions}
          value={viewMode}
          onChange={(val) => onViewModeChange?.(val as NodeCollectionViewMode)}
          size="sm"
          className="node-collection-toolbar__view-switcher"
        />
      )}

      {/* Overflow view modes dropdown */}
      {showViewSwitcher && overflowModes.length > 0 && (
        <ButtonWithPanel
          icon={"mdi mdi-dots-horizontal"}
          variant="ghost"
          size="sm"
          panelPosition="bottom"
          panelAlignment="end"
          panelWidth={160}
          usePortal={true}
          showCloseButton={false}
          className="node-collection-toolbar__overflow"
          tooltip="More views"
        >
          {(closePanel) => (
            <div className="view-overflow-menu">
              {overflowModes.map(mode => (
                <button
                  key={mode}
                  className={`view-overflow-menu__item ${mode === viewMode ? 'view-overflow-menu__item--active' : ''}`}
                  onClick={() => { onViewModeChange?.(mode); closePanel(); }}
                >
                  <Icon path={VIEW_MODE_ICONS[mode]} size={0.7} />
                  <span>{VIEW_MODE_LABELS[mode]}</span>
                </button>
              ))}
            </div>
          )}
        </ButtonWithPanel>
      )}

      {/* Active group-by badge */}
      {groupByLabel && onGroupByChange && (
        <span className="node-collection-toolbar__group-by-badge">
          <span className="node-collection-toolbar__group-by-badge-label">Group: {groupByLabel}</span>
          <button
            className="node-collection-toolbar__group-by-badge-close"
            onClick={() => onGroupByChange('none')}
            title="Clear grouping"
            type="button"
          >
            <Icon path={"mdi mdi-close"} size={0.6} />
          </button>
        </span>
      )}

      {/* View Settings – single button combining all view-specific config */}
      {hasViewSettings && (
        <ButtonWithPanel
          icon={"mdi mdi-tune"}
          variant="ghost"
          size="sm"
          panelPosition="bottom"
          panelAlignment="end"
          panelWidth={300}
          usePortal={true}
          className="node-collection-toolbar__view-settings"
          tooltip="View settings"
        >
          {(closePanel) => (
            <div className="view-settings-panel">
              {/* Card layout (card view) */}
              {showCardLayoutSelector && (
                <div className="view-settings-panel__section">
                  <div className="view-settings-panel__label">Card layout</div>
                  <SelectionButton
                    options={cardLayoutOptions}
                    value={effectiveCardLayout}
                    onChange={(val) => effectiveOnCardLayoutChange(val as 'no-cover' | 'cover-top' | 'cover-left' | 'cover-right')}
                    size="sm"
                  />
                </div>
              )}

              {/* Property columns (table view) */}
              {showPropertyColumnSelector && (
                <PropertyColumnSelector
                  selectedPropertyUuids={selectedPropertyUuids}
                  onSelectionChange={onPropertyColumnsChange!}
                  onClose={closePanel}
                />
              )}

              {/* Gantt config (gantt view) */}
              {showGanttPropertySelector && (
                <GanttPropertySelector
                  startDateProperty={ganttStartDateProperty}
                  endDateProperty={ganttEndDateProperty}
                  onStartDatePropertyChange={onGanttStartDatePropertyChange ?? (() => {})}
                  onEndDatePropertyChange={onGanttEndDatePropertyChange ?? (() => {})}
                  timeScale={ganttTimeScale}
                  onTimeScaleChange={onGanttTimeScaleChange}
                />
              )}

              {/* Group by (list/card/gantt) */}
              {showGroupByButton && onGroupByChange && (
                <GroupBySelector
                  value={groupBy ?? 'page'}
                  onChange={onGroupByChange}
                  onClose={closePanel}
                />
              )}
            </div>
          )}
        </ButtonWithPanel>
      )}
      
    </div>
        )}
    </div>
  );
}

