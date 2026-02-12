/**
 * GraphView Component
 * 
 * NodeCollection view mode for force-directed graph visualization.
 * Always receives nodes/links as props from the parent.
 * 
 * Features:
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
import { useClasses, useGraphLinks } from '@/hooks';
import { useSettingsQuery } from '@/hooks/useSettings';
import { useAppStore } from '@/stores';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { setSetting } from '@/api/databases';
import type { GraphNode as ApiGraphNode } from '@/api/nodes';
import { GraphRenderer, type GraphRendererRef } from './GraphRenderer';
import type {
  GraphNode,
  GraphLink,
  GraphSettings,
  GraphViewMode,
  GraphLayoutMode,
  VisibilityFilters,
  ConstraintMode,
  LinkDirection,
} from './viewTypes';
import { mdiCog, mdiPalette, mdiCrosshairsGps, mdiHistory, mdiEyeOff, mdiEye, mdiVectorPolygon, mdiCircleOutline, mdiFileTreeOutline, mdiTrashCanOutline, mdiClose, mdiConnection, mdiWeight, mdiAtom, mdiDistributeHorizontalCenter, mdiCallReceived, mdiCallMade, mdiSwapHorizontal } from '@mdi/js';
import { Button } from '@/components/core/Button';
import { ButtonWithPanel } from '@/components/core/ButtonWithPanel';
import { SelectionButton } from '@/components/core/SelectionButton';
import { ListSortable } from '@/components/core/ListSortable';
import { BooleanToggle } from '@/components/core/BooleanToggle';
import { ClassColorsPanel } from '@/components/shared/ClassColorsPanel';
import type { ClassColor } from '@/components/shared/ClassColorsPanel';
import { DEFAULT_SYSTEM_PAGES } from '@/utils/systemPages';
import './GraphView.css';

// Default class colors
const DEFAULT_CLASS_COLORS = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#14b8a6', '#f97316', '#3b82f6', '#84cc16',
];

export interface GraphViewProps {
  /** Unique ID for this view to persist settings separately */
  viewId?: string;
  /** CSS class */
  className?: string;
  /** Graph nodes to display */
  nodes: ApiGraphNode[];
  /** Currently highlighted node ID (e.g., current page for minimap) */
  currentNodeId?: number | null;
  /** Show settings panels (graph settings, class colors, visibility filters, animation). Default: true */
  showSettings?: boolean;
  /** Show search box and node selection panel. Default: true */
  showSearch?: boolean;
  /** Show view mode switcher (normal, circle, tree). Default: true */
  showViewModes?: boolean;
  /** Node click handler override */
  onNodeClick?: (nodeId: number) => void;
}

interface SelectedNodeItem {
  id: number;
  name: string;
  order: number;
}

// Helper to get localStorage key for a view
const getStorageKey = (viewId: string, key: string) => `graph_${viewId}_${key}`;

