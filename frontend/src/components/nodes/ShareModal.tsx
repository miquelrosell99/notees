/**
 * ShareModal — Manage public share links and user-level shares for a node.
 */
import { useState, useCallback } from 'react';
import { Modal } from '@/components/core/Modal';
import { Button } from '@/components/core/Button';
import { TextField } from '@/components/core/TextField';
import { Dropdown } from '@/components/core/Dropdown';
import { Badge } from '@/components/core/Badge';
import { Icon, LinkIcon } from '@/components/core/icons';
import {
  useNodeShares,
  useCreateShare,
  useDeleteShare,
  useNodeUserShares,
  useCreateUserShare,
  useDeleteUserShare,
} from '@/hooks/useShares';
import { copyToClipboard } from '@/utils/clipboardManager';
import './ShareModal.css';

interface ShareModalProps {
  nodeId: number;
  isOpen: boolean;
  onClose: () => void;
}

const PERMISSION_OPTIONS = [
  { value: 'read' as const, label: 'Read only' },
  { value: 'write' as const, label: 'Can edit' },
];

export function ShareModal({ nodeId, isOpen, onClose }: ShareModalProps) {
  // Public shares
  const { data: publicData, isLoading: publicLoading } = useNodeShares(nodeId);
  const createShare = useCreateShare();
  const deleteShare = useDeleteShare();
  const [expiryDate, setExpiryDate] = useState('');

  // User shares
  const { data: userData, isLoading: userLoading } = useNodeUserShares(nodeId);
  const createUserShare = useCreateUserShare();
  const deleteUserShare = useDeleteUserShare();
  const [inviteEmail, setInviteEmail] = useState('');
  const [invitePermission, setInvitePermission] = useState<'read' | 'write'>('read');

  const handleCreatePublic = useCallback(() => {
    createShare.mutate(
      { nodeId, expiryDate: expiryDate || null },
      { onSuccess: () => setExpiryDate('') }
    );
  }, [nodeId, expiryDate, createShare]);

  const handleCopy = useCallback((url: string) => {
    copyToClipboard(url);
  }, []);

  const handleInvite = useCallback(() => {
    const email = inviteEmail.trim();
    if (!email) return;
    createUserShare.mutate(
      { nodeId, email, permission: invitePermission },
      { onSuccess: () => { setInviteEmail(''); setInvitePermission('read'); } }
    );
  }, [nodeId, inviteEmail, invitePermission, createUserShare]);

  const shares = publicData?.shares ?? [];
  const userShares = userData?.shares ?? [];

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Share" size="md">
      <div className="share-modal">
        {/* Public Links */}
        <section className="share-modal__section">
          <h3 className="share-modal__section-title">
            <Icon path="mdi mdi-link-variant" size={0.8} />
            Public link
          </h3>
          <p className="share-modal__section-desc">
            Anyone with the link can view this page without signing in.
          </p>
          <div className="share-modal__create">
            <label className="share-modal__label">Optional expiry date</label>
            <div className="share-modal__create-row">
              <input
                type="datetime-local"
                className="share-modal__date-input"
                value={expiryDate}
                onChange={(e) => setExpiryDate(e.target.value)}
              />
              <Button
                variant="primary"
                size="sm"
                onClick={handleCreatePublic}
                disabled={createShare.isPending}
              >
                <LinkIcon size="sm" />
                Create link
              </Button>
            </div>
          </div>

          {publicLoading ? (
            <div className="share-modal__loading">Loading links…</div>
          ) : shares.length === 0 ? (
            <div className="share-modal__empty">No public links yet.</div>
          ) : (
            <div className="share-modal__list">
              {shares.map((share) => (
                <div key={share.share_uuid} className="share-modal__item">
                  <div className="share-modal__item-info">
                    <div className="share-modal__item-url">
                      <Icon path="mdi mdi-link-variant" size={0.7} />
                      <span className="share-modal__item-url-text">{share.url}</span>
                    </div>
                    <div className="share-modal__item-meta">
                      Created {new Date(share.created_at).toLocaleString()}
                      {share.expiry_date && (
                        <span className="share-modal__item-expiry">
                          {' · Expires '}{new Date(share.expiry_date).toLocaleString()}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="share-modal__item-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="mdi mdi-content-copy"
                      title="Copy link"
                      onClick={() => handleCopy(share.url)}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="mdi mdi-delete-outline"
                      title="Revoke link"
                      onClick={() => deleteShare.mutate(share.share_uuid)}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <div className="share-modal__divider" />

        {/* User Shares — Table */}
        <section className="share-modal__section">
          <h3 className="share-modal__section-title">
            <Icon path="mdi mdi-account-group-outline" size={0.8} />
            People with access
          </h3>

          {userLoading ? (
            <div className="share-modal__loading">Loading…</div>
          ) : (
            <div className="share-modal__table">
              {/* Header */}
              <div className="share-modal__table-header">
                <span>Email</span>
                <span>Permission</span>
                <span aria-hidden="true" />
              </div>

              {/* Invite row */}
              <div className="share-modal__table-invite">
                <div className="share-modal__table-cell-email">
                  <TextField
                    placeholder="Email address"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleInvite(); }}
                    size="sm"
                  />
                </div>
                <div className="share-modal__table-cell-permission">
                  <Dropdown
                    options={PERMISSION_OPTIONS}
                    value={invitePermission}
                    onChange={(val) => val && setInvitePermission(val)}
                    size="sm"
                  />
                </div>
                <div className="share-modal__table-cell-actions">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleInvite}
                    disabled={createUserShare.isPending || !inviteEmail.trim()}
                  >
                    Invite
                  </Button>
                </div>
              </div>

              {/* Data rows */}
              {userShares.length === 0 ? (
                <div className="share-modal__table-empty">No one has been invited yet.</div>
              ) : (
                userShares.map((share) => (
                  <div key={share.share_id} className="share-modal__table-row">
                    <span className="share-modal__table-cell-email">
                      {share.shared_with_email}
                    </span>
                    <span className="share-modal__table-cell-permission">
                      <Badge
                        variant={share.permission === 'write' ? 'primary' : 'neutral'}
                        size="xs"
                      >
                        {share.permission === 'write' ? 'Can edit' : 'Read only'}
                      </Badge>
                    </span>
                    <span className="share-modal__table-cell-actions">
                      <Button
                        variant="ghost"
                        size="sm"
                        icon="mdi mdi-delete-outline"
                        title="Remove access"
                        onClick={() => deleteUserShare.mutate(share.share_id)}
                      />
                    </span>
                  </div>
                ))
              )}
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}
