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
import { useNavigationStore } from '@/stores';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { NodeIcon } from '@/components/core/icons';
import { setSetting } from '@/api/workspaces';
import type { GraphNode as ApiGraphNode } from '@/api/nodes';
import { GraphRenderer, type GraphRendererRef } from './GraphRenderer';
import type {
  GraphNode,
  GraphLink,
  GraphSettings,
  VisibilityFilters,
  GraphDataMode,
  GraphColorGroup,
} from './viewTypes';
import type { SGEConfig } from './SemanticGraphEngine';
import { applyCircleLayout } from './circleLayout';
import { applyTreeLayout } from './treeLayout';
import { Button } from '@/components/core/Button';
import { SelectionButton } from '@/components/core/SelectionButton';
import { ListSortable } from '@/components/core/ListSortable';
import { GraphGroupModal } from './GraphGroupModal';
import { GraphSettingsSidebar } from './GraphSettingsSidebar';
import { evaluateQueryAST, buildEvalContext } from './evaluateQueryAST';
import { DEFAULT_SYSTEM_PAGES } from '@/utils/systemPages';
import './GraphView.css';
import { registerView } from './registry';
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
  /** When true, activates local-graph behaviour (hide-self default, collapsed sidebar, no filter persistence) */
  localGraphMode?: boolean;
}

interface SelectedNodeItem {
  id: number;
  name: string;
  order: number;
}

// Helper to get localStorage key for a view
const getStorageKey = (viewId: string, key: string) => `graph_${viewId}_${key}`;

const TAG_COLOR_PALETTE = [
  '#c55a55', // red
  '#c98557', // orange
  '#b8a23a', // yellow
  '#4f8f6a', // green
  '#4a8a83', // teal
  '#5a79c9', // blue
  '#8a6cc9', // purple
  '#c06a9a', // pink
];

function getTagColor(tag: string): string {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) {
    hash = tag.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % TAG_COLOR_PALETTE.length;
  return TAG_COLOR_PALETTE[index];
}

/** Derive SGE physics config from user-facing graph settings. */
function buildSGEConfig(settings: GraphSettings, viewMode: 'normal' | 'circle' | 'tree'): Partial<SGEConfig> {
  const isConstrained = (viewMode === 'circle' || viewMode === 'tree') && settings.constraintMode === 'equidistant';
  return {
    springStrength: isConstrained ? 0.15 : settings.linkCountAttraction ? 0.055 : 0.035,
    damping: isConstrained ? 0.78 : 0.85,
    idealDistance: isConstrained ? 90 : 80,
    maxVelocity: isConstrained ? 8 : 15,
    componentCenterStrength: settings.centralGravity ? 0.003 : 0,
    radialStrength: isConstrained ? 0.004 : settings.heightMode === 'hierarchy' ? 0.002 : 0.0005,
    clusterStrength: isConstrained ? 0.008 : settings.heightMode === 'hierarchy' ? 0.006 : 0.003,
    linkCountAttraction: settings.linkCountAttraction,
  };
}

