/**
 * useNodeLinkQueries
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import { nodeKeys } from '@/hooks/queryKeys';
import { getNodeUuidByServerId } from './useNodeMutations.utils';
import type { MentionsResponse } from '@/types/api';

export function useBacklinks(nodeId: number | null) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: nodeKeys.backlinks(nodeId ?? 0),
    queryFn: () => {
      const nodeUuid = getNodeUuidByServerId(queryClient, nodeId!);
      if (!nodeUuid) throw new Error('Node UUID not found');
      return nodesApi.getBacklinks(nodeUuid);
    },
    enabled: !!nodeId,
    placeholderData: [],
  });
}

/**
 * Hook to fetch linked references with context
 */

export function useLinkedReferences(
  nodeId: number | null,
  params?: { limit?: number; offset?: number }
) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: nodeKeys.linkedRefs(nodeId ?? 0, params),
    queryFn: () => {
      const nodeUuid = getNodeUuidByServerId(queryClient, nodeId!);
      if (!nodeUuid) throw new Error('Node UUID not found');
      return nodesApi.getLinkedReferences(nodeUuid, params);
    },
    enabled: !!nodeId,
    placeholderData: (previousData) => previousData,
  });
}

/**
 * Hook to fetch property backlinks (pages referencing via date/node properties)
 */

export function usePropertyBacklinks(nodeId: number | null) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: nodeKeys.propertyBacklinks(nodeId ?? 0),
    queryFn: () => {
      const nodeUuid = getNodeUuidByServerId(queryClient, nodeId!);
      if (!nodeUuid) throw new Error('Node UUID not found');
      return nodesApi.getPropertyBacklinks(nodeUuid);
    },
    enabled: !!nodeId,
    placeholderData: [],
  });
}

/**
 * Hook to fetch unlinked mention candidates for a node.
 */
export function useUnlinkedMentions(nodeId: number | null) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: nodeKeys.mentions(nodeId ?? 0),
    queryFn: () => {
      const nodeUuid = getNodeUuidByServerId(queryClient, nodeId!);
      if (!nodeUuid) throw new Error('Node UUID not found');
      return nodesApi.getUnlinkedMentions(nodeUuid);
    },
    enabled: !!nodeId,
    placeholderData: [],
  });
}

function findMentionUuid(queryClient: ReturnType<typeof useQueryClient>, nodeId: number, mentionId: number): string | null {
  const data = queryClient.getQueryData<MentionsResponse>(nodeKeys.mentions(nodeId));
  const mention = data?.mentions.find((m) => m.id === mentionId);
  return mention?.uuid ?? null;
}

/**
 * Hook to promote an unlinked mention into a real node link.
 */
export function usePromoteMention() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId, mentionId }: { nodeId: number; mentionId: number }) => {
      const nodeUuid = getNodeUuidByServerId(queryClient, nodeId);
      if (!nodeUuid) throw new Error('Node UUID not found');
      const mentionUuid = findMentionUuid(queryClient, nodeId, mentionId);
      if (!mentionUuid) throw new Error('Mention UUID not found');
      return nodesApi.promoteMention(nodeUuid, mentionUuid);
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.mentions(variables.nodeId) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.backlinks(variables.nodeId) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.linkedRefs(variables.nodeId) });
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
    mutationFn: ({ nodeId, mentionId }: { nodeId: number; mentionId: number }) => {
      const nodeUuid = getNodeUuidByServerId(queryClient, nodeId);
      if (!nodeUuid) throw new Error('Node UUID not found');
      const mentionUuid = findMentionUuid(queryClient, nodeId, mentionId);
      if (!mentionUuid) throw new Error('Mention UUID not found');
      return nodesApi.ignoreMention(nodeUuid, mentionUuid);
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.mentions(variables.nodeId) });
    },
  });
}

/**
 * Hook to restore a previously ignored mention candidate.
 */
export function useUnignoreMention() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId, mentionId }: { nodeId: number; mentionId: number }) => {
      const nodeUuid = getNodeUuidByServerId(queryClient, nodeId);
      if (!nodeUuid) throw new Error('Node UUID not found');
      const mentionUuid = findMentionUuid(queryClient, nodeId, mentionId);
      if (!mentionUuid) throw new Error('Mention UUID not found');
      return nodesApi.unignoreMention(nodeUuid, mentionUuid);
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.mentions(variables.nodeId) });
    },
  });
}

/**
 * Hook to fetch all existing daily pages (without creating new ones).
 * Both useExistingDailyPages and useDailyPages share the same query key
 * to avoid duplicate requests to GET /nodes/daily/list.
 */

