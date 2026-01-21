/**
 * Graph view component for visualizing page connections
 * 
 * Features:
 * - Three view modes: normal (force-directed), circle, tree
 * - Type-based node coloring (configurable in settings)
 * - Pinning nodes (lock movement)
 * - Recenter/fit button
 * - Settings modal for type coloring
 * - Search panel to add nodes to selection
 * - Selected nodes list with reordering
 * - Minimap mode for navigation
 * - Glare logic for node selection/highlighting
 * - Single click: brighten node, dim others
 * - Double click: navigate to node
 * - Shift+click: open in sidebar card
 * - Multi-select with path tracing
 * - Drag physics with connected nodes following
 */
import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useGraphData, useTypes, usePages } from '@/hooks';
import { useNodesStore } from '@/stores';
import type { GraphNode as ApiGraphNode, GraphLink as ApiGraphLink } from '@/api/nodes';
import type { Node } from '@/types';
import { getSettings, setSetting } from '@/api/databases';
import { mdiCog, mdiPalette, mdiCrosshairsGps, mdiHistory, mdiEyeOff, mdiEye, mdiVectorPolygon, mdiCircleOutline, mdiFileTreeOutline, mdiTrashCanOutline, mdiClose } from '@mdi/js';
import { Button } from '../components/core/Button';
import { ButtonWithPanel } from '../components/core/ButtonWithPanel';
import { ColorPicker } from '../components/core/ColorPicker';
import { SelectionButton } from '../components/core/SelectionButton';
import { ListSortable } from '../components/core/ListSortable';
import './GraphView.css';

// ==================== Configuration ====================

// Physics constants
const LINKED_ATTRACTION_DISTANCE = 120;
const UNLINKED_REPULSION_DISTANCE = 200;
const ATTRACTION_STRENGTH = 0.02;
const ATTRACTION_STRENGTH_LINK_COUNT = 0.008; // Weaker base, scaled by link count
const REPULSION_STRENGTH = 800;
// No center gravity - let link attraction and repulsion find equilibrium naturally
const VELOCITY_DAMPING = 0.85;
const RETURN_FORCE = 0.08;
const DRAG_PULL_STRENGTH = 0.15;

// Visual constants
const NODE_RADIUS_BASE = 10;
const NODE_RADIUS_MIN = 6;
const NODE_RADIUS_MAX = 20;
const NODE_HOVER_RADIUS_EXTRA = 4;
const GLARE_RADIUS_NORMAL = 18;
const GLARE_RADIUS_BRIGHT = 20;
const GLARE_OPACITY_NORMAL = 0.2;
const GLARE_OPACITY_BRIGHT = 0.4;
const GLARE_OPACITY_DIM = 0.05;

// Label fade settings - labels fade out below this zoom level
const LABEL_FADE_ZOOM_MIN = 0.4;  // Labels fully hidden below this
const LABEL_FADE_ZOOM_MAX = 0.7;  // Labels fully visible above this

// Default type colors
const DEFAULT_TYPE_COLORS = [
  '#6366f1', // Indigo
  '#10b981', // Emerald
  '#f59e0b', // Amber
  '#ef4444', // Red
  '#8b5cf6', // Violet
  '#ec4899', // Pink
  '#14b8a6', // Teal
  '#f97316', // Orange
  '#3b82f6', // Blue
  '#84cc16', // Lime
];

// ==================== Types ====================

type ViewMode = 'normal' | 'circle' | 'tree';
type GlareState = 'normal' | 'bright' | 'dim' | 'path' | 'current';
type NodeSizeMode = 'uniform' | 'backlinks' | 'internal-links' | 'total-links';

interface GraphSettings {
  linkCountAttraction: boolean;  // Use link count for attraction strength
  nodeSizeMode: NodeSizeMode;    // How to size nodes
}

interface GraphNode {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  targetX: number;
  targetY: number;
  name: string;
  type: 'page' | 'block';
  isDaily: boolean;
  tags: string[];
  types: number[];
  parentId: number | null;
  glare: GlareState;
  pinned: boolean;
  color?: string;
  // Link counts for size/attraction calculations
  backlinkCount: number;
  internalLinkCount: number;
  createdAt?: string;
  // Animation state
  visible: boolean;
  // Is this node used as a type definition
  isTypeNode: boolean;
}

interface GraphLink {
  source: number;
  target: number;
  type: 'parent' | 'reference';
}

interface TypeColor {
  typeId: number;
  typeName: string;
  color: string;
  order: number;
}

interface GraphViewProps {
  className?: string;
  width?: number;
  height?: number;
  /** If true, acts as minimap - single click navigates, shows current node highlighted */
  minimap?: boolean;
  /** Current node ID for minimap highlighting */
  currentNodeId?: number | null;
}

interface SelectedNodeItem {
  id: number;
  name: string;
  order: number;
}

// ==================== Helper Functions ====================

function findPathBetweenNodes(
  startId: number,
  endId: number,
  nodes: GraphNode[],
  links: GraphLink[]
): number[] {
  const adjacency = new Map<number, number[]>();
  
  for (const node of nodes) {
    adjacency.set(node.id, []);
  }
  
  for (const link of links) {
    adjacency.get(link.source)?.push(link.target);
    adjacency.get(link.target)?.push(link.source);
  }
  
  const visited = new Set<number>();
  const parent = new Map<number, number>();
  const queue: number[] = [startId];
  visited.add(startId);
  
  while (queue.length > 0) {
    const current = queue.shift()!;
    
    if (current === endId) {
      const path: number[] = [];
      let node: number | undefined = endId;
      while (node !== undefined) {
        path.unshift(node);
        node = parent.get(node);
      }
      return path;
    }
    
    for (const neighbor of adjacency.get(current) || []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        parent.set(neighbor, current);
        queue.push(neighbor);
      }
    }
  }
  
  return [];
}

function getNodeColor(node: GraphNode, typeColors: TypeColor[], accentColor: string): string {
  // First check if node has direct color
  if (node.color) return node.color;
  
  // Check type colors in order
  if (node.types && node.types.length > 0 && typeColors.length > 0) {
    // Sort typeColors by order to ensure priority
    const sortedTypeColors = [...typeColors].sort((a, b) => a.order - b.order);
    for (const typeColor of sortedTypeColors) {
      if (node.types.includes(typeColor.typeId)) {
        return typeColor.color;
      }
    }
  }
  
  // Default to accent color
  return accentColor;
}

