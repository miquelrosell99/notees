/**
 * Hooks for share operations (public shares, user shares, inbox)
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { sharesKeys } from '@/hooks/queryKeys';
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

// ============ Public Shares ============

export function useNodeShares(nodeUuid: string | null) {
  return useQuery({
    queryKey: sharesKeys.node(nodeUuid ?? ''),
    queryFn: () => listNodeShares(nodeUuid!),
    enabled: nodeUuid !== null,
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
    mutationFn: ({ nodeUuid, expiryDate, password }: { nodeUuid: string; expiryDate?: string | null; password?: string | null }) =>
      createShare(nodeUuid, expiryDate, password),
    onSuccess: (_, { nodeUuid }) => {
      queryClient.invalidateQueries({ queryKey: sharesKeys.node(nodeUuid) });
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

export function useNodeUserShares(nodeUuid: string | null) {
  return useQuery({
    queryKey: sharesKeys.userShares(nodeUuid ?? ''),
    queryFn: () => listNodeUserShares(nodeUuid!),
    enabled: nodeUuid !== null,
  });
}

export function useCreateUserShare() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
              nodeUuid,
              email,
              permission }: {
      nodeUuid: string;
      email: string;
      permission: 'read' | 'write' | 'comment';
    }) => createUserShare(nodeUuid, email, permission),
    onSuccess: (_, { nodeUuid }) => {
      queryClient.invalidateQueries({ queryKey: sharesKeys.userShares(nodeUuid) });
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
      memberUserUuid,
      role,
    }: {
      workspaceUuid: string;
      memberUserUuid: string;
      role: string;
    }) => updateWorkspaceMember(workspaceUuid, memberUserUuid, role),
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
      memberUserUuid,
    }: {
      workspaceUuid: string;
      memberUserUuid: string;
    }) => removeWorkspaceMember(workspaceUuid, memberUserUuid),
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
