/**
 * Shared utilities for node mutation hooks.
 */

import type { QueryClient } from '@tanstack/react-query';
import type { Node } from '@/types/api';
import { nodeKeys } from '@/hooks/queryKeys';
import { queryClient } from '@/lib/queryClient';
import { apiNodeToGraphNode } from './useRuntimeSync';
import { nodeViewKeys } from './useNodeViews';
import { findNodeInRootTree } from '@/utils/nodeTree';
import { getOperationRuntime } from '@/runtime';
import { getRuntimeEventBus } from '@/runtime/eventBus';
import { getUndoEngine } from '@/stores/undoEngine';
import { waitForOperationAck } from '@/sync/waitForOperation';
import type { MutationIntent } from '@/runtime/types';


export function invalidateNodeCaches(
  queryClient: QueryClient,
  options: {
    /** Invalidate list queries (sidebar) */
    lists?: boolean;
    /** Invalidate pages queries */
    pages?: boolean;
    /** Invalidate classes queries */
    classes?: boolean;
    /** Invalidate search queries */
    search?: boolean;
    /** Invalidate linked references queries */
    linkedRefs?: boolean;
    /** Invalidate backlinks queries */
    backlinks?: boolean;
    /** Invalidate property backlinks queries */
    propertyBacklinks?: boolean;
    /** Invalidate node view query results */
    queryResults?: boolean;
    /** Invalidate graph data query */
    graph?: boolean;
    /** Invalidate breadcrumbs queries */
    breadcrumbs?: boolean;
    /** Invalidate a specific node's detail cache */
    nodeUuid?: string;
    /** Whether to actively refetch (default: false for soft invalidation) */
    refetch?: boolean;
  } = {}
) {
  const {
          lists = false,
          pages = false,
          classes = false,
          search = false,
          linkedRefs = false,
          backlinks = false,
          propertyBacklinks = false,
          queryResults = false,
          graph = false,
          breadcrumbs = false,
          nodeUuid,
          refetch = false } = options;

  const refetchType = refetch ? 'active' : 'none';

  if (lists) {
    queryClient.invalidateQueries({
      queryKey: nodeKeys.lists(),
      refetchType,
    });
  }

  if (pages) {
    queryClient.invalidateQueries({
      queryKey: nodeKeys.allPages(),
      refetchType,
    });
  }

  if (classes) {
    queryClient.invalidateQueries({
      queryKey: nodeKeys.classes(),
      refetchType,
    });
  }

  if (search) {
    queryClient.invalidateQueries({
      queryKey: nodeKeys.searchAll(),
      refetchType,
    });
  }

  if (linkedRefs) {
    queryClient.invalidateQueries({
      queryKey: nodeKeys.allLinkedRefs(),
      refetchType,
    });
  }

  if (backlinks) {
    queryClient.invalidateQueries({
      queryKey: nodeKeys.allBacklinks(),
      refetchType,
    });
  }

  if (propertyBacklinks) {
    queryClient.invalidateQueries({
      queryKey: nodeKeys.allPropertyBacklinks(),
      refetchType,
    });
  }

  if (queryResults) {
    queryClient.invalidateQueries({
      queryKey: nodeViewKeys.queryResults(),
      refetchType,
    });
  }

  if (graph) {
    queryClient.invalidateQueries({
      queryKey: nodeKeys.graph(),
      refetchType,
    });
  }

  if (breadcrumbs) {
    queryClient.invalidateQueries({
      queryKey: nodeKeys.breadcrumbsAll(),
      refetchType,
    });
  }

  if (nodeUuid !== undefined) {
    queryClient.invalidateQueries({
      queryKey: nodeKeys.detailBase(nodeUuid),
      refetchType,
    });
  }
}

// ==================== Node Mutations ====================

export const TABLE_CLASS_UUID = '00000000-0000-0000-0001-000000000015';

/**
 * Helper to find a node in the query cache by UUID.
 * Searches through all detail and page-content queries.
 */
