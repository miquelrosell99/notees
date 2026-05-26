/**
 * Hooks for public share operations
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createShare,
  listNodeShares,
  listWorkspaceShares,
  deleteShare,
  getPublicSharedNode,
} from '@/api/shares';
const sharesKeys = {
  all: ['shares'] as const,
  node: (nodeId: number) => [...sharesKeys.all, 'node', nodeId] as const,
  workspace: () => [...sharesKeys.all, 'workspace'] as const,
  public: (shareUuid: string) => ['public-share', shareUuid] as const,
};

export function useNodeShares(nodeId: number | null) {
  return useQuery({
    queryKey: sharesKeys.node(nodeId ?? 0),
    queryFn: () => listNodeShares(nodeId!),
    enabled: nodeId !== null,
  });
}

export function useWorkspaceShares() {
  return useQuery({
    queryKey: sharesKeys.workspace(),
    queryFn: listWorkspaceShares,
  });
}

export function useCreateShare() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId, expiryDate }: { nodeId: number; expiryDate?: string | null }) =>
      createShare(nodeId, expiryDate),
    onSuccess: (_, { nodeId }) => {
      queryClient.invalidateQueries({ queryKey: sharesKeys.node(nodeId) });
      queryClient.invalidateQueries({ queryKey: sharesKeys.workspace() });
    },
  });
}

export function useDeleteShare() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteShare,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sharesKeys.all });
    },
  });
}

export function usePublicSharedNode(shareUuid: string | null) {
  return useQuery({
    queryKey: sharesKeys.public(shareUuid ?? ''),
    queryFn: () => getPublicSharedNode(shareUuid!),
    enabled: shareUuid !== null && shareUuid.length > 0,
  });
}
