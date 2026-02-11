/**
 * useRuntimeSync — Hook to sync backend API data with NodeGraphRuntime.
 *
 * Bridges TanStack Query (server state) with NodeGraphRuntime (client state).
 * Converts API Node objects to GraphNode format and loads them into the runtime.
 */

import { useEffect } from 'react';
import { getNodeGraphRuntime } from '../runtime/NodeGraphRuntime';
import type { GraphNode, GraphNodeType, ContentAST } from '../runtime/types';
import type { Node } from '../types/api';
import { parseAST } from '@/lib/astBuilder';
import { nodeNameToText } from './useStringifyAST';

/**
 * Convert an API Node to a GraphNode for the runtime.
 * Note: parentId will be set as the parent's UUID if idToUuidMap is provided.
 */
export function apiNodeToGraphNode(node: Node, idToUuidMap?: Map<number, string>): GraphNode {
  // Convert parent_id (server ID) to parent UUID
  let parentUuid: string | null = null;
  if (node.parent_id) {
    if (idToUuidMap) {
      parentUuid = idToUuidMap.get(node.parent_id) ?? null;
    }
    // Fallback: if no map or not found, leave as null
    // (node won't be linked to parent but at least won't crash)
  }
  
  return {
    blockId: node.uuid,
    serverId: node.id,
    parentId: parentUuid,
    orderIndex: node.sequence ?? 0,
    nodeType: inferNodeType(node),
    contentAST: parseAST(node.name) as ContentAST,
    collapsed: node.collapsed ?? false,
    isDeleted: node.is_deleted ?? false,
    isPage: node.is_page ?? false,
    name: nodeNameToText(node.name),
    icon: node.icon || null,
    color: node.color || null,
    classIds: (node.classes || []).map(String),
    tagIds: (node.tags || []).map(String),
    createdAt: node.create_date || new Date().toISOString(),
    updatedAt: node.write_date || new Date().toISOString(),
    version: 1,
  };
}

/**
 * Convert an array of API Nodes to GraphNodes with proper parent UUID resolution.
 */
export function apiNodesToGraphNodes(nodes: Node[]): GraphNode[] {
  // Build ID -> UUID map from all nodes
  const idToUuidMap = new Map<number, string>();
  for (const node of nodes) {
    idToUuidMap.set(node.id, node.uuid);
  }
  
  return nodes.map(n => apiNodeToGraphNode(n, idToUuidMap));
}

/**
 * Convert nodes for a virtual root scenario.
 * Top-level nodes (those without parents in the set) get assigned to a virtual root.
 * Returns { graphNodes, virtualRootId } where virtualRootId is the ID to pass to NoteesEditor.
 */
export function apiNodesToGraphNodesWithVirtualRoot(
  nodes: Node[],
  virtualRootId: string
): { graphNodes: GraphNode[]; virtualRootId: string } {
  // First, build ID -> UUID map
  const idToUuidMap = new Map<number, string>();
  const nodeIdSet = new Set<number>();
  for (const node of nodes) {
    idToUuidMap.set(node.id, node.uuid);
    nodeIdSet.add(node.id);
  }
  
  // Convert nodes, but override parentId for top-level nodes
  const graphNodes: GraphNode[] = nodes.map(n => {
    const gn = apiNodeToGraphNode(n, idToUuidMap);
    
    // If parent is not in our set, assign to virtual root
    if (!n.parent_id || !nodeIdSet.has(n.parent_id)) {
      gn.parentId = virtualRootId;
    }
    
    return gn;
  });
  
  // Create the virtual root node itself
  const virtualRoot: GraphNode = {
    blockId: virtualRootId,
    serverId: undefined,
    parentId: null,
    orderIndex: 0,
    nodeType: 'page',
    contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
    collapsed: false,
    isDeleted: false,
    isPage: true,
    name: '',
    icon: null,
    color: null,
    classIds: [],
    tagIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
  };
  
  return {
    graphNodes: [virtualRoot, ...graphNodes],
    virtualRootId,
  };
}

function inferNodeType(node: Node): GraphNodeType {
  if (node.is_page) return 'page';
  if (node.is_daily) return 'day';
  if (node.is_monthly) return 'month';
  if (node.is_yearly) return 'year';
  // Check classes for special types
  const classes = node.classes || [];
  for (const cls of classes) {
    const name = typeof cls === 'string' ? cls : String(cls);
    if (name.includes('query')) return 'query';
    if (name.includes('table')) return 'table';
    if (name.includes('code')) return 'code';
    if (name.includes('asset')) return 'asset';
    if (name.includes('card')) return 'card';
    if (name.includes('template')) return 'template';
    if (name.includes('comment')) return 'comment';
  }
  return 'block';
}

/**
 * Hook: Sync API nodes into the runtime when they change.
 */
export function useRuntimeSync(nodes: Node[] | undefined, isLoading: boolean): void {
  useEffect(() => {
    if (!nodes || isLoading) return;

    const runtime = getNodeGraphRuntime();
    const graphNodes = apiNodesToGraphNodes(nodes);
    runtime.upsertNodes(graphNodes);
  }, [nodes, isLoading]);
}

/**
 * Hook: Sync a single page and its children into the runtime.
 */
export function useRuntimePageSync(
  page: Node | undefined,
  children: Node[] | undefined,
  isLoading: boolean,
): void {
  useEffect(() => {
    if (!page || isLoading) return;

    const runtime = getNodeGraphRuntime();
    const allNodes: Node[] = [page, ...(children || [])];
    const graphNodes = apiNodesToGraphNodes(allNodes);
    runtime.upsertNodes(graphNodes);
  }, [page, children, isLoading]);
}
