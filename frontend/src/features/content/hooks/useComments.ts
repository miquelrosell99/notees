/**
 * Comment Hooks
 *
 * Local-first React Query hooks for comments. Comments are child blocks of the
 * target node that carry the system `comment` class.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { commentKeys } from '@/hooks/queryKeys';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';
import { useUndoManager } from '@/core/hooks/useUndoManager';
import { uuidv7 } from '@/core/uuid';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import type { Node, PaginatedResponse } from '@/types/api';

function findCommentUuid(
  queryClient: ReturnType<typeof useQueryClient>,
  nodeUuid: string,
  commentUuid: string
): string | null {
  const data = queryClient.getQueryData<PaginatedResponse<Node>>(
    commentKeys.forNode(nodeUuid)
  );
  if (data) {
    const found = data.items.find((c) => c.uuid === commentUuid);
    if (found?.uuid) return found.uuid;
  }
  return commentUuid;
}

// ==================== Comments Queries ====================

/**
 * Hook to fetch comments for a node
 */
export function useComments(nodeUuid: string | null) {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { client, isLoading: storeLoading, error: storeError } =
    useWorkspaceStoreClient(workspaceUuid ?? '');

  const result = useQuery<
    PaginatedResponse<Node>,
    Error,
    { comments: Node[]; comment_count: number }
  >({
    queryKey: commentKeys.forNode(nodeUuid ?? ''),
    queryFn: async () => {
      if (!nodeUuid || !client) {
        throw new Error('Node UUID or workspace store not found');
      }
      const items = await client.query<Node[]>('getCommentNodes', [nodeUuid]);
      return {
        items,
        total: items.length,
        page: 1,
        page_size: items.length,
        has_next: false,
        has_prev: false,
      };
    },
    enabled: !!nodeUuid && !!client,
    select: (data) => ({ comments: data.items, comment_count: data.total }),
  });

  return {
    ...result,
    isLoading: result.isLoading || storeLoading,
    error: result.error ?? storeError,
  };
}

/**
 * Hook to fetch comment count for a node (useful for showing indicators)
 */
export function useCommentCount(nodeUuid: string | null) {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { client, isLoading: storeLoading, error: storeError } =
    useWorkspaceStoreClient(workspaceUuid ?? '');

  const result = useQuery<number, Error>({
    queryKey: commentKeys.count(nodeUuid ?? ''),
    queryFn: async () => {
      if (!nodeUuid || !client) {
        throw new Error('Node UUID or workspace store not found');
      }
      const items = await client.query<Node[]>('getCommentNodes', [nodeUuid]);
      return items.length;
    },
    enabled: !!nodeUuid && !!client,
    staleTime: 30000,
  });

  return {
    ...result,
    isLoading: result.isLoading || storeLoading,
    error: result.error ?? storeError,
  };
}

// ==================== Comments Mutations ====================

/**
 * Hook to create a comment on a node
 */
export function useCreateComment() {
  const queryClient = useQueryClient();
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { client } = useWorkspaceStoreClient(workspaceUuid ?? '');
  const manager = useUndoManager(workspaceUuid ?? '');

  return useMutation<
    Node,
    Error,
    { nodeUuid: string; name: string; parentCommentUuid?: string }
  >({
    mutationFn: async ({ nodeUuid, name, parentCommentUuid }) => {
      if (!nodeUuid || !workspaceUuid || !client || !manager) {
        throw new Error('Node UUID or workspace store not found');
      }

      const parentId = parentCommentUuid ?? nodeUuid;
      const commentId = uuidv7();

      await manager.createNode({
        nodeId: commentId,
        kind: 'block',
        parentId,
        classIds: [SYSTEM_CLASS_UUIDS.comment],
      });
      await manager.moveNode(commentId, parentId);
      await manager.recordSetNodeText(commentId, name);

      const projected = await client.query<Node | undefined>('projectNode', [
        commentId,
        0,
      ]);
      if (!projected) throw new Error('Failed to project created comment');
      return projected;
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
  const workspaceUuid = useCurrentWorkspaceUuid();
  const manager = useUndoManager(workspaceUuid ?? '');

  return useMutation<void, Error, { nodeUuid: string; commentUuid: string }>({
    mutationFn: async ({ nodeUuid, commentUuid }) => {
      if (!nodeUuid || !workspaceUuid || !manager) {
        throw new Error('Node UUID or workspace store not found');
      }
      const resolvedCommentUuid = findCommentUuid(queryClient, nodeUuid, commentUuid);
      if (!resolvedCommentUuid) throw new Error('Comment UUID not found');
      await manager.deleteNode(resolvedCommentUuid);
    },
    onSuccess: (_, { nodeUuid }) => {
      queryClient.invalidateQueries({ queryKey: commentKeys.forNode(nodeUuid) });
      queryClient.invalidateQueries({ queryKey: commentKeys.count(nodeUuid) });
    },
  });
}
