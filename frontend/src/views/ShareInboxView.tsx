/**
 * ShareInboxView — Shows all nodes shared with the current user.
 */
import { useCallback } from 'react';
import { useShareInbox } from '@/hooks/useShares';
import { useNavigationStore } from '@/stores';
import { switchWorkspace } from '@/api/workspaces';
import { Button } from '@/components/core/Button';
import { Icon } from '@/components/core/icons';
import { NodeInline } from '@/components/blocks/NodeInline';
import './ShareInboxView.css';

export function ShareInboxView() {
  const { data, isLoading } = useShareInbox();
  const openNode = useNavigationStore((s) => s.openNode);

  const handleOpen = useCallback(
    async (item: NonNullable<typeof data>['items'][number]) => {
      await switchWorkspace(item.workspace.uuid);
      openNode(item.node_id);
    },
    [openNode]
  );

  const items = data?.items ?? [];

  return (
    <div className="share-inbox-view">
      <div className="share-inbox-view__header">
        <h1 className="share-inbox-view__title">
          <Icon path="mdi mdi-inbox-arrow-down" size={1} />
          Share Inbox
        </h1>
      </div>

      {isLoading ? (
        <div className="share-inbox-view__loading">Loading inbox...</div>
      ) : items.length === 0 ? (
        <div className="share-inbox-view__empty">
          <p>Nothing shared with you yet.</p>
          <p className="share-inbox-view__empty-hint">
            When someone shares a node with you, it will appear here.
          </p>
        </div>
      ) : (
        <div className="share-inbox-view__list">
          {items.map((item) => (
            <div key={item.share_id} className="share-inbox-view__item">
              <div className="share-inbox-view__item-header">
                <NodeInline
                  name={item.node_name}
                  icon={item.node_icon}
                  isPage={item.is_page}
                  nodeId={item.node_id}
                  showBullet={false}
                  className="share-inbox-view__item-name"
                />
                <span
                  className={`share-inbox-view__item-badge share-inbox-view__item-badge--${item.permission}`}
                >
                  {item.permission}
                </span>
              </div>
              <div className="share-inbox-view__item-meta">
                <span className="share-inbox-view__item-from">
                  From <strong>@{item.shared_by.username}</strong>
                </span>
                <span className="share-inbox-view__item-ws">
                  in <em>{item.workspace.name}</em>
                </span>
                <span className="share-inbox-view__item-time">
                  {new Date(item.shared_at).toLocaleString()}
                </span>
              </div>
              <div className="share-inbox-view__item-actions">
                <Button
                  variant="primary"
                  size="sm"
                  icon="mdi mdi-open-in-app"
                  onClick={() => handleOpen(item)}
                >
                  Open
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
