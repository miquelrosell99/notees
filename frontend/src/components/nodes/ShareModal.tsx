/**
 * ShareModal — Manage public share links for a node.
 */
import { useState, useCallback } from 'react';
import { Modal } from '@/components/core/Modal';
import { Button } from '@/components/core/Button';
import { Icon, LinkIcon } from '@/components/core/icons';
import { useNodeShares, useCreateShare, useDeleteShare } from '@/hooks/useShares';
import { copyToClipboard } from '@/utils/clipboardManager';
import './ShareModal.css';

interface ShareModalProps {
  nodeId: number;
  isOpen: boolean;
  onClose: () => void;
}

export function ShareModal({ nodeId, isOpen, onClose }: ShareModalProps) {
  const { data, isLoading } = useNodeShares(nodeId);
  const createShare = useCreateShare();
  const deleteShare = useDeleteShare();
  const [expiryDate, setExpiryDate] = useState('');

  const handleCreate = useCallback(() => {
    createShare.mutate(
      { nodeId, expiryDate: expiryDate || null },
      { onSuccess: () => setExpiryDate('') }
    );
  }, [nodeId, expiryDate, createShare]);

  const handleCopy = useCallback((url: string) => {
    copyToClipboard(url);
  }, []);

  const shares = data?.shares ?? [];

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Share" size="md">
      <div className="share-modal">
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
              onClick={handleCreate}
              disabled={createShare.isPending}
            >
              <LinkIcon size="sm" />
              Create link
            </Button>
          </div>
        </div>

        {isLoading ? (
          <div className="share-modal__loading">Loading shares...</div>
        ) : shares.length === 0 ? (
          <div className="share-modal__empty">No share links yet.</div>
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
                    title="Revoke share"
                    onClick={() => deleteShare.mutate(share.share_uuid)}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
