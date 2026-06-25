/**
 * useNodeMiscQueries
 */

import { useQuery, keepPreviousData, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import { nodeKeys } from '@/hooks/queryKeys';
import type { Node, PaginatedResponse } from '@/types/api';
import { getNodeUuidByServerId } from './useNodeMutations.utils';

export function useTasks(includeComplete = false) {
  return useQuery<PaginatedResponse<Node>, Error, Node[]>({
    queryKey: nodeKeys.tasks(includeComplete),
    queryFn: () => nodesApi.listTasks(includeComplete),
    select: (data) => data.items,
  });
}

/**
 * Hook to fetch nodes with a specific class
 */

export function useNodesWithClass(classId: number | null) {
  return useQuery<PaginatedResponse<Node>, Error, Node[]>({
    queryKey: nodeKeys.byClass(classId ?? 0),
    queryFn: () => nodesApi.getNodesWithClass(classId!),
    enabled: !!classId,
    select: (data) => data.items,
  });
}

/**
 * Hook to fetch text links for a node
 */

export function useTextLinks(nodeId: number | null) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: nodeKeys.textLinks(nodeId ?? 0),
    queryFn: () => {
      const nodeUuid = getNodeUuidByServerId(queryClient, nodeId!);
      if (!nodeUuid) throw new Error('Node UUID not found');
      return nodesApi.getTextLinks(nodeUuid);
    },
    enabled: !!nodeId,
    staleTime: 30000,
  });
}

/**
 * Hook to fetch suggested pages for node pickers.
 * Returns recently created (last 15 min) then most recently linked pages.
 */

export function useSuggestions(classFilters?: string, enabled = true) {
  return useQuery({
    queryKey: nodeKeys.suggestions(classFilters),
    queryFn: () => nodesApi.getSuggestions(20, classFilters),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 1000 * 30,
  });
}

