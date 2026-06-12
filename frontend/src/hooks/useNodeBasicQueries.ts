/**
 * useNodeBasicQueries
 */

import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { isApiError } from '@/api/client';
import * as nodesApi from '@/api/nodes';
import { nodeKeys } from './queryKeys';
import type { Node } from '@/types/api';
import { findNodeInTree } from './useNodeQueries.utils';

export function useNodes(filters?: { pages_only?: boolean; parent_id?: number; tag_id?: number; page_size?: number } | null) {
  return useQuery({
    queryKey: nodeKeys.list(filters ?? {}),
    queryFn: () => nodesApi.listNodes(filters ?? undefined),
    enabled: filters !== null,
    placeholderData: [],
  });
}

/**
 * Hook to fetch a single node by ID
 */

export function useNode(
  id: number | null,
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
  const result = useQuery({
    queryKey: nodeKeys.detail(id ?? 0, apiOptions),
    queryFn: () => nodesApi.getNode(id!, apiOptions),
    enabled: !!id,
    meta,
    staleTime,
    // Provide data from existing parent caches while the fresh fetch loads.
    // This prevents showing empty content when navigating to a block's
    // focused view before its content save has completed on the server.
    placeholderData: () => {
      if (!id) return undefined;
      const queryCache = queryClient.getQueryCache();
      for (const query of queryCache.findAll({ queryKey: nodeKeys.details() })) {
        const data = query.state.data as Node | undefined;
        if (data) {
          const found = findNodeInTree(data, id);
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
    if (result.error && isApiError(result.error) && result.error.response?.status === 404 && id) {
      import('@/stores').then(({ useNavigationStore }) => {
        const currentNodeId = useNavigationStore.getState().currentNodeId;
        if (currentNodeId === id) {
          // Node was deleted, navigate away
          useNavigationStore.setState({
            currentNodeId: null,
            mainViewType: 'node'
          });
          // Navigate to workspace home
          navigate(workspaceId ? `/${workspaceId}` : '/', { replace: true });
        }
      });
    }
  }, [result.error, id, navigate, workspaceId]);

  return result;
}

/**
 * PERFORMANCE: Metadata-only node fetch
 * 
 * Loads minimal node data without children, backlinks, or properties.
 * Use for breadcrumbs, link previews, and other lightweight displays.
 * 
 * This uses a separate cache key to avoid polluting the full detail cache.
 */

export function useNodeMetadata(id: number | null) {
  return useQuery({
    queryKey: nodeKeys.metadata(id ?? 0),
    queryFn: () => nodesApi.getNode(id!, {
      include_children: false,
      include_backlinks: false,
      include_properties: false,
    }),
    enabled: !!id,
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

export function useNodeChildren(parentId: number | null) {
  return useQuery({
    queryKey: nodeKeys.childrenOnly(parentId ?? 0),
    queryFn: async () => {
      const parent = await nodesApi.getNode(parentId!, { include_children: true });
      return parent.children ?? [];
    },
    enabled: !!parentId,
    staleTime: 1000 * 60 * 5,
  });
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

export function usePageContent(pageId: number | null) {
  return useQuery({
    queryKey: nodeKeys.pageContent(pageId ?? 0),
    queryFn: () => nodesApi.getPageContent(pageId!),
    enabled: !!pageId,

  });
}

/**
 * Hook to fetch workspace data for visualization
 * @deprecated Use useGraphNodes + useGraphLinks separately instead
 */

