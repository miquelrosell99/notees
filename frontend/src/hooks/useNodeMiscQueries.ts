/**
 * useNodeMiscQueries
 */

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import { nodeKeys } from './queryKeys';
import type { Node, PaginatedResponse } from '@/types/api';

export function useTasks(includeComplete = false) {
  return useQuery<PaginatedResponse<Node>, Error, Node[]>({
    queryKey: nodeKeys.tasks(includeComplete),
    queryFn: () => nodesApi.listTasks(includeComplete),
    select: (data) => data.items,
  });
}

/**
 * Hook to fetch archived pages
 */

export function useArchivedPages() {
  return useQuery<PaginatedResponse<Node>, Error, Node[]>({
    queryKey: nodeKeys.archived(),
    queryFn: () => nodesApi.getArchivedPages(),
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
 * Hook to fetch text links for a node with is_tag info
 */

export function useTextLinks(nodeId: number | null) {
  return useQuery({
    queryKey: nodeKeys.textLinks(nodeId ?? 0),
    queryFn: () => nodesApi.getTextLinks(nodeId!),
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

