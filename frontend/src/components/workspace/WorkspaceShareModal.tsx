/**
 * WorkspaceShareModal — Manage workspace members (invite, roles, remove).
 */
import { useState, useCallback, useMemo } from 'react';
import { Modal } from '@/components/core/Modal';
import { Spinner } from '@/components/core/Spinner';
import { Button } from '@/components/core/Button';
import { TextField } from '@/components/core/TextField';
import { Dropdown } from '@/components/core/Dropdown';
import { Badge } from '@/components/core/Badge';
import { Icon } from '@/components/core/icons';
import { useAuthStore } from '@/stores';
import {
  useWorkspaceMembers,
  useInviteWorkspaceMember,
  useUpdateWorkspaceMember,
  useRemoveWorkspaceMember,
  useRemovePendingInvite,
} from '@/hooks/useShares';
import type { WorkspaceMember } from '@/api/shares';
import './WorkspaceShareModal.css';

interface WorkspaceShareModalProps {
  workspaceUuid: string;
  isOpen: boolean;
  onClose: () => void;
}

const ROLE_OPTIONS = [
  { value: 'viewer', label: 'Viewer' },
  { value: 'commenter', label: 'Commenter' },
  { value: 'editor', label: 'Editor' },
  { value: 'admin', label: 'Admin' },
];

const ROLE_BADGE_VARIANT: Record<string, 'neutral' | 'primary' | 'warning' | 'secondary'> = {
  owner: 'warning',
  viewer: 'neutral',
  commenter: 'secondary',
  editor: 'primary',
  admin: 'warning',
};

