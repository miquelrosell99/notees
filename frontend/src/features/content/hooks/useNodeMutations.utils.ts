/**
 * Shared utilities for node mutation hooks.
 */

import type { QueryClient } from '@tanstack/react-query';
import type { Node } from '@/types/api';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from './useNodeViews';
import { findNodeInRootTree } from '@/utils/nodeTree';


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
 * Find a node anywhere in the query cache — by-uuid, detail, page-content,
 * uuid-batch, list, flat result, and metadata caches.
 */
export function findNodeInAnyCache(queryClient: QueryClient, nodeUuid: string): Node | null {
  // Fast path: directly keyed by UUID
  const byUuid = queryClient.getQueryData<Node>(nodeKeys.byUuid(nodeUuid));
  if (byUuid) return byUuid;

  const metadata = queryClient.getQueryData<Node>(nodeKeys.metadata(nodeUuid));
  if (metadata) return metadata;

  // Tree caches
  const fromTree = findNodeInCache(queryClient, nodeUuid);
  if (fromTree) return fromTree;

  const queryCache = queryClient.getQueryCache();

  // UUID-batch caches (tab bar, bulk fetches)
  for (const query of queryCache.findAll({ queryKey: nodeKeys.all })) {
    const key = query.queryKey;
    if (key[1] === 'uuid-batch') {
      const data = query.state.data as { nodes: Record<string, Node> } | undefined;
      if (data?.nodes?.[nodeUuid]) return data.nodes[nodeUuid];
    }
  }

  // Flat array caches (query results, pseudo-node queries, inline queries)
  for (const query of queryCache.findAll({ queryKey: nodeViewKeys.queryResults() })) {
    const data = query.state.data as Node[] | undefined;
    if (data) {
      const found = data.find((n) => n.uuid === nodeUuid);
      if (found) return found;
    }
  }
  for (const query of queryCache.findAll({ queryKey: nodeKeys.pseudoNodeQuery() })) {
    const data = query.state.data as Node[] | undefined;
    if (data) {
      const found = data.find((n) => n.uuid === nodeUuid);
      if (found) return found;
    }
  }
  for (const query of queryCache.findAll({ queryKey: nodeKeys.inlineQuery() })) {
    const data = query.state.data as Node[] | undefined;
    if (data) {
      const found = data.find((n) => n.uuid === nodeUuid);
      if (found) return found;
    }
  }

  // List caches (sidebar, search)
  for (const query of queryCache.findAll({ queryKey: nodeKeys.lists() })) {
    const data = query.state.data as Node[] | undefined;
    if (data) {
      const found = data.find((n) => n.uuid === nodeUuid);
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

// ─── UUID bridge helpers (legacy numeric names kept for minimal caller churn) ───

function findNodeUuidInCache(queryClient: QueryClient, nodeUuid: string): string | null {
  const node = findNodeInCache(queryClient, nodeUuid);
  return node?.uuid ?? null;
}

/**
 * Resolve a node UUID from the query cache.
 *
 * The legacy runtime block-ID lookup has been retired: the core store uses the
 * same public UUIDs as the server, so no translation is necessary.
 */
export function getNodeUuidByServerId(queryClient: QueryClient, nodeUuid: string): string | null {
  return findNodeUuidInCache(queryClient, nodeUuid);
}
