/**
 * useNodeLinkQueries
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import { nodeKeys } from '@/hooks/queryKeys';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { useConnectionStore } from '@/stores/connectionStore';
import { useWorkspaceRole } from '@/features/workspace';
import { getWorkspaceStore } from '@/core/adapters/workspaceStoreAdapter';
import { buildLinkedReferences } from '@/core/query/linkedReferences';
import type { MentionsResponse } from '@/types/api';

export function useBacklinks(nodeUuid: string | null) {
  return useQuery({
    queryKey: nodeKeys.backlinks(nodeUuid ?? ''),
    queryFn: () => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      return nodesApi.getBacklinks(nodeUuid);
    },
    enabled: !!nodeUuid,
    placeholderData: [],
  });
}

/**
 * Hook to fetch linked references with context
 */

export function useLinkedReferences(
  nodeUuid: string | null,
  params?: { limit?: number; offset?: number }
) {
  const isOnline = useOnlineStatus();
  const backendHealthy = useConnectionStore((s) => s.healthy);
  const isOffline = !isOnline || backendHealthy === false;
  const { activeWorkspace } = useWorkspaceRole();
  const workspaceUuid = activeWorkspace?.uuid ?? null;
  const offlineReady = isOffline && !!workspaceUuid;

  return useQuery({
    queryKey: nodeKeys.linkedRefs(nodeUuid ?? '', params),
    queryFn: () => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      if (offlineReady) {
        const store = getWorkspaceStore(workspaceUuid);
        if (!store) throw new Error('Workspace store is not ready');
        return buildLinkedReferences(store, nodeUuid, params);
      }
      return nodesApi.getLinkedReferences(nodeUuid, params);
    },
    enabled: !!nodeUuid && (!isOffline || offlineReady),
    staleTime: isOffline ? 0 : 30_000,
    placeholderData: (previousData) => previousData,
  });
}

/**
 * Hook to fetch property backlinks (pages referencing via date/node properties)
 */

export function usePropertyBacklinks(nodeUuid: string | null) {
  return useQuery({
    queryKey: nodeKeys.propertyBacklinks(nodeUuid ?? ''),
    queryFn: () => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      return nodesApi.getPropertyBacklinks(nodeUuid);
    },
    enabled: !!nodeUuid,
    placeholderData: [],
  });
}

/**
 * Hook to fetch unlinked mention candidates for a node.
 */
export function useUnlinkedMentions(nodeUuid: string | null) {
  return useQuery({
    queryKey: nodeKeys.mentions(nodeUuid ?? ''),
    queryFn: () => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      return nodesApi.getUnlinkedMentions(nodeUuid);
    },
    enabled: !!nodeUuid,
    placeholderData: [],
  });
}

function findMentionUuid(queryClient: ReturnType<typeof useQueryClient>, nodeUuid: string, mentionUuid: string): string | null {
  const data = queryClient.getQueryData<MentionsResponse>(nodeKeys.mentions(nodeUuid));
  const mention = data?.mentions.find((m) => m.uuid === mentionUuid);
  return mention?.uuid ?? mentionUuid;
}

/**
 * Hook to promote an unlinked mention into a real node link.
 */
export function usePromoteMention() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeUuid, mentionUuid }: { nodeUuid: string; mentionUuid: string }) => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      const resolvedMentionUuid = findMentionUuid(queryClient, nodeUuid, mentionUuid);
      if (!resolvedMentionUuid) throw new Error('Mention UUID not found');
      return nodesApi.promoteMention(nodeUuid, resolvedMentionUuid);
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
    mutationFn: ({ nodeUuid, mentionUuid }: { nodeUuid: string; mentionUuid: string }) => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      const resolvedMentionUuid = findMentionUuid(queryClient, nodeUuid, mentionUuid);
      if (!resolvedMentionUuid) throw new Error('Mention UUID not found');
      return nodesApi.ignoreMention(nodeUuid, resolvedMentionUuid);
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
    mutationFn: ({ nodeUuid, mentionUuid }: { nodeUuid: string; mentionUuid: string }) => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      const resolvedMentionUuid = findMentionUuid(queryClient, nodeUuid, mentionUuid);
      if (!resolvedMentionUuid) throw new Error('Mention UUID not found');
      return nodesApi.unignoreMention(nodeUuid, resolvedMentionUuid);
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.mentions(variables.nodeUuid) });
    },
  });
}

/**
 * Hook to fetch all existing daily pages (without creating new ones).
 * Both useExistingDailyPages and useDailyPages share the same query key
 * to avoid duplicate requests to GET /nodes/daily/list.
 */

