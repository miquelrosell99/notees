/**
 * useNodeLinkQueries
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { nodeKeys } from '@/hooks/queryKeys';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';
import { useGraphQuery } from '@/core/graphQueries/hooks/useGraphQuery';
import { GetLinkedReferencesQuery, HydrateLinkedReferencesQuery } from '@/core/graphQueries/queries';
import { buildBacklinksFromClient } from '@/core/query/backlinks';
import { buildPropertyBacklinksFromClient } from '@/core/query/propertyBacklinks';
import type { Backlink, Mention, PropertyBacklink } from '@/types/api';

export function useBacklinks(nodeUuid: string | null) {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { client, isLoading, error } = useWorkspaceStoreClient(workspaceUuid ?? '');

  const result = useQuery<Backlink[]>({
    queryKey: nodeKeys.backlinks(nodeUuid ?? ''),
    queryFn: async () => {
      if (!client) throw new Error('Workspace store is not ready');
      if (!nodeUuid) throw new Error('Node UUID not found');
      return buildBacklinksFromClient(client, nodeUuid);
    },
    enabled: !!client && !!nodeUuid,
    placeholderData: [],
  });

  return {
    ...result,
    isLoading: result.isLoading || isLoading,
    error: result.error ?? error,
  };
}

/**
 * Hook to fetch linked references with context.
 *
 * Uses a two-stage graph-query pipeline: first fetch lightweight source IDs,
 * then hydrate only the visible IDs into full LinkedReference objects.
 */

export function useLinkedReferences(
  nodeUuid: string | null,
  params?: { limit?: number; offset?: number },
  options?: { enabled?: boolean }
) {
  const queryEnabled = options?.enabled ?? true;

  const idsQuery = useGraphQuery(
    GetLinkedReferencesQuery,
    { nodeUuid: nodeUuid ?? '', limit: params?.limit, offset: params?.offset },
    { enabled: !!nodeUuid && queryEnabled }
  );

  const hydrated = useGraphQuery(
    HydrateLinkedReferencesQuery,
    { nodeUuid: nodeUuid ?? '', sourceIds: idsQuery.data?.ids ?? [] },
    { enabled: !!nodeUuid && queryEnabled && (idsQuery.data?.ids.length ?? 0) > 0 }
  );

  return {
    data: idsQuery.data
      ? {
          linked_references: hydrated.data ?? [],
          total_count: idsQuery.data.totalCount,
        }
      : undefined,
    isLoading: idsQuery.isLoading || hydrated.isLoading,
    isFetching: idsQuery.isLoading,
    error: idsQuery.error ?? hydrated.error,
  };
}

/**
 * Hook to fetch property backlinks (pages referencing via date/node properties)
 */

export function usePropertyBacklinks(nodeUuid: string | null) {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { client, isLoading, error } = useWorkspaceStoreClient(workspaceUuid ?? '');

  const result = useQuery<PropertyBacklink[]>({
    queryKey: nodeKeys.propertyBacklinks(nodeUuid ?? ''),
    queryFn: async () => {
      if (!client) throw new Error('Workspace store is not ready');
      if (!nodeUuid) throw new Error('Node UUID not found');
      return buildPropertyBacklinksFromClient(client, nodeUuid);
    },
    enabled: !!client && !!nodeUuid,
    placeholderData: [],
  });

  return {
    ...result,
    isLoading: result.isLoading || isLoading,
    error: result.error ?? error,
  };
}

/**
 * Hook to fetch unlinked mention candidates for a node.
 * Best-effort local implementation — the UI section hides when empty.
 */
export function useUnlinkedMentions(nodeUuid: string | null) {
  return useQuery<Mention[]>({
    queryKey: nodeKeys.mentions(nodeUuid ?? ''),
    queryFn: () => [],
    enabled: !!nodeUuid,
    placeholderData: [],
  });
}

/**
 * Hook to promote an unlinked mention into a real node link.
 */
export function usePromoteMention() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ nodeUuid }: { nodeUuid: string; mentionUuid: string }) => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      // No-op: persistence is not required for this slice.
      return { success: true, source_node_id: null };
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.mentions(variables.nodeUuid) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.backlinks(variables.nodeUuid) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.linkedRefs(variables.nodeUuid) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.allLinkedRefs() });
    },
  });
}

/**
 * Hook to ignore an unlinked mention candidate.
 */
export function useIgnoreMention() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ nodeUuid }: { nodeUuid: string; mentionUuid: string }) => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      // No-op: persistence is not required for this slice.
      return { success: true, is_ignored: true };
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.mentions(variables.nodeUuid) });
    },
  });
}

/**
 * Hook to restore a previously ignored mention candidate.
 */
export function useUnignoreMention() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ nodeUuid }: { nodeUuid: string; mentionUuid: string }) => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      // No-op: persistence is not required for this slice.
      return { success: true, is_ignored: false };
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.mentions(variables.nodeUuid) });
    },
  });
}
