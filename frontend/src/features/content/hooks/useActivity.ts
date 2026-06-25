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
    queryKey: activityKeys.forNode(nodeId ?? ''),
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
    onSuccess: (_, { node_id }) => {
      queryClient.invalidateQueries({ queryKey: activityKeys.forNode(node_id) });
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
      // Invalidate immediately so the UI updates even if the triggering
      // component unmounts before onSuccess fires (TanStack Query v5).
      queryClient.invalidateQueries({ queryKey: activityKeys.forNode(nodeId) });
    },
    onSuccess: (_, { nodeId }) => {
      queryClient.invalidateQueries({ queryKey: activityKeys.forNode(nodeId) });
    },
  });
}

// ==================== Link Click Tracking ====================

/**
 * Hook to fetch all link click counts from a source node
 */
export function useLinkClicks(sourceNodeId: number | null) {
  return useQuery({
    queryKey: activityKeys.linkClicks(sourceNodeId ?? 0),
    queryFn: () => activityApi.getLinkClicks(sourceNodeId!),
    enabled: !!sourceNodeId,
    staleTime: 60000, // Cache for 1 minute
  });
}

/**
 * Hook to fetch click count for a specific link
 */
export function useLinkClick(sourceNodeId: number | null, targetNodeId: number | null) {
  return useQuery({
    queryKey: activityKeys.linkClick(sourceNodeId ?? 0, targetNodeId ?? 0),
    queryFn: () => activityApi.getLinkClick(sourceNodeId!, targetNodeId!),
    enabled: !!sourceNodeId && !!targetNodeId,
    staleTime: 60000,
  });
}

/**
 * Hook to track a link click
 */
export function useTrackLinkClick() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ sourceNodeId, targetNodeId, nodeLinkUuid }: { sourceNodeId: number; targetNodeId: number; nodeLinkUuid?: string }) => 
      activityApi.trackLinkClick(sourceNodeId, targetNodeId, nodeLinkUuid),
    onSuccess: (_, { sourceNodeId, targetNodeId }) => {
      queryClient.invalidateQueries({ queryKey: activityKeys.linkClicks(sourceNodeId) });
      queryClient.invalidateQueries({ queryKey: activityKeys.linkClick(sourceNodeId, targetNodeId) });
    },
  });
}

/**
 * Hook to reset link click counter
 */
export function useResetLinkClick() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ sourceNodeId, targetNodeId }: { sourceNodeId: number; targetNodeId: number }) => 
      activityApi.resetLinkClick(sourceNodeId, targetNodeId),
    onSuccess: (_, { sourceNodeId, targetNodeId }) => {
      queryClient.invalidateQueries({ queryKey: activityKeys.linkClicks(sourceNodeId) });
      queryClient.invalidateQueries({ queryKey: activityKeys.linkClick(sourceNodeId, targetNodeId) });
    },
  });
}
