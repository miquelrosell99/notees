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
import { stringifyAST, StringifyMode } from '@/lib/stringifyAST';
import { queryClient } from '@/lib/queryClient';
import { nodeKeys } from './queryKeys';
import { SYSTEM_CLASS_UUIDS } from '@/constants';

/**
 * Convert an API Node to a GraphNode for the runtime.
 * Note: parentId will be set as the parent's UUID if idToUuidMap is provided.
 */
export function apiNodeToGraphNode(
  node: Node,
  idToUuidMap?: Map<number, string>,
  classIdToUuidMap?: Map<number, string>,
): GraphNode {
  // Convert parent_id (server ID) to parent UUID
  let parentUuid: string | null = null;
  if (node.parent_id) {
    if (idToUuidMap) {
      parentUuid = idToUuidMap.get(node.parent_id) ?? null;
    }
    // Fallback: if no map or not found, leave as null
    // (node won't be linked to parent but at least won't crash)
  }
  
  // Parse AST once — reuse for both contentAST and the plain-text name
  const ast = parseAST(node.name);
  return {
    blockId: node.uuid,
    serverId: node.id,
    parentId: parentUuid,
    orderIndex: node.sequence ?? 0,
    nodeType: inferNodeType(node, classIdToUuidMap),
    contentAST: ast as ContentAST,
    collapsed: node.collapsed ?? false,
    isDeleted: node.is_deleted ?? false,
    isPage: node.is_page ?? false,
    name: stringifyAST(ast, { mode: StringifyMode.TEXT_ONLY }),
    icon: node.icon || null,
    color: node.color || null,
    classIds: (node.classes || []).map(String),
    tagIds: (node.tags || []).map(String),
    createdAt: node.create_date || new Date().toISOString(),
    updatedAt: node.write_date || new Date().toISOString(),
    version: 1,
    // Track if server says this node has children that weren't sent (collapsed pruning)
    hasServerChildren: node.has_children ?? false,
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
  const classIdToUuidMap = buildClassIdToUuidMap();
  return nodes.map(n => apiNodeToGraphNode(n, idToUuidMap, classIdToUuidMap));
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
  const classIdToUuidMap = buildClassIdToUuidMap();

  // Include parent/page in map so children's parent_id resolves to pageUuid
  if (pageId != null && pageUuid) {
    idToUuidMap.set(pageId, pageUuid);
  }

  // Build a serverId → existing runtime blockId map so we can reconcile
  // API nodes with runtime blocks that were created optimistically (e.g. via
  // Enter split_block or useCreateNode optimistic updates).  Without this,
  // a refetch after persistence would introduce a duplicate block under the
  // server-assigned UUID while the runtime still holds the original blockId,
  // causing a flash (remove old + add new) and cursor loss.
  const runtime = getNodeGraphRuntime();
  const serverIdToRuntimeBlockId = new Map<number, string>();
  for (const node of nodes) {
    // Check if runtime already has a block with this serverId under a different blockId
    const existing = runtime.getNodeByServerId(node.id);
    if (existing && existing.blockId !== node.uuid) {
      // Reuse the runtime's blockId so upsertNodes treats it as an update
      serverIdToRuntimeBlockId.set(node.id, existing.blockId);
      idToUuidMap.set(node.id, existing.blockId);
    } else {
      idToUuidMap.set(node.id, node.uuid);
    }
    nodeIdSet.add(node.id);
  }

  const graphNodes = nodes.map(n => {
    const gn = apiNodeToGraphNode(n, idToUuidMap, classIdToUuidMap);
    // If this node was reconciled, rewrite its blockId to the runtime's blockId
    const runtimeBlockId = serverIdToRuntimeBlockId.get(n.id);
    if (runtimeBlockId) {
      gn.blockId = runtimeBlockId;
    }
    return gn;
  });

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

  // Multiple top-level nodes without a common resolvable parent.
  // Create a stable virtual root so project() can find all of them.
  if (topLevelNodes.length > 1) {
    // Use count + first/last IDs for a compact, stable identifier
    const sorted = topLevelNodes.map(n => n.id).sort((a, b) => a - b);
    const virtualRootId = `vroot-${sorted[0]}-${sorted[sorted.length - 1]}-${sorted.length}`;
    const topLevelUuids = new Set(topLevelNodes.map(n => n.uuid));
    for (const gn of graphNodes) {
      if (topLevelUuids.has(gn.blockId)) {
        gn.parentId = virtualRootId;
      }
    }
    return { graphNodes, rootBlockId: virtualRootId };
  }

  // Last resort: first node's UUID
  return { graphNodes, rootBlockId: nodes[0]?.uuid || '' };
}

/**
 * UUID → GraphNodeType mapping for system classes that define special block types.
 */
const CLASS_UUID_TO_NODE_TYPE: Partial<Record<string, GraphNodeType>> = {
  [SYSTEM_CLASS_UUIDS.query]: 'query',
  [SYSTEM_CLASS_UUIDS.table]: 'table',
  [SYSTEM_CLASS_UUIDS.code]: 'code',
  [SYSTEM_CLASS_UUIDS.asset]: 'asset',
  [SYSTEM_CLASS_UUIDS.card]: 'card',
  [SYSTEM_CLASS_UUIDS.template]: 'template',
  [SYSTEM_CLASS_UUIDS.comment]: 'comment',
};

/**
 * Build a class server-ID → UUID map from the TanStack Query cache.
 * Used to resolve numeric class IDs to UUIDs for type inference.
 */
function buildClassIdToUuidMap(): Map<number, string> {
  const allClasses = queryClient.getQueryData<Node[]>(nodeKeys.classes());
  if (!allClasses) return new Map();
  const map = new Map<number, string>();
  for (const cls of allClasses) {
    map.set(cls.id, cls.uuid);
  }
  return map;
}

function inferNodeType(node: Node, classIdToUuidMap?: Map<number, string>): GraphNodeType {
  if (node.is_page) return 'page';
  if (node.is_daily) return 'day';
  if (node.is_monthly) return 'month';
  if (node.is_yearly) return 'year';
  // Check classes for special types
  const classes = node.classes || [];
  if (classes.length === 0) return 'block';

  // Resolve class server IDs to UUIDs via the cached class list
  const map = classIdToUuidMap || buildClassIdToUuidMap();
  for (const classId of classes) {
    const uuid = map.get(classId);
    if (uuid) {
      const nodeType = CLASS_UUID_TO_NODE_TYPE[uuid];
      if (nodeType) return nodeType;
    }
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