function hexToRgba(hex: string, opacity: number): string {
  // Handle shorthand hex (#abc -> #aabbcc)
  let cleanHex = hex.replace('#', '');
  if (cleanHex.length === 3) {
    cleanHex = cleanHex.split('').map(c => c + c).join('');
  }
  const r = parseInt(cleanHex.substring(0, 2), 16);
  const g = parseInt(cleanHex.substring(2, 4), 16);
  const b = parseInt(cleanHex.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

function getNodeRadius(
  node: GraphNode, 
  nodeSizeMode: NodeSizeMode,
  maxBacklinks: number,
  maxInternalLinks: number,
  maxTotalLinks: number
): number {
  if (nodeSizeMode === 'uniform') {
    return NODE_RADIUS_BASE;
  }
  
  let count = 0;
  let max = 1;
  
  switch (nodeSizeMode) {
    case 'backlinks':
      count = node.backlinkCount;
      max = maxBacklinks || 1;
      break;
    case 'internal-links':
      count = node.internalLinkCount;
      max = maxInternalLinks || 1;
      break;
    case 'total-links':
      count = node.backlinkCount + node.internalLinkCount;
      max = maxTotalLinks || 1;
      break;
  }
  
  // Scale radius between min and max based on link count
  const ratio = Math.sqrt(count / max); // Use sqrt for more balanced scaling
  return NODE_RADIUS_MIN + ratio * (NODE_RADIUS_MAX - NODE_RADIUS_MIN);
}

// ==================== Component ====================

export function GraphView({ 
  className = '', 
  width = 800, 
  height = 600,
  minimap = false,
  currentNodeId = null
}: GraphViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<number>(0);
  const nodesRef = useRef<GraphNode[]>([]);
  const linksRef = useRef<GraphLink[]>([]);
  const dragNodeRef = useRef<GraphNode | null>(null);
  const didDragMoveRef = useRef(false);
  const lastClickTimeRef = useRef<number>(0);
  const lastClickedNodeRef = useRef<number | null>(null);
  const renderRef = useRef<((ctx: CanvasRenderingContext2D, nodes: GraphNode[], links: GraphLink[]) => void) | null>(null);
  
  // Pan and zoom state
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ x: 0, y: 0 });
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const transformRef = useRef({ x: 0, y: 0, scale: 1 });
  
  // Keep transformRef in sync with transform state
  useEffect(() => {
    transformRef.current = transform;
  }, [transform]);
  
  // View state
  const [dimensions, setDimensions] = useState({ width, height });
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('normal');
  const [selectedNodes, setSelectedNodes] = useState<SelectedNodeItem[]>([]);
  const [pinnedNodes, setPinnedNodes] = useState<Set<number>>(new Set());
  const [selectedEdge, setSelectedEdge] = useState<{ source: number; target: number } | null>(null);
  
  // Graph settings state
  const [graphSettings, setGraphSettings] = useState<GraphSettings>({
    linkCountAttraction: false,
    nodeSizeMode: 'uniform',
  });
  const graphSettingsRef = useRef<GraphSettings>(graphSettings);
  const graphSettingsLoadedRef = useRef(false);
  
  // Keep graphSettingsRef in sync
  useEffect(() => {
    graphSettingsRef.current = graphSettings;
  }, [graphSettings]);
  
  // UI state
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [typeColorsOpen, setTypeColorsOpen] = useState(false);
  const [typeVisibilityOpen, setTypeVisibilityOpen] = useState(false);
  const [typeColorSearch, setTypeColorSearch] = useState('');
  const [showTypeNodes, setShowTypeNodes] = useState(true);
  const showTypeNodesRef = useRef(true);
  const wasJustDraggingRef = useRef(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  
  // Keep showTypeNodesRef in sync
  useEffect(() => {
    showTypeNodesRef.current = showTypeNodes;
  }, [showTypeNodes]);
  
  // Type coloring
  const [typeColors, setTypeColors] = useState<TypeColor[]>([]);
  const typeColorsRef = useRef<TypeColor[]>([]);
  const typeColorsLoadedRef = useRef(false);
  
  // Keep typeColorsRef in sync with typeColors state for real-time rendering
  useEffect(() => {
    typeColorsRef.current = typeColors;
  }, [typeColors]);
  
  // Data hooks
  const { data: graphData, isLoading } = useGraphData();
  const { data: types } = useTypes();
  const { data: pages } = usePages();
  const { openNode, addSidebarCard } = useNodesStore();
  
  // Load type colors from settings on mount
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
          console.error('Failed to parse graph_type_colors setting:', e);
        }
      }
      // Mark as loaded AFTER setting state
      typeColorsLoadedRef.current = true;
    }).catch(e => {
      console.error('Failed to load settings:', e);
      typeColorsLoadedRef.current = true;
    });
  }, []);
  
  // Load graph settings from settings on mount
  useEffect(() => {
    if (graphSettingsLoadedRef.current) return;
    
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
      graphSettingsLoadedRef.current = true;
    }).catch(e => {
      console.error('Failed to load graph settings:', e);
      graphSettingsLoadedRef.current = true;
    });
  }, []);
  
  // Save type colors to settings when they change (debounced)
  useEffect(() => {
    // Don't save until initial load is complete
    if (!typeColorsLoadedRef.current) return;
    
    const timer = setTimeout(() => {
      setSetting('graph_type_colors', JSON.stringify(typeColors)).catch(e => {
        console.error('Failed to save graph_type_colors setting:', e);
      });
    }, 500); // Debounce 500ms
    
    return () => clearTimeout(timer);
  }, [typeColors]);
  
  // Save graph settings when they change (debounced)
  useEffect(() => {
    if (!graphSettingsLoadedRef.current) return;
    
    const timer = setTimeout(() => {
      setSetting('graph_settings', JSON.stringify(graphSettings)).catch(e => {
        console.error('Failed to save graph_settings:', e);
      });
    }, 500);
    
    return () => clearTimeout(timer);
  }, [graphSettings]);
  
  // Build adjacency map for connected nodes
  const getConnectedNodes = useCallback((nodeId: number): Set<number> => {
    const connected = new Set<number>();
    for (const link of linksRef.current) {
      if (link.source === nodeId) connected.add(link.target);
      if (link.target === nodeId) connected.add(link.source);
    }
    return connected;
  }, []);

  // Calculate node positions for different view modes
  const calculatePositions = useCallback((
    nodes: GraphNode[],
    mode: ViewMode,
    w: number,
    h: number
  ) => {
    const centerX = w / 2;
    const centerY = h / 2;
    
    if (mode === 'circle') {
      const radius = Math.min(centerX, centerY) * 0.7;
      nodes.forEach((node, i) => {
        const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
        node.targetX = centerX + radius * Math.cos(angle);
        node.targetY = centerY + radius * Math.sin(angle);
      });
    } else if (mode === 'tree') {
      const parentNodes = nodes.filter(n => n.parentId === null);
      const childNodes = nodes.filter(n => n.parentId !== null);
      
      const childrenByParent = new Map<number, GraphNode[]>();
      for (const child of childNodes) {
        const siblings = childrenByParent.get(child.parentId!) || [];
        siblings.push(child);
        childrenByParent.set(child.parentId!, siblings);
      }
      
      const innerRadius = Math.min(centerX, centerY) * 0.25;
      parentNodes.forEach((node, i) => {
        const angle = (2 * Math.PI * i) / parentNodes.length - Math.PI / 2;
        node.targetX = centerX + innerRadius * Math.cos(angle);
        node.targetY = centerY + innerRadius * Math.sin(angle);
      });
      
      const outerRadius = Math.min(centerX, centerY) * 0.6;
      for (const parent of parentNodes) {
        const children = childrenByParent.get(parent.id) || [];
        const parentAngle = Math.atan2(parent.targetY - centerY, parent.targetX - centerX);
        
        children.forEach((child, i) => {
          const spread = Math.PI * 0.4;
          const childAngle = parentAngle + (i - (children.length - 1) / 2) * (spread / Math.max(children.length - 1, 1));
          child.targetX = centerX + outerRadius * Math.cos(childAngle);
          child.targetY = centerY + outerRadius * Math.sin(childAngle);
        });
      }
      
      const orphans = childNodes.filter(n => !parentNodes.find(p => p.id === n.parentId));
      orphans.forEach((node, i) => {
        const angle = (2 * Math.PI * i) / orphans.length + Math.PI;
        node.targetX = centerX + outerRadius * Math.cos(angle);
        node.targetY = centerY + outerRadius * Math.sin(angle);
      });
    } else {
      nodes.forEach(node => {
        if (node.x === 0 && node.y === 0) {
          node.x = centerX + (Math.random() - 0.5) * w * 0.5;
          node.y = centerY + (Math.random() - 0.5) * h * 0.5;
        }
        node.targetX = node.x;
        node.targetY = node.y;
      });
    }
  }, []);

  // Recenter/fit graph - resets transform to fit all nodes in view
  const handleRecenter = useCallback(() => {
    const nodes = nodesRef.current.filter(n => n.visible);
    if (nodes.length === 0) return;
    
    // Calculate bounds
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const node of nodes) {
      minX = Math.min(minX, node.x);
      maxX = Math.max(maxX, node.x);
      minY = Math.min(minY, node.y);
      maxY = Math.max(maxY, node.y);
    }
    
    // Add padding
    const padding = 60;
    minX -= padding;
    maxX += padding;
    minY -= padding;
    maxY += padding;
    
    const graphWidth = maxX - minX;
    const graphHeight = maxY - minY;
    const graphCenterX = (minX + maxX) / 2;
    const graphCenterY = (minY + maxY) / 2;
    
    // Calculate scale to fit all nodes
    const scaleX = dimensions.width / graphWidth;
    const scaleY = dimensions.height / graphHeight;
    const newScale = Math.min(scaleX, scaleY, 1.5); // Cap at 1.5x zoom
    
    // Calculate translation to center the graph
    const newX = dimensions.width / 2 - graphCenterX * newScale;
    const newY = dimensions.height / 2 - graphCenterY * newScale;
    
    // Reset transform to fit all nodes
    setTransform({
      x: newX,
      y: newY,
      scale: Math.max(0.2, newScale),
    });
  }, [dimensions]);

  // Toggle pin on a node
  const togglePin = useCallback((nodeId: number) => {
    setPinnedNodes(prev => {
      const newSet = new Set(prev);
      if (newSet.has(nodeId)) {
        newSet.delete(nodeId);
        const node = nodesRef.current.find(n => n.id === nodeId);
        if (node) node.pinned = false;
      } else {
        newSet.add(nodeId);
        const node = nodesRef.current.find(n => n.id === nodeId);
        if (node) node.pinned = true;
      }
      return newSet;
    });
  }, []);
  
  // Animation ref to track creation animation
  const creationAnimationRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  // Trigger creation time animation - show nodes in order of creation
  // Physics remains active during animation for natural node positioning
  const triggerCreationAnimation = useCallback(() => {
    const nodes = nodesRef.current;
    if (nodes.length === 0) return;
    
    // Clear any existing animation timeouts
    if (creationAnimationRef.current) {
      clearTimeout(creationAnimationRef.current);
    }
    
    // Sort nodes by creation time
    const sortedNodes = [...nodes].sort((a, b) => {
      const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return dateA - dateB;
    });
    
    // Hide all nodes first
    nodes.forEach(n => n.visible = false);
    
    // Reveal nodes one by one with delay - physics continues to run
    const revealDelay = 80; // ms between each node
    sortedNodes.forEach((sortedNode, index) => {
      creationAnimationRef.current = setTimeout(() => {
        const node = nodes.find(n => n.id === sortedNode.id);
        if (node) {
          node.visible = true;
          // Give newly visible nodes a slight random velocity for physics interaction
          node.vx = (Math.random() - 0.5) * 2;
          node.vy = (Math.random() - 0.5) * 2;
        }
      }, index * revealDelay);
    });
  }, []);

  // Initialize graph data
  useEffect(() => {
    if (!graphData || graphData.nodes.length === 0) return;
    
    const centerX = dimensions.width / 2;
    const centerY = dimensions.height / 2;
    
    const parentMap = new Map<number, number>();
    for (const link of graphData.links) {
      if (link.type === 'parent') {
        parentMap.set(link.target, link.source);
      }
    }
    
    // Build a set of type IDs (nodes that are used as types by other nodes)
    const typeIds = new Set<number>();
    if (types) {
      for (const t of types) {
        typeIds.add(t.id);
      }
    }
    
    nodesRef.current = graphData.nodes.map((apiNode: ApiGraphNode, _i: number) => {
      const existingNode = nodesRef.current.find(n => n.id === apiNode.id);
      // Initialize nodes clustered near center with small random offsets
      // This prevents overlap while letting physics find natural equilibrium
      const initialSpread = 30; // Small spread to prevent all nodes starting at exact same point
      const randomX = (Math.random() - 0.5) * initialSpread;
      const randomY = (Math.random() - 0.5) * initialSpread;
      
      // Extract types from API node
      const nodeTypes = apiNode.types || [];
      const nodeColor = (apiNode.properties?.color as string) || undefined;
      
      return {
        id: apiNode.id,
        x: existingNode?.x ?? centerX + randomX,
        y: existingNode?.y ?? centerY + randomY,
        vx: 0,
        vy: 0,
        targetX: 0,
        targetY: 0,
        name: apiNode.title || 'Untitled',
        type: apiNode.type,
        isDaily: apiNode.is_daily,
        tags: apiNode.tags || [],
        types: nodeTypes,
        parentId: parentMap.get(apiNode.id) ?? null,
        glare: 'normal' as GlareState,
        pinned: pinnedNodes.has(apiNode.id),
        color: nodeColor,
        backlinkCount: apiNode.backlink_count ?? 0,
        internalLinkCount: apiNode.internal_link_count ?? 0,
        createdAt: apiNode.created_at,
        visible: true, // Always start visible, animation will hide then reveal
        isTypeNode: typeIds.has(apiNode.id),
      };
    });
    
    linksRef.current = graphData.links.map((link: ApiGraphLink) => ({
      source: link.source,
      target: link.target,
      type: link.type,
    }));
    
    calculatePositions(nodesRef.current, viewMode, dimensions.width, dimensions.height);
    startSimulation();
    
    return () => {
      cancelAnimationFrame(animationRef.current);
    };
  }, [graphData, dimensions, viewMode, calculatePositions, pinnedNodes, types]);
  
  // Recalculate positions when view mode changes
  useEffect(() => {
    if (nodesRef.current.length > 0) {
      calculatePositions(nodesRef.current, viewMode, dimensions.width, dimensions.height);
    }
  }, [viewMode, dimensions, calculatePositions]);
  
  // Handle container resize - observe canvas directly for accurate dimensions
  useEffect(() => {
    if (!canvasRef.current) return;
    
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width: w, height: h } = entry.contentRect;
        if (w > 0 && h > 0) {
          setDimensions({ width: w, height: h });
        }
      }
    });
    
    resizeObserver.observe(canvasRef.current);
    return () => resizeObserver.disconnect();
  }, []);
  
  // Update glare states based on selection and current node
  useEffect(() => {
    const nodes = nodesRef.current;
    const selectedIds = selectedNodes.map(s => s.id);
    
    if (minimap && currentNodeId) {
      // Minimap mode: highlight current node, don't dim others
      nodes.forEach(n => {
        n.glare = n.id === currentNodeId ? 'current' : 'normal';
      });
    } else if (selectedIds.length === 0) {
      nodes.forEach(n => n.glare = 'normal');
    } else if (selectedIds.length === 1) {
      nodes.forEach(n => {
        n.glare = n.id === selectedIds[0] ? 'bright' : 'dim';
      });
    } else {
      nodes.forEach(n => n.glare = 'dim');
      
      for (const id of selectedIds) {
        const node = nodes.find(n => n.id === id);
        if (node) node.glare = 'bright';
      }
      
      for (let i = 0; i < selectedIds.length - 1; i++) {
        const path = findPathBetweenNodes(
          selectedIds[i],
          selectedIds[i + 1],
          nodes,
          linksRef.current
        );
        
        for (const nodeId of path) {
          const node = nodes.find(n => n.id === nodeId);
          if (node && node.glare !== 'bright') {
            node.glare = 'path';
          }
        }
      }
    }
  }, [selectedNodes, minimap, currentNodeId]);
  
  const startSimulation = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    const simulate = () => {
      const nodes = nodesRef.current;
      const links = linksRef.current;
      const settings = graphSettingsRef.current;
      const isConstrainedMode = viewMode === 'circle' || viewMode === 'tree';
      
      const connectedPairs = new Set<string>();
      for (const link of links) {
        connectedPairs.add(`${link.source}-${link.target}`);
        connectedPairs.add(`${link.target}-${link.source}`);
      }
      
      const areConnected = (a: number, b: number) => 
        connectedPairs.has(`${a}-${b}`);
      
      // Apply forces to non-dragged, non-pinned nodes
      // In constrained modes (circle/tree), apply return force to target positions
      // In free mode, no center gravity - let repulsion and link attraction find equilibrium
      if (isConstrainedMode) {
        for (const node of nodes) {
          if (dragNodeRef.current?.id === node.id) continue;
          if (node.pinned) continue;
          
          const dx = node.targetX - node.x;
          const dy = node.targetY - node.y;
          node.vx += dx * RETURN_FORCE;
          node.vy += dy * RETURN_FORCE;
        }
      }
      
      // Node-to-node forces (skip in constrained modes - let return force handle positioning)
      if (!isConstrainedMode) {
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const nodeA = nodes[i];
            const nodeB = nodes[j];
            
            if (dragNodeRef.current?.id === nodeA.id || 
                dragNodeRef.current?.id === nodeB.id) continue;
            if (nodeA.pinned && nodeB.pinned) continue;
            
            const dx = nodeB.x - nodeA.x;
            const dy = nodeB.y - nodeA.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            
            if (areConnected(nodeA.id, nodeB.id)) {
            // Calculate attraction strength - optionally scale by link count
            let attractionStrength = ATTRACTION_STRENGTH;
            if (settings.linkCountAttraction) {
              // More links between connected nodes = stronger attraction
              const totalLinks = nodeA.backlinkCount + nodeA.internalLinkCount +
                                 nodeB.backlinkCount + nodeB.internalLinkCount;
              const linkFactor = Math.log2(2 + totalLinks); // Logarithmic scaling
              attractionStrength = ATTRACTION_STRENGTH_LINK_COUNT * linkFactor;
            }
            
            const force = (dist - LINKED_ATTRACTION_DISTANCE) * attractionStrength;
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            
            if (!nodeA.pinned) {
              nodeA.vx += fx;
              nodeA.vy += fy;
            }
            if (!nodeB.pinned) {
              nodeB.vx -= fx;
              nodeB.vy -= fy;
            }
          } else {
            if (dist < UNLINKED_REPULSION_DISTANCE) {
              const force = REPULSION_STRENGTH / (dist * dist);
              const fx = (dx / dist) * force;
              const fy = (dy / dist) * force;
              
              if (!nodeA.pinned) {
                nodeA.vx -= fx;
                nodeA.vy -= fy;
              }
              if (!nodeB.pinned) {
                nodeB.vx += fx;
                nodeB.vy += fy;
              }
            }
          }
        }
        }
      }
      
      // Dragged node pulls connected nodes (unless pinned)
      if (dragNodeRef.current) {
        const dragNode = dragNodeRef.current;
        const connected = getConnectedNodes(dragNode.id);
        
        for (const connectedId of connected) {
          const connectedNode = nodes.find(n => n.id === connectedId);
          if (!connectedNode || connectedNode.pinned) continue;
          
          const dx = dragNode.x - connectedNode.x;
          const dy = dragNode.y - connectedNode.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          
          if (dist > LINKED_ATTRACTION_DISTANCE) {
            connectedNode.vx += (dx / dist) * DRAG_PULL_STRENGTH * (dist - LINKED_ATTRACTION_DISTANCE);
            connectedNode.vy += (dy / dist) * DRAG_PULL_STRENGTH * (dist - LINKED_ATTRACTION_DISTANCE);
          }
        }
      }
      
      // Update positions with velocity damping
      for (const node of nodes) {
        if (dragNodeRef.current?.id !== node.id && !node.pinned) {
          node.x += node.vx;
          node.y += node.vy;
          node.vx *= VELOCITY_DAMPING;
          node.vy *= VELOCITY_DAMPING;
          
          // No boundary clamping - nodes can exist anywhere in world space
          // This allows proper dragging at any zoom level
        }
      }
      
      renderRef.current?.(ctx, nodes, links);
      animationRef.current = requestAnimationFrame(simulate);
    };
    
    simulate();
  }, [dimensions, viewMode, getConnectedNodes]);
  
  const render = useCallback((
    ctx: CanvasRenderingContext2D, 
    nodes: GraphNode[], 
    links: GraphLink[]
  ) => {
    const { width: w, height: h } = dimensions;
    const t = transformRef.current;
    const settings = graphSettingsRef.current;
    
    ctx.clearRect(0, 0, w, h);
    
    // Apply transform (pan and zoom)
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.scale(t.scale, t.scale);
    
    const style = getComputedStyle(document.documentElement);
    const textColor = style.getPropertyValue('--text-primary').trim() || '#333';
    const accentColor = style.getPropertyValue('--color-secondary').trim() || '#6366f1';
    const dimColor = style.getPropertyValue('--color-surface-variant').trim() || '#404040';
    
    // Filter nodes based on type visibility setting
    const showTypes = showTypeNodesRef.current;
    const visibleNodes = showTypes ? nodes : nodes.filter(n => !n.isTypeNode);
    const visibleNodeIds = new Set(visibleNodes.map(n => n.id));
    
    // Filter links to only include those between visible nodes
    const visibleLinks = links.filter(l => visibleNodeIds.has(l.source) && visibleNodeIds.has(l.target));
    
    // Calculate max link counts for node sizing
    let maxBacklinks = 0;
    let maxInternalLinks = 0;
    let maxTotalLinks = 0;
    for (const node of visibleNodes) {
      maxBacklinks = Math.max(maxBacklinks, node.backlinkCount);
      maxInternalLinks = Math.max(maxInternalLinks, node.internalLinkCount);
      maxTotalLinks = Math.max(maxTotalLinks, node.backlinkCount + node.internalLinkCount);
    }
    
    // Draw links
    for (const link of visibleLinks) {
      const source = visibleNodes.find(n => n.id === link.source);
      const target = visibleNodes.find(n => n.id === link.target);
      if (!source || !target) continue;
      
      const isParentLink = link.type === 'parent';
      const isSelected = selectedEdge?.source === link.source && selectedEdge?.target === link.target;
      
      ctx.beginPath();
      if (isSelected) {
        ctx.strokeStyle = '#f59e0b'; // Amber for selected edge
        ctx.lineWidth = 3;
      } else {
        ctx.strokeStyle = isParentLink 
          ? 'rgba(100, 100, 100, 0.4)' 
          : 'rgba(99, 102, 241, 0.5)';
        ctx.lineWidth = isParentLink ? 1 : 1.5;
      }
      
      if (isParentLink) {
        ctx.setLineDash([4, 4]);
      } else {
        ctx.setLineDash([]);
      }
      
      ctx.moveTo(source.x, source.y);
      ctx.lineTo(target.x, target.y);
      ctx.stroke();
      
      if (isParentLink) {
        const angle = Math.atan2(target.y - source.y, target.x - source.x);
        const arrowSize = 8;
        const targetRadius = getNodeRadius(target, settings.nodeSizeMode, maxBacklinks, maxInternalLinks, maxTotalLinks);
        const arrowX = target.x - (targetRadius + 5) * Math.cos(angle);
        const arrowY = target.y - (targetRadius + 5) * Math.sin(angle);
        
        ctx.beginPath();
        ctx.setLineDash([]);
        ctx.moveTo(arrowX, arrowY);
        ctx.lineTo(
          arrowX - arrowSize * Math.cos(angle - Math.PI / 6),
          arrowY - arrowSize * Math.sin(angle - Math.PI / 6)
        );
        ctx.moveTo(arrowX, arrowY);
        ctx.lineTo(
          arrowX - arrowSize * Math.cos(angle + Math.PI / 6),
          arrowY - arrowSize * Math.sin(angle + Math.PI / 6)
        );
        ctx.stroke();
      }
    }
    
    ctx.setLineDash([]);
    
    // Draw nodes with glare
    // Use ref to always get the latest type colors for real-time updates
    const currentTypeColors = typeColorsRef.current;
    for (const node of visibleNodes) {
      // Skip nodes that aren't visible yet (for animation)
      if (!node.visible) continue;
      
      const isHovered = hoveredNode?.id === node.id;
      const baseRadius = getNodeRadius(node, settings.nodeSizeMode, maxBacklinks, maxInternalLinks, maxTotalLinks);
      // Only the inner circle scales on hover, not the glare/text
      const circleRadius = isHovered ? baseRadius + NODE_HOVER_RADIUS_EXTRA : baseRadius;
      const nodeColor = getNodeColor(node, currentTypeColors, accentColor);
      
      // Determine glare properties
      let glareRadius = GLARE_RADIUS_NORMAL;
      let glareOpacity = GLARE_OPACITY_NORMAL;
      
      switch (node.glare) {
        case 'bright':
          glareRadius = GLARE_RADIUS_BRIGHT;
          glareOpacity = GLARE_OPACITY_BRIGHT;
          break;
        case 'dim':
          glareOpacity = GLARE_OPACITY_DIM;
          break;
        case 'path':
          glareOpacity = GLARE_OPACITY_NORMAL;
          break;
        case 'current':
          // Minimap current node - extra bright
          glareRadius = GLARE_RADIUS_BRIGHT + 4;
          glareOpacity = 0.5;
          break;
      }
      
      // Draw glare circle - use same color as node but transparent
      ctx.beginPath();
      const glareColor = node.glare === 'current' 
        ? `rgba(255, 215, 0, ${glareOpacity})` // Gold for current
        : hexToRgba(nodeColor, glareOpacity);
      ctx.fillStyle = glareColor;
      ctx.arc(node.x, node.y, glareRadius, 0, 2 * Math.PI);
      ctx.fill();
      
      // Draw pin indicator
      if (node.pinned) {
        ctx.beginPath();
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 2;
        ctx.arc(node.x, node.y, circleRadius + 6, 0, 2 * Math.PI);
        ctx.stroke();
      }
      
      // Draw main node circle
      let displayColor = nodeColor;
      if (node.glare === 'dim') {
        displayColor = dimColor;
      }
      
      ctx.beginPath();
      ctx.fillStyle = displayColor;
      ctx.arc(node.x, node.y, circleRadius, 0, 2 * Math.PI);
      ctx.fill();
      
      // Selection is indicated via glare state (bright), no extra ring needed
      
      // Draw node label with zoom-based fade (use baseRadius for consistent text position)
      const currentScale = transformRef.current.scale;
      const zoomOpacity = currentScale <= LABEL_FADE_ZOOM_MIN 
        ? 0 
        : currentScale >= LABEL_FADE_ZOOM_MAX 
          ? 1 
          : (currentScale - LABEL_FADE_ZOOM_MIN) / (LABEL_FADE_ZOOM_MAX - LABEL_FADE_ZOOM_MIN);
      const dimOpacity = node.glare === 'dim' ? 0.4 : 1;
      const labelOpacity = zoomOpacity * dimOpacity;
      
      ctx.fillStyle = textColor;
      ctx.globalAlpha = labelOpacity;
      ctx.font = '10px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      
      const displayName = node.name.length > 18 
        ? node.name.slice(0, 18) + '...' 
        : node.name;
      ctx.fillText(displayName, node.x, node.y + baseRadius + 6);
      ctx.globalAlpha = 1;
    }
    
    // Restore transform context
    ctx.restore();
  }, [dimensions, hoveredNode, selectedNodes, selectedEdge]);
  
  // Keep renderRef in sync with render callback
  useEffect(() => {
    renderRef.current = render;
  }, [render]);
  
  // Convert screen coordinates to world coordinates (accounting for pan/zoom)
  // Uses transformRef to always have the current transform value
  const screenToWorld = useCallback((screenX: number, screenY: number) => {
    const t = transformRef.current;
    return {
      x: (screenX - t.x) / t.scale,
      y: (screenY - t.y) / t.scale
    };
  }, []);
  
  // Mouse event handlers
  const getNodeAtPosition = useCallback((screenX: number, screenY: number): GraphNode | null => {
    const { x, y } = screenToWorld(screenX, screenY);
    const t = transformRef.current;
    const settings = graphSettingsRef.current;
    
    // Calculate max link counts for sizing
    let maxBacklinks = 0, maxInternalLinks = 0, maxTotalLinks = 0;
    for (const node of nodesRef.current) {
      maxBacklinks = Math.max(maxBacklinks, node.backlinkCount);
      maxInternalLinks = Math.max(maxInternalLinks, node.internalLinkCount);
      maxTotalLinks = Math.max(maxTotalLinks, node.backlinkCount + node.internalLinkCount);
    }
    
    // Check if type nodes should be shown
    const showTypes = showTypeNodesRef.current;
    
    for (let i = nodesRef.current.length - 1; i >= 0; i--) {
      const node = nodesRef.current[i];
      if (!node.visible) continue;
      // Skip hidden type nodes
      if (!showTypes && node.isTypeNode) continue;
      const nodeRadius = getNodeRadius(node, settings.nodeSizeMode, maxBacklinks, maxInternalLinks, maxTotalLinks);
      const hitRadius = (nodeRadius + NODE_HOVER_RADIUS_EXTRA + 4) / t.scale;
      const dx = x - node.x;
      const dy = y - node.y;
      if (dx * dx + dy * dy < hitRadius * hitRadius) {
        return node;
      }
    }
    return null;
  }, [screenToWorld]);
  
  // Get edge at position for edge selection
  const getEdgeAtPosition = useCallback((screenX: number, screenY: number): GraphLink | null => {
    const { x, y } = screenToWorld(screenX, screenY);
    const links = linksRef.current;
    const nodes = nodesRef.current;
    const threshold = 8; // Distance threshold for edge hit detection
    const showTypes = showTypeNodesRef.current;
    
    for (const link of links) {
      const source = nodes.find(n => n.id === link.source);
      const target = nodes.find(n => n.id === link.target);
      if (!source || !target) continue;
      
      // Skip edges connected to hidden type nodes
      if (!showTypes && (source.isTypeNode || target.isTypeNode)) continue;
      
      // Calculate distance from point to line segment
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const lengthSq = dx * dx + dy * dy;
      if (lengthSq === 0) continue;
      
      // Parameter t represents position along line segment (0 = source, 1 = target)
      const t = Math.max(0, Math.min(1, ((x - source.x) * dx + (y - source.y) * dy) / lengthSq));
      const projX = source.x + t * dx;
      const projY = source.y + t * dy;
      
      const distSq = (x - projX) * (x - projX) + (y - projY) * (y - projY);
      if (distSq < threshold * threshold) {
        return link;
      }
    }
    return null;
  }, [screenToWorld]);
  
  // Helper to get canvas-relative coordinates accounting for CSS scaling
  const getCanvasCoordinates = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    
    const rect = canvas.getBoundingClientRect();
    // Scale mouse coordinates to match canvas internal dimensions
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY
    };
  }, []);
  
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x: screenX, y: screenY } = getCanvasCoordinates(e);
    
    if (isPanningRef.current) {
      // Panning the view
      const dx = screenX - panStartRef.current.x;
      const dy = screenY - panStartRef.current.y;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        didDragMoveRef.current = true;
      }
      setTransform(prev => ({
        ...prev,
        x: prev.x + dx,
        y: prev.y + dy
      }));
      panStartRef.current = { x: screenX, y: screenY };
    } else if (dragNodeRef.current) {
      // Dragging a node - convert screen to world coordinates
      const { x, y } = screenToWorld(screenX, screenY);
      const dx = x - dragNodeRef.current.x;
      const dy = y - dragNodeRef.current.y;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        didDragMoveRef.current = true;
      }
      dragNodeRef.current.x = x;
      dragNodeRef.current.y = y;
      dragNodeRef.current.vx = 0;
      dragNodeRef.current.vy = 0;
    } else {
      const node = getNodeAtPosition(screenX, screenY);
      setHoveredNode(node);
    }
  }, [getCanvasCoordinates, getNodeAtPosition, screenToWorld]);
  
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x: screenX, y: screenY } = getCanvasCoordinates(e);
    const node = getNodeAtPosition(screenX, screenY);
    
    if (node) {
      // Allow dragging even pinned nodes (to reposition them)
      dragNodeRef.current = node;
    } else {
      // Start panning the view
      isPanningRef.current = true;
      panStartRef.current = { x: screenX, y: screenY };
    }
  }, [getCanvasCoordinates, getNodeAtPosition]);
  
  const handleMouseUp = useCallback(() => {
    // Track if we actually moved during drag (used to prevent click handling)
    const didMove = didDragMoveRef.current;
    
    if (dragNodeRef.current) {
      // If a pinned node was dragged, update its target position
      if (dragNodeRef.current.pinned) {
        dragNodeRef.current.targetX = dragNodeRef.current.x;
        dragNodeRef.current.targetY = dragNodeRef.current.y;
      }
    }
    dragNodeRef.current = null;
    isPanningRef.current = false;
    didDragMoveRef.current = false;
    
    // Mark that we just finished dragging (for click handler) - only if we actually moved
    if (didMove) {
      wasJustDraggingRef.current = true;
      // Reset after a short delay
      setTimeout(() => {
        wasJustDraggingRef.current = false;
      }, 50);
    }
  }, []);
  
  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    // Ignore click if we just finished dragging
    if (wasJustDraggingRef.current) {
      return;
    }
    
    const { x: screenX, y: screenY } = getCanvasCoordinates(e);
    const node = getNodeAtPosition(screenX, screenY);
    const now = Date.now();
    const isShiftClick = e.shiftKey;
    const isCtrlClick = e.ctrlKey || e.metaKey;
    
    if (!node) {
      // Check if we clicked on an edge
      const edge = getEdgeAtPosition(screenX, screenY);
      if (edge) {
        // Select both nodes connected by this edge
        const sourceNode = nodesRef.current.find(n => n.id === edge.source);
        const targetNode = nodesRef.current.find(n => n.id === edge.target);
        if (sourceNode && targetNode) {
          setSelectedEdge({ source: edge.source, target: edge.target });
          setSelectedNodes([
            { id: sourceNode.id, name: sourceNode.name, order: 0 },
            { id: targetNode.id, name: targetNode.name, order: 1 }
          ]);
        }
      } else {
        // Clear selection when clicking empty space
        setSelectedEdge(null);
        setSelectedNodes([]);
      }
      return;
    }
    
    // Clear edge selection when selecting a node
    setSelectedEdge(null);
    
    // Check for double click
    const isDoubleClick = 
      lastClickedNodeRef.current === node.id && 
      now - lastClickTimeRef.current < 300;
    
    lastClickTimeRef.current = now;
    lastClickedNodeRef.current = node.id;
    
    if (minimap) {
      // Minimap: single click navigates, shift+click opens sidebar
      if (isShiftClick) {
        addSidebarCard(node.id, node.type);
      } else {
        openNode(node.id, node.parentId === null ? 'page' : 'block');
      }
      return;
    }
    
    if (isDoubleClick) {
      openNode(node.id, node.parentId === null ? 'page' : 'block');
      setSelectedNodes([]);
    } else if (isShiftClick) {
      addSidebarCard(node.id, node.type);
    } else if (isCtrlClick) {
      // Ctrl+click: toggle this node in selection
      setSelectedNodes(prev => {
        const exists = prev.find(s => s.id === node.id);
        if (exists) {
          return prev.filter(s => s.id !== node.id);
        } else {
          return [...prev, { id: node.id, name: node.name, order: prev.length }];
        }
      });
    } else {
      // Regular click: add to selection (multi-select behavior)
      setSelectedNodes(prev => {
        const exists = prev.find(s => s.id === node.id);
        if (exists) {
          // Already selected, do nothing
          return prev;
        } else {
          return [...prev, { id: node.id, name: node.name, order: prev.length }];
        }
      });
    }
  }, [getCanvasCoordinates, getNodeAtPosition, getEdgeAtPosition, openNode, addSidebarCard, minimap]);
  
  // Right-click to toggle pin
  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const { x: screenX, y: screenY } = getCanvasCoordinates(e);
    const node = getNodeAtPosition(screenX, screenY);
    
    if (node) {
      togglePin(node.id);
    }
  }, [getCanvasCoordinates, getNodeAtPosition, togglePin]);
  
  // Zoom to mouse position via scroll wheel (supports touchpad)
  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const { x: screenX, y: screenY } = getCanvasCoordinates(e);
    
    // Handle pinch zoom (ctrlKey is set for pinch gestures)
    // and regular scroll wheel
    const delta = e.ctrlKey ? -e.deltaY * 0.01 : -e.deltaY * 0.001;
    const zoomFactor = Math.exp(delta);
    const newScale = Math.min(Math.max(transform.scale * zoomFactor, 0.1), 5);
    
    // Calculate new transform to zoom toward mouse position
    const scaleChange = newScale / transform.scale;
    const newX = screenX - (screenX - transform.x) * scaleChange;
    const newY = screenY - (screenY - transform.y) * scaleChange;
    
    setTransform({
      x: newX,
      y: newY,
      scale: newScale
    });
  }, [getCanvasCoordinates, transform]);
  
  // Search filtered pages
  const searchResults = useMemo(() => {
    if (!searchQuery.trim() || !pages) return [];
    const query = searchQuery.toLowerCase();
    return pages
      .filter((p: Node) => p.name?.toLowerCase().includes(query))
      .slice(0, 10);
  }, [searchQuery, pages]);
  
  // Add node to selection from search
  const addToSelection = useCallback((node: Node) => {
    setSelectedNodes(prev => {
      if (prev.find(s => s.id === node.id)) return prev;
      return [...prev, { id: node.id, name: node.name || 'Untitled', order: prev.length }];
    });
    setSearchQuery('');
    setSearchOpen(false);
  }, []);
  
  // Remove from selection
  const removeFromSelection = useCallback((nodeId: number) => {
    setSelectedNodes(prev => prev.filter(s => s.id !== nodeId));
  }, []);
  
  // Reorder selection (drag-drop)
  const moveSelectionItem = useCallback((fromIndex: number, toIndex: number) => {
    setSelectedNodes(prev => {
      const newList = [...prev];
      const [removed] = newList.splice(fromIndex, 1);
      newList.splice(toIndex, 0, removed);
      return newList.map((item, i) => ({ ...item, order: i }));
    });
  }, []);
  
  // Update type color
  const updateTypeColor = useCallback((typeId: number, color: string) => {
    setTypeColors(prev => prev.map(tc => 
      tc.typeId === typeId ? { ...tc, color } : tc
    ));
  }, []);
  
  // Reorder type colors
  const moveTypeColor = useCallback((fromIndex: number, toIndex: number) => {
    setTypeColors(prev => {
      const newList = [...prev];
      const [removed] = newList.splice(fromIndex, 1);
      newList.splice(toIndex, 0, removed);
      return newList.map((item, i) => ({ ...item, order: i }));
    });
  }, []);
  
  // View mode options for SelectionButton
  const modeOptions = [
    { value: 'normal', icon: mdiVectorPolygon, label: 'Force-directed layout' },
    { value: 'circle', icon: mdiCircleOutline, label: 'Circle layout' },
    { value: 'tree', icon: mdiFileTreeOutline, label: 'Tree layout' },
  ];
  
  if (isLoading) {
    return (
      <div className={`graph-view loading ${className}`}>
        <div className="graph-loading-spinner">Loading graph...</div>
      </div>
    );
  }
  
  if (!graphData || graphData.nodes.length === 0) {
    return (
      <div className={`graph-view empty ${className}`}>
        <div className="graph-empty-state">
          <h3>No nodes to display</h3>
          <p>Create some pages to see them in the graph view.</p>
        </div>
      </div>
    );
  }
  
  // Minimap view (simplified)
  if (minimap) {
    return (
      <div className={`graph-view minimap ${className}`} ref={containerRef}>
        <canvas
          ref={canvasRef}
          width={dimensions.width}
          height={dimensions.height}
          className="graph-canvas"
          onMouseMove={handleMouseMove}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onClick={handleClick}
          onWheel={handleWheel}
          style={{ cursor: hoveredNode ? 'pointer' : 'grab' }}
        />
      </div>
    );
  }
  
  return (
    <div className={`graph-view ${className}`} ref={containerRef}>
      {/* Top Left: Settings and Type Colors buttons */}
      <div className="graph-top-left">
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
                  nodeSizeMode: e.target.value as NodeSizeMode
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
                {types?.filter((t: Node) => 
                  t.name?.toLowerCase().includes(typeColorSearch.toLowerCase()) &&
                  !typeColors.some(tc => tc.typeId === t.id)
                ).length === 0 && (
                  <div className="no-results">No matching types</div>
                )}
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
        
        {/* Type Visibility Toggle */}
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
        
        {/* Creation Animation Button */}
        <Button
          icon={mdiHistory}
          size="sm"
          onClick={triggerCreationAnimation}
          title="Animate by creation time"
        />
      </div>
      
      {/* Top Right: Search and selected nodes */}
      <div className="graph-top-right">
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
      <canvas
        ref={canvasRef}
        width={dimensions.width}
        height={dimensions.height}
        className="graph-canvas"
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onWheel={handleWheel}
        style={{ cursor: hoveredNode ? 'pointer' : isPanningRef.current ? 'grabbing' : 'grab' }}
      />
      
      {/* Bottom Center: Mode switcher */}
      <div className="graph-bottom-center">
        <SelectionButton
          options={modeOptions}
          value={viewMode}
          onChange={(val) => setViewMode(val as ViewMode)}
          size="sm"
        />
      </div>
      
      {/* Bottom Right: Recenter button */}
      <div className="graph-bottom-right">
        <Button
          icon={mdiCrosshairsGps}
          size="sm"
          onClick={handleRecenter}
          title="Fit graph to view"
        />
      </div>
    </div>
  );
}

export default GraphView;
