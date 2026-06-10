/**
 * Hooks for share operations (public shares, user shares, inbox)
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createShare,
  listNodeShares,
  listWorkspaceShares,
  deleteShare,
  getPublicSharedNode,
  createUserShare,
  listNodeUserShares,
  deleteUserShare,
  getShareInbox,
  inviteWorkspaceMember,
  listWorkspaceMembers,
  updateWorkspaceMember,
  removeWorkspaceMember,
  removePendingInvite,
} from '@/features/shares/api/shares';

const sharesKeys = {
  all: ['shares'] as const,
  node: (nodeId: number) => [...sharesKeys.all, 'node', nodeId] as const,
  workspace: () => [...sharesKeys.all, 'workspace'] as const,
  public: (shareUuid: string) => ['public-share', shareUuid] as const,
  userShares: (nodeId: number) => [...sharesKeys.all, 'user-shares', nodeId] as const,
  inbox: () => [...sharesKeys.all, 'inbox'] as const,
  workspaceMembers: (workspaceUuid: string) => ['workspace-members', workspaceUuid] as const,
};

// ============ Public Shares ============

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
    mutationFn: ({ nodeId, expiryDate, password }: { nodeId: number; expiryDate?: string | null; password?: string | null }) =>
      createShare(nodeId, expiryDate, password),
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

// ============ Node User Shares ============

export function useNodeUserShares(nodeId: number | null) {
  return useQuery({
    queryKey: sharesKeys.userShares(nodeId ?? 0),
    queryFn: () => listNodeUserShares(nodeId!),
    enabled: nodeId !== null,
  });
}

export function useCreateUserShare() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      nodeId,
      email,
      permission,
    }: {
      nodeId: number;
      email: string;
      permission: 'read' | 'write' | 'comment';
    }) => createUserShare(nodeId, email, permission),
    onSuccess: (_, { nodeId }) => {
      queryClient.invalidateQueries({ queryKey: sharesKeys.userShares(nodeId) });
    },
  });
}

export function useDeleteUserShare() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteUserShare,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sharesKeys.all });
    },
  });
}

// ============ Share Inbox ============

export function useShareInbox() {
  return useQuery({
    queryKey: sharesKeys.inbox(),
    queryFn: () => getShareInbox(),
    select: (data) => ({ items: data.items }),
  });
}

// ============ Workspace Members ============

export function useWorkspaceMembers(workspaceUuid: string | null) {
  return useQuery({
    queryKey: sharesKeys.workspaceMembers(workspaceUuid ?? ''),
    queryFn: () => listWorkspaceMembers(workspaceUuid!),
    enabled: workspaceUuid !== null && workspaceUuid.length > 0,
    select: (data) => ({ members: data.items }),
  });
}

export function useInviteWorkspaceMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      workspaceUuid,
      email,
      role,
    }: {
      workspaceUuid: string;
      email: string;
      role: string;
    }) => inviteWorkspaceMember(workspaceUuid, email, role),
    onSuccess: (_, { workspaceUuid }) => {
      queryClient.invalidateQueries({ queryKey: sharesKeys.workspaceMembers(workspaceUuid) });
    },
  });
}

export function useUpdateWorkspaceMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      workspaceUuid,
      memberUserId,
      role,
    }: {
      workspaceUuid: string;
      memberUserId: number;
      role: string;
    }) => updateWorkspaceMember(workspaceUuid, memberUserId, role),
    onSuccess: (_, { workspaceUuid }) => {
      queryClient.invalidateQueries({ queryKey: sharesKeys.workspaceMembers(workspaceUuid) });
    },
  });
}

export function useRemoveWorkspaceMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      workspaceUuid,
      memberUserId,
    }: {
      workspaceUuid: string;
      memberUserId: number;
    }) => removeWorkspaceMember(workspaceUuid, memberUserId),
    onSuccess: (_, { workspaceUuid }) => {
      queryClient.invalidateQueries({ queryKey: sharesKeys.workspaceMembers(workspaceUuid) });
    },
  });
}


export function useRemovePendingInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workspaceUuid, email }: { workspaceUuid: string; email: string }) =>
      removePendingInvite(workspaceUuid, email),
    onSuccess: (_, { workspaceUuid }) => {
      queryClient.invalidateQueries({ queryKey: sharesKeys.workspaceMembers(workspaceUuid) });
    },
  });
}
