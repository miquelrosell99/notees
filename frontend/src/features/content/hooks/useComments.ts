/**
 * Comment Hooks
 *
 * Local-first React Query hooks for comments. Comments are child blocks of the
 * target node that carry the system `comment` class.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { commentKeys } from '@/hooks/queryKeys';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStore } from '@/core/hooks/useWorkspaceStore';
import { projectNode } from '@/core/adapters/nodeProjection';
import { uuidv7 } from '@/core/uuid';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import type { Node, PaginatedResponse } from '@/types/api';
import type { WorkspaceStore } from '@/core/store';

function getCommentNodes(store: WorkspaceStore, nodeUuid: string): Node[] {
  const childIds = store.getChildren(nodeUuid);
  return childIds
    .map((childId) => projectNode(store, childId, 0))
    .filter(
      (n): n is Node =>
        n !== undefined &&
        n.active !== false &&
        !!n.classes_uuid?.includes(SYSTEM_CLASS_UUIDS.comment)
    );
}

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
  const { store, isLoading: storeLoading, error: storeError } = useWorkspaceStore(
    workspaceUuid ?? ''
  );

  const result = useQuery<PaginatedResponse<Node>, Error, { comments: Node[]; comment_count: number }>({
    queryKey: commentKeys.forNode(nodeUuid ?? ''),
    queryFn: () => {
      if (!nodeUuid || !store) throw new Error('Node UUID or workspace store not found');
      const items = getCommentNodes(store, nodeUuid);
      return {
        items,
        total: items.length,
        page: 1,
        page_size: items.length,
        has_next: false,
        has_prev: false,
      };
    },
    enabled: !!nodeUuid && !!store,
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
  const { store, isLoading: storeLoading, error: storeError } = useWorkspaceStore(
    workspaceUuid ?? ''
  );

  const result = useQuery<number, Error>({
    queryKey: commentKeys.count(nodeUuid ?? ''),
    queryFn: () => {
      if (!nodeUuid || !store) throw new Error('Node UUID or workspace store not found');
      return getCommentNodes(store, nodeUuid).length;
    },
    enabled: !!nodeUuid && !!store,
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
  const { store } = useWorkspaceStore(workspaceUuid ?? '');

  return useMutation<
    Node,
    Error,
    { nodeUuid: string; name: string; parentCommentUuid?: string }
  >({
    mutationFn: async ({ nodeUuid, name, parentCommentUuid }) => {
      if (!nodeUuid || !store) throw new Error('Node UUID or workspace store not found');

      const parentId = parentCommentUuid ?? nodeUuid;
      const commentId = uuidv7();

      store.createNode({
        nodeId: commentId,
        kind: 'block',
        parentId,
        classIds: [SYSTEM_CLASS_UUIDS.comment],
      });
      // Ensure the comment appears in the parent's ordered child list.
      store.moveNode(commentId, parentId);
      store.updateText(commentId, (text) => {
        const current = text.toPlaintext();
        text.delete(0, current.length);
        text.insert(0, name);
      });

      const projected = projectNode(store, commentId, 0);
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
  const { store } = useWorkspaceStore(workspaceUuid ?? '');

  return useMutation<void, Error, { nodeUuid: string; commentUuid: string }>({
    mutationFn: async ({ nodeUuid, commentUuid }) => {
      if (!nodeUuid || !store) throw new Error('Node UUID or workspace store not found');
      const resolvedCommentUuid = findCommentUuid(queryClient, nodeUuid, commentUuid);
      if (!resolvedCommentUuid) throw new Error('Comment UUID not found');
      store.deleteNode(resolvedCommentUuid);
    },
    onSuccess: (_, { nodeUuid }) => {
      queryClient.invalidateQueries({ queryKey: commentKeys.forNode(nodeUuid) });
      queryClient.invalidateQueries({ queryKey: commentKeys.count(nodeUuid) });
    },
  });
}
