/**
 * View Helpers Module
 * 
 * Shared helper functions for graph and terrain view components.
 * Contains pure functions for node calculations, color handling, and path finding.
 */
import type { GraphNode, GraphLink, ClassColor, NodeSizeMode, LinkDirection } from './viewTypes';

// ==================== Visual Constants ====================

export const NODE_RADIUS_BASE = 10;
export const NODE_RADIUS_MIN = 10;
export const NODE_RADIUS_MAX = 20;
export const NODE_HOVER_RADIUS_EXTRA = 4;
export const GLARE_SCALE_NORMAL = 1.8;
export const GLARE_SCALE_BRIGHT = 2.0;
export const GLARE_SCALE_CURRENT = 2.4;
export const GLARE_OPACITY_NORMAL = 0.2;
export const GLARE_OPACITY_BRIGHT = 0.4;
export const GLARE_OPACITY_DIM = 0.05;

// Label fade settings
export const LABEL_FADE_ZOOM_MIN = 0.4;
export const LABEL_FADE_ZOOM_MAX = 0.7;

// Pre-allocated arrays for setLineDash (avoids per-frame array creation)
export const LINE_DASH_NONE: number[] = [];
export const LINE_DASH_DOTTED: number[] = [2, 3];

// Link type priority: higher number wins when multiple links connect same pair
export const LINK_TYPE_PRIORITY: Record<string, number> = {
  'semantic': 0,
  'reference': 1,
  'property-reference': 2,
  'extends': 3,
  'class': 4,
  'parent': 5,
};

// ==================== Helper Functions ====================

/**
 * Cache for hexToRgba results — avoids repeated string creation in hot render loop
 */
const hexToRgbaCache = new Map<string, string>();

/**
 * Convert hex color to rgba string
 */
export function hexToRgba(hex: string, opacity: number): string {
  const key = hex + opacity;
  const cached = hexToRgbaCache.get(key);
  if (cached) return cached;
  
  let cleanHex = hex.replace('#', '');
  if (cleanHex.length === 3) {
    cleanHex = cleanHex.split('').map(c => c + c).join('');
  }
  const r = parseInt(cleanHex.substring(0, 2), 16);
  const g = parseInt(cleanHex.substring(2, 4), 16);
  const b = parseInt(cleanHex.substring(4, 6), 16);
  const result = `rgba(${r}, ${g}, ${b}, ${opacity})`;
  hexToRgbaCache.set(key, result);
  return result;
}

/**
 * Calculate node radius based on size mode
 */
export function getNodeRadius(
  node: GraphNode, 
  nodeSizeMode: NodeSizeMode,
  maxConnections: number,
  maxMass: number,
  maxContentSize: number = 0,
  linkDirection: LinkDirection = 'all',
): number {
  if (nodeSizeMode === 'uniform') {
    return NODE_RADIUS_BASE;
  }
  
  let value = 0;
  let max = 1;
  
  switch (nodeSizeMode) {
    case 'connections': {
      if (linkDirection === 'in') {
        value = node.inLinkCount;
      } else if (linkDirection === 'out') {
        value = node.outLinkCount;
      } else {
        value = node.connectionCount;
      }
      max = maxConnections || 1;
      break;
    }
    case 'mass':
      // mass is stored on the node by the simulation
      value = (node as GraphNode & { _mass?: number })._mass ?? 1;
      max = maxMass || 1;
      break;
    case 'content':
      value = node.contentSize;
      max = maxContentSize || 1;
      break;
  }
  
  const ratio = Math.sqrt(value / max);
  return NODE_RADIUS_MIN + ratio * (NODE_RADIUS_MAX - NODE_RADIUS_MIN);
}

/**
 * Get node color based on class colors and properties
 * NOTE: classColors must be pre-sorted by order before passing in.
 * Do NOT sort inside this hot-path function — it runs per-node per-frame.
 */
export function getNodeColor(node: GraphNode, classColors: ClassColor[], accentColor: string): string {
  if (node.color) return node.color;
  
  if (node.types && node.types.length > 0 && classColors.length > 0) {
    for (const classColor of classColors) {
      if (node.types.includes(classColor.classId)) {
        return classColor.color;
      }
    }
  }
  
  return accentColor;
}

