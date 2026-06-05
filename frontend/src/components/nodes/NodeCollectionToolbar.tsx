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
import { useMemo, useState, useCallback } from 'react';
import { useAppStore } from '@/stores';
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import type { NodeCollectionViewMode, NodeCollectionGroupBy } from '@/types/nodeCollection';
import { getViewDefinition, getViewModeOptions } from './views';
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
import { Icon, DragVerticalIcon } from '@/components/core/icons';
import type { SortEntry } from '@/components/core/Table';

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
  /** Active sort columns */
  sortColumns?: SortEntry[];
  /** Called when sort changes */
  onSortChange?: (sort: SortEntry[]) => void;
  /** Available columns for sorting */
  availableSortColumns?: { key: string; label: string }[];
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
  availableViewModes = [],
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
  sortColumns = [],
  onSortChange,
  availableSortColumns = [],
  toolbarPrefix,
  leftElement,
  hideToolbarControls = false,
  className = '',
}: NodeCollectionToolbarProps) {
  // Use store for card layout if not controlled
  const storeCardLayout = useAppStore((state) => state.cardLayout);
  const storeSetCardLayout = useAppStore((state) => state.setCardLayout);

  const effectiveCardLayout = cardLayout ?? storeCardLayout;
  const effectiveOnCardLayoutChange = onCardLayoutChange ?? ((layout: 'no-cover' | 'cover-top' | 'cover-left' | 'cover-right') => {
    storeSetCardLayout(layout);
  });

  const showViewSwitcher = availableViewModes.length > 1 && onViewModeChange;

  // Introspect current view capabilities from registry
  const viewDef = getViewDefinition(viewMode);
  const capabilities = viewDef?.capabilities ?? {};

  const showGroupByButton = showGroupBy && capabilities.groupBy;
  const showAdd = showAddButton && onAdd;
  const showCardLayoutSelector = capabilities.cardLayout;
  const showPropertyColumnSelector = capabilities.propertyColumns && onPropertyColumnsChange;
  const showGanttPropertySelector = capabilities.ganttConfig && (onGanttStartDatePropertyChange || onGanttEndDatePropertyChange);
  const showSortButton = capabilities.sorting && onSortChange;

  // Whether we have any view-mode-specific settings to show
  const hasViewSettings = showGroupByButton || showPropertyColumnSelector || showGanttPropertySelector || showCardLayoutSelector;

  // Resolve active group-by label for visible indicator
  const { data: properties } = useProperties();
  const groupByLabel = useMemo(() => {
    if (!groupBy || groupBy === 'none') return null;
    if (groupBy === 'page') return 'Page';
    const prop = properties?.find((p) => p.uuid === groupBy);
    return prop?.name ?? 'Property';
  }, [groupBy, properties]);

  // Build view mode metadata from registry
  const allModeOptions = useMemo(() => getViewModeOptions(), []);
  const modeMeta = useMemo(() => {
    const map = new Map<NodeCollectionViewMode, { icon: string; label: string }>();
    for (const opt of allModeOptions) {
      map.set(opt.mode, { icon: opt.icon, label: opt.label });
    }
    return map;
  }, [allModeOptions]);

  // Build SelectionButton options for all available view modes
  const viewModeOptions = useMemo<SelectionButtonOption[]>(() =>
    availableViewModes.map((mode) => {
      const meta = modeMeta.get(mode);
      return {
        value: mode,
        icon: meta?.icon ?? 'mdi mdi-help-circle',
        label: meta?.label ?? mode,
      };
    }),
    [availableViewModes, modeMeta]
  );

  // Build SelectionButton options for card layouts
  const cardLayoutOptions = useMemo<SelectionButtonOption[]>(() =>
    ['no-cover', 'cover-left', 'cover-right', 'cover-top'].map((layout) => ({
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

          {/* View Mode Switcher */}
          {showViewSwitcher && (
            <SelectionButton
              options={viewModeOptions}
              value={viewMode}
              onChange={(val) => onViewModeChange?.(val as NodeCollectionViewMode)}
              size="sm"
              maxVisibleOptions={4}
              className="node-collection-toolbar__view-switcher"
            />
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

          {/* Sort button */}
          {showSortButton && (
            <ButtonWithPanel
              icon={"mdi mdi-sort"}
              variant="ghost"
              size="sm"
              panelPosition="bottom"
              panelAlignment="end"
              panelWidth={260}
              usePortal={true}
              className="node-collection-toolbar__sort"
              tooltip="Sort"
            >
              {() => (
                <SortConfigurator
                  sortColumns={sortColumns}
                  onSortChange={onSortChange}
                  availableSortColumns={availableSortColumns}
                />
              )}
            </ButtonWithPanel>
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
                      hidePageOption={viewMode === 'card'}
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

// ==================== Sort Configurator ====================

interface SortConfiguratorProps {
  sortColumns: SortEntry[];
  onSortChange: (sort: SortEntry[]) => void;
  availableSortColumns: { key: string; label: string }[];
}

function SortConfigurator({ sortColumns, onSortChange, availableSortColumns }: SortConfiguratorProps) {
  const [showAddList, setShowAddList] = useState(false);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = sortColumns.findIndex((s) => s.key === active.id);
    const newIndex = sortColumns.findIndex((s) => s.key === over.id);
    if (oldIndex !== -1 && newIndex !== -1) {
      onSortChange(arrayMove(sortColumns, oldIndex, newIndex));
    }
  }, [sortColumns, onSortChange]);

  const toggleDirection = (key: string) => {
    onSortChange(
      sortColumns.map((s) =>
        s.key === key ? { ...s, direction: s.direction === 'asc' ? 'desc' : 'asc' } : s
      )
    );
  };

  const removeSort = (key: string) => {
    onSortChange(sortColumns.filter((s) => s.key !== key));
  };

  const addSort = (key: string) => {
    onSortChange([...sortColumns, { key, direction: 'asc' }]);
    setShowAddList(false);
  };

  const unusedColumns = availableSortColumns.filter(
    (c) => !sortColumns.some((s) => s.key === c.key)
  );

  return (
    <div className="sort-configurator">
      <div className="sort-configurator__header">Sort by</div>

      {sortColumns.length > 0 && (
        <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext
            items={sortColumns.map((s) => s.key)}
            strategy={verticalListSortingStrategy}
          >
            <div className="sort-configurator__list">
              {sortColumns.map((sort) => (
                <SortConfiguratorItem
                  key={sort.key}
                  sort={sort}
                  label={availableSortColumns.find((c) => c.key === sort.key)?.label ?? sort.key}
                  onToggleDirection={() => toggleDirection(sort.key)}
                  onRemove={() => removeSort(sort.key)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {unusedColumns.length > 0 && (
        <div className="sort-configurator__add">
          {showAddList ? (
            <div className="sort-configurator__add-list">
              {unusedColumns.map((col) => (
                <button
                  key={col.key}
                  className="sort-configurator__add-item"
                  onClick={() => addSort(col.key)}
                  type="button"
                >
                  {col.label}
                </button>
              ))}
            </div>
          ) : (
            <button
              className="sort-configurator__add-btn"
              onClick={() => setShowAddList(true)}
              type="button"
            >
              + Add sort field
            </button>
          )}
        </div>
      )}

      {sortColumns.length > 0 && (
        <button
          className="sort-configurator__reset"
          onClick={() => onSortChange([])}
          type="button"
        >
          Reset
        </button>
      )}
    </div>
  );
}

function SortConfiguratorItem({
  sort,
  label,
  onToggleDirection,
  onRemove,
}: {
  sort: SortEntry;
  label: string;
  onToggleDirection: () => void;
  onRemove: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: sort.key });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="sort-configurator__item"
      {...attributes}
    >
      <span className="sort-configurator__drag-handle" {...listeners}>
        <DragVerticalIcon size="xs" />
      </span>
      <span className="sort-configurator__label">{label}</span>
      <button
        className="sort-configurator__direction"
        onClick={onToggleDirection}
        type="button"
        title={sort.direction === 'asc' ? 'Ascending' : 'Descending'}
      >
        {sort.direction === 'asc' ? '↑' : '↓'}
      </button>
      <button
        className="sort-configurator__remove"
        onClick={onRemove}
        type="button"
        title="Remove"
      >
        <Icon path="mdi mdi-close" size={0.6} />
      </button>
    </div>
  );
}
