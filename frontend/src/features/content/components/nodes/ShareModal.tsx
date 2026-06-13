/**
 * ShareModal — Manage public share links and user-level shares for a node.
 */
import { useState, useCallback } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Spinner } from '@/components/ui/Spinner';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { Dropdown } from '@/components/ui/Dropdown';
import { Badge } from '@/components/ui/Badge';
import { Icon, LinkIcon } from '@/components/ui/icons';
import {
  useNodeShares,
  useCreateShare,
  useDeleteShare,
  useNodeUserShares,
  useCreateUserShare,
  useDeleteUserShare,
} from '@/features/shares/hooks/useShares';
import { copyToClipboard } from '@/utils/clipboardManager';
import './ShareModal.css';

interface ShareModalProps {
  nodeId: number;
  isOpen: boolean;
  onClose: () => void;
}

const PERMISSION_OPTIONS = [
  { value: 'read' as const, label: 'Read only' },
  { value: 'comment' as const, label: 'Can comment' },
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
  const [invitePermission, setInvitePermission] = useState<'read' | 'write' | 'comment'>('read');
  const [publicPassword, setPublicPassword] = useState('');

  const handleCreatePublic = useCallback(() => {
    createShare.mutate(
      { nodeId, expiryDate: expiryDate || null, password: publicPassword || null },
      { onSuccess: () => { setExpiryDate(''); setPublicPassword(''); } }
    );
  }, [nodeId, expiryDate, publicPassword, createShare]);

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
    <Modal isOpen={isOpen} onClose={onClose} title="Share" size="md" className="share-modal__dialog">
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
            <label htmlFor="share-expiry-date" className="share-modal__label">Optional expiry date</label>
            <div className="share-modal__create-row">
              <input
                id="share-expiry-date"
                type="datetime-local"
                className="share-modal__date-input"
                value={expiryDate}
                onChange={(e) => setExpiryDate(e.target.value)}
              />
            </div>
            <label htmlFor="share-public-password" className="share-modal__label">Optional password</label>
            <div className="share-modal__create-row">
              <TextField
                id="share-public-password"
                type="password"
                placeholder="Leave empty for no password"
                value={publicPassword}
                onChange={(e) => setPublicPassword(e.target.value)}
                size="sm"
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
            <div className="share-modal__loading"><Spinner size="sm" label="Loading links…" /></div>
          ) : shares.length === 0 ? (
            <div className="share-modal__empty">No public links yet</div>
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
                    <Button aria-label="Copy link"
                      variant="ghost"
                      size="sm"
                      icon="mdi mdi-content-copy"
                      title="Copy link"
                      onClick={() => handleCopy(share.url)}
                    />
                    <Button aria-label="Revoke link"
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

        {/* User Shares */}
        <section className="share-modal__section">
          <h3 className="share-modal__section-title">
            <Icon path="mdi mdi-account-group-outline" size={0.8} />
            People with access
          </h3>

          {userLoading ? (
            <div className="share-modal__loading"><Spinner size="sm" /></div>
          ) : (
            <>
              {/* Invite bar */}
              <div className="share-modal__invite-bar">
                <div className="share-modal__invite-input-wrap">
                  <TextField
                    placeholder="Email address"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleInvite(); }}
                    size="sm"
                  />
                </div>
                <Dropdown
                  options={PERMISSION_OPTIONS}
                  value={invitePermission}
                  onChange={(val) => val && setInvitePermission(val)}
                  size="sm"
                  className="share-modal__invite-permission"
                />
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleInvite}
                  disabled={createUserShare.isPending || !inviteEmail.trim()}
                >
                  Invite
                </Button>
              </div>

              {/* People list */}
              {userShares.length === 0 ? (
                <div className="share-modal__people-empty">No one invited yet</div>
              ) : (
                <div className="share-modal__people-list">
                  {userShares.map((share) => (
                    <div key={share.share_id} className="share-modal__people-row">
                      <div className="share-modal__people-info">
                        <Icon path="mdi mdi-account-circle" size={1} />
                        <span className="share-modal__people-email">
                          {share.shared_with_email}
                        </span>
                      </div>
                      <div className="share-modal__people-actions">
                        <Badge
                          variant={share.permission === 'write' ? 'primary' : share.permission === 'comment' ? 'secondary' : 'neutral'}
                          size="sm"
                        >
                          {share.permission === 'write' ? 'Can edit' : share.permission === 'comment' ? 'Can comment' : 'Read only'}
                        </Badge>
                        <Button aria-label="Remove access"
                          variant="ghost"
                          size="sm"
                          icon="mdi mdi-delete-outline"
                          title="Remove access"
                          onClick={() => deleteUserShare.mutate(share.share_id)}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </Modal>
  );
}
