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
import { useState, useCallback, useMemo, useRef, useEffect, useDeferredValue } from 'react';
import { useClasses, useGraphLinks } from '@/hooks';
import { useSettingsQuery } from '@/hooks/useSettings';
import { useAppStore } from '@/stores';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { setSetting } from '@/api/workspaces';
import type { GraphNode as ApiGraphNode } from '@/api/nodes';
import { GraphRenderer, type GraphRendererRef } from './GraphRenderer';
import type {
  GraphNode,
  GraphLink,
  GraphSettings,
  VisibilityFilters,
  ConstraintMode,
  LinkDirection,
  GraphDataMode,
} from './viewTypes';
import { mdiCog, mdiPalette, mdiCrosshairsGps, mdiEye, mdiCircleOutline, mdiTrashCanOutline, mdiClose, mdiConnection, mdiWeight, mdiAtom, mdiDistributeHorizontalCenter, mdiCallReceived, mdiCallMade, mdiSwapHorizontal, mdiNote, mdiFileTree } from '@mdi/js';
import { Button } from '@/components/core/Button';
import { ButtonWithPanel } from '@/components/core/ButtonWithPanel';
import { SelectionButton } from '@/components/core/SelectionButton';
import { ListSortable } from '@/components/core/ListSortable';
import { BooleanToggle } from '@/components/core/BooleanToggle';
import { ClassColorsPanel } from '@/components/shared/ClassColorsPanel';
import type { ClassColor } from '@/components/shared/ClassColorsPanel';
import { DEFAULT_SYSTEM_PAGES } from '@/utils/systemPages';
import './GraphView.css';

