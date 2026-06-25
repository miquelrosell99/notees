/**
 * Activity Hooks
 * 
 * React Query hooks for activity tracking and link click analytics.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as activityApi from '../api/activity';
import { activityKeys } from '@/hooks/queryKeys';
import { getNodeUuidByServerId } from './useNodeMutations.utils';

// ==================== Activity Queries ====================

/**
 * Hook to fetch activity log for a node
 */
export function useNodeActivity(nodeId: string | number | null, limit = 50) {
  const queryClient = useQueryClient();
  const nodeUuid = nodeId === null ? null : typeof nodeId === 'string' ? nodeId : getNodeUuidByServerId(queryClient, nodeId);
  return useQuery({
    queryKey: activityKeys.forNode(nodeUuid ?? ''),
    queryFn: () => activityApi.getNodeActivity(nodeUuid!, limit),
    enabled: !!nodeUuid,
  });
}

// ==================== Activity Mutations ====================

/**
 * Hook to create a new activity entry
 */
export function useCreateNodeActivity() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: activityApi.NodeActivityCreate) => activityApi.createNodeActivity(data),
    onSuccess: (_, { node_uuid }) => {
      queryClient.invalidateQueries({ queryKey: activityKeys.forNode(node_uuid) });
    },
  });
}

/**
 * Hook to delete an activity entry
 */
export function useDeleteNodeActivity() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ nodeId, activityId }: { nodeId: string | number; activityId: number }) => {
      const nodeUuid = typeof nodeId === 'string' ? nodeId : getNodeUuidByServerId(queryClient, nodeId);
      if (!nodeUuid) throw new Error('Node UUID not found');
      return activityApi.deleteNodeActivity(nodeUuid, activityId);
    },
    onMutate: ({ nodeId }) => {
      const nodeUuid = typeof nodeId === 'string' ? nodeId : getNodeUuidByServerId(queryClient, nodeId);
      // Invalidate immediately so the UI updates even if the triggering
      // component unmounts before onSuccess fires (TanStack Query v5).
      if (nodeUuid) {
        queryClient.invalidateQueries({ queryKey: activityKeys.forNode(nodeUuid) });
      }
    },
    onSuccess: (_, { nodeId }) => {
      const nodeUuid = typeof nodeId === 'string' ? nodeId : getNodeUuidByServerId(queryClient, nodeId);
      if (nodeUuid) {
        queryClient.invalidateQueries({ queryKey: activityKeys.forNode(nodeUuid) });
      }
    },
  });
}

// ==================== Link Click Tracking ====================

function resolveNodeIdArg(queryClient: ReturnType<typeof useQueryClient>, nodeId: string | number | null | undefined): string | null {
  if (nodeId == null) return null;
  return typeof nodeId === 'string' ? nodeId : getNodeUuidByServerId(queryClient, nodeId);
}

/**
 * Hook to fetch all link click counts from a source node
 */
export function useLinkClicks(sourceNodeId: string | number | null) {
  const queryClient = useQueryClient();
  const sourceUuid = resolveNodeIdArg(queryClient, sourceNodeId);
  return useQuery({
    queryKey: activityKeys.linkClicks(sourceUuid ?? ''),
    queryFn: () => activityApi.getLinkClicks(sourceUuid!),
    enabled: !!sourceUuid,
    staleTime: 60000, // Cache for 1 minute
  });
}

/**
 * Hook to fetch click count for a specific link
 */
export function useLinkClick(sourceNodeId: string | number | null, targetNodeId: string | number | null) {
  const queryClient = useQueryClient();
  const sourceUuid = resolveNodeIdArg(queryClient, sourceNodeId);
  const targetUuid = resolveNodeIdArg(queryClient, targetNodeId);
  return useQuery({
    queryKey: activityKeys.linkClick(sourceUuid ?? '', targetUuid ?? ''),
    queryFn: () => activityApi.getLinkClick(sourceUuid!, targetUuid!),
    enabled: !!sourceUuid && !!targetUuid,
    staleTime: 60000,
  });
}

/**
 * Hook to track a link click
 */
export function useTrackLinkClick() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ sourceNodeId, targetNodeId, nodeLinkUuid }: { sourceNodeId: string | number; targetNodeId: string | number; nodeLinkUuid?: string }) => {
      const sourceUuid = resolveNodeIdArg(queryClient, sourceNodeId);
      const targetUuid = resolveNodeIdArg(queryClient, targetNodeId);
      if (!sourceUuid || !targetUuid) throw new Error('Node UUID not found');
      return activityApi.trackLinkClick(sourceUuid, targetUuid, nodeLinkUuid);
    },
    onSuccess: (_, { sourceNodeId, targetNodeId }) => {
      const sourceUuid = resolveNodeIdArg(queryClient, sourceNodeId);
      const targetUuid = resolveNodeIdArg(queryClient, targetNodeId);
      if (sourceUuid && targetUuid) {
        queryClient.invalidateQueries({ queryKey: activityKeys.linkClicks(sourceUuid) });
        queryClient.invalidateQueries({ queryKey: activityKeys.linkClick(sourceUuid, targetUuid) });
      }
    },
  });
}

/**
 * Hook to reset link click counter
 */
export function useResetLinkClick() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ sourceNodeId, targetNodeId }: { sourceNodeId: string | number; targetNodeId: string | number }) => {
      const sourceUuid = resolveNodeIdArg(queryClient, sourceNodeId);
      const targetUuid = resolveNodeIdArg(queryClient, targetNodeId);
      if (!sourceUuid || !targetUuid) throw new Error('Node UUID not found');
      return activityApi.resetLinkClick(sourceUuid, targetUuid);
    },
    onSuccess: (_, { sourceNodeId, targetNodeId }) => {
      const sourceUuid = resolveNodeIdArg(queryClient, sourceNodeId);
      const targetUuid = resolveNodeIdArg(queryClient, targetNodeId);
      if (sourceUuid && targetUuid) {
        queryClient.invalidateQueries({ queryKey: activityKeys.linkClicks(sourceUuid) });
        queryClient.invalidateQueries({ queryKey: activityKeys.linkClick(sourceUuid, targetUuid) });
      }
    },
  });
}
