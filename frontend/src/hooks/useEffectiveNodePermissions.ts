/**
 * useEffectiveNodePermissions — Merges workspace role permissions with
 * node-level permissions (from node shares) using OR logic.
 *
 * This fixes the gap where a user has a node share with write access
 * but is not a workspace member (or is only a viewer). The frontend
 * previously only looked at workspace role, defaulting to "owner" when
 * the workspace wasn't in the user's list.
 */
import { useWorkspaceRole } from '@/features/workspace/hooks/useWorkspaceRole';
import type { Node } from '@/types/api';

export interface EffectivePermissions {
  canRead: boolean;
  canWrite: boolean;
  canCreate: boolean;
  canDelete: boolean;
  isOwner: boolean;
}

export function useEffectiveNodePermissions(
  node?: Node | null,
): EffectivePermissions {
  const workspace = useWorkspaceRole();
  const nodePerms = node?.permissions;

  return {
    canRead: workspace.canRead || nodePerms?.can_read || false,
    canWrite: workspace.canWrite || nodePerms?.can_write || false,
    canCreate: workspace.canCreate || nodePerms?.can_create || false,
    canDelete: workspace.canDelete || nodePerms?.can_delete || false,
    isOwner: workspace.isOwner,
  };
}
