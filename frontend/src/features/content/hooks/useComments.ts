/**
 * Comment Hooks
 *
 * React Query hooks for comments queries and mutations.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import { commentKeys } from '@/hooks/queryKeys';
import type { Node } from '@/types/api';

function findCommentUuid(queryClient: ReturnType<typeof useQueryClient>, nodeUuid: string, commentUuid: string): string | null {
  const pages = queryClient.getQueryData<{ items: Node[] }>(commentKeys.forNode(nodeUuid));
  if (pages) {
    const found = pages.items.find((c) => c.uuid === commentUuid);
    if (found?.uuid) return found.uuid;
  }
  return commentUuid;
}

// ==================== Comments Queries ====================

/**
 * Hook to fetch comments for a node
 */
export function useComments(nodeUuid: string | null) {
  return useQuery({
    queryKey: commentKeys.forNode(nodeUuid ?? ''),
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
export function useCommentCount(nodeUuid: string | null) {
  return useQuery({
    queryKey: commentKeys.count(nodeUuid ?? ''),
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
    mutationFn: ({ nodeUuid, name, parentCommentUuid }: { nodeUuid: string; name: string; parentCommentUuid?: string }) => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      return nodesApi.createComment(nodeUuid, name, parentCommentUuid);
    },
    onSuccess: (_, { nodeUuid }) => {
      queryClient.invalidateQueries({ queryKey: commentKeys.forNode(nodeUuid) });
      queryClient.invalidateQueries({ queryKey: commentKeys.count(nodeUuid) });
    },
  });
}

/**
 * Hook to delete a comment from a node
 */
export function useDeleteComment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ nodeUuid, commentUuid }: { nodeUuid: string; commentUuid: string }) => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      const resolvedCommentUuid = findCommentUuid(queryClient, nodeUuid, commentUuid);
      if (!resolvedCommentUuid) throw new Error('Comment UUID not found');
      return nodesApi.deleteComment(nodeUuid, resolvedCommentUuid);
    },
    onSuccess: (_, { nodeUuid }) => {
      queryClient.invalidateQueries({ queryKey: commentKeys.forNode(nodeUuid) });
      queryClient.invalidateQueries({ queryKey: commentKeys.count(nodeUuid) });
    },
  });
}