export function findNodeInCache(queryClient: QueryClient, nodeUuid: string): Node | null {
  const queryCache = queryClient.getQueryCache();

  const candidates = [
    ...queryCache.findAll({ queryKey: nodeKeys.details() }),
    ...queryCache.findAll({ queryKey: nodeKeys.pageContents() }),
  ];
  for (const query of candidates) {
    const data = query.state.data as Node | undefined;
    if (data) {
      const found = findNodeInRootTree(data, nodeUuid);
      if (found) return found;
    }
  }

  return null;
}

/**
 * Check if a node has the table class.
 */
export function hasTableClass(node: Node, allClasses: Node[] | undefined): boolean {
  if (!node.classes_uuid || !allClasses) return false;

  const tableClass = allClasses.find(c => c.uuid === TABLE_CLASS_UUID);
  if (!tableClass) return false;

  return node.classes_uuid.includes(tableClass.uuid);
}

/**
 * Apply a runtime mutation intent and return the operation ID so callers can
 * wait for SyncManager to acknowledge it.
 */
export async function applyNodeIntent(intent: MutationIntent): Promise<string> {
  await getUndoEngine().applyIntent(intent, { pushUndo: true });
  getRuntimeEventBus().flushEvents();
  const ops = getOperationRuntime().getOperations();
  // The operation we just added is the last new one.
  return ops[ops.length - 1]?.id ?? '';
}

/**
 * Emit a runtime intent for a node UUID and wait for acknowledgement.
 * Returns false if the node is not in the runtime (caller should fall back to
 * a direct API mutation).
 */
export function ensureNodeInRuntime(nodeUuid: string): string | null {
  const runtime = getOperationRuntime();
  const runtimeNode = runtime.getNode(nodeUuid);
  if (runtimeNode) {
    return runtimeNode.blockId;
  }

  const cachedNode = queryClient.getQueryData<Node>(nodeKeys.byUuid(nodeUuid));
  if (!cachedNode) return null;

  const allClasses = queryClient.getQueryData<Node[]>(nodeKeys.classes());
  runtime.upsertBaseNodes([apiNodeToGraphNode(cachedNode, allClasses ?? undefined)]);
  return runtime.getNode(nodeUuid)?.blockId ?? cachedNode.uuid;
}

export async function emitNodeIntentAndWait(
  nodeUuid: string,
  intent: MutationIntent,
): Promise<boolean> {
  if (!ensureNodeInRuntime(nodeUuid)) return false;

  const operationId = await applyNodeIntent(intent);
  if (!operationId) return false;

  await waitForOperationAck(operationId);
  return true;
}

// ─── UUID bridge helpers (legacy numeric names kept for minimal caller churn) ───

function findNodeUuidInCache(queryClient: QueryClient, nodeUuid: string): string | null {
  const node = findNodeInCache(queryClient, nodeUuid);
  return node?.uuid ?? null;
}

export function getRuntimeBlockIdForServerId(nodeUuid: string): string | null {
  const runtime = getOperationRuntime();
  return runtime.getNode(nodeUuid)?.blockId ?? null;
}

export function getNodeUuidByServerId(queryClient: QueryClient, nodeUuid: string): string | null {
  const runtimeNodeUuid = getRuntimeBlockIdForServerId(nodeUuid);
  if (runtimeNodeUuid) return runtimeNodeUuid;
  return findNodeUuidInCache(queryClient, nodeUuid);
}

export function getClassUuidByServerId(queryClient: QueryClient, classUuid: string): string | null {
  const classes = queryClient.getQueryData<Node[]>(nodeKeys.classes());
  if (!classes) return null;
  return classes.find((c) => c.uuid === classUuid)?.uuid ?? null;
}

export function getTagUuidByServerId(queryClient: QueryClient, tagUuid: string): string | null {
  const pages = queryClient.getQueryData<Node[]>(nodeKeys.pages());
  if (!pages) return null;
  return pages.find((p) => p.uuid === tagUuid)?.uuid ?? null;
}