/**
 * Calculate glare radius based on node state
 */
export function getGlareRadius(
  node: GraphNode, 
  nodeSizeMode: NodeSizeMode, 
  maxConnections: number, 
  maxMass: number,
  maxContentSize: number = 0,
  linkDirection: LinkDirection = 'all'
): number {
  const nodeRadius = getNodeRadius(node, nodeSizeMode, maxConnections, maxMass, maxContentSize, linkDirection);
  switch (node.glare) {
    case 'bright': return nodeRadius * GLARE_SCALE_BRIGHT;
    case 'current': return nodeRadius * GLARE_SCALE_CURRENT;
    default: return nodeRadius * GLARE_SCALE_NORMAL;
  }
}

/**
 * Link type to numeric id for dedup key
 */
export function linkclassId(t: string): number {
  switch (t) { 
    case 'parent': return 0; 
    case 'class': return 1; 
    case 'extends': return 2; 
    case 'reference': return 3; 
    default: return 4; 
  }
}

/**
 * Numeric pair key — avoids string interpolation in hot loop
 */
export function pairKey(a: number, b: number): number {
  const lo = a < b ? a : b;
  const hi = a < b ? b : a;
  return lo * 100000 + hi;
}

/**
 * Find all shortest paths between two nodes using BFS
 * Returns all nodes that appear in any shortest path
 */
export function findAllShortestPaths(
  startId: number,
  endId: number,
  nodes: GraphNode[],
  links: GraphLink[]
): Set<number> {
  if (startId === endId) return new Set([startId]);
  
  // Build adjacency list
  const adjacency = new Map<number, number[]>();
  for (const node of nodes) {
    adjacency.set(node.id, []);
  }
  for (const link of links) {
    adjacency.get(link.source)?.push(link.target);
    adjacency.get(link.target)?.push(link.source);
  }
  
  // BFS to find shortest distance and track all parents
  const distance = new Map<number, number>();
  const parents = new Map<number, number[]>();
  const queue: number[] = [startId];
  distance.set(startId, 0);
  parents.set(startId, []);
  
  let found = false;
  
  while (queue.length > 0 && !found) {
    const current = queue.shift()!;
    const currentDist = distance.get(current)!;
    
    if (current === endId) {
      found = true;
      break;
    }
    
    for (const neighbor of adjacency.get(current) || []) {
      const neighborDist = distance.get(neighbor);
      
      if (neighborDist === undefined) {
        // First time visiting this node
        distance.set(neighbor, currentDist + 1);
        parents.set(neighbor, [current]);
        queue.push(neighbor);
      } else if (neighborDist === currentDist + 1) {
        // Found another shortest path to this node
        parents.get(neighbor)?.push(current);
      }
    }
  }
  
  if (!found) return new Set();
  
  // Reconstruct all nodes in all shortest paths using DFS
  const nodesInPaths = new Set<number>();
  
  const dfs = (nodeId: number) => {
    if (nodesInPaths.has(nodeId)) return;
    nodesInPaths.add(nodeId);
    
    const nodeParents = parents.get(nodeId) || [];
    for (const parent of nodeParents) {
      dfs(parent);
    }
  };
  
  dfs(endId);
  
  return nodesInPaths;
}

/**
 * Get connection count based on link direction setting
 */
export function getDirectionalConnectionCount(
  node: GraphNode,
  linkDirection: LinkDirection
): number {
  if (linkDirection === 'in') {
    return node.inLinkCount;
  } else if (linkDirection === 'out') {
    return node.outLinkCount;
  } else {
    return node.connectionCount;
  }
}

/**
 * Calculate max connections based on link direction
 */
export function calculateMaxConnections(
  nodes: GraphNode[],
  linkDirection: LinkDirection
): number {
  let maxConnections = 0;
  for (const node of nodes) {
    const count = getDirectionalConnectionCount(node, linkDirection);
    if (count > maxConnections) maxConnections = count;
  }
  return maxConnections;
}
