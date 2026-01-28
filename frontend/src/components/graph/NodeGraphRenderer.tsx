/**
 * NodeGraphRenderer Component
 * 
 * Core graph rendering component that handles:
 * - Canvas-based rendering of nodes and links
 * - Force-directed physics simulation
 * - Multiple view modes (normal, circle, tree)
 * - Pan and zoom
 * - Node interaction (hover, click, drag)
 * - Type-based coloring
 * 
 * This is a pure visualization component - all data filtering and
 * UI chrome (settings panels, buttons) are handled by parent components.
 */
import { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from 'react';
import './NodeGraphRenderer.css';

// ==================== Configuration ====================

// Physics constants
const LINKED_ATTRACTION_DISTANCE = 120;
const UNLINKED_REPULSION_DISTANCE = 200;
const ATTRACTION_STRENGTH = 0.02;
const ATTRACTION_STRENGTH_LINK_COUNT = 0.008;
const REPULSION_STRENGTH = 800;
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

// Label fade settings
const LABEL_FADE_ZOOM_MIN = 0.4;
const LABEL_FADE_ZOOM_MAX = 0.7;

// ==================== Types ====================

export type GraphViewMode = 'normal' | 'circle' | 'tree';
export type GlareState = 'normal' | 'bright' | 'dim' | 'path' | 'current';
export type NodeSizeMode = 'uniform' | 'backlinks' | 'internal-links' | 'total-links';

export interface GraphNode {
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
  backlinkCount: number;
  internalLinkCount: number;
  createdAt?: string;
  visible: boolean;
  isTypeNode: boolean;
}

export interface GraphLink {
  source: number;
  target: number;
  type: 'parent' | 'reference';
}

export interface TypeColor {
  typeId: number;
  typeName: string;
  color: string;
  order: number;
}

export interface GraphSettings {
  linkCountAttraction: boolean;
  nodeSizeMode: NodeSizeMode;
}

export interface NodeGraphRendererProps {
  /** Nodes to display */
  nodes: GraphNode[];
  /** Links between nodes */
  links: GraphLink[];
  /** Current view mode */
  viewMode?: GraphViewMode;
  /** Graph settings */
  settings?: GraphSettings;
  /** Type colors for node coloring */
  typeColors?: TypeColor[];
  /** Whether to show type nodes */
  showTypeNodes?: boolean;
  /** Currently highlighted node (for minimap mode) */
  currentNodeId?: number | null;
  /** Selected node IDs */
  selectedNodeIds?: number[];
  /** CSS class */
  className?: string;
  /** Node click handler */
  onNodeClick?: (node: GraphNode, event: { shiftKey: boolean; ctrlKey: boolean }) => void;
  /** Node double-click handler */
  onNodeDoubleClick?: (node: GraphNode) => void;
  /** Node right-click handler (for pinning) */
  onNodeRightClick?: (node: GraphNode) => void;
  /** Selection change handler */
  onSelectionChange?: (nodeIds: number[]) => void;
  /** Hovered node change handler */
  onHoveredNodeChange?: (node: GraphNode | null) => void;
}

export interface NodeGraphRendererRef {
  recenter: () => void;
  triggerCreationAnimation: () => void;
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
  if (node.color) return node.color;
  
  if (node.types && node.types.length > 0 && typeColors.length > 0) {
    const sortedTypeColors = [...typeColors].sort((a, b) => a.order - b.order);
    for (const typeColor of sortedTypeColors) {
      if (node.types.includes(typeColor.typeId)) {
        return typeColor.color;
      }
    }
  }
  
  return accentColor;
}

function hexToRgba(hex: string, opacity: number): string {
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
  
  const ratio = Math.sqrt(count / max);
  return NODE_RADIUS_MIN + ratio * (NODE_RADIUS_MAX - NODE_RADIUS_MIN);
}

function buildFullPath(
  node: GraphNode,
  nodes: GraphNode[]
): string {
  if (node.parentId === null) {
    // Root page, just return name
    return node.name;
  }
  
  // Build path from root to current node
  const path: string[] = [];
  let currentId: number | null = node.id;
  const visited = new Set<number>(); // Prevent infinite loops
  
  while (currentId !== null && !visited.has(currentId)) {
    visited.add(currentId);
    const currentNode = nodes.find(n => n.id === currentId);
    if (!currentNode) break;
    
    path.unshift(currentNode.name);
    currentId = currentNode.parentId;
  }
  
  return path.join(' / ');
}

// ==================== Component ====================

export const NodeGraphRenderer = forwardRef<NodeGraphRendererRef, NodeGraphRendererProps>(function NodeGraphRenderer({
  nodes: inputNodes,
  links: inputLinks,
  viewMode = 'normal',
  settings = { linkCountAttraction: false, nodeSizeMode: 'uniform' },
  typeColors = [],
  showTypeNodes = true,
  currentNodeId = null,
  selectedNodeIds = [],
  className = '',
  onNodeClick,
  onNodeDoubleClick,
  onNodeRightClick,
  onSelectionChange,
  onHoveredNodeChange,
}, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<number>(0);
  const nodesRef = useRef<GraphNode[]>([]);
  const linksRef = useRef<GraphLink[]>([]);
  const dragNodeRef = useRef<GraphNode | null>(null);
  const didDragMoveRef = useRef(false);
  const lastClickTimeRef = useRef<number>(0);
  const lastClickedNodeRef = useRef<number | null>(null);
  const renderRef = useRef<((ctx: CanvasRenderingContext2D) => void) | null>(null);
  const wasJustDraggingRef = useRef(false);
  const dragLiftProgressRef = useRef(0); // 0 to 1 for drag lift animation
  const dragStartTimeRef = useRef<number | null>(null);
  
  // Refs for current values (to avoid stale closures)
  const settingsRef = useRef(settings);
  const typeColorsRef = useRef(typeColors);
  const showTypeNodesRef = useRef(showTypeNodes);
  const selectedNodeIdsRef = useRef(selectedNodeIds);
  const currentNodeIdRef = useRef(currentNodeId);
  
  // Pan and zoom state
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ x: 0, y: 0 });
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const transformRef = useRef({ x: 0, y: 0, scale: 1 });
  
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  
  // Build adjacency for connected nodes
  const getConnectedNodes = useCallback((nodeId: number): Set<number> => {
    const connected = new Set<number>();
    for (const link of linksRef.current) {
      if (link.source === nodeId) connected.add(link.target);
      if (link.target === nodeId) connected.add(link.source);
    }
    return connected;
  }, []);

  // Calculate positions for view modes
  const calculatePositions = useCallback((
    nodes: GraphNode[],
    mode: GraphViewMode,
    w: number,
    h: number,
    filterTypeNodes: boolean = false
  ) => {
    const centerX = w / 2;
    const centerY = h / 2;
    
    if (mode === 'circle') {
      // Only position visible nodes in the circle
      const visibleNodes = filterTypeNodes ? nodes.filter(n => !n.isTypeNode) : nodes;
      const radius = Math.min(centerX, centerY) * 0.7;
      visibleNodes.forEach((node, i) => {
        const angle = (2 * Math.PI * i) / visibleNodes.length - Math.PI / 2;
        node.targetX = centerX + radius * Math.cos(angle);
        node.targetY = centerY + radius * Math.sin(angle);
      });
      // Hidden type nodes should stay at center
      if (filterTypeNodes) {
        nodes.filter(n => n.isTypeNode).forEach(node => {
          node.targetX = centerX;
          node.targetY = centerY;
        });
      }
    } else if (mode === 'tree') {
      const baseNodes = filterTypeNodes ? nodes.filter(n => !n.isTypeNode) : nodes;
      const parentNodes = baseNodes.filter(n => n.parentId === null);
      const childNodes = baseNodes.filter(n => n.parentId !== null);
      // Hidden type nodes should stay at center
      if (filterTypeNodes) {
        nodes.filter(n => n.isTypeNode).forEach(node => {
          node.targetX = centerX;
          node.targetY = centerY;
        });
      }
      
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

  // Keep refs in sync
  useEffect(() => { transformRef.current = transform; }, [transform]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => { typeColorsRef.current = typeColors; }, [typeColors]);
  useEffect(() => { 
    showTypeNodesRef.current = showTypeNodes;
    // Recalculate positions when type node visibility changes (affects circle/tree layout)
    if (nodesRef.current.length > 0 && (viewMode === 'circle' || viewMode === 'tree')) {
      calculatePositions(nodesRef.current, viewMode, dimensions.width, dimensions.height, !showTypeNodes);
    }
  }, [showTypeNodes, viewMode, dimensions, calculatePositions]);
  useEffect(() => { selectedNodeIdsRef.current = selectedNodeIds; }, [selectedNodeIds]);
  useEffect(() => { currentNodeIdRef.current = currentNodeId; }, [currentNodeId]);

  // Recenter/fit graph
  const recenter = useCallback(() => {
    const nodes = nodesRef.current.filter(n => n.visible);
    if (nodes.length === 0) return;
    
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const node of nodes) {
      minX = Math.min(minX, node.x);
      maxX = Math.max(maxX, node.x);
      minY = Math.min(minY, node.y);
      maxY = Math.max(maxY, node.y);
    }
    
    const padding = 60;
    minX -= padding;
    maxX += padding;
    minY -= padding;
    maxY += padding;
    
    const graphWidth = maxX - minX;
    const graphHeight = maxY - minY;
    const graphCenterX = (minX + maxX) / 2;
    const graphCenterY = (minY + maxY) / 2;
    
    const scaleX = dimensions.width / graphWidth;
    const scaleY = dimensions.height / graphHeight;
    const newScale = Math.min(scaleX, scaleY, 1.5);
    
    const newX = dimensions.width / 2 - graphCenterX * newScale;
    const newY = dimensions.height / 2 - graphCenterY * newScale;
    
    setTransform({
      x: newX,
      y: newY,
      scale: Math.max(0.2, newScale),
    });
  }, [dimensions]);

  // Creation time animation
  const creationAnimationRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  
  const triggerCreationAnimation = useCallback(() => {
    const nodes = nodesRef.current;
    if (nodes.length === 0) return;
    
    // Clear any existing animation timers
    creationAnimationRef.current.forEach(timer => clearTimeout(timer));
    creationAnimationRef.current = [];
    
    const sortedNodes = [...nodes].sort((a, b) => {
      const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return dateA - dateB;
    });
    
    // Hide all nodes and move them to center with slight random offset
    const centerX = dimensions.width / 2;
    const centerY = dimensions.height / 2;
    const spawnRadius = 50; // Nodes spawn within this radius of center
    
    nodes.forEach(n => {
      n.visible = false;
    });
    
    const revealDelay = 80;
    sortedNodes.forEach((sortedNode, index) => {
      const timer = setTimeout(() => {
        const node = nodes.find(n => n.id === sortedNode.id);
        if (node) {
          // Spawn at center with random offset
          node.x = centerX + (Math.random() - 0.5) * spawnRadius;
          node.y = centerY + (Math.random() - 0.5) * spawnRadius;
          node.visible = true;
          // Give small initial velocity for organic spread
          node.vx = (Math.random() - 0.5) * 3;
          node.vy = (Math.random() - 0.5) * 3;
        }
      }, index * revealDelay);
      creationAnimationRef.current.push(timer);
    });
  }, [dimensions.width, dimensions.height]);

  // Expose methods via ref
  useImperativeHandle(ref, () => ({
    recenter,
    triggerCreationAnimation,
  }), [recenter, triggerCreationAnimation]);

  // Initialize nodes from input
  useEffect(() => {
    if (inputNodes.length === 0) return;
    
    const centerX = dimensions.width / 2;
    const centerY = dimensions.height / 2;
    
    // Preserve existing node positions if they exist
    const existingPositions = new Map<number, { x: number; y: number }>();
    for (const node of nodesRef.current) {
      existingPositions.set(node.id, { x: node.x, y: node.y });
    }
    
    nodesRef.current = inputNodes.map(inputNode => {
      const existing = existingPositions.get(inputNode.id);
      const initialSpread = 30;
      
      return {
        ...inputNode,
        x: existing?.x ?? centerX + (Math.random() - 0.5) * initialSpread,
        y: existing?.y ?? centerY + (Math.random() - 0.5) * initialSpread,
        vx: 0,
        vy: 0,
        targetX: 0,
        targetY: 0,
      };
    });
    
    linksRef.current = [...inputLinks];
    
    calculatePositions(nodesRef.current, viewMode, dimensions.width, dimensions.height, !showTypeNodes);
    startSimulation();
    
    return () => {
      cancelAnimationFrame(animationRef.current);
    };
  }, [inputNodes, inputLinks, dimensions, viewMode, calculatePositions]);

  // Update glare states
  useEffect(() => {
    const nodes = nodesRef.current;
    const selectedIds = selectedNodeIdsRef.current;
    const currentId = currentNodeIdRef.current;
    
    if (currentId !== null) {
      // Highlight current node mode
      nodes.forEach(n => {
        n.glare = n.id === currentId ? 'current' : 'normal';
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
      
      // Path tracing between selected nodes
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
  }, [selectedNodeIds, currentNodeId, viewMode]);

  // Handle container resize
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

  // Start physics simulation
  const startSimulation = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    const simulate = () => {
      const nodes = nodesRef.current;
      const links = linksRef.current;
      const currentSettings = settingsRef.current;
      const showTypes = showTypeNodesRef.current;
      const isConstrainedMode = viewMode === 'circle' || viewMode === 'tree';
      
      // Filter to only visible nodes for force calculations
      const visibleNodes = nodes.filter(n => n.visible && (showTypes || !n.isTypeNode));
      const visibleNodeIds = new Set(visibleNodes.map(n => n.id));
      
      const connectedPairs = new Set<string>();
      for (const link of links) {
        // Only consider links between visible nodes
        if (visibleNodeIds.has(link.source) && visibleNodeIds.has(link.target)) {
          connectedPairs.add(`${link.source}-${link.target}`);
          connectedPairs.add(`${link.target}-${link.source}`);
        }
      }
      
      const areConnected = (a: number, b: number) => 
        connectedPairs.has(`${a}-${b}`);
      
      // Constrained mode return force
      if (isConstrainedMode) {
        for (const node of visibleNodes) {
          if (dragNodeRef.current?.id === node.id) continue;
          if (node.pinned) continue;
          
          const dx = node.targetX - node.x;
          const dy = node.targetY - node.y;
          node.vx += dx * RETURN_FORCE;
          node.vy += dy * RETURN_FORCE;
        }
      }
      
      // Node-to-node forces (only between visible nodes)
      if (!isConstrainedMode) {
        for (let i = 0; i < visibleNodes.length; i++) {
          for (let j = i + 1; j < visibleNodes.length; j++) {
            const nodeA = visibleNodes[i];
            const nodeB = visibleNodes[j];
            
            if (dragNodeRef.current?.id === nodeA.id || 
                dragNodeRef.current?.id === nodeB.id) continue;
            if (nodeA.pinned && nodeB.pinned) continue;
            
            const dx = nodeB.x - nodeA.x;
            const dy = nodeB.y - nodeA.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            
            if (areConnected(nodeA.id, nodeB.id)) {
              let attractionStrength = ATTRACTION_STRENGTH;
              if (currentSettings.linkCountAttraction) {
                const totalLinks = nodeA.backlinkCount + nodeA.internalLinkCount +
                                   nodeB.backlinkCount + nodeB.internalLinkCount;
                const linkFactor = Math.log2(2 + totalLinks);
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
      
      // Dragged node pulls connected visible nodes
      if (dragNodeRef.current && dragNodeRef.current.visible) {
        const dragNode = dragNodeRef.current;
        const connected = getConnectedNodes(dragNode.id);
        
        for (const connectedId of connected) {
          const connectedNode = nodes.find(n => n.id === connectedId);
          if (!connectedNode || connectedNode.pinned || !connectedNode.visible) continue;
          if (!showTypes && connectedNode.isTypeNode) continue;
          
          const dx = dragNode.x - connectedNode.x;
          const dy = dragNode.y - connectedNode.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          
          if (dist > LINKED_ATTRACTION_DISTANCE) {
            connectedNode.vx += (dx / dist) * DRAG_PULL_STRENGTH * (dist - LINKED_ATTRACTION_DISTANCE);
            connectedNode.vy += (dy / dist) * DRAG_PULL_STRENGTH * (dist - LINKED_ATTRACTION_DISTANCE);
          }
        }
        
        // Update drag lift animation progress
        if (dragStartTimeRef.current !== null) {
          const elapsed = Date.now() - dragStartTimeRef.current;
          dragLiftProgressRef.current = Math.min(1, elapsed / 150); // 150ms to fully lift
        }
      } else {
        // Animate lift down when not dragging
        if (dragLiftProgressRef.current > 0) {
          dragLiftProgressRef.current = Math.max(0, dragLiftProgressRef.current - 0.1);
        }
      }
      
      // Update positions (for all nodes including hidden ones, but they won't be rendered)
      for (const node of visibleNodes) {
        if (dragNodeRef.current?.id !== node.id && !node.pinned) {
          node.x += node.vx;
          node.y += node.vy;
          node.vx *= VELOCITY_DAMPING;
          node.vy *= VELOCITY_DAMPING;
        }
      }
      
      renderRef.current?.(ctx);
      animationRef.current = requestAnimationFrame(simulate);
    };
    
    simulate();
  }, [viewMode, getConnectedNodes]);

  // Render function
  const render = useCallback((ctx: CanvasRenderingContext2D) => {
    const { width: w, height: h } = dimensions;
    const t = transformRef.current;
    const currentSettings = settingsRef.current;
    const currentTypeColors = typeColorsRef.current;
    const showTypes = showTypeNodesRef.current;
    const nodes = nodesRef.current;
    const links = linksRef.current;
    
    ctx.clearRect(0, 0, w, h);
    
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.scale(t.scale, t.scale);
    
    const style = getComputedStyle(document.documentElement);
    const textColor = style.getPropertyValue('--text-primary').trim() || '#333';
    const accentColor = style.getPropertyValue('--color-secondary').trim() || '#6366f1';
    const dimColor = style.getPropertyValue('--color-surface-variant').trim() || '#404040';
    
    // Filter visible nodes
    const visibleNodes = showTypes ? nodes : nodes.filter(n => !n.isTypeNode);
    const visibleNodeIds = new Set(visibleNodes.map(n => n.id));
    const visibleLinks = links.filter(l => visibleNodeIds.has(l.source) && visibleNodeIds.has(l.target));
    
    // Calculate max link counts
    let maxBacklinks = 0, maxInternalLinks = 0, maxTotalLinks = 0;
    for (const node of visibleNodes) {
      maxBacklinks = Math.max(maxBacklinks, node.backlinkCount);
      maxInternalLinks = Math.max(maxInternalLinks, node.internalLinkCount);
      maxTotalLinks = Math.max(maxTotalLinks, node.backlinkCount + node.internalLinkCount);
    }
    
    // Build link direction map - check if reverse link exists for bidirectional arrows
    const linkDirections = new Map<string, { forward: boolean; reverse: boolean }>();
    for (const link of visibleLinks) {
      const key = `${Math.min(link.source, link.target)}-${Math.max(link.source, link.target)}`;
      if (!linkDirections.has(key)) {
        linkDirections.set(key, { forward: false, reverse: false });
      }
      const dir = linkDirections.get(key)!;
      if (link.source < link.target) {
        dir.forward = true;
      } else {
        dir.reverse = true;
      }
    }
    
    // Draw links (deduped - draw each pair only once)
    const drawnLinks = new Set<string>();
    for (const link of visibleLinks) {
      const source = visibleNodes.find(n => n.id === link.source);
      const target = visibleNodes.find(n => n.id === link.target);
      if (!source || !target) continue;
      
      // Skip if we've already drawn this link pair
      const linkKey = `${Math.min(link.source, link.target)}-${Math.max(link.source, link.target)}-${link.type}`;
      if (drawnLinks.has(linkKey)) continue;
      drawnLinks.add(linkKey);
      
      const isParentLink = link.type === 'parent';
      const dirKey = `${Math.min(link.source, link.target)}-${Math.max(link.source, link.target)}`;
      const directions = linkDirections.get(dirKey);
      
      ctx.beginPath();
      ctx.strokeStyle = isParentLink 
        ? 'rgba(100, 100, 100, 0.4)' 
        : 'rgba(99, 102, 241, 0.5)';
      ctx.lineWidth = isParentLink ? 1 : 1.5;
      
      if (isParentLink) {
        ctx.setLineDash([4, 4]);
      } else {
        ctx.setLineDash([]);
      }
      
      ctx.moveTo(source.x, source.y);
      ctx.lineTo(target.x, target.y);
      ctx.stroke();
      
      // Draw arrows
      const arrowSize = 8;
      const sourceRadius = getNodeRadius(source, currentSettings.nodeSizeMode, maxBacklinks, maxInternalLinks, maxTotalLinks);
      const targetRadius = getNodeRadius(target, currentSettings.nodeSizeMode, maxBacklinks, maxInternalLinks, maxTotalLinks);
      
      // Helper function to draw an arrow
      const drawArrow = (fromX: number, fromY: number, toX: number, toY: number, nodeRadius: number) => {
        const angle = Math.atan2(toY - fromY, toX - fromX);
        const arrowX = toX - (nodeRadius + 5) * Math.cos(angle);
        const arrowY = toY - (nodeRadius + 5) * Math.sin(angle);
        
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
      };
      
      if (isParentLink) {
        // Parent links always have arrow pointing to child (target)
        drawArrow(source.x, source.y, target.x, target.y, targetRadius);
      } else {
        // Reference links - draw directional arrows
        // Arrow pointing from source to target (at target end)
        if (link.source === source.id) {
          drawArrow(source.x, source.y, target.x, target.y, targetRadius);
        }
        
        // If bidirectional, draw arrow pointing back (at source end)
        if (directions?.forward && directions?.reverse) {
          drawArrow(target.x, target.y, source.x, source.y, sourceRadius);
        }
      }
    }
    
    ctx.setLineDash([]);
    
    // Get dragged node info for shadow rendering
    const draggedNodeId = dragNodeRef.current?.id ?? null;
    const liftProgress = dragLiftProgressRef.current;
    
    // Draw nodes (dragged node last to be on top)
    const sortedNodes = [...visibleNodes].sort((a, b) => {
      if (a.id === draggedNodeId) return 1;
      if (b.id === draggedNodeId) return -1;
      return 0;
    });
    
    for (const node of sortedNodes) {
      if (!node.visible) continue;
      
      const isHovered = hoveredNode?.id === node.id;
      const isDragging = node.id === draggedNodeId;
      const baseRadius = getNodeRadius(node, currentSettings.nodeSizeMode, maxBacklinks, maxInternalLinks, maxTotalLinks);
      const circleRadius = isHovered ? baseRadius + NODE_HOVER_RADIUS_EXTRA : baseRadius;
      const nodeColor = getNodeColor(node, currentTypeColors, accentColor);
      
      // Draw shadow for dragged node
      if (isDragging && liftProgress > 0) {
        const shadowOffset = 4 * liftProgress;
        const shadowBlur = 12 * liftProgress;
        const shadowOpacity = 0.3 * liftProgress;
        
        ctx.save();
        ctx.shadowColor = `rgba(0, 0, 0, ${shadowOpacity})`;
        ctx.shadowBlur = shadowBlur;
        ctx.shadowOffsetX = shadowOffset;
        ctx.shadowOffsetY = shadowOffset;
        
        // Draw shadow circle
        ctx.beginPath();
        ctx.fillStyle = nodeColor;
        ctx.arc(node.x, node.y, circleRadius, 0, 2 * Math.PI);
        ctx.fill();
        
        ctx.restore();
      }
      
      // Glare properties
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
          glareRadius = GLARE_RADIUS_BRIGHT + 4;
          glareOpacity = 0.5;
          break;
      }
      
      // Draw glare
      ctx.beginPath();
      const glareColor = node.glare === 'current' 
        ? `rgba(255, 215, 0, ${glareOpacity})`
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
      
      // Draw node circle
      let displayColor = nodeColor;
      if (node.glare === 'dim') {
        displayColor = dimColor;
      }
      
      ctx.beginPath();
      ctx.fillStyle = displayColor;
      ctx.arc(node.x, node.y, circleRadius, 0, 2 * Math.PI);
      ctx.fill();
      
      // Draw label
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
      
      // For nodes with parents (blocks/child pages), show full path
      const fullPath = buildFullPath(node, nodesRef.current);
      const displayName = fullPath.length > 35 
        ? fullPath.slice(0, 35) + '...' 
        : fullPath;
      ctx.fillText(displayName, node.x, node.y + baseRadius + 10);
      ctx.globalAlpha = 1;
    }
    
    ctx.restore();
  }, [dimensions, hoveredNode]);

  // Keep renderRef in sync
  useEffect(() => {
    renderRef.current = render;
  }, [render]);

  // Coordinate conversion
  const screenToWorld = useCallback((screenX: number, screenY: number) => {
    const t = transformRef.current;
    return {
      x: (screenX - t.x) / t.scale,
      y: (screenY - t.y) / t.scale
    };
  }, []);

  // Get node at position
  const getNodeAtPosition = useCallback((screenX: number, screenY: number): GraphNode | null => {
    const { x, y } = screenToWorld(screenX, screenY);
    const t = transformRef.current;
    const currentSettings = settingsRef.current;
    const showTypes = showTypeNodesRef.current;
    
    let maxBacklinks = 0, maxInternalLinks = 0, maxTotalLinks = 0;
    for (const node of nodesRef.current) {
      maxBacklinks = Math.max(maxBacklinks, node.backlinkCount);
      maxInternalLinks = Math.max(maxInternalLinks, node.internalLinkCount);
      maxTotalLinks = Math.max(maxTotalLinks, node.backlinkCount + node.internalLinkCount);
    }
    
    for (let i = nodesRef.current.length - 1; i >= 0; i--) {
      const node = nodesRef.current[i];
      if (!node.visible) continue;
      if (!showTypes && node.isTypeNode) continue;
      
      const nodeRadius = getNodeRadius(node, currentSettings.nodeSizeMode, maxBacklinks, maxInternalLinks, maxTotalLinks);
      const hitRadius = (nodeRadius + NODE_HOVER_RADIUS_EXTRA + 4) / t.scale;
      const dx = x - node.x;
      const dy = y - node.y;
      if (dx * dx + dy * dy < hitRadius * hitRadius) {
        return node;
      }
    }
    return null;
  }, [screenToWorld]);

  // Get canvas coordinates
  const getCanvasCoordinates = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY
    };
  }, []);

  // Mouse handlers
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x: screenX, y: screenY } = getCanvasCoordinates(e);
    
    if (isPanningRef.current) {
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
      onHoveredNodeChange?.(node);
    }
  }, [getCanvasCoordinates, getNodeAtPosition, screenToWorld, onHoveredNodeChange]);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x: screenX, y: screenY } = getCanvasCoordinates(e);
    const node = getNodeAtPosition(screenX, screenY);
    
    if (node) {
      dragNodeRef.current = node;
      dragStartTimeRef.current = Date.now();
    } else {
      isPanningRef.current = true;
      panStartRef.current = { x: screenX, y: screenY };
    }
  }, [getCanvasCoordinates, getNodeAtPosition]);

  const handleMouseUp = useCallback(() => {
    const didMove = didDragMoveRef.current;
    
    if (dragNodeRef.current) {
      if (dragNodeRef.current.pinned) {
        dragNodeRef.current.targetX = dragNodeRef.current.x;
        dragNodeRef.current.targetY = dragNodeRef.current.y;
      }
    }
    
    dragNodeRef.current = null;
    dragStartTimeRef.current = null;
    isPanningRef.current = false;
    didDragMoveRef.current = false;
    
    if (didMove) {
      wasJustDraggingRef.current = true;
      setTimeout(() => {
        wasJustDraggingRef.current = false;
      }, 50);
    }
  }, []);

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (wasJustDraggingRef.current) return;
    
    const { x: screenX, y: screenY } = getCanvasCoordinates(e);
    const node = getNodeAtPosition(screenX, screenY);
    const now = Date.now();
    
    if (!node) {
      onSelectionChange?.([]);
      return;
    }
    
    const isDoubleClick = 
      lastClickedNodeRef.current === node.id && 
      now - lastClickTimeRef.current < 300;
    
    lastClickTimeRef.current = now;
    lastClickedNodeRef.current = node.id;
    
    if (isDoubleClick) {
      onNodeDoubleClick?.(node);
    } else {
      onNodeClick?.(node, { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey || e.metaKey });
    }
  }, [getCanvasCoordinates, getNodeAtPosition, onNodeClick, onNodeDoubleClick, onSelectionChange]);

  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const { x: screenX, y: screenY } = getCanvasCoordinates(e);
    const node = getNodeAtPosition(screenX, screenY);
    
    if (node) {
      onNodeRightClick?.(node);
    }
  }, [getCanvasCoordinates, getNodeAtPosition, onNodeRightClick]);

  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const { x: screenX, y: screenY } = getCanvasCoordinates(e);
    
    const delta = e.ctrlKey ? -e.deltaY * 0.01 : -e.deltaY * 0.001;
    const zoomFactor = Math.exp(delta);
    const newScale = Math.min(Math.max(transform.scale * zoomFactor, 0.1), 5);
    
    const scaleChange = newScale / transform.scale;
    const newX = screenX - (screenX - transform.x) * scaleChange;
    const newY = screenY - (screenY - transform.y) * scaleChange;
    
    setTransform({
      x: newX,
      y: newY,
      scale: newScale
    });
  }, [getCanvasCoordinates, transform]);

  return (
    <div className={`node-graph-renderer ${className}`} ref={containerRef}>
      <canvas
        ref={canvasRef}
        width={dimensions.width}
        height={dimensions.height}
        className="node-graph-renderer__canvas"
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onWheel={handleWheel}
        style={{ cursor: hoveredNode ? 'pointer' : isPanningRef.current ? 'grabbing' : 'grab' }}
      />
    </div>
  );
});

export default NodeGraphRenderer;
