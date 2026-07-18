/**
 * useNodeBasicQueries
 */

import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { isApiError } from '@/api/client';
import * as nodesApi from '@/api/nodes';
import { nodeKeys } from '@/hooks/queryKeys';
import type { Node } from '@/types/api';
import { ENABLE_SQLITE_STORE } from '@/core/utils/featureFlags';
import {
  useNodeAdapter,
  useNodesAdapter,
  useNodeChildrenAdapter,
} from '@/core/adapters';
import { findNodeInTreeByUuid } from './useNodeQueries.utils';

/**
 * Legacy list-node query. Imported by the SQLite adapter so the adapter can
 * delegate when ENABLE_SQLITE_STORE is off without creating a circular call.
 */
export function useNodesLegacy(filters?: { pages_only?: boolean; parent_uuid?: string; tag_uuid?: string; page_size?: number } | null) {
  return useQuery({
    queryKey: nodeKeys.list(filters ?? {}),
    queryFn: () => nodesApi.listNodes(filters ?? undefined),
    enabled: filters !== null && !ENABLE_SQLITE_STORE,
    placeholderData: [],
  });
}

export function useNodes(filters?: { pages_only?: boolean; parent_uuid?: string; tag_uuid?: string; page_size?: number } | null) {
  const legacyResult = useNodesLegacy(filters);
  const sqliteResult = useNodesAdapter(filters ?? undefined);

  return ENABLE_SQLITE_STORE ? sqliteResult : legacyResult;
}

/**
 * Hook to fetch a single node by ID
 */

/**
 * Legacy single-node query. Imported by the SQLite adapter so the adapter can
 * delegate when ENABLE_SQLITE_STORE is off without creating a circular call.
 */
export function useNodeLegacy(
  id: string | null,
  options?: {
    include_children?: boolean;
    include_backlinks?: boolean;
    include_properties?: boolean;
    meta?: Record<string, unknown>;
    staleTime?: number;
  }
) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { meta, staleTime, ...apiOptions } = options || {};
  const nodeUuid = id;
  // Detail queries that include full child trees can hold tens of megabytes in
  // memory. Keep a shorter gcTime than the global default so old node caches are
  // collected sooner after the user navigates away.
  const gcTime = apiOptions.include_children ? 1000 * 60 * 2 : undefined;
  const result = useQuery({
    queryKey: nodeKeys.detail(id ?? '', apiOptions),
    queryFn: () => nodesApi.getNode(nodeUuid!, apiOptions),
    enabled: !!nodeUuid && !ENABLE_SQLITE_STORE,
    meta,
    staleTime,
    gcTime,
    // Provide data from existing parent caches while the fresh fetch loads.
    // This prevents showing empty content when navigating to a block's
    // focused view before its content save has completed on the server.
    placeholderData: () => {
      if (!nodeUuid) return undefined;
      const queryCache = queryClient.getQueryCache();
      for (const query of queryCache.findAll({ queryKey: nodeKeys.details() })) {
        const data = query.state.data as Node | undefined;
        if (data) {
          const found = findNodeInTreeByUuid(data, nodeUuid);
          if (found) return found;
        }
      }
      return undefined;
    },

    retry: (failureCount, error) => {
      // Don't retry on 404 - node has been deleted
      if (isApiError(error) && error.response?.status === 404) {
        return false;
      }
      return failureCount < 1;
    },
  });

  // If we get a 404 for the currently viewed node, navigate to home
  // Wrapped in useEffect to avoid scheduling state updates during render,
  // which can trigger "Maximum update depth exceeded" loops.
  useEffect(() => {
    if (result.error && isApiError(result.error) && result.error.response?.status === 404 && nodeUuid) {
      import('@/stores').then(({ useNavigationStore }) => {
        const currentNodeUuid = useNavigationStore.getState().currentNodeUuid;
        if (currentNodeUuid === nodeUuid) {
          // Node was deleted, navigate away
          useNavigationStore.setState({
            currentNodeUuid: null,
            mainViewType: 'node'
          });
          // Navigate to workspace home
          navigate(workspaceId ? `/${workspaceId}` : '/', { replace: true });
        }
      });
    }
  }, [result.error, nodeUuid, navigate, workspaceId]);

  return result;
}

export function useNode(
  id: string | null,
  options?: {
    include_children?: boolean;
    include_backlinks?: boolean;
    include_properties?: boolean;
    meta?: Record<string, unknown>;
    staleTime?: number;
  }
) {
  const legacyResult = useNodeLegacy(id, options);
  const sqliteResult = useNodeAdapter(id, options);

  return ENABLE_SQLITE_STORE ? sqliteResult : legacyResult;
}

/**
 * PERFORMANCE: Metadata-only node fetch
 * 
 * Loads minimal node data without children, backlinks, or properties.
 * Use for breadcrumbs, link previews, and other lightweight displays.
 * 
 * This uses a separate cache key to avoid polluting the full detail cache.
 */

export function useNodeMetadata(id: string | null) {
  const nodeUuid = id;
  return useQuery({
    queryKey: nodeKeys.metadata(id ?? ''),
    queryFn: () => nodesApi.getNode(nodeUuid!, {
      include_children: false,
      include_backlinks: false,
      include_properties: false,
    }),
    enabled: !!nodeUuid,
    // Metadata is stable, cache longer
    staleTime: 1000 * 60 * 10, // 10 minutes
  });
}

/**
 * PERFORMANCE: Children-only fetch
 * 
 * Loads just the direct children of a node, useful for lazy-loading tree views.
 * Results are normalized into the main node cache on success.
 */

/**
 * Legacy children query. Imported by the SQLite adapter so the adapter can
 * delegate when ENABLE_SQLITE_STORE is off without creating a circular call.
 */
export function useNodeChildrenLegacy(parentId: string | null) {
  const parentUuid = parentId;
  return useQuery({
    queryKey: nodeKeys.childrenOnly(parentId ?? ''),
    queryFn: async () => {
      const parent = await nodesApi.getNode(parentUuid!, { include_children: true });
      return parent.children ?? [];
    },
    enabled: !!parentUuid && !ENABLE_SQLITE_STORE,
    staleTime: 1000 * 60 * 5,
  });
}

export function useNodeChildren(parentId: string | null) {
  const legacyResult = useNodeChildrenLegacy(parentId);
  const sqliteResult = useNodeChildrenAdapter(parentId);

  return ENABLE_SQLITE_STORE ? sqliteResult : legacyResult;
}

/**
 * Hook to fetch a node by UUID
 */

export function useNodeByUuid(
  uuid: string | null,
  options?: {
    include_children?: boolean;
    include_backlinks?: boolean;
    meta?: Record<string, unknown>;
  }
) {
  const { meta, ...apiOptions } = options || {};
  return useQuery({
    queryKey: nodeKeys.byUuid(uuid ?? ''),
    queryFn: () => nodesApi.getNodeByUuid(uuid!, apiOptions),
    enabled: !!uuid,
    meta,
  });
}

/**
 * Hook to fetch page content (blocks, properties, backlinks)
 */

export function usePageContent(pageId: string | null) {
  const pageUuid = pageId;
  return useQuery({
    queryKey: nodeKeys.pageContent(pageId ?? ''),
    queryFn: () => nodesApi.getPageContent(pageUuid!),
    enabled: !!pageUuid,

  });
}

/**
 * Hook to fetch workspace data for visualization
 * @deprecated Use useGraphNodes + useGraphLinks separately instead
 */
