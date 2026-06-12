/**
 * SharesView — Centralized list of all public share links in the workspace.
 */
import { useCallback } from 'react';
import { DataStateView } from '@/components/ui/DataStateView';
import { useWorkspaceShares, useDeleteShare } from '@/features/shares/hooks/useShares';
import { useNavigationStore } from '@/stores';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/icons';
import { copyToClipboard } from '@/utils/clipboardManager';
import './SharesView.css';

export function SharesView() {
  const { data, isLoading, error, refetch } = useWorkspaceShares();
  const deleteShare = useDeleteShare();
  const openNode = useNavigationStore((s) => s.openNode);

  const handleCopy = useCallback((url: string) => {
    copyToClipboard(url);
  }, []);

  const shares = data?.shares ?? [];

  return (
    <div className="shares-view">
      <div className="shares-view__header">
        <h1 className="shares-view__title">
          Shared Links
        </h1>
      </div>

      <DataStateView
        isLoading={isLoading}
        error={error}
        isEmpty={shares.length === 0}
        onRetry={refetch}
        errorTitle="Failed to load shares"
        emptyTitle="No shared links yet."
        emptyDescription="Open any page and click the share button to create a public link."
        skeletonRows={4}
      >
        <div className="shares-view__list">
          {shares.map((share) => (
            <div key={share.share_uuid} className="shares-view__item">
              <button
                className="shares-view__item-name"
                onClick={() => share.node_id && openNode(share.node_id)}
              >
                {share.node_name || 'Untitled'}
              </button>
              <div className="shares-view__item-url">
                <Icon path="mdi mdi-link-variant" size={0.7} />
                <span>{share.url}</span>
              </div>
              <div className="shares-view__item-meta">
                Created {new Date(share.created_at).toLocaleString()}
                {share.expiry_date && (
                  <span className="shares-view__item-expiry">
                    {' · Expires '}{new Date(share.expiry_date).toLocaleString()}
                  </span>
                )}
              </div>
              <div className="shares-view__item-actions">
                <Button aria-label="Copy link"
                  variant="ghost"
                  size="sm"
                  icon="mdi mdi-content-copy"
                  title="Copy link"
                  onClick={() => handleCopy(share.url)}
                />
                <Button aria-label="Revoke share"
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
      </DataStateView>
    </div>
  );
}
