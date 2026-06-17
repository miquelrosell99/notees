/**
 * SharesUnifiedView — Combined view for Shared Out (public links) and Inbox (shares received).
 */
import { useState, useCallback } from 'react';
import { Spinner } from '@/components/ui/Spinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { useNavigationStore } from '@/stores';
import { useWorkspaceShares, useDeleteShare, useShareInbox } from '@/features/shares';
import { switchWorkspace } from '@/features/workspace';
import { Button } from '@/components/ui/Button';
import { Tabs } from '@/components/ui/Tabs';
import { Icon } from '@/components/ui/icons';
import { NodeInline } from '@/features/content';
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
  const { data: sharesData, isLoading: sharesLoading, error: sharesError, refetch: refetchShares } = useWorkspaceShares();
  const deleteShare = useDeleteShare();
  const shares = sharesData?.shares ?? [];

  // Inbox data
  const { data: inboxData, isLoading: inboxLoading, error: inboxError, refetch: refetchInbox } = useShareInbox();
  const items = inboxData?.items ?? [];

  const handleCopy = useCallback((url: string) => {
    copyToClipboard(url);
  }, []);

  const handleOpenInboxItem = useCallback(
    async (item: NonNullable<typeof inboxData>['items'][number]) => {
      useNavigationStore.setState({ isSwitchingWorkspace: true });
      try {
        await switchWorkspace(item.workspace.uuid);
        openNode(item.node_id);
      } finally {
        useNavigationStore.setState({ isSwitchingWorkspace: false });
      }
    },
    [openNode]
  );

  return (
    <div className="shares-unified-view">
      <div className="shares-unified-view__header">
        <h1 className="shares-unified-view__title">
          Shares
        </h1>
        <Tabs value={activeTab} onChange={setActiveTab}>
          <Tabs.List>
            <Tabs.Tab value="shared-out">Shared Out</Tabs.Tab>
            <Tabs.Tab value="inbox">Inbox</Tabs.Tab>
          </Tabs.List>
        </Tabs>
      </div>

      {activeTab === 'shared-out' && (
        <div className="shares-unified-view__panel">
          {sharesLoading ? (
            <div className="shares-unified-view__loading"><Spinner size="md" centered /></div>
          ) : sharesError ? (
            <div className="shares-unified-view__error">
              <EmptyState
                title="Failed to load shared links"
                description="There was a problem fetching your shared links."
                actionLabel="Try again"
                onAction={() => refetchShares()}
              />
            </div>
          ) : shares.length === 0 ? (
            <div className="shares-unified-view__empty">
              <p>No shared links yet</p>
              <p className="shares-unified-view__empty-hint">
                Open a page and select Share to create a public link.
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
          )}
        </div>
      )}

      {activeTab === 'inbox' && (
        <div className="shares-unified-view__panel">
          {inboxLoading ? (
            <div className="shares-unified-view__loading"><Spinner size="md" centered /></div>
          ) : inboxError ? (
            <div className="shares-unified-view__error">
              <EmptyState
                title="Failed to load inbox"
                description="There was a problem fetching your shared items."
                actionLabel="Try again"
                onAction={() => refetchInbox()}
              />
            </div>
          ) : items.length === 0 ? (
            <div className="shares-unified-view__empty">
              <p>Nothing shared with you yet</p>
              <p className="shares-unified-view__empty-hint">
                Pages and blocks shared with you appear here.
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
