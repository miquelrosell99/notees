/**
 * useNodeLinkQueries
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import { nodeKeys } from './queryKeys';

export function useBacklinks(nodeId: number | null) {
  return useQuery({
    queryKey: nodeKeys.backlinks(nodeId ?? 0),
    queryFn: () => nodesApi.getBacklinks(nodeId!),
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
  return useQuery({
    queryKey: nodeKeys.linkedRefs(nodeId ?? 0, params),
    queryFn: () => nodesApi.getLinkedReferences(nodeId!, params),
    enabled: !!nodeId,
    placeholderData: (previousData) => previousData,
  });
}

/**
 * Hook to fetch property backlinks (pages referencing via date/node properties)
 */

export function usePropertyBacklinks(nodeId: number | null) {
  return useQuery({
    queryKey: nodeKeys.propertyBacklinks(nodeId ?? 0),
    queryFn: () => nodesApi.getPropertyBacklinks(nodeId!),
    enabled: !!nodeId,
    placeholderData: [],
  });
}

/**
 * Hook to fetch unlinked mention candidates for a node.
 */
export function useUnlinkedMentions(nodeId: number | null) {
  return useQuery({
    queryKey: nodeKeys.mentions(nodeId ?? 0),
    queryFn: () => nodesApi.getUnlinkedMentions(nodeId!),
    enabled: !!nodeId,
    placeholderData: [],
  });
}

/**
 * Hook to promote an unlinked mention into a real node link.
 */
export function usePromoteMention() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId, mentionId }: { nodeId: number; mentionId: number }) =>
      nodesApi.promoteMention(nodeId, mentionId),
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
    mutationFn: ({ nodeId, mentionId }: { nodeId: number; mentionId: number }) =>
      nodesApi.ignoreMention(nodeId, mentionId),
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
    mutationFn: ({ nodeId, mentionId }: { nodeId: number; mentionId: number }) =>
      nodesApi.unignoreMention(nodeId, mentionId),
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

