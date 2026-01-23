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
import { 
  mdiGroup,
  mdiFormatListBulleted, 
  mdiFileDocumentOutline, 
  mdiViewGrid, 
  mdiTable, 
  mdiChartGantt, 
  mdiGraphOutline,
  mdiPlus,
} from '@mdi/js';
import type { NodeCollectionViewMode, NodeCollectionGroupBy } from '@/types/nodeCollection';
import { GROUP_BY_OPTIONS } from '@/types/nodeCollection';
import { SelectionButton, type SelectionButtonOption } from '../core/SelectionButton';
import { ButtonWithPanel } from '../core/ButtonWithPanel';
import { Button } from '../core/Button';
import './NodeCollectionToolbar.css';

// View mode icon mappings
const VIEW_MODE_ICONS: Record<NodeCollectionViewMode, string> = {
  list: mdiFormatListBulleted,
  document: mdiFileDocumentOutline,
  card: mdiViewGrid,
  table: mdiTable,
  gantt: mdiChartGantt,
  graph: mdiGraphOutline,
};

// View mode labels
const VIEW_MODE_LABELS: Record<NodeCollectionViewMode, string> = {
  list: 'List',
  document: 'Document',
  card: 'Cards',
  table: 'Table',
  gantt: 'Gantt',
  graph: 'Graph',
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
  availableViewModes = ['list', 'document', 'card', 'table', 'gantt', 'graph'],
  onViewModeChange,
  showGroupBy = false,
  groupBy = 'page',
  onGroupByChange,
  showAddButton = false,
  onAdd,
  className = '',
}: NodeCollectionToolbarProps) {
  const showViewSwitcher = availableViewModes.length > 1 && onViewModeChange;
  const showGroupByButton = showGroupBy && viewMode === 'list';
  const showAdd = showAddButton && onAdd;
  
  // Build SelectionButton options from available view modes
  const viewModeOptions = useMemo<SelectionButtonOption[]>(() => 
    availableViewModes.map(mode => ({
      value: mode,
      icon: VIEW_MODE_ICONS[mode],
      label: VIEW_MODE_LABELS[mode],
    })),
    [availableViewModes]
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
