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
import { useGraphData, useTypes, usePages } from '@/hooks';
import { useNodesStore } from '@/stores';
import { getSettings, setSetting } from '@/api/databases';
import type { Node } from '@/types';
import type { GraphNode as ApiGraphNode } from '@/api/nodes';
import { 
  NodeGraphRenderer, 
  type NodeGraphRendererRef,
  type GraphNode,
  type GraphLink,
  type TypeColor,
  type GraphSettings,
  type GraphViewMode,
} from './NodeGraphRenderer';
import { mdiCog, mdiPalette, mdiCrosshairsGps, mdiHistory, mdiEyeOff, mdiEye, mdiVectorPolygon, mdiCircleOutline, mdiFileTreeOutline, mdiTrashCanOutline, mdiClose } from '@mdi/js';
import { Button } from '../core/Button';
import { ButtonWithPanel } from '../core/ButtonWithPanel';
import { ColorPicker } from '../core/ColorPicker';
import { SelectionButton } from '../core/SelectionButton';
import { ListSortable } from '../core/ListSortable';
import './NodeGraphView.css';

// Default type colors
const DEFAULT_TYPE_COLORS = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#14b8a6', '#f97316', '#3b82f6', '#84cc16',
];

export interface NodeGraphViewProps {
  /** CSS class */
  className?: string;
}

interface SelectedNodeItem {
  id: number;
  name: string;
  order: number;
}

