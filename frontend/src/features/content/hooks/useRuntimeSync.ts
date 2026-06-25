/**
 * useRuntimeSync — Hook to sync backend API data with OperationRuntime.
 *
 * Bridges TanStack Query (server state) with OperationRuntime (client state).
 * Converts API Node objects to GraphNode format and loads them into the runtime.
 */

import { useEffect } from 'react';
import type { GraphNode, GraphNodeType, ContentAST } from '@/runtime/types';
import type { Node } from '@/types/api';
import { parseAST } from '@/lib/astBuilder';
import { stringifyAST, StringifyMode } from '@/lib/stringifyAST';
import { queryClient } from '@/lib/queryClient';
import { nodeKeys } from '@/hooks/queryKeys';
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from '@/constants';
import { getEffectiveIcon, getEffectiveColor } from '@/utils/nodeIcon';
import { propertyKeys } from '@/hooks/queryKeys';
import { upsertNodes } from '@/runtime/eventBus';

/** Resolve class icon from numeric class IDs using a prebuilt map */
function resolveClassIcon(classIds: number[] | undefined, iconMap?: Map<number, string>): string | null {
  if (!classIds || classIds.length === 0 || !iconMap) return null;
  for (const id of classIds) {
    const icon = iconMap.get(id);
    if (icon) return icon;
  }
  return null;
}

/** Map of system class UUIDs to callout banner types */
const CALLOUT_UUID_TO_TYPE: Record<string, string> = {
  [SYSTEM_CLASS_UUIDS.warning]: 'warning',
  [SYSTEM_CLASS_UUIDS.note]: 'note',
  [SYSTEM_CLASS_UUIDS.tip]: 'tip',
  [SYSTEM_CLASS_UUIDS.info]: 'info',
  [SYSTEM_CLASS_UUIDS.danger]: 'danger',
  [SYSTEM_CLASS_UUIDS.success]: 'success',
};

/** Resolve callout type from numeric class IDs using a prebuilt map */
function resolveCalloutType(classIds: number[] | undefined, uuidMap?: Map<number, string>): string | null {
  if (!classIds || classIds.length === 0 || !uuidMap) return null;
  for (const id of classIds) {
    const classUuid = uuidMap.get(id);
    if (classUuid) {
      const type = CALLOUT_UUID_TO_TYPE[classUuid];
      if (type) return type;
    }
  }
  return null;
}

/**
 * Convert an API Node to a GraphNode for the runtime.
 * Note: parentId will be set as the parent's UUID if idToUuidMap is provided.
 */
export function apiNodeToGraphNode(
  node: Node,
  idToUuidMap?: Map<number, string>,
  classIdToUuidMap?: Map<number, string>,
  classIdToIconMap?: Map<number, string>,
  allClasses?: Node[],
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
    icon: getEffectiveIcon(node, allClasses) ?? resolveClassIcon(node.classes, classIdToIconMap) ?? null,
    color: getEffectiveColor(node, allClasses) ?? null,
    classIds: (node.classes || []).map(String),
    tagIds: (node.tags || []).map(String),
    calloutType: resolveCalloutType(node.classes, classIdToUuidMap),
    taskStatus: resolveTaskStatus(node),
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
  const classIdToIconMap = buildClassIdToIconMap();
  const allClasses = queryClient.getQueryData<Node[]>(nodeKeys.classes());
  return nodes.map(n => apiNodeToGraphNode(n, idToUuidMap, classIdToUuidMap, classIdToIconMap, allClasses ?? undefined));
}

/**
 * Convert API nodes to GraphNodes for the editor.
 * No virtual root is created. Instead:
 * - If pageId/nodeUuid are provided, they're added to the ID→UUID map so
 *   children's parent_id resolves correctly. rootBlockId = nodeUuid.
 * - Otherwise, auto-detects the root from the array structure.
 *
 * The parent node is NOT added as a GraphNode — only its serverId is registered
 * via runtime.registerParentServerId() by the caller.
 */
export function apiNodesToGraphNodes(
  nodes: Node[],
  pageId?: number,
  nodeUuid?: string,
): { graphNodes: GraphNode[]; rootBlockId: string } {
  console.log('[apiNodesToGraphNodes] called', { nodeCount: nodes.length, pageId, nodeUuid, topLevelUuids: nodes.map((n) => n.uuid) });
  const idToUuidMap = new Map<number, string>();
  const nodeIdSet = new Set<number>();
  const classIdToUuidMap = buildClassIdToUuidMap();
  const classIdToIconMap = buildClassIdToIconMap();
  const allClasses = queryClient.getQueryData<Node[]>(nodeKeys.classes());

  // Include parent/page in map so children's parent_id resolves to nodeUuid
  if (pageId != null && nodeUuid) {
    idToUuidMap.set(pageId, nodeUuid);
  }

  // With the intent-aware upsertNodes, the runtime preserves locally-mutated
  // fields for nodes with pending intents and accepts server state for all
  // other fields. The old serverId→runtimeBlockId reconciliation hack is no
  // longer needed because remapBlockId is called before cache invalidation
  // in the bridge hooks, so the runtime and API data use the same UUID.
  for (const node of nodes) {
    idToUuidMap.set(node.id, node.uuid);
    nodeIdSet.add(node.id);
  }

  const graphNodes = nodes.map(n =>
    apiNodeToGraphNode(n, idToUuidMap, classIdToUuidMap, classIdToIconMap, allClasses ?? undefined)
  );

  console.log('[apiNodesToGraphNodes] output', {
    firstGraphNode: graphNodes[0]?.blockId,
    firstParentId: graphNodes[0]?.parentId,
    firstOrderIndex: graphNodes[0]?.orderIndex,
    idToUuidMapSize: idToUuidMap.size,
    idToUuidMapHasPageId: pageId != null ? idToUuidMap.has(pageId) : null,
  });

  // Determine rootBlockId — the parent ID used for project() traversal
  if (nodeUuid) {
    return { graphNodes, rootBlockId: nodeUuid };
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

function buildClassIdToIconMap(): Map<number, string> {
  const allClasses = queryClient.getQueryData<Node[]>(nodeKeys.classes());
  if (!allClasses) return new Map();
  const map = new Map<number, string>();
  for (const cls of allClasses) {
    if (cls.icon) map.set(cls.id, cls.icon);
  }
  return map;
}

/**
 * Resolve task status name from a node's properties.
 * Looks up the task_status property value in the node's cached properties
 * and maps the selection option ID to its display name.
 */
function resolveTaskStatus(node: Node): string | null {
  const allProperties = queryClient.getQueryData<{ id: number; uuid: string; options?: { id: number; name: string }[] }[]>(propertyKeys.lists());
  const statusProp = allProperties?.find(p => p.uuid === SYSTEM_PROPERTY_UUIDS.task_status);
  if (!statusProp || !node.properties) return null;
  const selId = node.properties[statusProp.id];
  if (typeof selId !== 'number') return null;
  const option = statusProp.options?.find(o => o.id === selId);
  return option?.name ?? null;
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
    const classUuid = map.get(classId);
    if (classUuid) {
      const nodeType = CLASS_UUID_TO_NODE_TYPE[classUuid];
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

    const graphNodes = convertNodesToGraphNodes(nodes);
    upsertNodes(graphNodes);
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

    const allNodes: Node[] = [page, ...(children || [])];
    const graphNodes = convertNodesToGraphNodes(allNodes);
    upsertNodes(graphNodes);
  }, [page, children, isLoading]);
}
