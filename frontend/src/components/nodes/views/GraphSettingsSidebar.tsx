import { Button } from '@/components/core/Button';
import { SelectionButton } from '@/components/core/SelectionButton';
import { BooleanToggle } from '@/components/core/BooleanToggle';
import { ListSortable } from '@/components/core/ListSortable';
import { ColorButton } from '@/components/core/ColorButton';
import type { ColorEntry } from '@/components/core/ColorButton';
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

const GRAPH_COLOR_ENTRIES: ColorEntry[] = [
  { cssVar: '#c55a55', label: 'Red' },
  { cssVar: '#c98557', label: 'Orange' },
  { cssVar: '#b8a23a', label: 'Yellow' },
  { cssVar: '#4f8f6a', label: 'Green' },
  { cssVar: '#4a8a83', label: 'Teal' },
  { cssVar: '#5a79c9', label: 'Blue' },
  { cssVar: '#8a6cc9', label: 'Purple' },
  { cssVar: '#c06a9a', label: 'Pink' },
];

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
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="mdi mdi-chevron-left"
          className="graph-sidebar-header__collapse"
          onClick={onCollapse}
          title="Collapse sidebar"
        />
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
          <ListSortable
            className="graph-groups-list"
            itemClassName="graph-group-item"
            items={colorGroups}
            onReorder={(fromIndex, toIndex) => {
              onColorGroupsChange(prev => {
                const next = [...prev];
                const [removed] = next.splice(fromIndex, 1);
                next.splice(toIndex, 0, removed);
                return next;
              });
            }}
            onItemClick={(group) => onEditGroup(group.id)}
            renderIcon={(group) => (
              <ColorButton
                color={group.color}
                size="xs"
                showPicker
                colors={GRAPH_COLOR_ENTRIES}
                onColorChange={(color) => {
                  if (color) {
                    onColorGroupsChange(prev =>
                      prev.map(g => g.id === group.id ? { ...g, color } : g)
                    );
                  }
                }}
                title="Change color"
              />
            )}
            renderText={(group) => (
              <span className="graph-group-name">{group.name}</span>
            )}
            renderActions={(group) => [
              <Button
                key="delete"
                icon="mdi mdi-trash-can-outline"
                size="xs"
                variant="ghost"
                onClick={(e) => {
                  e.stopPropagation();
                  onColorGroupsChange(prev => prev.filter(g => g.id !== group.id));
                }}
              />,
            ]}
          />
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
          <span className="visibility-option__label">Density preset</span>
          <SelectionButton
            size="sm"
            options={[
              { value: 'sparse', icon: "mdi mdi-arrow-expand", label: 'Sparse' },
              { value: 'balanced', icon: "mdi mdi-scale-balance", label: 'Balanced' },
              { value: 'compact', icon: "mdi mdi-arrow-collapse", label: 'Compact' },
            ]}
            value={graphSettings.physicsPreset}
            onChange={(value) => onGraphSettingsChange(prev => ({
              ...prev,
              physicsPreset: value as GraphSettings['physicsPreset']
            }))}
          />
        </div>
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
        <div className="visibility-option visibility-option--slider">
          <span className="visibility-option__label">Center force</span>
          <div className="visibility-option__slider-row">
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={graphSettings.centralGravity}
              onChange={(e) => onGraphSettingsChange(prev => ({
                ...prev,
                centralGravity: Number(e.target.value)
              }))}
              className="graph-radius-slider"
            />
            <span className="graph-radius-value">{graphSettings.centralGravity}</span>
          </div>
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
        <div className="visibility-option">
          <BooleanToggle
            size="sm"
            label="Clustering"
            labelPosition="left"
            checked={graphSettings.clustering}
            onChange={(e) => onGraphSettingsChange(prev => ({
              ...prev,
              clustering: e.target.checked
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
        <div className="visibility-option">
          <BooleanToggle
            size="sm"
            label="Hide orphans"
            labelPosition="left"
            checked={visibilityFilters.hideOrphans}
            onChange={(e) => onVisibilityFiltersChange(prev => ({
              ...prev,
              hideOrphans: e.target.checked
            }))}
          />
        </div>
        <div className="visibility-option">
          <BooleanToggle
            size="sm"
            label="Show aliases"
            labelPosition="left"
            checked={visibilityFilters.showAliases ?? false}
            onChange={(e) => onVisibilityFiltersChange(prev => ({
              ...prev,
              showAliases: e.target.checked
            }))}
          />
        </div>
      </GraphSidebarSection>

      <GraphSidebarSection title="Links" icon="mdi mdi-link-variant" defaultOpen={false}>
        <div className="visibility-option">
          <BooleanToggle
            size="sm"
            label="Co-occurrence links"
            labelPosition="left"
            checked={graphDataMode === 'cooccurrence'}
            onChange={(e) => {
              const mode = e.target.checked ? 'cooccurrence' : 'standard';
              onGraphDataModeChange(mode);
            }}
          />
        </div>
        {graphDataMode === 'cooccurrence' && (
          <div className="visibility-option visibility-option--slider">
            <span className="visibility-option__label">Min link weight</span>
            <div className="visibility-option__slider-row">
              <input
                type="range"
                min={0}
                max={10}
                step={1}
                value={graphSettings.minLinkWeight}
                onChange={(e) => onGraphSettingsChange(prev => ({
                  ...prev,
                  minLinkWeight: Number(e.target.value)
                }))}
                className="graph-radius-slider"
              />
              <span className="graph-radius-value">{graphSettings.minLinkWeight}</span>
            </div>
          </div>
        )}
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
            label="Temporal links"
            labelPosition="left"
            checked={graphSettings.showTemporalLinks}
            onChange={(e) => onGraphSettingsChange(prev => ({
              ...prev,
              showTemporalLinks: e.target.checked
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
        <div className="visibility-option">
          <BooleanToggle
            size="sm"
            label="Highlight paths"
            labelPosition="left"
            checked={graphSettings.highlightPaths}
            onChange={(e) => onGraphSettingsChange(prev => ({
              ...prev,
              highlightPaths: e.target.checked
            }))}
          />
        </div>
        <div className="visibility-option">
          <BooleanToggle
            size="sm"
            label="Curved edges"
            labelPosition="left"
            checked={graphSettings.curvedEdges}
            onChange={(e) => onGraphSettingsChange(prev => ({
              ...prev,
              curvedEdges: e.target.checked
            }))}
          />
        </div>
        <div className="visibility-option">
          <BooleanToggle
            size="sm"
            label="Colored edges"
            labelPosition="left"
            checked={graphSettings.coloredEdges}
            onChange={(e) => onGraphSettingsChange(prev => ({
              ...prev,
              coloredEdges: e.target.checked
            }))}
          />
        </div>
        <div className="visibility-option">
          <BooleanToggle
            size="sm"
            label="Tapered edges"
            labelPosition="left"
            checked={graphSettings.taperedEdges}
            onChange={(e) => onGraphSettingsChange(prev => ({
              ...prev,
              taperedEdges: e.target.checked
            }))}
          />
        </div>
        <div className="visibility-option">
          <BooleanToggle
            size="sm"
            label="Link LOD"
            labelPosition="left"
            checked={graphSettings.enableLinkLOD}
            onChange={(e) => onGraphSettingsChange(prev => ({
              ...prev,
              enableLinkLOD: e.target.checked
            }))}
          />
        </div>
      </GraphSidebarSection>
    </div>
  );
}