export function NodeGraphView({ className = '' }: NodeGraphViewProps) {
  const rendererRef = useRef<NodeGraphRendererRef>(null);
  
  // Data hooks
  const { data: graphData, isLoading } = useGraphData();
  const { data: types } = useTypes();
  const { data: pages } = usePages();
  const { openNode, addSidebarCard } = useNodesStore();
  
  // View state
  const [viewMode, setViewMode] = useState<GraphViewMode>('normal');
  const [selectedNodes, setSelectedNodes] = useState<SelectedNodeItem[]>([]);
  const [pinnedNodes, setPinnedNodes] = useState<Set<number>>(new Set());
  
  // Settings state
  const [graphSettings, setGraphSettings] = useState<GraphSettings>({
    linkCountAttraction: false,
    nodeSizeMode: 'uniform',
  });
  const settingsLoadedRef = useRef(false);
  
  // Type colors
  const [typeColors, setTypeColors] = useState<TypeColor[]>([]);
  const typeColorsLoadedRef = useRef(false);
  const [showTypeNodes, setShowTypeNodes] = useState(true);
  
  // UI panel state
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [typeColorsOpen, setTypeColorsOpen] = useState(false);
  const [typeVisibilityOpen, setTypeVisibilityOpen] = useState(false);
  const [typeColorSearch, setTypeColorSearch] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  
  // Load settings from database
  useEffect(() => {
    if (typeColorsLoadedRef.current) return;
    
    getSettings().then(settings => {
      const saved = settings['graph_type_colors'];
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed)) {
            setTypeColors(parsed);
          }
        } catch (e) {
          console.error('Failed to parse graph_type_colors:', e);
        }
      }
      typeColorsLoadedRef.current = true;
    }).catch(e => {
      console.error('Failed to load settings:', e);
      typeColorsLoadedRef.current = true;
    });
  }, []);
  
  useEffect(() => {
    if (settingsLoadedRef.current) return;
    
    getSettings().then(settings => {
      const saved = settings['graph_settings'];
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          setGraphSettings(prev => ({ ...prev, ...parsed }));
        } catch (e) {
          console.error('Failed to parse graph_settings:', e);
        }
      }
      settingsLoadedRef.current = true;
    }).catch(e => {
      console.error('Failed to load graph settings:', e);
      settingsLoadedRef.current = true;
    });
  }, []);
  
  // Save settings (debounced)
  useEffect(() => {
    if (!typeColorsLoadedRef.current) return;
    
    const timer = setTimeout(() => {
      setSetting('graph_type_colors', JSON.stringify(typeColors)).catch(e => {
        console.error('Failed to save graph_type_colors:', e);
      });
    }, 500);
    
    return () => clearTimeout(timer);
  }, [typeColors]);
  
  useEffect(() => {
    if (!settingsLoadedRef.current) return;
    
    const timer = setTimeout(() => {
      setSetting('graph_settings', JSON.stringify(graphSettings)).catch(e => {
        console.error('Failed to save graph_settings:', e);
      });
    }, 500);
    
    return () => clearTimeout(timer);
  }, [graphSettings]);
  
  // Build type ID set
  const typeIds = useMemo(() => {
    const set = new Set<number>();
    if (types) {
      for (const t of types) {
        set.add(t.id);
      }
    }
    return set;
  }, [types]);
  
  // Convert API data to renderer format
  const { nodes, links } = useMemo(() => {
    if (!graphData) return { nodes: [], links: [] };
    
    const parentMap = new Map<number, number>();
    for (const link of graphData.links) {
      if (link.type === 'parent') {
        parentMap.set(link.target, link.source);
      }
    }
    
    const nodes: GraphNode[] = graphData.nodes.map((apiNode: ApiGraphNode) => ({
      id: apiNode.id,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      targetX: 0,
      targetY: 0,
      name: apiNode.title || 'Untitled',
      type: apiNode.type,
      isDaily: apiNode.is_daily,
      tags: apiNode.tags || [],
      types: apiNode.types || [],
      parentId: parentMap.get(apiNode.id) ?? null,
      glare: 'normal',
      pinned: pinnedNodes.has(apiNode.id),
      color: (apiNode.properties?.color as string) || undefined,
      backlinkCount: apiNode.backlink_count ?? 0,
      internalLinkCount: apiNode.internal_link_count ?? 0,
      createdAt: apiNode.created_at,
      visible: true,
      isTypeNode: typeIds.has(apiNode.id),
    }));
    
    const links: GraphLink[] = graphData.links.map(link => ({
      source: link.source,
      target: link.target,
      type: link.type,
    }));
    
    return { nodes, links };
  }, [graphData, pinnedNodes, typeIds]);
  
  // Selected node IDs
  const selectedNodeIds = useMemo(() => selectedNodes.map(s => s.id), [selectedNodes]);
  
  // Event handlers
  const handleNodeClick = useCallback((node: GraphNode, event: { shiftKey: boolean; ctrlKey: boolean }) => {
    if (event.shiftKey) {
      addSidebarCard(node.id, node.type);
    } else if (event.ctrlKey) {
      setSelectedNodes(prev => {
        const exists = prev.find(s => s.id === node.id);
        if (exists) {
          return prev.filter(s => s.id !== node.id);
        } else {
          return [...prev, { id: node.id, name: node.name, order: prev.length }];
        }
      });
    } else {
      setSelectedNodes(prev => {
        const exists = prev.find(s => s.id === node.id);
        if (exists) return prev;
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
  
  // Type color handlers
  const updateTypeColor = useCallback((typeId: number, color: string) => {
    setTypeColors(prev => prev.map(tc => 
      tc.typeId === typeId ? { ...tc, color } : tc
    ));
  }, []);
  
  const moveTypeColor = useCallback((fromIndex: number, toIndex: number) => {
    setTypeColors(prev => {
      const newList = [...prev];
      const [removed] = newList.splice(fromIndex, 1);
      newList.splice(toIndex, 0, removed);
      return newList.map((item, i) => ({ ...item, order: i }));
    });
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
  
  // Search
  const searchResults = useMemo(() => {
    if (!searchQuery.trim() || !pages) return [];
    const query = searchQuery.toLowerCase();
    return pages
      .filter((p: Node) => p.name?.toLowerCase().includes(query))
      .slice(0, 10);
  }, [searchQuery, pages]);
  
  const addToSelection = useCallback((node: Node) => {
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
          <div className="settings-panel-content">
            <div className="settings-group">
              <label className="settings-label">
                <input
                  type="checkbox"
                  checked={graphSettings.linkCountAttraction}
                  onChange={(e) => setGraphSettings(prev => ({
                    ...prev,
                    linkCountAttraction: e.target.checked
                  }))}
                />
                <span>Link-count attraction</span>
              </label>
              <p className="settings-hint">
                More connected nodes attract more strongly
              </p>
            </div>
            
            <div className="settings-group">
              <label className="settings-label-text">Node size based on:</label>
              <select 
                className="settings-select"
                value={graphSettings.nodeSizeMode}
                onChange={(e) => setGraphSettings(prev => ({
                  ...prev,
                  nodeSizeMode: e.target.value as GraphSettings['nodeSizeMode']
                }))}
              >
                <option value="uniform">Uniform size</option>
                <option value="backlinks">Backlink count</option>
                <option value="internal-links">Internal link count</option>
                <option value="total-links">Total link count</option>
              </select>
              <p className="settings-hint">
                Size nodes by how connected they are
              </p>
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
          title="Type Colors"
          tooltip="Type colors"
          open={typeColorsOpen}
          onOpenChange={setTypeColorsOpen}
        >
          <p className="type-colors-description">
            Colors apply by priority. First match wins. Drag to reorder.
          </p>
          <div className="type-colors-search">
            <input
              type="text"
              placeholder="Search types to add..."
              value={typeColorSearch}
              onChange={(e) => setTypeColorSearch(e.target.value)}
            />
            {typeColorSearch && (
              <div className="type-colors-search-results">
                {types
                  ?.filter((t: Node) => 
                    t.name?.toLowerCase().includes(typeColorSearch.toLowerCase()) &&
                    !typeColors.some(tc => tc.typeId === t.id)
                  )
                  .slice(0, 5)
                  .map((t: Node) => (
                    <Button
                      key={t.id}
                      variant="ghost"
                      className="type-search-result"
                      onClick={() => {
                        setTypeColors(prev => [...prev, {
                          typeId: t.id,
                          typeName: t.name || 'Untitled',
                          color: DEFAULT_TYPE_COLORS[prev.length % DEFAULT_TYPE_COLORS.length],
                          order: prev.length,
                        }]);
                        setTypeColorSearch('');
                      }}
                    >
                      {t.name || 'Untitled'}
                    </Button>
                  ))}
              </div>
            )}
          </div>
          <div className="type-colors-list-floating">
            {typeColors.length > 0 ? (
              <ListSortable
                items={typeColors.map(tc => ({ id: tc.typeId, ...tc }))}
                onReorder={moveTypeColor}
                itemClassName="type-color-item"
                renderIcon={(item) => (
                  <ColorPicker
                    value={item.color}
                    onChange={(color) => updateTypeColor(item.id as number, color || DEFAULT_TYPE_COLORS[0])}
                    size="xs"
                    panelPosition="right"
                    showNoColor={false}
                    showCustom={true}
                    tooltip="Change color"
                    trigger={
                      <span 
                        className="type-color-swatch type-color-swatch--clickable" 
                        style={{ backgroundColor: item.color }}
                      />
                    }
                  />
                )}
                renderText={(item) => (
                  <span className="type-name">{item.typeName}</span>
                )}
                renderAction={(item) => (
                  <Button
                    icon={mdiClose}
                    size="xs"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      setTypeColors(prev => prev.filter(t => t.typeId !== item.id));
                    }}
                  />
                )}
              />
            ) : (
              <p className="no-types-floating">Search to add types</p>
            )}
          </div>
        </ButtonWithPanel>
        
        <ButtonWithPanel
          icon={showTypeNodes ? mdiEye : mdiEyeOff}
          size="sm"
          panelPosition="right"
          panelAlignment="start"
          panelWidth={220}
          title="Node Visibility"
          tooltip="Toggle node visibility"
          open={typeVisibilityOpen}
          onOpenChange={setTypeVisibilityOpen}
        >
          <div className="visibility-panel-content">
            <label className="settings-label">
              <input
                type="checkbox"
                checked={showTypeNodes}
                onChange={(e) => setShowTypeNodes(e.target.checked)}
              />
              <span>Show type nodes</span>
            </label>
            <p className="settings-hint">
              Toggle visibility of nodes that are used as types
            </p>
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
                {searchResults.map((page: Node) => (
                  <Button
                    key={page.id}
                    variant="ghost"
                    className="graph-search-result"
                    onClick={() => addToSelection(page)}
                  >
                    {page.icon && <span className="result-icon">{page.icon}</span>}
                    <span className="result-name">{page.name || 'Untitled'}</span>
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
        typeColors={typeColors}
        showTypeNodes={showTypeNodes}
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
          onChange={(val) => setViewMode(val as GraphViewMode)}
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
