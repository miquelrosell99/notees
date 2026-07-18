/**
 * useNodeMiscQueries
 */

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import type { Node, PaginatedResponse } from '@/types/api';
import { nodeKeys } from '@/hooks/queryKeys';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStore } from '@/core/hooks/useWorkspaceStore';
import { queryNodes } from '@/core/query/queryNodes';
import { buildTasks } from '@/core/query/tasks';
import { buildTextLinks } from '@/core/query/textLinks';
import { buildSuggestions } from '@/core/query/suggestions';

export function useTasks(includeComplete = false) {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { store, isLoading, error } = useWorkspaceStore(workspaceUuid ?? '');

  const result = useQuery<PaginatedResponse<Node>, Error, Node[]>({
    queryKey: nodeKeys.tasks(includeComplete),
    queryFn: () => {
      if (!store) throw new Error('Workspace store is not ready');
      const items = buildTasks(store, includeComplete);
      return {
        items,
        total: items.length,
        page: 1,
        page_size: items.length,
        has_next: false,
        has_prev: false,
      };
    },
    enabled: !!store,
    select: (data) => data.items,
  });

  return {
    ...result,
    isLoading: result.isLoading || isLoading,
    error: result.error ?? error,
  };
}

/**
 * Hook to fetch nodes with a specific class
 */

export function useNodesWithClass(classUuid: string | null) {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { store, isLoading, error } = useWorkspaceStore(workspaceUuid ?? '');

  const result = useQuery<PaginatedResponse<Node>, Error, Node[]>({
    queryKey: nodeKeys.byClass(classUuid ?? ''),
    queryFn: () => {
      if (!store) throw new Error('Workspace store is not ready');
      const items = queryNodes(store, { classIds: classUuid ? [classUuid] : [] });
      return {
        items,
        total: items.length,
        page: 1,
        page_size: items.length,
        has_next: false,
        has_prev: false,
      };
    },
    enabled: !!store && !!classUuid,
    select: (data) => data.items,
  });

  return {
    ...result,
    isLoading: result.isLoading || isLoading,
    error: result.error ?? error,
  };
}

/**
 * Hook to fetch text links for a node
 */

export function useTextLinks(nodeUuid: string | null) {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { store, isLoading, error } = useWorkspaceStore(workspaceUuid ?? '');

  const result = useQuery<ReturnType<typeof buildTextLinks>>({
    queryKey: nodeKeys.textLinks(nodeUuid ?? ''),
    queryFn: () => {
      if (!store) throw new Error('Workspace store is not ready');
      if (!nodeUuid) throw new Error('Node UUID not found');
      return buildTextLinks(store, nodeUuid);
    },
    enabled: !!store && !!nodeUuid,
    staleTime: 30000,
  });

  return {
    ...result,
    isLoading: result.isLoading || isLoading,
    error: result.error ?? error,
  };
}

/**
 * Hook to fetch suggested pages for node pickers.
 * Returns recently created (last 15 min) then most recently linked pages.
 */

export function useSuggestions(classFilters?: string, enabled = true) {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { store, isLoading, error } = useWorkspaceStore(workspaceUuid ?? '');

  const result = useQuery({
    queryKey: nodeKeys.suggestions(classFilters),
    queryFn: () => {
      if (!store) throw new Error('Workspace store is not ready');
      return buildSuggestions(store, classFilters);
    },
    enabled: enabled && !!store,
    placeholderData: keepPreviousData,
    staleTime: 1000 * 30,
  });

  return {
    ...result,
    isLoading: result.isLoading || isLoading,
    error: result.error ?? error,
  };
}
