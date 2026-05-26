/**
 * WorkspaceShareModal — Manage workspace members (invite, roles, remove).
 */
import { useState, useCallback, useMemo } from 'react';
import { Modal } from '@/components/core/Modal';
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
  { value: 'editor', label: 'Editor' },
  { value: 'admin', label: 'Admin' },
];

const ROLE_BADGE_VARIANT: Record<string, 'neutral' | 'primary' | 'warning'> = {
  owner: 'warning',
  viewer: 'neutral',
  editor: 'primary',
  admin: 'warning',
};

function MemberRow({
  member,
  isCurrentUserOwner,
  onRoleChange,
  onRemove,
  isUpdating,
  isRemoving,
}: {
  member: WorkspaceMember;
  isCurrentUserOwner: boolean;
  onRoleChange: (userId: number, role: string) => void;
  onRemove: (userId: number) => void;
  isUpdating: boolean;
  isRemoving: boolean;
}) {
  const isOwner = member.role === 'owner';

  return (
    <div className="workspace-share-modal__member">
      <div className="workspace-share-modal__member-info">
        <Icon path="mdi mdi-account-outline" size={0.75} />
        <span className="workspace-share-modal__member-email">{member.email}</span>
      </div>
      <div className="workspace-share-modal__member-actions">
        {isOwner ? (
          <Badge variant="warning" size="xs">Owner</Badge>
        ) : isCurrentUserOwner ? (
          <>
            <Dropdown
              options={ROLE_OPTIONS}
              value={member.role}
              onChange={(val) => val && onRoleChange(member.user_id, val)}
              size="sm"
              className="workspace-share-modal__role-dropdown"
              disabled={isUpdating}
            />
            <Button
              variant="ghost"
              size="sm"
              icon="mdi mdi-delete-outline"
              title="Remove member"
              onClick={() => onRemove(member.user_id)}
              disabled={isRemoving}
            />
          </>
        ) : (
          <Badge variant={ROLE_BADGE_VARIANT[member.role] ?? 'neutral'} size="xs">
            {member.role.charAt(0).toUpperCase() + member.role.slice(1)}
          </Badge>
        )}
      </div>
    </div>
  );
}

export function WorkspaceShareModal({ workspaceUuid, isOpen, onClose }: WorkspaceShareModalProps) {
  const { data, isLoading } = useWorkspaceMembers(workspaceUuid);
  const inviteMember = useInviteWorkspaceMember();
  const updateMember = useUpdateWorkspaceMember();
  const removeMember = useRemoveWorkspaceMember();

  const currentUser = useAuthStore((s) => s.user);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('viewer');
  const [inviteError, setInviteError] = useState<string | null>(null);

  const members = useMemo(() => data?.members ?? [], [data?.members]);

  const isCurrentUserOwner = useMemo(() => {
    const owner = members.find((m) => m.role === 'owner');
    return owner ? owner.email === currentUser?.email : false;
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

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Share Workspace" size="md">
      <div className="workspace-share-modal">
        {isCurrentUserOwner && (
          <section className="workspace-share-modal__section">
            <h3 className="workspace-share-modal__section-title">
              <Icon path="mdi mdi-account-plus-outline" size={0.8} />
              Invite people
            </h3>
            <p className="workspace-share-modal__section-desc">
              Invite users to collaborate in this workspace.
            </p>
            <div className="workspace-share-modal__invite-row">
              <TextField
                placeholder="Email address"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleInvite(); }}
                size="sm"
                className="workspace-share-modal__invite-input"
                error={!!inviteError}
                errorMessage={inviteError ?? undefined}
              />
              <Dropdown
                options={ROLE_OPTIONS}
                value={inviteRole}
                onChange={(val) => val && setInviteRole(val)}
                size="sm"
                className="workspace-share-modal__role-dropdown"
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
          </section>
        )}

        <section className="workspace-share-modal__section">
          <h3 className="workspace-share-modal__section-title">
            <Icon path="mdi mdi-account-group-outline" size={0.8} />
            Members
          </h3>

          {isLoading ? (
            <div className="workspace-share-modal__loading">Loading members…</div>
          ) : members.length === 0 ? (
            <div className="workspace-share-modal__empty">No members found.</div>
          ) : (
            <div className="workspace-share-modal__members-list">
              {members.map((member) => (
                <MemberRow
                  key={member.user_id}
                  member={member}
                  isCurrentUserOwner={isCurrentUserOwner}
                  onRoleChange={handleRoleChange}
                  onRemove={handleRemove}
                  isUpdating={updateMember.isPending}
                  isRemoving={removeMember.isPending}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}
