/**
 * Shared utilities for node mutation hooks.
 */

import type { QueryClient } from '@tanstack/react-query';
import type { Node } from '@/types/api';
import { nodeKeys } from './queryKeys';
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
    nodeId?: number;
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
    nodeId,
    refetch = false,
  } = options;

  const refetchType = refetch ? 'active' : 'none';

  if (lists) {
    queryClient.invalidateQueries({ 
      queryKey: nodeKeys.lists(),
      refetchType,
    });
  }

  if (pages) {
    // Use ['nodes', 'pages'] prefix (without options) so ALL usePages() variants
    // are matched — e.g. usePages({ includeChildren: true }) which uses a different
    // options object and would otherwise be missed.
    queryClient.invalidateQueries({ 
      queryKey: [...nodeKeys.all, 'pages'],
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
      queryKey: [...nodeKeys.all, 'search'],
      refetchType,
    });
  }

  if (linkedRefs) {
    queryClient.invalidateQueries({ 
      queryKey: ['nodes', 'linked-refs'],
      refetchType,
    });
  }

  if (backlinks) {
    queryClient.invalidateQueries({ 
      queryKey: ['nodes', 'backlinks'],
      refetchType,
    });
  }

  if (propertyBacklinks) {
    queryClient.invalidateQueries({ 
      queryKey: ['nodes', 'property-backlinks'],
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
      queryKey: [...nodeKeys.all, 'breadcrumbs'],
      refetchType,
    });
  }

  if (nodeId !== undefined) {
    queryClient.invalidateQueries({ 
      queryKey: nodeKeys.detailBase(nodeId),
      refetchType,
    });
  }
}

// ==================== Node Mutations ====================

// Counter for optimistic IDs - negative to avoid collision with real IDs
// Module-level to ensure uniqueness across all hook instances

export const TABLE_CLASS_UUID = '00000000-0000-0000-0001-000000000015';

/**
 * Helper to find a node in the query cache by ID
 * Searches through all detail and page-content queries
 */
export function findNodeInCache(queryClient: QueryClient, nodeId: number): Node | null {
  const queryCache = queryClient.getQueryCache();
  
  // Search all detail queries
  const detailQueries = queryCache.findAll({ queryKey: nodeKeys.details() });
  for (const query of detailQueries) {
    const data = query.state.data as Node | undefined;
    if (data) {
      const found = findNodeInRootTree(data, nodeId);
      if (found) return found;
    }
  }
  
  // Search all page-content queries
  const pageContentQueries = queryCache.findAll({ queryKey: nodeKeys.pageContents() });
  for (const query of pageContentQueries) {
    const data = query.state.data as Node | undefined;
    if (data) {
      const found = findNodeInRootTree(data, nodeId);
      if (found) return found;
    }
  }
  
  return null;
}

/**
 * Check if a node has the table class
 */
export function hasTableClass(node: Node, allClasses: Node[] | undefined): boolean {
  if (!node.classes || !allClasses) return false;
  
  const tableClass = allClasses.find(c => c.uuid === TABLE_CLASS_UUID);
  if (!tableClass) return false;
  
  return node.classes.includes(tableClass.id);
}