export function GraphView({ 
  viewId = 'default', 
  className = '',
  nodes: apiNodes,
  currentNodeId = null,
  showSettings = true,
  showSearch = true,
  showViewModes = true,
  onNodeClick: customNodeClick,
}: GraphViewProps) {
  const rendererRef = useRef<GraphRendererRef>(null);
  
  // Fetch links between the provided nodes
  const nodeIds = useMemo(() => apiNodes.map(n => n.id), [apiNodes]);
  const { data: apiLinks = [] } = useGraphLinks(nodeIds);
  
  const { data: classes } = useClasses();
  const { data: serverSettings } = useSettingsQuery();
  const { openNode, addSidebarCard } = useAppStore();
  
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
    linkDirection: 'all',
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
            // Convert raw AST class names to text
            console.log('[GraphView] Loading class colors, raw:', JSON.stringify(parsed));
            const migrated = parsed.map((cc: Record<string, unknown>) => {
              const rawName = (cc.className ?? '') as string;
              const converted = nodeNameToText(rawName);
              console.log('[GraphView] Migrate class color:', { rawName, converted, type: typeof rawName });
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
  
  // Data source: nodes from props, links from hook
  const sourceNodes = apiNodes;
  const sourceLinks = apiLinks;
  
  // Convert API data to renderer format
  const { nodes, links } = useMemo(() => {
    if (!sourceNodes || sourceNodes.length === 0) return { nodes: [], links: [] };
    
    // Build parent map from links
    // - 'parent' links: actual parent-child relationships (target is child of source)
    // - 'extends' links: class inheritance (source extends target, so target is parent)
    const parentMap = new Map<number, number>();
    for (const link of sourceLinks) {
      if (link.type === 'parent') {
        parentMap.set(link.target, link.source);
      } else if (link.type === 'extends') {
        // Class extends: source extends target, so target is the parent
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
        name: apiNode.name, // Keep raw AST name for NodeInline
        displayName: nodeName, // Cache parsed name for canvas rendering
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
        inLinkCount: 0,
        outLinkCount: 0,
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
  
  // Event handlers
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
  }, [customNodeClick, addSidebarCard]);
  
  const handleNodeDoubleClick = useCallback((node: GraphNode) => {
    // Graph nodes are always pages (backend only returns is_page=TRUE nodes)
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
      // Convert node IDs to SelectedNodeItem objects
      const nodeMap = new Map(nodes.map(n => [n.id, n.name]));
      const newSelection = nodeIds.map((id, index) => ({
        id,
        name: nodeMap.get(id) || 'Untitled',
        order: index,
      }));
      setSelectedNodes(newSelection);
    }
  }, [nodes]);
  
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
  
  // Search — use sourceNodes to avoid loading full Node objects twice
  const searchResults = useMemo(() => {
    if (!searchQuery.trim() || !sourceNodes) return [];
    const query = searchQuery.toLowerCase();
    return sourceNodes
      .map(p => ({ id: p.id, uuid: p.uuid, name: nodeNameToText(p.name) || 'Untitled', icon: p.icon }))
      .filter(p => p.name.toLowerCase().includes(query))
      .slice(0, 10);
  }, [searchQuery, sourceNodes]);
  
  const addToSelection = useCallback((node: { id: number; name?: string }) => {
    setSelectedNodes(prev => {
      if (prev.find(s => s.id === node.id)) return prev;
      return [...prev, { id: node.id, name: node.name || 'Untitled', order: prev.length }];
    });
    setSearchQuery('');
    setSearchOpen(false);
  }, []);
  
  // View mode options (terrain is now its own view mode at NodeCollection level)
  const modeOptions = [
    { value: 'normal', icon: mdiVectorPolygon, label: 'Force-directed layout' },
    { value: 'circle', icon: mdiCircleOutline, label: 'Circle layout' },
    { value: 'tree', icon: mdiFileTreeOutline, label: 'Tree layout' },
  ];
  
  if (!sourceNodes || sourceNodes.length === 0) {
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
      {showSettings && (
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

            {graphSettings.nodeSizeMode === 'connections' && (
              <div className="visibility-option">
                <SelectionButton
                  size="sm"
                  label="Link direction"
                  description="Count incoming, outgoing, or all links"
                  labelPosition="left"
                  options={[
                    { value: 'in', icon: mdiCallReceived, label: 'Incoming links' },
                    { value: 'out', icon: mdiCallMade, label: 'Outgoing links' },
                    { value: 'all', icon: mdiSwapHorizontal, label: 'All links' }
                  ]}
                  value={graphSettings.linkDirection}
                  onChange={(value) => setGraphSettings(prev => ({
                    ...prev,
                    linkDirection: value as LinkDirection
                  }))}
                />
              </div>
            )}

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
      )}
      
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
      
      {/* Canvas */}
      <GraphRenderer
        ref={rendererRef}
        nodes={nodes}
        links={links}
        viewMode={viewMode as GraphLayoutMode}
        settings={graphSettings}
        classColors={classColors}
        visibilityFilters={visibilityFilters}
        currentNodeId={currentNodeId}
        selectedNodeIds={selectedNodeIds}
        onNodeClick={handleNodeClick}
        onNodeDoubleClick={handleNodeDoubleClick}
        onNodeRightClick={handleNodeRightClick}
        onSelectionChange={handleSelectionChange}
        className="node-graph-view__renderer"
      />
      
      {/* Bottom Center: Mode switcher */}
      {showViewModes && (
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
      )}
      
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

export default GraphView;
