/**
 * Graph Helper Functions
 *
 * Pure utility functions for graph physics and rendering:
 * radius calculation, path finding, render skip logic, and deduplication.
 */

import type {
  GraphNode,
  GraphLink,
  NodeSizeMode,
  LinkDirection,
} from '../types/graphTypes';
import {
  NODE_RADIUS_BASE,
  NODE_RADIUS_MIN,
  NODE_RADIUS_MAX,
  NODE_RADIUS_MASS_SCALE,
  NODE_RADIUS_CONN_SCALE,
  GLARE_SCALE_NORMAL,
} from '../utils/graphConstants';

/**
 * Get render skip interval based on node count
 */
export const getRenderSkip = (nodeCount: number): number => {
  if (nodeCount < 200) return 1;
  if (nodeCount < 500) return 2;
  if (nodeCount < 1000) return 3;
  if (nodeCount < 2000) return 4;
  if (nodeCount < 4000) return 6;
  if (nodeCount < 8000) return 8;
  return 10;
};

/**
 * Generate order-independent pair key for link deduplication
 */
export const pairKey = (a: string, b: string): string => {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
};

/**
 * Convert link type to numeric id for cache keys
 */
export const linkclassId = (type: GraphLink['type']): number => {
  switch (type) {
    case 'parent': return 0;
    case 'reference': return 1;
    case 'class': return 2;
    case 'property-reference': return 3;
    case 'extends': return 4;
    default: return 9;
  }
};

/**
 * Get node radius based on size mode
 */
export const getNodeRadius = (
  node: GraphNode,
  nodeSizeMode: NodeSizeMode,
  maxConnections: number,
  maxMass: number,
  maxContentSize: number = 0,
  linkDirection: LinkDirection = 'all'
): number => {
  if (nodeSizeMode === 'uniform') return NODE_RADIUS_BASE;

  if (nodeSizeMode === 'connections') {
    const count = linkDirection === 'in' ? node.inLinkCount
      : linkDirection === 'out' ? node.outLinkCount
      : node.connectionCount;
    const ratio = maxConnections > 0 ? Math.min(count / maxConnections, 1) : 0;
    return NODE_RADIUS_MIN + (NODE_RADIUS_MAX - NODE_RADIUS_MIN) * Math.pow(ratio, NODE_RADIUS_CONN_SCALE);
  }

  if (nodeSizeMode === 'mass') {
    const mass = (node as GraphNode & { _mass?: number })._mass ?? 1;
    const ratio = maxMass > 1 ? Math.min((mass - 1) / (maxMass - 1), 1) : 0;
    return NODE_RADIUS_MIN + (NODE_RADIUS_MAX - NODE_RADIUS_MIN) * Math.pow(ratio, NODE_RADIUS_MASS_SCALE);
  }

  if (nodeSizeMode === 'content') {
    const count = node.contentSize;
    const ratio = maxContentSize > 0 ? Math.min(count / maxContentSize, 1) : 0;
    return NODE_RADIUS_MIN + (NODE_RADIUS_MAX - NODE_RADIUS_MIN) * Math.pow(ratio, NODE_RADIUS_CONN_SCALE);
  }

  return NODE_RADIUS_BASE;
};

/**
 * Get glare radius for a node
 */
export const getGlareRadius = (
  node: GraphNode,
  nodeSizeMode: NodeSizeMode,
  maxConnections: number,
  maxMass: number,
  maxContentSize: number = 0,
  linkDirection: LinkDirection = 'all'
): number => {
  const baseRadius = getNodeRadius(node, nodeSizeMode, maxConnections, maxMass, maxContentSize, linkDirection);
  return baseRadius * GLARE_SCALE_NORMAL;
};

/**
 * Find all shortest paths between two nodes using BFS.
 * Returns all nodes that appear in any shortest path.
 */
export const findAllShortestPaths = (
  startId: string,
  endId: string,
  nodes: GraphNode[],
  links: GraphLink[]
): Set<string> => {
  if (startId === endId) return new Set([startId]);

  // Build adjacency list
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) {
    adjacency.set(node.id, []);
  }
  for (const link of links) {
    adjacency.get(link.source)?.push(link.target);
    adjacency.get(link.target)?.push(link.source);
  }

  // BFS to find shortest distance and track all parents
  const distance = new Map<string, number>();
  const parents = new Map<string, string[]>();
  const queue: string[] = [startId];
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
  const nodesInPaths = new Set<string>();

  const dfs = (nodeId: string) => {
    if (nodesInPaths.has(nodeId)) return;
    nodesInPaths.add(nodeId);

    const nodeParents = parents.get(nodeId) || [];
    for (const parent of nodeParents) {
      dfs(parent);
    }
  };

  dfs(endId);

  return nodesInPaths;
};
