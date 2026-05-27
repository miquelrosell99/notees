/**
 * SharesUnifiedView — Combined view for Shared Out (public links) and Inbox (shares received).
 */
import { useState, useCallback } from 'react';
import { useNavigationStore } from '@/stores';
import { useWorkspaceShares, useDeleteShare, useShareInbox } from '@/hooks/useShares';
import { switchWorkspace } from '@/api/workspaces';
import { Button } from '@/components/core/Button';
import { Icon } from '@/components/core/icons';
import { NodeInline } from '@/components/blocks/NodeInline';
import { copyToClipboard } from '@/utils/clipboardManager';
import './SharesUnifiedView.css';

type TabId = 'shared-out' | 'inbox';

interface SharesUnifiedViewProps {
  initialTab?: TabId;
}

export function SharesUnifiedView({ initialTab = 'shared-out' }: SharesUnifiedViewProps) {
  const [activeTab, setActiveTab] = useState<TabId>(initialTab);
  const openNode = useNavigationStore((s) => s.openNode);

  // Shared Out data
  const { data: sharesData, isLoading: sharesLoading } = useWorkspaceShares();
  const deleteShare = useDeleteShare();
  const shares = sharesData?.shares ?? [];

  // Inbox data
  const { data: inboxData, isLoading: inboxLoading } = useShareInbox();
  const items = inboxData?.items ?? [];

  const handleCopy = useCallback((url: string) => {
    copyToClipboard(url);
  }, []);

  const handleOpenInboxItem = useCallback(
    async (item: NonNullable<typeof inboxData>['items'][number]) => {
      await switchWorkspace(item.workspace.uuid);
      openNode(item.node_id);
    },
    [openNode]
  );

  return (
    <div className="shares-unified-view">
      <div className="shares-unified-view__header">
        <h1 className="shares-unified-view__title">
          <Icon path="mdi mdi-share-variant" size={1} />
          Shares
        </h1>
        <div className="shares-unified-view__tabs">
          <button
            className={`shares-unified-view__tab ${activeTab === 'shared-out' ? 'active' : ''}`}
            onClick={() => setActiveTab('shared-out')}
          >
            Shared Out
          </button>
          <button
            className={`shares-unified-view__tab ${activeTab === 'inbox' ? 'active' : ''}`}
            onClick={() => setActiveTab('inbox')}
          >
            Inbox
          </button>
        </div>
      </div>

      {activeTab === 'shared-out' && (
        <div className="shares-unified-view__panel">
          {sharesLoading ? (
            <div className="shares-unified-view__loading">Loading shares...</div>
          ) : shares.length === 0 ? (
            <div className="shares-unified-view__empty">
              <p>No shared links yet.</p>
              <p className="shares-unified-view__empty-hint">
                Open any page and click the share button to create a public link.
              </p>
            </div>
          ) : (
            <div className="shares-unified-view__list">
              {shares.map((share) => (
                <div key={share.share_uuid} className="shares-unified-view__item">
                  <button
                    className="shares-unified-view__item-name"
                    onClick={() => share.node_id && openNode(share.node_id)}
                  >
                    {share.node_name || 'Untitled'}
                  </button>
                  <div className="shares-unified-view__item-url">
                    <Icon path="mdi mdi-link-variant" size={0.7} />
                    <span>{share.url}</span>
                  </div>
                  <div className="shares-unified-view__item-meta">
                    Created {new Date(share.created_at).toLocaleString()}
                    {share.expiry_date && (
                      <span className="shares-unified-view__item-expiry">
                        {' · Expires '}{new Date(share.expiry_date).toLocaleString()}
                      </span>
                    )}
                  </div>
                  <div className="shares-unified-view__item-actions">
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
      )}

      {activeTab === 'inbox' && (
        <div className="shares-unified-view__panel">
          {inboxLoading ? (
            <div className="shares-unified-view__loading">Loading inbox...</div>
          ) : items.length === 0 ? (
            <div className="shares-unified-view__empty">
              <p>Nothing shared with you yet.</p>
              <p className="shares-unified-view__empty-hint">
                When someone shares a node with you, it will appear here.
              </p>
            </div>
          ) : (
            <div className="shares-unified-view__list">
              {items.map((item) => (
                <div key={item.share_id} className="shares-unified-view__item shares-unified-view__item--inbox">
                  <div className="shares-unified-view__item-header">
                    <NodeInline
                      name={item.node_name}
                      icon={item.node_icon}
                      isPage={item.is_page}
                      nodeId={item.node_id}
                      showBullet={false}
                      className="shares-unified-view__item-inline"
                    />
                    <span
                      className={`shares-unified-view__item-badge shares-unified-view__item-badge--${item.permission}`}
                    >
                      {item.permission}
                    </span>
                  </div>
                  <div className="shares-unified-view__item-meta shares-unified-view__item-meta--inbox">
                    <span>From <strong>@{item.shared_by.email}</strong></span>
                    <span>in <em>{item.workspace.name}</em></span>
                    <span className="shares-unified-view__item-time">{new Date(item.shared_at).toLocaleString()}</span>
                  </div>
                  <div className="shares-unified-view__item-actions shares-unified-view__item-actions--inbox">
                    <Button
                      variant="primary"
                      size="sm"
                      icon="mdi mdi-open-in-app"
                      onClick={() => handleOpenInboxItem(item)}
                    >
                      Open
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
