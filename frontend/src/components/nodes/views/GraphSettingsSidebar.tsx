import { Button } from '@/components/core/Button';
import { SelectionButton } from '@/components/core/SelectionButton';
import { BooleanToggle } from '@/components/core/BooleanToggle';
import { GraphSidebarSection } from './GraphSidebarSection';
import type {
  GraphSettings,
  VisibilityFilters,
  GraphDataMode,
  GraphColorGroup,
  ConstraintMode,
  LinkDirection,
} from './viewTypes';

export interface GraphSettingsSidebarProps {
  colorGroups: GraphColorGroup[];
  onColorGroupsChange: (updater: React.SetStateAction<GraphColorGroup[]>) => void;
  onEditGroup: (groupId: string | null) => void;
  simulationPaused: boolean;
  onToggleSimulation: (running: boolean) => void;
  graphSettings: GraphSettings;
  onGraphSettingsChange: (updater: React.SetStateAction<GraphSettings>) => void;
  visibilityFilters: VisibilityFilters;
  onVisibilityFiltersChange: (updater: React.SetStateAction<VisibilityFilters>) => void;
  graphDataMode: GraphDataMode;
  onGraphDataModeChange: (mode: GraphDataMode) => void;
  baseNodeRadius: number;
  onBaseNodeRadiusChange: (radius: number) => void;
  viewMode: 'normal' | 'circle' | 'tree';
  onCollapse: () => void;
  localGraphMode?: boolean;
}

