/**
 * NodeGraphView Component
 * 
 * Full-featured graph view with:
 * - Settings panel (link count attraction, node size mode)
 * - Type colors panel with drag reorder
 * - Type visibility toggle
 * - View mode switcher (normal, circle, tree)
 * - Creation animation button
 * - Recenter button
 * - Search panel for node selection
 * - Multi-select with path tracing
 * 
 * Uses NodeGraphRenderer for the actual visualization.
 */
import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useGraphData, useClasses } from '@/hooks';
import { useSettingsQuery } from '@/hooks/useSettings';
import { useNodesStore } from '@/stores';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { setSetting } from '@/api/databases';
import type { GraphNode as ApiGraphNode } from '@/api/nodes';
import { 
  NodeGraphRenderer, 
  type NodeGraphRendererRef,
  type GraphNode,
  type GraphLink,
  type GraphSettings,
  type GraphViewMode,
  type VisibilityFilters,
  type ConstraintMode,
} from './NodeGraphRenderer';
import { mdiCog, mdiPalette, mdiCrosshairsGps, mdiHistory, mdiEyeOff, mdiEye, mdiVectorPolygon, mdiCircleOutline, mdiFileTreeOutline, mdiTrashCanOutline, mdiClose, mdiConnection, mdiWeight, mdiAtom, mdiDistributeHorizontalCenter } from '@mdi/js';
import { Button } from '../core/Button';
import { ButtonWithPanel } from '../core/ButtonWithPanel';
import { SelectionButton } from '../core/SelectionButton';
import { ListSortable } from '../core/ListSortable';
import { BooleanToggle } from '../core/BooleanToggle';
import { ClassColorsPanel } from '../shared/ClassColorsPanel';
import type { ClassColor } from '../shared/ClassColorsPanel';
import { DEFAULT_SYSTEM_PAGES } from '@/utils/systemPages';
import './NodeGraphView.css';

// Default class colors
const DEFAULT_CLASS_COLORS = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#14b8a6', '#f97316', '#3b82f6', '#84cc16',
];

export interface NodeGraphViewProps {
  /** Unique ID for this view to persist settings separately */
  viewId?: string;
  /** CSS class */
  className?: string;
}

interface SelectedNodeItem {
  id: number;
  name: string;
  order: number;
}

// Helper to get localStorage key for a view
const getStorageKey = (viewId: string, key: string) => `graph_${viewId}_${key}`;

