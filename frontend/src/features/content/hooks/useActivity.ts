/**
 * Activity Hooks
 * 
 * React Query hooks for activity tracking and link click analytics.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as activityApi from '../api/activity';
import { activityKeys } from '@/hooks/queryKeys';

// ==================== Activity Queries ====================

/**
 * Hook to fetch activity log for a node
 */
export function useNodeActivity(nodeUuid: string | null, limit = 50) {
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
    mutationFn: ({ nodeUuid, activityId }: { nodeUuid: string; activityId: string }) => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      return activityApi.deleteNodeActivity(nodeUuid, activityId);
    },
    onMutate: ({ nodeUuid }) => {
      // Invalidate immediately so the UI updates even if the triggering
      // component unmounts before onSuccess fires (TanStack Query v5).
      if (nodeUuid) {
        queryClient.invalidateQueries({ queryKey: activityKeys.forNode(nodeUuid) });
      }
    },
    onSuccess: (_, { nodeUuid }) => {
      if (nodeUuid) {
        queryClient.invalidateQueries({ queryKey: activityKeys.forNode(nodeUuid) });
      }
    },
  });
}

// ==================== Link Click Tracking ====================

/**
 * Hook to fetch all link click counts from a source node
 */
export function useLinkClicks(sourceNodeUuid: string | null) {
  return useQuery({
    queryKey: activityKeys.linkClicks(sourceNodeUuid ?? ''),
    queryFn: () => activityApi.getLinkClicks(sourceNodeUuid!),
    enabled: !!sourceNodeUuid,
    staleTime: 60000, // Cache for 1 minute
  });
}

/**
 * Hook to fetch click count for a specific link
 */
export function useLinkClick(sourceNodeUuid: string | null, targetNodeUuid: string | null) {
  return useQuery({
    queryKey: activityKeys.linkClick(sourceNodeUuid ?? '', targetNodeUuid ?? ''),
    queryFn: () => activityApi.getLinkClick(sourceNodeUuid!, targetNodeUuid!),
    enabled: !!sourceNodeUuid && !!targetNodeUuid,
    staleTime: 60000,
  });
}

/**
 * Hook to track a link click
 */
export function useTrackLinkClick() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ sourceNodeUuid, targetNodeUuid, nodeLinkUuid }: { sourceNodeUuid: string; targetNodeUuid: string; nodeLinkUuid?: string }) => {
      if (!sourceNodeUuid || !targetNodeUuid) throw new Error('Node UUID not found');
      return activityApi.trackLinkClick(sourceNodeUuid, targetNodeUuid, nodeLinkUuid);
    },
    onSuccess: (_, { sourceNodeUuid, targetNodeUuid }) => {
      if (sourceNodeUuid && targetNodeUuid) {
        queryClient.invalidateQueries({ queryKey: activityKeys.linkClicks(sourceNodeUuid) });
        queryClient.invalidateQueries({ queryKey: activityKeys.linkClick(sourceNodeUuid, targetNodeUuid) });
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
    mutationFn: ({ sourceNodeUuid, targetNodeUuid }: { sourceNodeUuid: string; targetNodeUuid: string }) => {
      if (!sourceNodeUuid || !targetNodeUuid) throw new Error('Node UUID not found');
      return activityApi.resetLinkClick(sourceNodeUuid, targetNodeUuid);
    },
    onSuccess: (_, { sourceNodeUuid, targetNodeUuid }) => {
      if (sourceNodeUuid && targetNodeUuid) {
        queryClient.invalidateQueries({ queryKey: activityKeys.linkClicks(sourceNodeUuid) });
        queryClient.invalidateQueries({ queryKey: activityKeys.linkClick(sourceNodeUuid, targetNodeUuid) });
      }
    },
  });
}