export function GraphSettingsSidebar({
  colorGroups,
  onColorGroupsChange,
  onEditGroup,
  simulationPaused,
  onToggleSimulation,
  graphSettings,
  onGraphSettingsChange,
  visibilityFilters,
  onVisibilityFiltersChange,
  graphDataMode,
  onGraphDataModeChange,
  baseNodeRadius,
  onBaseNodeRadiusChange,
  viewMode,
  onCollapse,
  localGraphMode = false,
}: GraphSettingsSidebarProps) {
  return (
    <div className="graph-sidebar">
      <div className="graph-sidebar-header">
        <span className="graph-sidebar-header__title">Graph</span>
        <button
          className="graph-sidebar-header__collapse"
          onClick={onCollapse}
          type="button"
          title="Collapse sidebar"
        >
          <span className="mdi mdi-chevron-left" />
        </button>
      </div>

      {localGraphMode && (
        <GraphSidebarSection title="Local Graph" icon="mdi mdi-target" defaultOpen={true}>
          <div className="visibility-option">
            <BooleanToggle
              size="sm"
              label="Hide self"
              labelPosition="left"
              checked={visibilityFilters.hideSelfNode ?? true}
              onChange={(e) => onVisibilityFiltersChange(prev => ({
                ...prev,
                hideSelfNode: e.target.checked
              }))}
            />
          </div>
        </GraphSidebarSection>
      )}

      <GraphSidebarSection title="Groups" icon="mdi mdi-tag-multiple" defaultOpen={false}>
        {colorGroups.length === 0 && (
          <p className="graph-groups-empty">No color groups. Add one to highlight pages matching any query.</p>
        )}
        {colorGroups.length > 0 && (
          <div className="graph-groups-list">
            {colorGroups.map((group, index) => (
              <div key={group.id} className="graph-group-item">
                <div className="graph-group-dot" style={{ backgroundColor: group.color }} />
                <div className="graph-group-info">
                  <span className="graph-group-name">{group.name}</span>
                </div>
                <div className="graph-group-actions">
                  <Button
                    icon="mdi mdi-pencil-outline"
                    size="xs"
                    variant="ghost"
                    onClick={() => onEditGroup(group.id)}
                  />
                  <Button
                    icon="mdi mdi-chevron-up"
                    size="xs"
                    variant="ghost"
                    disabled={index === 0}
                    onClick={() => {
                      onColorGroupsChange(prev => {
                        const newGroups = [...prev];
                        [newGroups[index - 1], newGroups[index]] = [newGroups[index], newGroups[index - 1]];
                        return newGroups;
                      });
                    }}
                  />
                  <Button
                    icon="mdi mdi-chevron-down"
                    size="xs"
                    variant="ghost"
                    disabled={index === colorGroups.length - 1}
                    onClick={() => {
                      onColorGroupsChange(prev => {
                        const newGroups = [...prev];
                        [newGroups[index], newGroups[index + 1]] = [newGroups[index + 1], newGroups[index]];
                        return newGroups;
                      });
                    }}
                  />
                  <Button
                    icon="mdi mdi-trash-can-outline"
                    size="xs"
                    variant="ghost"
                    onClick={() => onColorGroupsChange(prev => prev.filter(g => g.id !== group.id))}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
        <Button
          icon="mdi mdi-plus"
          size="sm"
          variant="ghost"
          className="graph-add-group-btn"
          onClick={() => onEditGroup(null)}
        >
          Add group
        </Button>
      </GraphSidebarSection>

      <GraphSidebarSection title="Physics" icon="mdi mdi-tune" defaultOpen={false}>
        <div className="visibility-option">
          <BooleanToggle
            size="sm"
            label="Simulation"
            labelPosition="left"
            checked={!simulationPaused}
            onChange={(e) => onToggleSimulation(e.target.checked)}
          />
        </div>
        <div className="visibility-option">
          <BooleanToggle
            size="sm"
            label="Link-count attraction"
            labelPosition="left"
            checked={graphSettings.linkCountAttraction}
            onChange={(e) => onGraphSettingsChange(prev => ({
              ...prev,
              linkCountAttraction: e.target.checked
            }))}
          />
        </div>
        <div className="visibility-option">
          <BooleanToggle
            size="sm"
            label="Central gravity"
            labelPosition="left"
            checked={graphSettings.centralGravity}
            onChange={(e) => onGraphSettingsChange(prev => ({
              ...prev,
              centralGravity: e.target.checked
            }))}
          />
        </div>
        <div className="visibility-option">
          <BooleanToggle
            size="sm"
            label="Mass accumulation"
            labelPosition="left"
            checked={graphSettings.heightMode === 'hierarchy'}
            onChange={(e) => onGraphSettingsChange(prev => ({
              ...prev,
              heightMode: e.target.checked ? 'hierarchy' : 'references'
            }))}
          />
        </div>
      </GraphSidebarSection>

      <GraphSidebarSection title="Nodes" icon="mdi mdi-filter" defaultOpen={false}>
        <div className="visibility-option">
          <BooleanToggle
            size="sm"
            label="Class nodes"
            labelPosition="left"
            checked={visibilityFilters.showClassNodes}
            onChange={(e) => onVisibilityFiltersChange(prev => ({
              ...prev,
              showClassNodes: e.target.checked
            }))}
          />
        </div>
        <div className="visibility-option">
          <BooleanToggle
            size="sm"
            label="Day pages"
            labelPosition="left"
            checked={visibilityFilters.showDayPages}
            onChange={(e) => onVisibilityFiltersChange(prev => ({
              ...prev,
              showDayPages: e.target.checked
            }))}
          />
        </div>
        <div className="visibility-option">
          <BooleanToggle
            size="sm"
            label="Month pages"
            labelPosition="left"
            checked={visibilityFilters.showMonthPages}
            onChange={(e) => onVisibilityFiltersChange(prev => ({
              ...prev,
              showMonthPages: e.target.checked
            }))}
          />
        </div>
        <div className="visibility-option">
          <BooleanToggle
            size="sm"
            label="Year pages"
            labelPosition="left"
            checked={visibilityFilters.showYearPages}
            onChange={(e) => onVisibilityFiltersChange(prev => ({
              ...prev,
              showYearPages: e.target.checked
            }))}
          />
        </div>
        <div className="visibility-option">
          <BooleanToggle
            size="sm"
            label="System pages"
            labelPosition="left"
            checked={visibilityFilters.showSystemPages}
            onChange={(e) => onVisibilityFiltersChange(prev => ({
              ...prev,
              showSystemPages: e.target.checked
            }))}
          />
        </div>
      </GraphSidebarSection>

      <GraphSidebarSection title="Links" icon="mdi mdi-link-variant" defaultOpen={false}>
        <div className="visibility-option">
          <BooleanToggle
            size="sm"
            label="Co-occurrence analysis"
            labelPosition="left"
            checked={graphDataMode === 'cooccurrence'}
            onChange={(e) => {
              const mode = e.target.checked ? 'cooccurrence' : 'standard';
              onGraphDataModeChange(mode);
              if (!e.target.checked) {
                onVisibilityFiltersChange(prev => ({ ...prev, showCooccurrenceLinks: false }));
              }
            }}
          />
        </div>
        <div className="visibility-option">
          <BooleanToggle
            size="sm"
            label="Parent links"
            labelPosition="left"
            checked={visibilityFilters.showParentLinks}
            onChange={(e) => onVisibilityFiltersChange(prev => ({
              ...prev,
              showParentLinks: e.target.checked
            }))}
          />
        </div>
        <div className="visibility-option">
          <BooleanToggle
            size="sm"
            label="Reference links"
            labelPosition="left"
            checked={visibilityFilters.showReferenceLinks}
            onChange={(e) => onVisibilityFiltersChange(prev => ({
              ...prev,
              showReferenceLinks: e.target.checked
            }))}
          />
        </div>
        <div className="visibility-option">
          <BooleanToggle
            size="sm"
            label="Class links"
            labelPosition="left"
            checked={visibilityFilters.showClassLinks}
            onChange={(e) => onVisibilityFiltersChange(prev => ({
              ...prev,
              showClassLinks: e.target.checked
            }))}
          />
        </div>
        <div className="visibility-option">
          <BooleanToggle
            size="sm"
            label="Co-occurrence links"
            labelPosition="left"
            checked={visibilityFilters.showCooccurrenceLinks}
            disabled={graphDataMode === 'standard'}
            onChange={(e) => onVisibilityFiltersChange(prev => ({
              ...prev,
              showCooccurrenceLinks: e.target.checked
            }))}
          />
        </div>
      </GraphSidebarSection>

      <GraphSidebarSection title="Style" icon="mdi mdi-palette" defaultOpen={false}>
        <div className="visibility-option">
          <span className="visibility-option__label">Node sizing</span>
          <SelectionButton
            size="sm"
            options={[
              { value: 'uniform', icon: "mdi mdi-circle-outline", label: 'Uniform' },
              { value: 'connections', icon: "mdi mdi-connection", label: 'Links' },
              { value: 'mass', icon: "mdi mdi-weight", label: 'Mass' },
              { value: 'content', icon: "mdi mdi-note", label: 'Content' }
            ]}
            value={graphSettings.nodeSizeMode}
            onChange={(value) => onGraphSettingsChange(prev => ({
              ...prev,
              nodeSizeMode: value as GraphSettings['nodeSizeMode']
            }))}
          />
        </div>
        <div className="visibility-option visibility-option--slider">
          <span className="visibility-option__label">Node radius</span>
          <div className="visibility-option__slider-row">
            <input
              type="range"
              min={5}
              max={40}
              step={1}
              value={baseNodeRadius}
              onChange={(e) => onBaseNodeRadiusChange(Number(e.target.value))}
              className="graph-radius-slider"
            />
            <span className="graph-radius-value">{baseNodeRadius}</span>
          </div>
        </div>
        {graphSettings.nodeSizeMode === 'connections' && (
          <div className="visibility-option">
            <span className="visibility-option__label">Link direction</span>
            <SelectionButton
              size="sm"
              options={[
                { value: 'in', icon: "mdi mdi-call-received", label: 'In' },
                { value: 'out', icon: "mdi mdi-call-made", label: 'Out' },
                { value: 'all', icon: "mdi mdi-swap-horizontal", label: 'All' }
              ]}
              value={graphSettings.linkDirection}
              onChange={(value) => onGraphSettingsChange(prev => ({
                ...prev,
                linkDirection: value as LinkDirection
              }))}
            />
          </div>
        )}
        {(viewMode === 'circle' || viewMode === 'tree') && (
          <div className="visibility-option">
            <span className="visibility-option__label">Layout mode</span>
            <SelectionButton
              size="sm"
              options={[
                { value: 'physics', icon: "mdi mdi-atom", label: 'Physics' },
                { value: 'equidistant', icon: "mdi mdi-distribute-horizontal-center", label: 'Fixed' }
              ]}
              value={graphSettings.constraintMode}
              onChange={(value) => onGraphSettingsChange(prev => ({
                ...prev,
                constraintMode: value as ConstraintMode
              }))}
            />
          </div>
        )}
      </GraphSidebarSection>
    </div>
  );
}