export function NodeGraphView({ viewId = 'global', className = '' }: NodeGraphViewProps) {
  const rendererRef = useRef<NodeGraphRendererRef>(null);
  
  // Data hooks
  const { data: graphData, isLoading } = useGraphData();
  const { data: classes } = useClasses();
  const { data: serverSettings } = useSettingsQuery();
  const { openNode, addSidebarCard } = useNodesStore();
  
  // View state
  const [viewMode, setViewMode] = useState<GraphViewMode>('normal');
  const [selectedNodes, setSelectedNodes] = useState<SelectedNodeItem[]>([]);
  const [pinnedNodes, setPinnedNodes] = useState<Set<number>>(new Set());
  
  // Settings state
  const [graphSettings, setGraphSettings] = useState<GraphSettings>({
    linkCountAttraction: false,
    nodeSizeMode: 'uniform',
    massAccumulation: true,
    constraintMode: 'physics',
  });
  const settingsLoadedRef = useRef(false);
  
  // Class colors
  const [classColors, setClassColors] = useState<ClassColor[]>([]);
  const classColorsLoadedRef = useRef(false);
  
  // Tracks how many state changes should be skipped by the save effects.
  // Incremented when loading from server, so the subsequent render doesn't
  // fire a no-op PUT back.
  const skipClassColorsSaveRef = useRef(0);
  const skipGraphSettingsSaveRef = useRef(0);
  
  // Visibility filters
  const [visibilityFilters, setVisibilityFilters] = useState<VisibilityFilters>({
    showClassNodes: true,
    showClassLinks: true,
    showParentLinks: true,
    showReferenceLinks: true,
    showDayPages: true,
    showMonthPages: true,
    showYearPages: true,
    showSystemPages: true,
  });
  const visibilityFiltersLoadedRef = useRef(false);
  
  // UI panel state
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [classColorsOpen, setClassColorsOpen] = useState(false);
  const [typeVisibilityOpen, setTypeVisibilityOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  
  // Load graph settings from cached TanStack Query data
  useEffect(() => {
    if (!serverSettings) return;
    
    if (!classColorsLoadedRef.current) {
      const saved = serverSettings['graph_class_colors'];
      if (saved) {
        try {
          // Value is stored as JSONB — it arrives as the parsed object already.
          // Handle both formats: raw object (new) or JSON string (legacy).
          const parsed = typeof saved === 'string' ? JSON.parse(saved) : saved;
          if (Array.isArray(parsed)) {
            // Migrate legacy data: typeName → className, convert raw AST to text
            const migrated = parsed.map((cc: Record<string, unknown>) => {
              const rawName = (cc.className ?? cc.typeName ?? '') as string;
              return {
                ...cc,
                className: nodeNameToText(rawName) || rawName || 'Untitled',
              };
            });
            skipClassColorsSaveRef.current++;  // skip the save-back on next render
            setClassColors(migrated);
          }
        } catch (e) {
          console.error('Failed to parse graph_class_colors:', e);
        }
      }
      classColorsLoadedRef.current = true;
    }
    
    if (!settingsLoadedRef.current) {
      const savedSettings = serverSettings['graph_settings'];
      if (savedSettings) {
        try {
          // Value is stored as JSONB — it arrives as the parsed object already.
          // Handle both formats: raw object (new) or JSON string (legacy).
          const parsed = typeof savedSettings === 'string' ? JSON.parse(savedSettings) : savedSettings;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            skipGraphSettingsSaveRef.current++;  // skip the save-back on next render
            setGraphSettings(prev => ({ ...prev, ...parsed }));
          }
        } catch (e) {
          console.error('Failed to parse graph_settings:', e);
        }
      }
      settingsLoadedRef.current = true;
    }
  }, [serverSettings]);
  
  // Save settings (debounced) — skip save-backs triggered by initial load
  useEffect(() => {
    if (!classColorsLoadedRef.current) return;
    if (skipClassColorsSaveRef.current > 0) {
      skipClassColorsSaveRef.current--;
      return;
    }
    
    const timer = setTimeout(() => {
      setSetting('graph_class_colors', classColors).catch(e => {
        console.error('Failed to save graph_class_colors:', e);
      });
    }, 500);
    
    return () => clearTimeout(timer);
  }, [classColors]);
  
  useEffect(() => {
    if (!settingsLoadedRef.current) return;
    if (skipGraphSettingsSaveRef.current > 0) {
      skipGraphSettingsSaveRef.current--;
      return;
    }
    
    const timer = setTimeout(() => {
      setSetting('graph_settings', graphSettings).catch(e => {
        console.error('Failed to save graph_settings:', e);
      });
    }, 500);
    
    return () => clearTimeout(timer);
  }, [graphSettings]);
  
  // Load visibility filters from localStorage (per-view)
  useEffect(() => {
    if (visibilityFiltersLoadedRef.current) return;
    
    try {
      const saved = localStorage.getItem(getStorageKey(viewId, 'visibility_filters'));
      if (saved) {
        const parsed = JSON.parse(saved);
        setVisibilityFilters(prev => ({ ...prev, ...parsed }));
      }
    } catch (e) {
      console.error('Failed to load visibility filters:', e);
    }
    visibilityFiltersLoadedRef.current = true;
  }, [viewId]);
  
  // Save visibility filters to localStorage (debounced, per-view)
  useEffect(() => {
    if (!visibilityFiltersLoadedRef.current) return;
    
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(getStorageKey(viewId, 'visibility_filters'), JSON.stringify(visibilityFilters));
      } catch (e) {
        console.error('Failed to save visibility filters:', e);
      }
    }, 500);
    
    return () => clearTimeout(timer);
  }, [visibilityFilters, viewId]);
  
  // Build class ID set
  const classIds = useMemo(() => {
    const set = new Set<number>();
    if (classes) {
      for (const c of classes) {
        set.add(c.id);
      }
    }
    return set;
  }, [classes]);
  
  // Convert API data to renderer format
  const { nodes, links } = useMemo(() => {
    if (!graphData) return { nodes: [], links: [] };
    
    // Build parent map from links
    // - 'parent' links: actual parent-child relationships (target is child of source)
    // - 'extends' links: class inheritance (source extends target, so target is parent)
    const parentMap = new Map<number, number>();
    for (const link of graphData.links) {
      if (link.type === 'parent') {
        parentMap.set(link.target, link.source);
      } else if (link.type === 'extends') {
        // Class extends: source extends target, so target is the parent
        parentMap.set(link.source, link.target);
      }
    }
    
    const nodes: GraphNode[] = graphData.nodes.map((apiNode: ApiGraphNode) => {
      const nodeName = nodeNameToText(apiNode.name) || 'Untitled';
      const isSystemPage = DEFAULT_SYSTEM_PAGES.some(
        sysName => sysName.toLowerCase() === nodeName.toLowerCase()
      );
      return {
        id: apiNode.id,
        uuid: apiNode.uuid,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        targetX: 0,
        targetY: 0,
        name: nodeName,
        type: apiNode.type || 'page',
        isDaily: apiNode.is_daily || false,
        isMonthly: apiNode.is_monthly || false,
        isYearly: apiNode.is_yearly || false,
        isSystemPage,
        tags: apiNode.tags || [],
        types: apiNode.class_ids || [],
        parentId: parentMap.get(apiNode.id) ?? null,
        glare: 'normal',
        pinned: pinnedNodes.has(apiNode.id),
        color: (apiNode.properties?.color as string) || undefined,
        connectionCount: 0, // computed by renderer from visible links
        createdAt: apiNode.created_at,
        visible: true,
        isClassNode: apiNode.is_class || classIds.has(apiNode.id),
      };
    });
    
    const links: GraphLink[] = graphData.links.map(link => ({
      source: link.source,
      target: link.target,
      type: link.type,
    }));
    
    return { nodes, links };
  }, [graphData, pinnedNodes, classIds]);
  
  // Selected node IDs
  const selectedNodeIds = useMemo(() => selectedNodes.map(s => s.id), [selectedNodes]);
  
  // Event handlers
  const handleNodeClick = useCallback((node: GraphNode, event: { shiftKey: boolean; ctrlKey: boolean }) => {
    if (event.shiftKey) {
      addSidebarCard(node.id, node.type);
    } else if (event.ctrlKey) {
      // Ctrl+click: toggle selection
      setSelectedNodes(prev => {
        const exists = prev.find(s => s.id === node.id);
        if (exists) {
          return prev.filter(s => s.id !== node.id);
        } else {
          return [...prev, { id: node.id, name: node.name, order: prev.length }];
        }
      });
    } else {
      // Regular click: toggle selection (add if not selected, remove if selected)
      setSelectedNodes(prev => {
        const exists = prev.find(s => s.id === node.id);
        if (exists) {
          return prev.filter(s => s.id !== node.id);
        }
        return [...prev, { id: node.id, name: node.name, order: prev.length }];
      });
    }
  }, [addSidebarCard]);
  
  const handleNodeDoubleClick = useCallback((node: GraphNode) => {
    openNode(node.id, node.parentId === null ? 'page' : 'block');
    setSelectedNodes([]);
  }, [openNode]);
  
  const handleNodeRightClick = useCallback((node: GraphNode) => {
    setPinnedNodes(prev => {
      const newSet = new Set(prev);
      if (newSet.has(node.id)) {
        newSet.delete(node.id);
      } else {
        newSet.add(node.id);
      }
      return newSet;
    });
  }, []);
  
  const handleSelectionChange = useCallback((nodeIds: number[]) => {
    if (nodeIds.length === 0) {
      setSelectedNodes([]);
    }
  }, []);
  
  // Class color handler
  const handleClassColorsChange = useCallback((newClassColors: ClassColor[]) => {
    setClassColors(newClassColors);
  }, []);
  
  // Selection handlers
  const removeFromSelection = useCallback((nodeId: number) => {
    setSelectedNodes(prev => prev.filter(s => s.id !== nodeId));
  }, []);
  
  const moveSelectionItem = useCallback((fromIndex: number, toIndex: number) => {
    setSelectedNodes(prev => {
      const newList = [...prev];
      const [removed] = newList.splice(fromIndex, 1);
      newList.splice(toIndex, 0, removed);
      return newList.map((item, i) => ({ ...item, order: i }));
    });
  }, []);
  
  // Search — use graphData.nodes instead of usePages() to avoid loading full Node objects twice
  const searchResults = useMemo(() => {
    if (!searchQuery.trim() || !graphData?.nodes) return [];
    const query = searchQuery.toLowerCase();
    return graphData.nodes
      .map(p => ({ id: p.id, uuid: p.uuid, name: nodeNameToText(p.name) || 'Untitled', icon: p.icon }))
      .filter(p => p.name.toLowerCase().includes(query))
      .slice(0, 10);
  }, [searchQuery, graphData]);
  
  const addToSelection = useCallback((node: { id: number; name?: string }) => {
    setSelectedNodes(prev => {
      if (prev.find(s => s.id === node.id)) return prev;
      return [...prev, { id: node.id, name: node.name || 'Untitled', order: prev.length }];
    });
    setSearchQuery('');
    setSearchOpen(false);
  }, []);
  
  // View mode options
  const modeOptions = [
    { value: 'normal', icon: mdiVectorPolygon, label: 'Force-directed layout' },
    { value: 'circle', icon: mdiCircleOutline, label: 'Circle layout' },
    { value: 'tree', icon: mdiFileTreeOutline, label: 'Tree layout' },
  ];
  
  if (isLoading) {
    return (
      <div className={`node-graph-view loading ${className}`}>
        <div className="node-graph-view__loading">Loading graph...</div>
      </div>
    );
  }
  
  if (!graphData || graphData.nodes.length === 0) {
    return (
      <div className={`node-graph-view empty ${className}`}>
        <div className="node-graph-view__empty">
          <h3>No nodes to display</h3>
          <p>Create some pages to see them in the graph view.</p>
        </div>
      </div>
    );
  }
  
  return (
    <div className={`node-graph-view ${className}`}>
      {/* Top Left: Settings panels */}
      <div className="node-graph-view__top-left">
        <ButtonWithPanel
          icon={mdiCog}
          size="sm"
          panelPosition="right"
          panelAlignment="start"
          panelWidth={320}
          title="Graph Settings"
          tooltip="Graph settings"
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
        >
          <div className="visibility-panel-content">
            <div className="visibility-option">
              <BooleanToggle
                size="sm"
                label="Link-count attraction"
                description="More connected nodes attract more strongly"
                labelPosition="left"
                checked={graphSettings.linkCountAttraction}
                onChange={(e) => setGraphSettings(prev => ({
                  ...prev,
                  linkCountAttraction: e.target.checked
                }))}
              />
            </div>
            
            <div className="visibility-option">
              <BooleanToggle
                size="sm"
                label="Mass accumulation"
                description="Parent nodes resist movement based on descendants"
                labelPosition="left"
                checked={graphSettings.massAccumulation}
                onChange={(e) => setGraphSettings(prev => ({
                  ...prev,
                  massAccumulation: e.target.checked
                }))}
              />
            </div>

            <div className="visibility-option">
              <SelectionButton
                size="sm"
                label="Node sizing"
                description="Size nodes uniformly, by connections, or by mass"
                labelPosition="left"
                options={[
                  { value: 'uniform', icon: mdiCircleOutline, label: 'Uniform size' },
                  { value: 'connections', icon: mdiConnection, label: 'Connection count' },
                  { value: 'mass', icon: mdiWeight, label: 'Hierarchy mass' }
                ]}
                value={graphSettings.nodeSizeMode}
                onChange={(value) => setGraphSettings(prev => ({
                  ...prev,
                  nodeSizeMode: value as GraphSettings['nodeSizeMode']
                }))}
              />
            </div>

            {(viewMode === 'circle' || viewMode === 'tree') && (
              <div className="visibility-option">
                <SelectionButton
                  size="sm"
                  label="Layout mode"
                  description="Physics simulation or fixed equidistant positions"
                  labelPosition="left"
                  options={[
                    { value: 'physics', icon: mdiAtom, label: 'Physics simulation' },
                    { value: 'equidistant', icon: mdiDistributeHorizontalCenter, label: 'Equidistant' }
                  ]}
                  value={graphSettings.constraintMode}
                  onChange={(value) => setGraphSettings(prev => ({
                    ...prev,
                    constraintMode: value as ConstraintMode
                  }))}
                />
              </div>
            )}
          </div>
        </ButtonWithPanel>
        
        <ButtonWithPanel
          icon={mdiPalette}
          size="sm"
          panelPosition="right"
          panelAlignment="start"
          panelWidth={280}
          panelMaxHeight={400}
          title="Class Colors"
          tooltip="Class colors"
          open={classColorsOpen}
          onOpenChange={setClassColorsOpen}
          panelClassName="class-colors-panel"
        >
          <ClassColorsPanel
            classColors={classColors}
            defaultColors={DEFAULT_CLASS_COLORS}
            onChange={handleClassColorsChange}
          />
        </ButtonWithPanel>
        
        <ButtonWithPanel
          icon={mdiEye}
          size="sm"
          panelPosition="right"
          panelAlignment="start"
          panelWidth={280}
          title="Node Visibility"
          tooltip="Toggle node visibility"
          open={typeVisibilityOpen}
          onOpenChange={setTypeVisibilityOpen}
        >
          <div className="visibility-panel-content">
            <div className="visibility-option">
              <BooleanToggle
                size="sm"
                label="Class nodes"
                description="Show nodes used as classes/types"
                labelPosition="left"
                checked={visibilityFilters.showClassNodes}
                onChange={(e) => setVisibilityFilters(prev => ({
                  ...prev,
                  showClassNodes: e.target.checked
                }))}
              />
            </div>
            <div className="visibility-option">
              <BooleanToggle
                size="sm"
                label="Class links"
                description="Show class assignment lines"
                labelPosition="left"
                checked={visibilityFilters.showClassLinks}
                onChange={(e) => setVisibilityFilters(prev => ({
                  ...prev,
                  showClassLinks: e.target.checked
                }))}
              />
            </div>
            <div className="visibility-option">
              <BooleanToggle
                size="sm"
                label="Parent links"
                description="Show parent and extends lines"
                labelPosition="left"
                checked={visibilityFilters.showParentLinks}
                onChange={(e) => setVisibilityFilters(prev => ({
                  ...prev,
                  showParentLinks: e.target.checked
                }))}
              />
            </div>
            <div className="visibility-option">
              <BooleanToggle
                size="sm"
                label="Reference links"
                description="Show backlink reference lines"
                labelPosition="left"
                checked={visibilityFilters.showReferenceLinks}
                onChange={(e) => setVisibilityFilters(prev => ({
                  ...prev,
                  showReferenceLinks: e.target.checked
                }))}
              />
            </div>
            <div className="visibility-option">
              <BooleanToggle
                size="sm"
                label="Day pages"
                description="Show daily journal pages"
                labelPosition="left"
                checked={visibilityFilters.showDayPages}
                onChange={(e) => setVisibilityFilters(prev => ({
                  ...prev,
                  showDayPages: e.target.checked
                }))}
              />
            </div>
            <div className="visibility-option">
              <BooleanToggle
                size="sm"
                label="Month pages"
                description="Show monthly journal pages"
                labelPosition="left"
                checked={visibilityFilters.showMonthPages}
                onChange={(e) => setVisibilityFilters(prev => ({
                  ...prev,
                  showMonthPages: e.target.checked
                }))}
              />
            </div>
            <div className="visibility-option">
              <BooleanToggle
                size="sm"
                label="Year pages"
                description="Show yearly journal pages"
                labelPosition="left"
                checked={visibilityFilters.showYearPages}
                onChange={(e) => setVisibilityFilters(prev => ({
                  ...prev,
                  showYearPages: e.target.checked
                }))}
              />
            </div>
            <div className="visibility-option">
              <BooleanToggle
                size="sm"
                label="System pages"
                description="Show Inbox, Home, Archive, etc."
                labelPosition="left"
                checked={visibilityFilters.showSystemPages}
                onChange={(e) => setVisibilityFilters(prev => ({
                  ...prev,
                  showSystemPages: e.target.checked
                }))}
              />
            </div>
          </div>
        </ButtonWithPanel>
        
        <Button
          icon={mdiHistory}
          size="sm"
          onClick={() => rendererRef.current?.triggerCreationAnimation()}
          title="Animate by creation time"
        />
      </div>
      
      {/* Top Right: Search and selection */}
      <div className="node-graph-view__top-right">
        <div className="graph-search-panel">
          <div className="graph-search-input-container">
            <input
              type="text"
              className="graph-search-input"
              placeholder="Search to add nodes..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onFocus={() => setSearchOpen(true)}
              onBlur={() => setTimeout(() => setSearchOpen(false), 200)}
            />
            {searchOpen && searchResults.length > 0 && (
              <div className="graph-search-results">
                {searchResults.map((page) => (
                  <Button
                    key={page.id}
                    variant="ghost"
                    className="graph-search-result"
                    onClick={() => addToSelection(page)}
                  >
                    {page.icon && <span className="result-icon">{page.icon}</span>}
                    <span className="result-name">{page.name}</span>
                  </Button>
                ))}
              </div>
            )}
          </div>
          
          {selectedNodes.length > 0 && (
            <div className="graph-selected-list">
              <div className="selected-list-header">
                Selected ({selectedNodes.length})
                <Button
                  icon={mdiTrashCanOutline}
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelectedNodes([])}
                />
              </div>
              <ListSortable
                items={selectedNodes}
                onReorder={moveSelectionItem}
                itemClassName="selected-node-item"
                renderText={(item) => (
                  <span className="node-name">{item.name}</span>
                )}
                renderAction={(item) => (
                  <Button
                    icon={mdiClose}
                    size="xs"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeFromSelection(item.id);
                    }}
                  />
                )}
              />
            </div>
          )}
        </div>
      </div>
      
      {/* Canvas */}
      <NodeGraphRenderer
        ref={rendererRef}
        nodes={nodes}
        links={links}
        viewMode={viewMode}
        settings={graphSettings}
        classColors={classColors}
        visibilityFilters={visibilityFilters}
        selectedNodeIds={selectedNodeIds}
        onNodeClick={handleNodeClick}
        onNodeDoubleClick={handleNodeDoubleClick}
        onNodeRightClick={handleNodeRightClick}
        onSelectionChange={handleSelectionChange}
        className="node-graph-view__renderer"
      />
      
      {/* Bottom Center: Mode switcher */}
      <div className="node-graph-view__bottom-center">
        <SelectionButton
          options={modeOptions}
          value={viewMode}
          onChange={(val) => {
            const newMode = val as GraphViewMode;
            setViewMode(newMode);
            // Auto-switch constraint mode default: tree→physics, circle→equidistant
            if (newMode === 'tree') {
              setGraphSettings(prev => ({ ...prev, constraintMode: 'physics' }));
            } else if (newMode === 'circle') {
              setGraphSettings(prev => ({ ...prev, constraintMode: 'equidistant' }));
            }
          }}
          size="sm"
        />
      </div>
      
      {/* Bottom Right: Recenter */}
      <div className="node-graph-view__bottom-right">
        <Button
          icon={mdiCrosshairsGps}
          size="sm"
          onClick={() => rendererRef.current?.recenter()}
          title="Fit graph to view"
        />
      </div>
    </div>
  );
}

export default NodeGraphView;
