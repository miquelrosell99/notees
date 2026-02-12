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
 * Simple version used by sync hooks.
 */
function convertNodesToGraphNodes(nodes: Node[]): GraphNode[] {
  const idToUuidMap = new Map<number, string>();
  for (const node of nodes) {
    idToUuidMap.set(node.id, node.uuid);
  }
  return nodes.map(n => apiNodeToGraphNode(n, idToUuidMap));
}

/**
 * Convert API nodes to GraphNodes for the editor.
 * No virtual root is created. Instead:
 * - If pageId/pageUuid are provided, they're added to the ID→UUID map so
 *   children's parent_id resolves correctly. rootBlockId = pageUuid.
 * - Otherwise, auto-detects the root from the array structure.
 *
 * The parent node is NOT added as a GraphNode — only its serverId is registered
 * via runtime.registerParentServerId() by the caller.
 */
export function apiNodesToGraphNodes(
  nodes: Node[],
  pageId?: number,
  pageUuid?: string,
): { graphNodes: GraphNode[]; rootBlockId: string } {
  const idToUuidMap = new Map<number, string>();
  const nodeIdSet = new Set<number>();

  // Include parent/page in map so children's parent_id resolves to pageUuid
  if (pageId != null && pageUuid) {
    idToUuidMap.set(pageId, pageUuid);
  }

  for (const node of nodes) {
    idToUuidMap.set(node.id, node.uuid);
    nodeIdSet.add(node.id);
  }

  const graphNodes = nodes.map(n => apiNodeToGraphNode(n, idToUuidMap));

  // Determine rootBlockId — the parent ID used for project() traversal
  if (pageUuid) {
    return { graphNodes, rootBlockId: pageUuid };
  }

  // Auto-detect: find nodes whose parent is not in the set
  const topLevelNodes = nodes.filter(n => !n.parent_id || !nodeIdSet.has(n.parent_id));

  if (topLevelNodes.length === 1 && nodes.length > 1) {
    // Single top-level node with children in the array — it's the natural root
    return { graphNodes, rootBlockId: topLevelNodes[0].uuid };
  }

  if (topLevelNodes.length > 0 && topLevelNodes[0].parent_id) {
    // Multiple top-level nodes share a common parent not in the set
    const parentUuid = idToUuidMap.get(topLevelNodes[0].parent_id);
    if (parentUuid) {
      return { graphNodes, rootBlockId: parentUuid };
    }
  }

  // Last resort: first node's UUID
  return { graphNodes, rootBlockId: nodes[0]?.uuid || '' };
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
    const graphNodes = convertNodesToGraphNodes(nodes);
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
    const graphNodes = convertNodesToGraphNodes(allNodes);
    runtime.upsertNodes(graphNodes);
  }, [page, children, isLoading]);
}
