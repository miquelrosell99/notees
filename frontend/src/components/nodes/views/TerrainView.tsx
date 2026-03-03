/**
 * TerrainView Component
 * 
 * NodeCollection view mode for terrain contour visualization.
 * Uses physics engine and renders terrain
 * contour lines based on node mass (height) and link count (peak size).
 * 
 * Features:
 * - Settings panel (mass accumulation, link direction)
 * - Type colors panel with drag reorder
 * - Type visibility toggle
 * - Recenter button
 * - Search panel for node selection
 * 
 * Uses TerrainRenderer for visualization.
 */
import { useState, useCallback, useMemo, useRef, useEffect, useDeferredValue } from 'react';
import { useClasses, useGraphLinks } from '@/hooks';
import { useSettingsQuery } from '@/hooks/useSettings';
import { useAppStore } from '@/stores';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { setSetting } from '@/api/workspaces';
import type { GraphNode as ApiGraphNode } from '@/api/nodes';
import { TerrainRenderer, type TerrainRendererRef } from './TerrainRenderer';
import type { GraphNode, GraphLink, GraphSettings, VisibilityFilters, HeightMode, PeakSizeMode } from './viewTypes';
import { mdiCog, mdiPalette, mdiCrosshairsGps, mdiEye, mdiTrashCanOutline, mdiClose, mdiFileTree, mdiLinkVariant, mdiArrowExpandAll, mdiTextBox } from '@mdi/js';
import { Button } from '@/components/core/Button';
import { ButtonWithPanel } from '@/components/core/ButtonWithPanel';
import { SelectionButton } from '@/components/core/SelectionButton';
import { ListSortable } from '@/components/core/ListSortable';
import { BooleanToggle } from '@/components/core/BooleanToggle';
import { ClassColorsPanel } from '@/components/shared/ClassColorsPanel';
import type { ClassColor } from '@/components/shared/ClassColorsPanel';
import { DEFAULT_SYSTEM_PAGES } from '@/utils/systemPages';
import './GraphView.css'; // Reuse GraphView styles

export interface TerrainViewProps {
  /** Unique ID for this view to persist settings separately */
  viewId?: string;
  /** CSS class */
  className?: string;
  /** Graph nodes to display */
  nodes: ApiGraphNode[];
  /** Currently highlighted node ID (e.g., current page for minimap) */
  currentNodeId?: number | null;
  /** Show settings panels. Default: true */
  showSettings?: boolean;
  /** Show search box and node selection panel. Default: true */
  showSearch?: boolean;
  /** Node click handler override */
  onNodeClick?: (nodeId: number) => void;
}

interface SelectedNodeItem {
  id: number;
  name: string;
  order: number;
}

// Helper to get localStorage key for a view
const getStorageKey = (viewId: string, key: string) => `terrain_${viewId}_${key}`;