// Stable empty-array references so the renderer receives a consistent identity
// while links are still loading (avoids re-triggering topology sync).
const EMPTY_NODES: GraphNode[] = [];
const EMPTY_EDGES: GraphLink[] = [];

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
  currentNodeId: _currentNodeId = null,
  showSettings = true,
  showSearch = true,
  showViewModes = true,
  onNodeClick: customNodeClick,
}: GraphViewProps) {
  const rendererRef = useRef<GraphRendererRef>(null);
  
  // Fetch links between the provided nodes
  // Stabilize nodeIds with a content-based key so useGraphLinks doesn't refetch
  // when apiNodes is a new array reference with the same IDs (common with TanStack Query)
  const nodeIds = useMemo(() => apiNodes.map(n => n.id), [apiNodes]);
  const prevNodeIdsRef = useRef<number[]>([]);
  const stableNodeIds = useMemo(() => {
    const prev = prevNodeIdsRef.current;
    if (
      prev.length === nodeIds.length &&
      prev.every((id, i) => id === nodeIds[i])
    ) {
      return prev;
    }
    prevNodeIdsRef.current = nodeIds;
    return nodeIds;
  }, [nodeIds]);

  // Graph data mode: standard (explicit links) vs semantic (co-occurrence inference)
  const [graphDataMode, setGraphDataMode] = useState<GraphDataMode>(() => {
    try {
      return (localStorage.getItem(getStorageKey(viewId, 'data_mode')) as GraphDataMode) || 'standard';
    } catch {
      return 'standard';
    }
  });

  const { data: apiLinks = [], isLoading: linksLoading } = useGraphLinks(stableNodeIds, {
    semantic: graphDataMode === 'semantic',
  });
  
  const { data: classes } = useClasses();
  const { data: serverSettings } = useSettingsQuery();
  const { openNode } = useAppStore();
  
  // View state
  const [selectedNodes, setSelectedNodes] = useState<SelectedNodeItem[]>([]);
  const [pinnedNodes, setPinnedNodes] = useState<Set<number>>(new Set());
  const [simulationPaused, setSimulationPaused] = useState(false);
  
  // Settings state
  const [graphSettings, setGraphSettings] = useState<GraphSettings>({
    linkCountAttraction: false,
    centralGravity: true,
    nodeSizeMode: 'uniform',
    heightMode: 'hierarchy',
    peakSizeMode: 'links',
    constraintMode: 'physics',
    linkDirection: 'all',
  });
  const settingsLoadedRef = useRef(false);
  
  // Node radius (world units) — separate from graphSettings because it feeds directly to the renderer
  const [baseNodeRadius, setBaseNodeRadius] = useState(7);
  
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
    showSemanticLinks: true,
  });
  const visibilityFiltersLoadedRef = useRef(false);
  
  // UI panel state
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [classColorsOpen, setClassColorsOpen] = useState(false);
  const [typeVisibilityOpen, setTypeVisibilityOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [viewMode, setViewMode] = useState<'normal' | 'circle' | 'tree'>('normal');
  
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
            const migrated = parsed.map((cc: Record<string, unknown>) => {
              const rawName = (cc.className ?? '') as string;
              const converted = nodeNameToText(rawName);
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
  
  // Persist graphDataMode to localStorage whenever it changes
  useEffect(() => {
    try {
      localStorage.setItem(getStorageKey(viewId, 'data_mode'), graphDataMode);
    } catch {
      // ignore
    }
  }, [graphDataMode, viewId]);

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
  
  // Convert API data to renderer format, applying visibility filters and class colors
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

    // Build class-color lookup: classId → hex color string
    const classColorMap = new Map<number, string>();
    for (const cc of classColors) {
      classColorMap.set(cc.classId, cc.color);
    }

    // Build full nodes
    const allNodes: GraphNode[] = sourceNodes.map((apiNode: ApiGraphNode) => {
      const nodeName = nodeNameToText(apiNode.name) || 'Untitled';
      const isSystemPage = DEFAULT_SYSTEM_PAGES.some(
        sysName => sysName.toLowerCase() === nodeName.toLowerCase()
      );
      const isClassNode = apiNode.is_class || classIds.has(apiNode.id);

      // Class color: first matching class in the node's type list
      let resolvedColor = (apiNode.properties?.color as string) || undefined;
      if (!resolvedColor) {
        for (const typeId of (apiNode.class_ids || [])) {
          const cc = classColorMap.get(typeId);
          if (cc) { resolvedColor = cc; break; }
        }
      }

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
        color: resolvedColor,
        connectionCount: 0,
        inLinkCount: 0,
        outLinkCount: 0,
        contentSize: apiNode.block_count || 0,
        createdAt: apiNode.created_at,
        visible: true,
        isClassNode,
      };
    });

    // Apply visibility filters to nodes
    const visibleNodes = allNodes.filter(n => {
      if (!visibilityFilters.showClassNodes && n.isClassNode) return false;
      if (!visibilityFilters.showDayPages   && n.isDaily)    return false;
      if (!visibilityFilters.showMonthPages && n.isMonthly)  return false;
      if (!visibilityFilters.showYearPages  && n.isYearly)   return false;
      if (!visibilityFilters.showSystemPages && n.isSystemPage) return false;
      return true;
    });

    const visibleIds = new Set(visibleNodes.map(n => n.id));

    // Apply visibility filters to links
    const visibleLinks: GraphLink[] = sourceLinks
      .filter(link => {
        if (!visibleIds.has(link.source) || !visibleIds.has(link.target)) return false;
        if (!visibilityFilters.showClassLinks &&
            (link.type === 'class')) return false;
        if (!visibilityFilters.showParentLinks &&
            (link.type === 'parent' || link.type === 'extends')) return false;
        if (!visibilityFilters.showReferenceLinks &&
            (link.type === 'reference' || link.type === 'property-reference')) return false;
        if (!visibilityFilters.showSemanticLinks && link.type === 'semantic') return false;
        return true;
      })
      .map(link => ({ source: link.source, target: link.target, type: link.type }));
    
    return { nodes: visibleNodes, links: visibleLinks };
  }, [sourceNodes, sourceLinks, pinnedNodes, classIds, classColors, visibilityFilters]);
  
  // Event handlers — SGEGraphView fires (nodeId: number) without event objects
  const handleNodeClick = useCallback((nodeId: number) => {
    if (customNodeClick) {
      customNodeClick(nodeId);
      return;
    }
    // Toggle selection
    setSelectedNodes(prev => {
      const exists = prev.find(s => s.id === nodeId);
      if (exists) return prev.filter(s => s.id !== nodeId);
      const name = nodes.find(n => n.id === nodeId)?.displayName ?? 'Untitled';
      return [...prev, { id: nodeId, name, order: prev.length }];
    });
  }, [customNodeClick, nodes]);

  const handleNodeDoubleClick = useCallback((nodeId: number) => {
    openNode(nodeId);
    setSelectedNodes([]);
  }, [openNode]);

  
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

  // Search — use sourceNodes to avoid loading full Node objects twice
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
                label="Central gravity"
                description="Pull disconnected components toward the canvas center"
                labelPosition="left"
                checked={graphSettings.centralGravity}
                onChange={(e) => setGraphSettings(prev => ({
                  ...prev,
                  centralGravity: e.target.checked
                }))}
              />
            </div>
            
            <div className="visibility-option">
              <BooleanToggle
                size="sm"
                label="Mass accumulation"
                description="Parent nodes resist movement based on descendants"
                labelPosition="left"
                checked={graphSettings.heightMode === 'hierarchy'}
                onChange={(e) => setGraphSettings(prev => ({
                  ...prev,
                  heightMode: e.target.checked ? 'hierarchy' : 'references'
                }))}
              />
            </div>

            <div className="visibility-option">
              <SelectionButton
                size="sm"
                label="Node sizing"
                description="Size nodes uniformly, by connections, mass, or content"
                labelPosition="left"
                options={[
                  { value: 'uniform', icon: mdiCircleOutline, label: 'Uniform size' },
                  { value: 'connections', icon: mdiConnection, label: 'Connection count' },
                  { value: 'mass', icon: mdiWeight, label: 'Hierarchy mass' },
                  { value: 'content', icon: mdiNote, label: 'Content size' }
                ]}
                value={graphSettings.nodeSizeMode}
                onChange={(value) => setGraphSettings(prev => ({
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
                    min={3}
                    max={20}
                    step={1}
                    value={baseNodeRadius}
                    onChange={(e) => setBaseNodeRadius(Number(e.target.value))}
                    className="graph-radius-slider"
                  />
                  <span className="graph-radius-value">{baseNodeRadius}</span>
                </div>
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
                label="Semantic links"
                description="Fetch and show inferred co-occurrence links"
                labelPosition="left"
                checked={graphDataMode === 'semantic'}
                onChange={(e) => {
                  const mode = e.target.checked ? 'semantic' : 'standard';
                  setGraphDataMode(mode);
                  if (!e.target.checked) {
                    setVisibilityFilters(prev => ({ ...prev, showSemanticLinks: false }));
                  } else {
                    setVisibilityFilters(prev => ({ ...prev, showSemanticLinks: true }));
                  }
                }}
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
      
      {/* Show spinner overlay while links are loading; the renderer stays
         mounted (WebGL + worker ready) but receives empty data so the physics
         engine doesn't do a wasted initialisation with 0 edges.  Once links
         arrive both nodes AND edges are passed together → single init. */}
      {linksLoading && (
        <div className="node-graph-view__loading-overlay">
          <div className="node-graph-view__spinner" />
        </div>
      )}
      <GraphRenderer
        ref={rendererRef}
        nodes={linksLoading ? EMPTY_NODES : nodes}
        edges={linksLoading ? EMPTY_EDGES : links}
        sizeByConnections={graphSettings.nodeSizeMode === 'connections'}
        baseNodeRadius={baseNodeRadius}
        onNodeClick={handleNodeClick}
        onNodeDblClick={handleNodeDoubleClick}
        onEmptyClick={() => setSelectedNodes([])}
        className="node-graph-view__renderer"
      />
      
      {/* Bottom Center: View mode switcher */}
      {showViewModes && (
        <div className="node-graph-view__bottom-center">
          <SelectionButton
            size="sm"
            options={[
              { value: 'normal', icon: mdiAtom, label: 'Normal' },
              { value: 'circle', icon: mdiCircleOutline, label: 'Circle' },
              { value: 'tree', icon: mdiFileTree, label: 'Tree' },
            ]}
            value={viewMode}
            onChange={(value) => setViewMode(value as 'normal' | 'circle' | 'tree')}
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
