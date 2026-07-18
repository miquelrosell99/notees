/**
 * useRuntimeSync — Hook to sync backend API data with OperationRuntime.
 *
 * Bridges TanStack Query (server state) with OperationRuntime (client state).
 * Converts API Node objects to GraphNode format and loads them into the runtime.
 */

import type { GraphNode, GraphNodeType, ContentAST } from '@/runtime/types';
import type { Node } from '@/types/api';
import { parseAST } from '@/lib/astBuilder';
import { stringifyAST, StringifyMode } from '@/lib/stringifyAST';
import { queryClient } from '@/lib/queryClient';
import { nodeKeys } from '@/hooks/queryKeys';
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from '@/constants';
import { getEffectiveIcon } from '@/utils/nodeIcon';
import { propertyKeys } from '@/hooks/queryKeys';

/** Map of system class UUIDs to callout banner types */
const CALLOUT_UUID_TO_TYPE: Record<string, string> = {
  [SYSTEM_CLASS_UUIDS.warning]: 'warning',
  [SYSTEM_CLASS_UUIDS.note]: 'note',
  [SYSTEM_CLASS_UUIDS.tip]: 'tip',
  [SYSTEM_CLASS_UUIDS.info]: 'info',
  [SYSTEM_CLASS_UUIDS.danger]: 'danger',
  [SYSTEM_CLASS_UUIDS.success]: 'success',
};

/** Resolve callout type from class UUIDs. */
function resolveCalloutType(classUuids: string[] | undefined): string | null {
  if (!classUuids || classUuids.length === 0) return null;
  for (const classUuid of classUuids) {
    const type = CALLOUT_UUID_TO_TYPE[classUuid];
    if (type) return type;
  }
  return null;
}

/**
 * Convert an API Node to a GraphNode for the runtime.
 */
export function apiNodeToGraphNode(
  node: Node,
  allClasses?: Node[],
): GraphNode {
  // Parse AST once — reuse for both contentAST and the plain-text name
  const ast = parseAST(node.name);
  return {
    blockId: node.uuid,
    parentId: node.parent_uuid,
    orderIndex: node.sequence ?? 0,
    nodeType: inferNodeType(node),
    contentAST: ast as ContentAST,
    collapsed: false,
    isDeleted: node.is_deleted ?? false,
    isPage: node.is_page ?? false,
    name: stringifyAST(ast, { mode: StringifyMode.TEXT_ONLY }),
    icon: getEffectiveIcon(node, allClasses) ?? null,
    // Runtime color is the node's OWN color only. Consumers that treat it as
    // such (e.g. overlayRuntimeContent feeding the block background tint)
    // must not see class-inherited colors here — those are display-only and
    // computed per surface via getEffectiveColor().
    color: node.color ?? null,
    classIds: node.classes_uuid || [],
    tagIds: node.tags_uuid || [],
    calloutType: resolveCalloutType(node.classes_uuid),
    taskStatus: resolveTaskStatus(node),
    createdAt: node.create_date || new Date().toISOString(),
    updatedAt: node.write_date || new Date().toISOString(),
    version: 1,
    // Track if server says this node has children that weren't sent (collapsed pruning)
    hasServerChildren: node.has_children ?? false,
  };
}

/**
 * Convert API nodes to GraphNodes for the editor.
 * No virtual root is created. Instead:
 * - If nodeUuid is provided, rootBlockId = nodeUuid.
 * - Otherwise, auto-detects the root from the array structure.
 *
 * The parent node is NOT added as a GraphNode.
 */
export function apiNodesToGraphNodes(
  nodes: Node[],
  nodeUuid?: string,
): { graphNodes: GraphNode[]; rootBlockId: string } {
  const allClasses = queryClient.getQueryData<Node[]>(nodeKeys.classes());

  const graphNodes = nodes.map(n => apiNodeToGraphNode(n, allClasses ?? undefined));

  // Determine rootBlockId — the parent ID used for project() traversal
  if (nodeUuid) {
    return { graphNodes, rootBlockId: nodeUuid };
  }

  const nodeUuidSet = new Set(nodes.map(n => n.uuid));

  // Auto-detect: find nodes whose parent is not in the set
  const topLevelNodes = nodes.filter(n => !n.parent_uuid || !nodeUuidSet.has(n.parent_uuid));

  if (topLevelNodes.length === 1 && nodes.length > 1) {
    // Single top-level node with children in the array — it's the natural root
    return { graphNodes, rootBlockId: topLevelNodes[0].uuid };
  }

  if (topLevelNodes.length > 0 && topLevelNodes[0].parent_uuid) {
    // Multiple top-level nodes share a common parent not in the set
    return { graphNodes, rootBlockId: topLevelNodes[0].parent_uuid };
  }

  // Multiple top-level nodes without a common resolvable parent.
  // Create a stable virtual root so project() can find all of them.
  if (topLevelNodes.length > 1) {
    const sorted = topLevelNodes.map(n => n.uuid).sort((a, b) => a.localeCompare(b));
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
 * Resolve task status name from a node's properties.
 * Looks up the task_status property value in the node's cached properties
 * and maps the selection option ID to its display name.
 */
function resolveTaskStatus(node: Node): string | null {
  const allProperties = queryClient.getQueryData<{ uuid: string; options?: { uuid: string; name: string }[] }[]>(propertyKeys.lists());
  const statusProp = allProperties?.find(p => p.uuid === SYSTEM_PROPERTY_UUIDS.task_status);
  if (!statusProp || !node.properties_uuid) return null;
  const selId = node.properties_uuid[statusProp.uuid];
  if (typeof selId !== 'string') return null;
  const option = statusProp.options?.find(o => o.uuid === selId);
  return option?.name ?? null;
}

function inferNodeType(node: Node): GraphNodeType {
  if (node.is_page) return 'page';
  if (node.is_daily) return 'day';
  if (node.is_monthly) return 'month';
  if (node.is_yearly) return 'year';
  // Check classes for special types
  const classes = node.classes_uuid || [];
  if (classes.length === 0) return 'block';

  for (const classUuid of classes) {
    const nodeType = CLASS_UUID_TO_NODE_TYPE[classUuid];
    if (nodeType) return nodeType;
  }
  return 'block';
}

/**
 * Hook: Sync API nodes into the runtime when they change.
 *
 * Compatibility shim: the local-first core store is now the source of truth, so
 * syncing API nodes into the legacy OperationRuntime is no longer required.
 * The hook is kept for callers that have not been migrated yet.
 */
export function useRuntimeSync(_nodes: Node[] | undefined, _isLoading: boolean): void {
  // No-op: core store subscribes directly to derived state.
}

/**
 * Hook: Sync a single page and its children into the runtime.
 *
 * Compatibility shim: see useRuntimeSync.
 */
export function useRuntimePageSync(
  _page: Node | undefined,
  _children: Node[] | undefined,
  _isLoading: boolean,
): void {
  // No-op: core store subscribes directly to derived state.
}
