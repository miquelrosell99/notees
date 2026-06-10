/**
 * Comment Hooks
 * 
 * React Query hooks for comments queries and mutations.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import { commentKeys } from './queryKeys';

// ==================== Comments Queries ====================

/**
 * Hook to fetch comments for a node
 */
export function useComments(nodeId: number | null) {
  return useQuery({
    queryKey: commentKeys.forNode(nodeId ?? 0),
    queryFn: () => nodesApi.getComments(nodeId!),
    enabled: !!nodeId,
    select: (data) => ({ comments: data.items, comment_count: data.total }),
  });
}

/**
 * Hook to fetch comment count for a node (useful for showing indicators)
 */
export function useCommentCount(nodeId: number | null) {
  return useQuery({
    queryKey: commentKeys.count(nodeId ?? 0),
    queryFn: () => nodesApi.getCommentCount(nodeId!),
    enabled: !!nodeId,
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
    mutationFn: ({ nodeId, name, parentCommentId }: { nodeId: number; name: string; parentCommentId?: number }) => 
      nodesApi.createComment(nodeId, name, parentCommentId),
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
    mutationFn: ({ nodeId, commentId }: { nodeId: number; commentId: number }) => 
      nodesApi.deleteComment(nodeId, commentId),
    onSuccess: (_, { nodeId }) => {
      queryClient.invalidateQueries({ queryKey: commentKeys.forNode(nodeId) });
      queryClient.invalidateQueries({ queryKey: commentKeys.count(nodeId) });
    },
  });
}