export function WorkspaceShareModal({ workspaceUuid, isOpen, onClose }: WorkspaceShareModalProps) {
  const { data, isLoading } = useWorkspaceMembers(workspaceUuid);
  const inviteMember = useInviteWorkspaceMember();
  const updateMember = useUpdateWorkspaceMember();
  const removeMember = useRemoveWorkspaceMember();
  const removePending = useRemovePendingInvite();

  const currentUser = useAuthStore((s) => s.user);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('viewer');
  const [inviteError, setInviteError] = useState<string | null>(null);

  const members = useMemo(() => data?.members ?? [], [data?.members]);

  const isCurrentUserOwner = useMemo(() => {
    const owner = members.find((m) => m.role === 'owner');
    return owner ? owner.email === currentUser?.email : false;
  }, [members, currentUser?.email]);

  const currentUserMember = useMemo(() => {
    return members.find((m) => m.email === currentUser?.email);
  }, [members, currentUser?.email]);

  const otherMembers = useMemo(() => {
    return members.filter((m) => m.email !== currentUser?.email);
  }, [members, currentUser?.email]);

  const handleInvite = useCallback(() => {
    const email = inviteEmail.trim();
    if (!email) return;
    setInviteError(null);
    inviteMember.mutate(
      { workspaceUuid, email, role: inviteRole },
      {
        onSuccess: () => {
          setInviteEmail('');
          setInviteRole('viewer');
        },
        onError: (err: Error) => {
          setInviteError(err.message || 'Failed to invite member');
        },
      }
    );
  }, [workspaceUuid, inviteEmail, inviteRole, inviteMember]);

  const handleRoleChange = useCallback(
    (memberUserId: number, role: string) => {
      updateMember.mutate({ workspaceUuid, memberUserId, role });
    },
    [workspaceUuid, updateMember]
  );

  const handleRemove = useCallback(
    (memberUserId: number) => {
      removeMember.mutate({ workspaceUuid, memberUserId });
    },
    [workspaceUuid, removeMember]
  );

  const handleRemovePending = useCallback(
    (email: string) => {
      removePending.mutate({ workspaceUuid, email });
    },
    [workspaceUuid, removePending]
  );

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Share Workspace" size="md" className="workspace-share-modal__dialog">
      <div className="workspace-share-modal">
        {isLoading ? (
          <div className="workspace-share-modal__loading"><Spinner size="sm" label="Loading members…" /></div>
        ) : (
          <>
            {/* Invite bar */}
            {isCurrentUserOwner && (
              <div className="workspace-share-modal__invite-bar">
                <div className="workspace-share-modal__invite-input-wrap">
                  <TextField
                    placeholder="Email address"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleInvite(); }}
                    size="sm"
                    error={!!inviteError}
                    errorMessage={inviteError ?? undefined}
                  />
                </div>
                <Dropdown
                  options={ROLE_OPTIONS}
                  value={inviteRole}
                  onChange={(val) => val && setInviteRole(val)}
                  size="sm"
                  className="workspace-share-modal__invite-role"
                />
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleInvite}
                  disabled={inviteMember.isPending || !inviteEmail.trim()}
                >
                  Invite
                </Button>
              </div>
            )}

            {/* Current user */}
            {currentUserMember && (
              <div className="workspace-share-modal__you-row">
                <div className="workspace-share-modal__user-info">
                  <Icon path="mdi mdi-account-circle" size={1} />
                  <div className="workspace-share-modal__user-details">
                    <span className="workspace-share-modal__user-name">
                      {currentUserMember.email}
                    </span>
                    <span className="workspace-share-modal__user-hint">
                      {currentUserMember.role === 'owner' ? 'Workspace owner' : 'You'}
                    </span>
                  </div>
                </div>
                <Badge variant={ROLE_BADGE_VARIANT[currentUserMember.role] ?? 'neutral'} size="sm">
                  {currentUserMember.role === 'owner' ? 'Owner' : currentUserMember.role}
                </Badge>
              </div>
            )}

            {/* People with access */}
            {otherMembers.length > 0 && (
              <>
                <div className="workspace-share-modal__section-label">
                  People with access
                </div>
                <div className="workspace-share-modal__people-list">
                  {otherMembers.map((member) => (
                    <MemberRow
                      key={member.email}
                      member={member}
                      isCurrentUserOwner={isCurrentUserOwner}
                      onRoleChange={handleRoleChange}
                      onRemove={handleRemove}
                      onRemovePending={handleRemovePending}
                      isUpdating={updateMember.isPending}
                      isRemoving={removeMember.isPending}
                      isRemovingPending={removePending.isPending}
                    />
                  ))}
                </div>
              </>
            )}

            {members.length === 0 && (
              <div className="workspace-share-modal__empty">No members yet.</div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

function MemberRow({
  member,
  isCurrentUserOwner,
  onRoleChange,
  onRemove,
  onRemovePending,
  isUpdating,
  isRemoving,
  isRemovingPending,
}: {
  member: WorkspaceMember;
  isCurrentUserOwner: boolean;
  onRoleChange: (userId: number, role: string) => void;
  onRemove: (userId: number) => void;
  onRemovePending: (email: string) => void;
  isUpdating: boolean;
  isRemoving: boolean;
  isRemovingPending: boolean;
}) {
  const isPending = member.status === 'pending' || member.user_id === null;
  return (
    <div className="workspace-share-modal__people-row">
      <div className="workspace-share-modal__user-info">
        <Icon path="mdi mdi-account-circle" size={1} />
        <span className="workspace-share-modal__user-name">{member.email}</span>
        {isPending && <Badge variant="neutral" size="sm">Pending</Badge>}
      </div>
      <div className="workspace-share-modal__people-actions">
        {isCurrentUserOwner ? (
          <>
            {!isPending && (
              <Dropdown
                options={ROLE_OPTIONS}
                value={member.role}
                onChange={(val) => val && member.user_id !== null && onRoleChange(member.user_id, val)}
                size="sm"
                disabled={isUpdating}
                className="workspace-share-modal__role-dropdown"
              />
            )}
            <Button
              variant="ghost"
              size="sm"
              icon="mdi mdi-delete-outline"
              title={isPending ? "Cancel invite" : "Remove member"}
              onClick={() => isPending ? onRemovePending(member.email) : onRemove(member.user_id!)}
              disabled={isRemoving || isRemovingPending}
            />
          </>
        ) : (
          <Badge variant={ROLE_BADGE_VARIANT[member.role] ?? 'neutral'} size="sm">
            {member.role.charAt(0).toUpperCase() + member.role.slice(1)}
          </Badge>
        )}
      </div>
    </div>
  );
}
