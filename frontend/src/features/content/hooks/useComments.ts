/**
 * Comment Hooks
 * 
 * React Query hooks for comments queries and mutations.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import { commentKeys } from '@/hooks/queryKeys';
import { getNodeUuidByServerId } from './useNodeMutations.utils';
import type { Node } from '@/types/api';

function findCommentUuid(queryClient: ReturnType<typeof useQueryClient>, nodeId: string | number, commentId: number): string | null {
  const pages = queryClient.getQueryData<{ items: Node[] }>(commentKeys.forNode(nodeId));
  if (pages) {
    const found = pages.items.find((c) => c.id === commentId);
    if (found?.uuid) return found.uuid;
  }
  return getNodeUuidByServerId(queryClient, commentId);
}

// ==================== Comments Queries ====================

/**
 * Hook to fetch comments for a node
 */
export function useComments(nodeId: string | number | null) {
  const queryClient = useQueryClient();
  const nodeUuid = nodeId === null ? null : typeof nodeId === 'string' ? nodeId : getNodeUuidByServerId(queryClient, nodeId);
  return useQuery({
    queryKey: commentKeys.forNode(nodeId ?? ''),
    queryFn: () => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      return nodesApi.getComments(nodeUuid);
    },
    enabled: !!nodeUuid,
    select: (data) => ({ comments: data.items, comment_count: data.total }),
  });
}

/**
 * Hook to fetch comment count for a node (useful for showing indicators)
 */
export function useCommentCount(nodeId: string | number | null) {
  const queryClient = useQueryClient();
  const nodeUuid = nodeId === null ? null : typeof nodeId === 'string' ? nodeId : getNodeUuidByServerId(queryClient, nodeId);
  return useQuery({
    queryKey: commentKeys.count(nodeId ?? ''),
    queryFn: () => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      return nodesApi.getCommentCount(nodeUuid);
    },
    enabled: !!nodeUuid,
    staleTime: 30000, // Cache for 30 seconds
  });
}

// ==================== Comments Mutations ====================

/**
 * Hook to create a comment on a node
 */
export function useCreateComment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ nodeId, name, parentCommentId }: { nodeId: string | number; name: string; parentCommentId?: number }) => {
      const nodeUuid = typeof nodeId === 'string' ? nodeId : getNodeUuidByServerId(queryClient, nodeId);
      if (!nodeUuid) throw new Error('Node UUID not found');
      const parentCommentUuid = parentCommentId ? findCommentUuid(queryClient, nodeId, parentCommentId) : undefined;
      return nodesApi.createComment(nodeUuid, name, parentCommentUuid ?? undefined);
    },
    onSuccess: (_, { nodeId }) => {
      queryClient.invalidateQueries({ queryKey: commentKeys.forNode(nodeId) });
      queryClient.invalidateQueries({ queryKey: commentKeys.count(nodeId) });
    },
  });
}

/**
 * Hook to delete a comment from a node
 */
export function useDeleteComment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ nodeId, commentId }: { nodeId: string | number; commentId: number }) => {
      const nodeUuid = typeof nodeId === 'string' ? nodeId : getNodeUuidByServerId(queryClient, nodeId);
      if (!nodeUuid) throw new Error('Node UUID not found');
      const commentUuid = findCommentUuid(queryClient, nodeId, commentId);
      if (!commentUuid) throw new Error('Comment UUID not found');
      return nodesApi.deleteComment(nodeUuid, commentUuid);
    },
    onSuccess: (_, { nodeId }) => {
      queryClient.invalidateQueries({ queryKey: commentKeys.forNode(nodeId) });
      queryClient.invalidateQueries({ queryKey: commentKeys.count(nodeId) });
    },
  });
}