export function GraphView({ 
  viewId = 'default', 
  className = '',
  nodes: apiNodes,
  currentNodeId,
  localGraphMode = false,
  showSettings = true,
  showSearch = true,
  showViewModes = true,
  onNodeClick: customNodeClick,
}: GraphViewProps) {
  const rendererRef = useRef<GraphRendererRef>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(localGraphMode);
  
  // Fetch links between the provided nodes
  const nodeIds = useMemo(() => apiNodes.map(n => n.id), [apiNodes]);

  // Graph data mode: standard (explicit links) vs co-occurrence inference
  const [graphDataMode, setGraphDataMode] = useState<GraphDataMode>(() => {
    try {
      const raw = localStorage.getItem(getStorageKey(viewId, 'data_mode'));
      // Backward compat: old 'semantic' value maps to 'cooccurrence'
      if (raw === 'semantic' || raw === 'cooccurrence') return 'cooccurrence';
      return (raw as GraphDataMode) || 'standard';
    } catch {
      return 'standard';
    }
  });

  const { data: apiLinks = [], isLoading: linksLoading } = useGraphLinks(nodeIds, {
    cooccurrence: graphDataMode === 'cooccurrence',
    contextNodeId: localGraphMode ? currentNodeId ?? null : null,
  });
  
  const { data: classes } = useClasses();
  const { data: serverSettings } = useSettingsQuery();
  const { openNode } = useNavigationStore();
  
  // View state
  const [selectedNodes, setSelectedNodes] = useState<SelectedNodeItem[]>([]);
  const [pinnedNodes] = useState<Set<number>>(new Set());
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
  const [baseNodeRadius, setBaseNodeRadius] = useState(20);
  
  // Unified color groups (QueryAST-based)
  const [colorGroups, setColorGroups] = useState<GraphColorGroup[]>([]);
  const colorGroupsLoadedRef = useRef(false);
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  
  // Tracks how many state changes should be skipped by the save effects.
  // Incremented when loading from server, so the subsequent render doesn't
  // fire a no-op PUT back.
  const skipColorGroupsSaveRef = useRef(0);
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
    showCooccurrenceLinks: true,
    hideSelfNode: localGraphMode || false,
  });
  const visibilityFiltersLoadedRef = useRef(false);
  
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [viewMode, setViewMode] = useState<'normal' | 'circle' | 'tree'>('normal');

  const sgeConfig = useMemo(() => buildSGEConfig(graphSettings, viewMode), [graphSettings, viewMode]);
  
  // Load graph settings from cached TanStack Query data
  useEffect(() => {
    if (!serverSettings) return;
    
    if (!colorGroupsLoadedRef.current) {
      const saved = serverSettings['graph_color_groups'];
      if (saved) {
        try {
          const parsed = typeof saved === 'string' ? JSON.parse(saved) : saved;
          if (Array.isArray(parsed)) {
            skipColorGroupsSaveRef.current++;
            setColorGroups(parsed as GraphColorGroup[]);
          }
        } catch (e) {
          console.error('Failed to parse graph_color_groups:', e);
        }
      }
      colorGroupsLoadedRef.current = true;
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
  
  // Save color groups (debounced) — skip save-backs triggered by initial load
  useEffect(() => {
    if (!colorGroupsLoadedRef.current) return;
    if (skipColorGroupsSaveRef.current > 0) {
      skipColorGroupsSaveRef.current--;
      return;
    }
    
    const timer = setTimeout(() => {
      setSetting('graph_color_groups', colorGroups).catch(e => {
        console.error('Failed to save graph_color_groups:', e);
      });
    }, 500);
    
    return () => clearTimeout(timer);
  }, [colorGroups]);
  
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
        setVisibilityFilters(prev => ({
          ...prev,
          ...parsed,
          // Backward compat: migrate old showSemanticLinks to showCooccurrenceLinks
          showCooccurrenceLinks: parsed.showSemanticLinks ?? parsed.showCooccurrenceLinks ?? prev.showCooccurrenceLinks,
          // In local graph mode, always reset hideSelfNode to true (no memory)
          hideSelfNode: localGraphMode ? true : (parsed.hideSelfNode ?? prev.hideSelfNode),
        }));
      } else if (localGraphMode) {
        setVisibilityFilters(prev => ({ ...prev, hideSelfNode: true }));
      }
    } catch (e) {
      console.error('Failed to load visibility filters:', e);
    }
    visibilityFiltersLoadedRef.current = true;
  }, [viewId, localGraphMode]);
  
  // Save visibility filters to localStorage (debounced, per-view)
  useEffect(() => {
    if (!visibilityFiltersLoadedRef.current) return;
    
    const timer = setTimeout(() => {
      try {
        // In local graph mode, do not persist hideSelfNode
        if (localGraphMode) {
          const filtersToSave = { ...visibilityFilters };
          delete filtersToSave.hideSelfNode;
          localStorage.setItem(getStorageKey(viewId, 'visibility_filters'), JSON.stringify(filtersToSave));
        } else {
          localStorage.setItem(getStorageKey(viewId, 'visibility_filters'), JSON.stringify(visibilityFilters));
        }
      } catch (e) {
        console.error('Failed to save visibility filters:', e);
      }
    }, 500);
    
    return () => clearTimeout(timer);
  }, [visibilityFilters, viewId, localGraphMode]);
  
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

    // Build eval context for QueryAST-based color groups
    const evalContext = colorGroups.length > 0
      ? buildEvalContext(sourceNodes, sourceLinks, classes ?? [])
      : null;

    // Build full nodes
    const allNodes: GraphNode[] = sourceNodes.map((apiNode: ApiGraphNode) => {
      const nodeName = nodeNameToText(apiNode.name) || 'Untitled';
      const isSystemPage = DEFAULT_SYSTEM_PAGES.some(
        sysName => sysName.toLowerCase() === nodeName.toLowerCase()
      );
      const isClassNode = apiNode.is_class || classIds.has(apiNode.id);

      // Color resolution: explicit → query groups → tag fallback
      let resolvedColor = (apiNode.properties?.color as string) || undefined;
      if (!resolvedColor && evalContext) {
        for (const group of colorGroups) {
          if (evaluateQueryAST(group.query, apiNode, evalContext)) {
            resolvedColor = group.color;
            break;
          }
        }
      }
      if (!resolvedColor && apiNode.tags && apiNode.tags.length > 0) {
        resolvedColor = getTagColor(apiNode.tags[0]);
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
      // Local graph: hide the ego / center node when requested
      if (localGraphMode && visibilityFilters.hideSelfNode && currentNodeId != null && n.id === currentNodeId) {
        return false;
      }
      return true;
    });

    // Apply circle/tree initial positions so view modes are visible immediately
    if (viewMode === 'circle') {
      const nodeSpacing = baseNodeRadius * 2.5 * 2 + 8;
      applyCircleLayout(visibleNodes, 0, 0, nodeSpacing);
      for (const n of visibleNodes) {
        // Use a tiny non-zero sentinel so SGE doesn't fall back to spiral defaults
        n.x = n.targetX === 0 ? 0.001 : n.targetX;
        n.y = n.targetY === 0 ? 0.001 : n.targetY;
      }
    } else if (viewMode === 'tree') {
      const nodeSpacing = baseNodeRadius * 2.5 * 2 + 8;
      const levelGap = baseNodeRadius * 2.5 * 2 + 40;
      applyTreeLayout(visibleNodes, 0, 0, nodeSpacing, levelGap, graphSettings.constraintMode);
      for (const n of visibleNodes) {
        n.x = n.targetX === 0 ? 0.001 : n.targetX;
        n.y = n.targetY === 0 ? 0.001 : n.targetY;
      }
    }

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
        if (!visibilityFilters.showCooccurrenceLinks && link.type === 'cooccurrence') return false;
        // Local graph: hide edges touching the ego / center node when requested
        if (localGraphMode && visibilityFilters.hideSelfNode && currentNodeId != null) {
          if (link.source === currentNodeId || link.target === currentNodeId) return false;
        }
        return true;
      })
      .map(link => ({ source: link.source, target: link.target, type: link.type }));
    
    return { nodes: visibleNodes, links: visibleLinks };
  }, [sourceNodes, sourceLinks, pinnedNodes, classIds, colorGroups, classes, visibilityFilters, viewMode, baseNodeRadius, graphSettings.constraintMode]);
  
  // Forward live graph-settings changes to the physics worker
  useEffect(() => {
    if (!settingsLoadedRef.current) return;
    rendererRef.current?.setConfig(sgeConfig);
  }, [sgeConfig]);

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

  // Keyboard shortcuts for graph navigation
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Only handle when the graph view is focused / no input is active
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }
      const renderer = rendererRef.current;
      if (!renderer) return;

      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault();
          renderer.panBy(0, 40);
          break;
        case 'ArrowDown':
          e.preventDefault();
          renderer.panBy(0, -40);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          renderer.panBy(40, 0);
          break;
        case 'ArrowRight':
          e.preventDefault();
          renderer.panBy(-40, 0);
          break;
        case '+':
        case '=':
          e.preventDefault();
          renderer.zoomBy(1.2);
          break;
        case '-':
        case '_':
          e.preventDefault();
          renderer.zoomBy(1 / 1.2);
          break;
        case 'r':
        case 'R':
          e.preventDefault();
          renderer.recenter();
          break;
        case 'Escape':
          e.preventDefault();
          renderer.clearSelection();
          setSelectedNodes([]);
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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
    <div className={`node-graph-view ${showSettings && !sidebarCollapsed ? 'node-graph-view--with-sidebar' : ''} ${className}`}>
      {showSettings && !sidebarCollapsed && (
        <GraphSettingsSidebar
          colorGroups={colorGroups}
          onColorGroupsChange={setColorGroups}
          onEditGroup={(groupId) => {
            setEditingGroupId(groupId);
            setGroupModalOpen(true);
          }}
          simulationPaused={simulationPaused}
          onToggleSimulation={(running) => {
            if (running) {
              rendererRef.current?.resumeSimulation();
              setSimulationPaused(false);
            } else {
              rendererRef.current?.pauseSimulation();
              setSimulationPaused(true);
            }
          }}
          graphSettings={graphSettings}
          onGraphSettingsChange={setGraphSettings}
          visibilityFilters={visibilityFilters}
          onVisibilityFiltersChange={setVisibilityFilters}
          graphDataMode={graphDataMode}
          onGraphDataModeChange={setGraphDataMode}
          baseNodeRadius={baseNodeRadius}
          onBaseNodeRadiusChange={setBaseNodeRadius}
          viewMode={viewMode}
          onCollapse={() => setSidebarCollapsed(true)}
          localGraphMode={localGraphMode}
        />
      )}
      
      {/* Sidebar expand button (when collapsed) */}
      {showSettings && sidebarCollapsed && (
        <button
          className="graph-sidebar-expand"
          onClick={() => setSidebarCollapsed(false)}
          type="button"
          title="Show sidebar"
        >
          <span className="mdi mdi-cog-outline" />
        </button>
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
                    {page.icon && <NodeIcon icon={page.icon} size="xs" className="result-icon" />}
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
                  icon={"mdi mdi-trash-can-outline"}
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
                    icon={"mdi mdi-close"}
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
        config={sgeConfig}
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
              { value: 'normal', icon: "mdi mdi-atom", label: 'Normal' },
              { value: 'circle', icon: "mdi mdi-circle-outline", label: 'Circle' },
              { value: 'tree', icon: "mdi mdi-file-tree", label: 'Tree' },
            ]}
            value={viewMode}
            onChange={(value) => setViewMode(value as 'normal' | 'circle' | 'tree')}
          />
        </div>
      )}

      {/* Bottom Right: Recenter */}
      <div className="node-graph-view__bottom-right">
        <Button
          icon={"mdi mdi-crosshairs-gps"}
          size="sm"
          onClick={() => rendererRef.current?.recenter()}
          title="Fit graph to view (R)"
        />
      </div>

      {/* Group Editor Modal */}
      <GraphGroupModal
        key={editingGroupId ?? 'new-group'}
        isOpen={groupModalOpen}
        onClose={() => {
          setGroupModalOpen(false);
          setEditingGroupId(null);
        }}
        onSave={(group) => {
          if (editingGroupId) {
            setColorGroups(prev => prev.map(g => g.id === editingGroupId ? group : g));
          } else {
            setColorGroups(prev => [...prev, group]);
          }
        }}
        initialGroup={editingGroupId ? colorGroups.find(g => g.id === editingGroupId) ?? null : null}
        nodes={apiNodes}
        links={apiLinks}
        classes={classes ?? []}
      />
    </div>
  );
}

registerView({
  id: 'graph',
  label: 'Graph',
  icon: 'mdi mdi-graph-outline',
  component: GraphView,
  capabilities: { errorBoundary: true, containerCard: true },
});
