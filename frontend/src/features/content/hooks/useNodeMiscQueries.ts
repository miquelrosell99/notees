/**
 * useNodeMiscQueries
 */

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import type { Node, PaginatedResponse, TextLink } from '@/types/api';
import { nodeKeys } from '@/hooks/queryKeys';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';
import { buildTasksFromClient } from '@/core/query/tasks';
import { buildTextLinksFromClient } from '@/core/query/textLinks';
import { buildSuggestionsFromClient } from '@/core/query/suggestions';

export function useTasks(includeComplete = false) {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { client, isLoading, error } = useWorkspaceStoreClient(workspaceUuid ?? '');

  const result = useQuery<PaginatedResponse<Node>, Error, Node[]>({
    queryKey: nodeKeys.tasks(includeComplete),
    queryFn: async () => {
      if (!client) throw new Error('Workspace store is not ready');
      const items = await buildTasksFromClient(client, includeComplete);
      return {
        items,
        total: items.length,
        page: 1,
        page_size: items.length,
        has_next: false,
        has_prev: false,
      };
    },
    enabled: !!client,
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
  const { client, isLoading, error } = useWorkspaceStoreClient(workspaceUuid ?? '');

  const result = useQuery<PaginatedResponse<Node>, Error, Node[]>({
    queryKey: nodeKeys.byClass(classUuid ?? ''),
    queryFn: async () => {
      if (!client) throw new Error('Workspace store is not ready');
      const items = await client.query<Node[]>('queryNodes', [
        { classIds: classUuid ? [classUuid] : [], projectionDepth: 0 },
      ]);
      return {
        items,
        total: items.length,
        page: 1,
        page_size: items.length,
        has_next: false,
        has_prev: false,
      };
    },
    enabled: !!client && !!classUuid,
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
  const { client, isLoading, error } = useWorkspaceStoreClient(workspaceUuid ?? '');

  const result = useQuery<TextLink[]>({
    queryKey: nodeKeys.textLinks(nodeUuid ?? ''),
    queryFn: async () => {
      if (!client) throw new Error('Workspace store is not ready');
      if (!nodeUuid) throw new Error('Node UUID not found');
      return buildTextLinksFromClient(client, nodeUuid);
    },
    enabled: !!client && !!nodeUuid,
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
  const { client, isLoading, error } = useWorkspaceStoreClient(workspaceUuid ?? '');

  const result = useQuery({
    queryKey: nodeKeys.suggestions(classFilters),
    queryFn: async () => {
      if (!client) throw new Error('Workspace store is not ready');
      return buildSuggestionsFromClient(client, classFilters);
    },
    enabled: enabled && !!client,
    placeholderData: keepPreviousData,
    staleTime: 1000 * 30,
  });

  return {
    ...result,
    isLoading: result.isLoading || isLoading,
    error: result.error ?? error,
  };
}