export function TerrainView({ 
  viewId = 'default', 
  className = '',
  nodes: apiNodes,
  currentNodeId = null,
  showSettings = true,
  showSearch = true,
  onNodeClick: customNodeClick,
}: TerrainViewProps) {
  const rendererRef = useRef<TerrainRendererRef>(null);
  
  // Fetch links between the provided nodes
  const nodeIds = useMemo(() => apiNodes.map(n => n.id), [apiNodes]);
  const { data: apiLinks = [], isLoading: linksLoading } = useGraphLinks(nodeIds);
  
  const { data: classes } = useClasses();
  const { data: serverSettings } = useSettingsQuery();
  const { openNode, addSidebarCard } = useAppStore();
  
  // View state
  const [selectedNodes, setSelectedNodes] = useState<SelectedNodeItem[]>([]);
  const [pinnedNodes, setPinnedNodes] = useState<Set<number>>(new Set());
  const [simulationPaused, setSimulationPaused] = useState(false);
  
  // Settings state - terrain mode specific
  const [graphSettings, setGraphSettings] = useState<GraphSettings>({
    linkCountAttraction: false,
    nodeSizeMode: 'mass', // Not used in terrain, but keep for compatibility
    heightMode: 'hierarchy',
    peakSizeMode: 'links',
    constraintMode: 'physics',
    linkDirection: 'in',
  });
  const settingsLoadedRef = useRef(false);
  
  // Class colors
  const [classColors, setClassColors] = useState<ClassColor[]>([]);
  const classColorsLoadedRef = useRef(false);
  
  // Skip counters for save effects
  const skipClassColorsSaveRef = useRef(0);
  const skipGraphSettingsSaveRef = useRef(0);
  
  // Visibility filters (class nodes hidden in terrain mode, but other filters apply)
  const [visibilityFilters, setVisibilityFilters] = useState<VisibilityFilters>({
    showClassNodes: false, // Hidden by default in terrain mode
    showClassLinks: false,
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
  
  // Load settings
  useEffect(() => {
    if (!serverSettings) return;
    
    if (!classColorsLoadedRef.current) {
      const saved = serverSettings['graph_class_colors'];
      if (saved) {
        try {
          const parsed = typeof saved === 'string' ? JSON.parse(saved) : saved;
          if (Array.isArray(parsed)) {
            const migrated = parsed.map((cc: ClassColor) => {
              const rawName = cc.className || '';
              return {
                classId: cc.classId,
                className: nodeNameToText(rawName) || rawName || 'Untitled',
                color: cc.color,
                order: cc.order,
              };
            });
            skipClassColorsSaveRef.current++;
            setClassColors(migrated);
          }
        } catch (e) {
          console.error('Failed to parse graph_class_colors:', e);
        }
      }
      classColorsLoadedRef.current = true;
    }
    
    if (!settingsLoadedRef.current) {
      const savedSettings = serverSettings['terrain_settings'];
      if (savedSettings) {
        try {
          const parsed = typeof savedSettings === 'string' ? JSON.parse(savedSettings) : savedSettings;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            // Migrate old heightMode values and force linkDirection
            const migrated = { ...parsed };
            migrated.linkDirection = 'in'; // Always use incoming reference links for size
            skipGraphSettingsSaveRef.current++;
            setGraphSettings(prev => ({ ...prev, ...migrated }));
          }
        } catch (e) {
          console.error('Failed to parse terrain_settings:', e);
        }
      }
      settingsLoadedRef.current = true;
    }
  }, [serverSettings]);
  
  // Save settings
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
      setSetting('terrain_settings', graphSettings).catch(e => {
        console.error('Failed to save terrain_settings:', e);
      });
    }, 500);
    
    return () => clearTimeout(timer);
  }, [graphSettings]);
  
  // Load visibility filters from localStorage
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
  
  // Save visibility filters
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
  
  // Data source
  const sourceNodes = apiNodes;
  const sourceLinks = apiLinks;
  
  // Convert API data to renderer format
  const { nodes, links } = useMemo(() => {
    if (!sourceNodes || sourceNodes.length === 0) return { nodes: [], links: [] };
    
    // Build parent map from links
    const parentMap = new Map<number, number>();
    for (const link of sourceLinks) {
      if (link.type === 'parent') {
        parentMap.set(link.target, link.source);
      } else if (link.type === 'extends') {
        parentMap.set(link.source, link.target);
      }
    }
    
    const nodes: GraphNode[] = sourceNodes.map((apiNode: ApiGraphNode) => {
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
        name: apiNode.name,
        displayName: nodeName,
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
        connectionCount: 0,
        inLinkCount: 0,
        outLinkCount: 0,
        contentSize: apiNode.block_count || 0,
        createdAt: apiNode.created_at,
        visible: true,
        isClassNode: apiNode.is_class || classIds.has(apiNode.id),
      };
    });
    
    const links: GraphLink[] = sourceLinks.map(link => ({
      source: link.source,
      target: link.target,
      type: link.type,
    }));
    
    return { nodes, links };
  }, [sourceNodes, sourceLinks, pinnedNodes, classIds]);
  
  // Selected node IDs
  const selectedNodeIds = useMemo(() => selectedNodes.map(s => s.id), [selectedNodes]);
  
  // Event handlers — click toggles selection, double-click opens node
  const handleNodeClick = useCallback((node: GraphNode, event: { shiftKey: boolean; ctrlKey: boolean }) => {
    if (customNodeClick) {
      customNodeClick(node.id);
      return;
    }
    if (event.shiftKey) {
      addSidebarCard(node.id, node.type);
    } else if (event.ctrlKey) {
      // Ctrl+click: toggle selection
      setSelectedNodes(prev => {
        const exists = prev.find(s => s.id === node.id);
        if (exists) {
          return prev.filter(s => s.id !== node.id);
        } else {
          return [...prev, { id: node.id, name: node.displayName, order: prev.length }];
        }
      });
    } else {
      // Regular click: toggle selection (add if not selected, remove if selected)
      setSelectedNodes(prev => {
        const exists = prev.find(s => s.id === node.id);
        if (exists) {
          return prev.filter(s => s.id !== node.id);
        }
        return [...prev, { id: node.id, name: node.displayName, order: prev.length }];
      });
    }
  }, [customNodeClick, addSidebarCard]);
  
  const handleNodeDoubleClick = useCallback((node: GraphNode) => {
    openNode(node.id);
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
    } else {
      const nodeMap = new Map(nodes.map(n => [n.id, n.displayName]));
      const newSelection = nodeIds.map((id, index) => ({
        id,
        name: nodeMap.get(id) || 'Untitled',
        order: index,
      }));
      setSelectedNodes(newSelection);
    }
  }, [nodes]);
  
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
  
  // Pre-compute display names once per sourceNodes change —
  // searchResults can then read O(1) from this map instead of calling
  // nodeNameToText (parseAST + stringifyAST) on every keystroke.
  const nodeNamesMap = useMemo(() => {
    const map = new Map<number, string>();
    for (const n of sourceNodes ?? []) {
      map.set(n.id, nodeNameToText(n.name) || 'Untitled');
    }
    return map;
  }, [sourceNodes]);

  const deferredSearchQuery = useDeferredValue(searchQuery);

  // Search
  const searchResults = useMemo(() => {
    if (!deferredSearchQuery.trim() || !sourceNodes) return [];
    const q = deferredSearchQuery.toLowerCase();
    return sourceNodes
      .filter(p => (nodeNamesMap.get(p.id) ?? '').toLowerCase().includes(q))
      .slice(0, 10)
      .map(p => ({ id: p.id, uuid: p.uuid, name: nodeNamesMap.get(p.id) ?? 'Untitled', icon: p.icon }));
  }, [deferredSearchQuery, sourceNodes, nodeNamesMap]);
  
  const addToSelection = useCallback((node: { id: number; name?: string }) => {
    setSelectedNodes(prev => {
      if (prev.find(s => s.id === node.id)) return prev;
      return [...prev, { id: node.id, name: node.name || 'Untitled', order: prev.length }];
    });
    setSearchQuery('');
    setSearchOpen(false);
  }, []);
  
  // Class color handler
  const handleClassColorsChange = useCallback((newClassColors: ClassColor[]) => {
    setClassColors(newClassColors);
  }, []);
  
  if (!sourceNodes || sourceNodes.length === 0) {
    return (
      <div className={`node-graph-view empty ${className}`}>
        <div className="node-graph-view__empty">
          <h3>No nodes to display</h3>
          <p>Create some pages to see them in the terrain view.</p>
        </div>
      </div>
    );
  }
  
  return (
    <div className={`node-graph-view ${className}`}>
      <div className="node-graph-view__top-left">
        {/* Settings panels */}
        {showSettings && (
          <>
            <ButtonWithPanel
              icon={mdiCog}
              size="sm"
              panelPosition="right"
              panelAlignment="start"
              panelWidth={280}
              title="Terrain Settings"
              tooltip="Terrain settings"
              open={settingsOpen}
              onOpenChange={setSettingsOpen}
            >
              <div className="visibility-panel-content">
                <div className="visibility-option">
                  <SelectionButton
                    size="sm"
                    label="Height"
                    description="How terrain peak height is determined"
                    labelPosition="left"
                    options={[
                      { value: 'hierarchy', icon: mdiFileTree, label: 'Parent / child' },
                      { value: 'references', icon: mdiLinkVariant, label: 'Reference links' },
                    ]}
                    value={graphSettings.heightMode}
                    onChange={(value) => setGraphSettings(prev => ({
                      ...prev,
                      heightMode: value as HeightMode
                    }))}
                  />
                </div>
                <div className="visibility-option">
                  <SelectionButton
                    size="sm"
                    label="Peak size"
                    description="How terrain peak radius is determined"
                    labelPosition="left"
                    options={[
                      { value: 'links', icon: mdiArrowExpandAll, label: 'Links in' },
                      { value: 'pageSize', icon: mdiTextBox, label: 'Page characters' },
                    ]}
                    value={graphSettings.peakSizeMode}
                    onChange={(value) => setGraphSettings(prev => ({
                      ...prev,
                      peakSizeMode: value as PeakSizeMode
                    }))}
                  />
                </div>

                <div className="visibility-option">
                  <BooleanToggle
                    size="sm"
                    label="Simulation"
                    description="Run or pause the physics simulation"
                    labelPosition="left"
                    checked={!simulationPaused}
                    onChange={(e) => {
                      if (e.target.checked) {
                        rendererRef.current?.resumeSimulation();
                        setSimulationPaused(false);
                      } else {
                        rendererRef.current?.pauseSimulation();
                        setSimulationPaused(true);
                      }
                    }}
                  />
                </div>

                <div className="visibility-option">
                  <BooleanToggle
                    size="sm"
                    label="Debug grid"
                    description="Show height map, stamp boxes, and grid overlay"
                    labelPosition="left"
                    checked={graphSettings.showDebugGrid ?? false}
                    onChange={(e) => setGraphSettings(prev => ({
                      ...prev,
                      showDebugGrid: e.target.checked
                    }))}
                  />
                </div>
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
                    label="Hierarchy links"
                    description="Lines between parent/child pages"
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
                    description="Lines for [[wiki links]]"
                    labelPosition="left"
                    checked={visibilityFilters.showReferenceLinks}
                    onChange={(e) => setVisibilityFilters(prev => ({
                      ...prev,
                      showReferenceLinks: e.target.checked
                    }))}
                  />
                </div>
                <div className="visibility-section-divider" />
                <div className="visibility-option">
                  <BooleanToggle
                    size="sm"
                    label="Daily pages"
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
                    label="Monthly pages"
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
                    label="Yearly pages"
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
                    description="Built-in pages like Settings, Templates"
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
          </>
        )}
      </div>
      
      {/* Recenter button — bottom right */}
      <div className="terrain-recenter-btn">
        <Button
          icon={mdiCrosshairsGps}
          size="sm"
          variant="ghost"
          onClick={() => rendererRef.current?.recenter()}
          title="Recenter view"
        />
      </div>
      
      {/* Top Right: Search and selection */}
      {showSearch && (
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
      )}
      
      {/* Show spinner overlay while links are loading; don't mount the renderer
         until links have arrived so the physics engine initializes only once with
         the correct topology (prevents two-phase init and progressive edge appearance). */}
      {linksLoading ? (
        <div className="node-graph-view__loading-overlay">
          <div className="node-graph-view__spinner" />
        </div>
      ) : (
        <TerrainRenderer
          ref={rendererRef}
          nodes={nodes}
          links={links}
          settings={graphSettings}
          classColors={classColors}
          visibilityFilters={visibilityFilters}
          currentNodeId={currentNodeId}
          selectedNodeIds={selectedNodeIds}
          className="node-graph-view__renderer"
          onNodeClick={handleNodeClick}
          onNodeDoubleClick={handleNodeDoubleClick}
          onNodeRightClick={handleNodeRightClick}
          onSelectionChange={handleSelectionChange}
        />
      )}
    </div>
  );
}
