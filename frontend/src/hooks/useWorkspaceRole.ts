/**
 * useWorkspaceRole — Hook to get the current user's role and permissions
 * in the active workspace.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listWorkspaces } from '@/features/workspace/api/workspaces';

export type WorkspaceRole = 'owner' | 'admin' | 'editor' | 'viewer';

interface WorkspacePermissions {
  canRead: boolean;
  canWrite: boolean;
  canCreate: boolean;
  canDelete: boolean;
  isOwner: boolean;
}

const PERMS_BY_ROLE: Record<WorkspaceRole, WorkspacePermissions> = {
  owner: { canRead: true, canWrite: true, canCreate: true, canDelete: true, isOwner: true },
  admin: { canRead: true, canWrite: true, canCreate: true, canDelete: true, isOwner: false },
  editor: { canRead: true, canWrite: true, canCreate: true, canDelete: false, isOwner: false },
  viewer: { canRead: true, canWrite: false, canCreate: false, canDelete: false, isOwner: false },
};

export function useWorkspaceRole() {
  const { data } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => listWorkspaces(),
    staleTime: 30000,
    select: (d) => ({
      workspaces: d.items,
      active: d.items.find((w) => w.is_active)?.uuid ?? null,
    }),
  });

  const activeWorkspace = useMemo(() => {
    if (!data) return null;
    return data.workspaces.find((w) => w.uuid === data.active) ?? null;
  }, [data]);

  const role = (activeWorkspace?.role ?? 'owner') as WorkspaceRole;
  const perms = PERMS_BY_ROLE[role];

  return {
    role,
    ...perms,
    activeWorkspace,
  };
}
