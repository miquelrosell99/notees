/**
 * useNodeLinkQueries
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { nodeKeys } from '@/hooks/queryKeys';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStore } from '@/core/hooks/useWorkspaceStore';
import { buildLinkedReferences } from '@/core/query/linkedReferences';
import { buildBacklinks } from '@/core/query/backlinks';
import { buildPropertyBacklinks } from '@/core/query/propertyBacklinks';
import type { Backlink, LinkedReference, Mention, PropertyBacklink } from '@/types/api';

export function useBacklinks(nodeUuid: string | null) {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { store, isLoading, error } = useWorkspaceStore(workspaceUuid ?? '');

  const result = useQuery<Backlink[]>({
    queryKey: nodeKeys.backlinks(nodeUuid ?? ''),
    queryFn: () => {
      if (!store) throw new Error('Workspace store is not ready');
      if (!nodeUuid) throw new Error('Node UUID not found');
      return buildBacklinks(store, nodeUuid);
    },
    enabled: !!store && !!nodeUuid,
    placeholderData: [],
  });

  return {
    ...result,
    isLoading: result.isLoading || isLoading,
    error: result.error ?? error,
  };
}

/**
 * Hook to fetch linked references with context
 */

export function useLinkedReferences(
  nodeUuid: string | null,
  params?: { limit?: number; offset?: number }
) {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { store, isLoading, error } = useWorkspaceStore(workspaceUuid ?? '');

  const result = useQuery<{ linked_references: LinkedReference[]; total_count: number }>({
    queryKey: nodeKeys.linkedRefs(nodeUuid ?? '', params),
    queryFn: () => {
      if (!store) throw new Error('Workspace store is not ready');
      if (!nodeUuid) throw new Error('Node UUID not found');
      return buildLinkedReferences(store, nodeUuid, params);
    },
    enabled: !!store && !!nodeUuid,
    placeholderData: (previousData) => previousData,
  });

  return {
    ...result,
    isLoading: result.isLoading || isLoading,
    error: result.error ?? error,
  };
}

/**
 * Hook to fetch property backlinks (pages referencing via date/node properties)
 */

export function usePropertyBacklinks(nodeUuid: string | null) {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { store, isLoading, error } = useWorkspaceStore(workspaceUuid ?? '');

  const result = useQuery<PropertyBacklink[]>({
    queryKey: nodeKeys.propertyBacklinks(nodeUuid ?? ''),
    queryFn: () => {
      if (!store) throw new Error('Workspace store is not ready');
      if (!nodeUuid) throw new Error('Node UUID not found');
      return buildPropertyBacklinks(store, nodeUuid);
    },
    enabled: !!store && !!nodeUuid,
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
