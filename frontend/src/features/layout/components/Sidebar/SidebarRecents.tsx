import { useState, useCallback, memo } from 'react';
import { useNavigationStore } from '@/stores';
import { useShallow } from 'zustand/react/shallow';
import { useIsMobile } from '@/hooks';
import { useNodeByUuid } from '@/features/content';
import { useNodeDisplayName, nodeNameToDisplayText } from '@/features/queries';
import { useRecents, removeRecent, useNodeDisplay, NodeInline, NodeBreadcrumbs } from '@/features/content';
import { Button } from '@/components/ui/Button';
import { ConfirmationModal } from '@/components/ui/ConfirmationModal';
import {
  ClockIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from '@/components/ui/icons';

interface RecentItemProps {
  nodeUuid: string;
  isActive: boolean;
  onClick: (event: React.MouseEvent) => void;
  onNavigate: (nodeUuid: string) => void;
  onRequestRemove: (nodeUuid: string) => void;
  onContextMenu?: (event: React.MouseEvent) => void;
}

const RecentItem = memo(function RecentItem({ nodeUuid, isActive, onClick, onNavigate, onRequestRemove, onContextMenu }: RecentItemProps) {
  const { data: node } = useNodeByUuid(nodeUuid);
  const { effectiveIcon } = useNodeDisplay(node);
  const displayName = useNodeDisplayName(node);

  const handleClick = useCallback((e: React.MouseEvent | { target?: never }) => {
    // Don't navigate if clicking the remove button or breadcrumbs
    const target = (e as React.MouseEvent).target as HTMLElement | undefined;
    if (target?.closest('.sidebar-recent-remove, .sidebar-item-breadcrumbs-wrapper')) {
      return;
    }
    onClick(e as React.MouseEvent);
  }, [onClick]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.sidebar-recent-remove')) {
      return;
    }
    onContextMenu?.(e);
  }, [onContextMenu]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    // Let the remove button and breadcrumbs handle their own Enter/Space activation.
    if ((e.target as HTMLElement).closest('.sidebar-recent-remove, .sidebar-item-breadcrumbs-wrapper')) {
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onNavigate(nodeUuid);
    }
  }, [nodeUuid, onNavigate]);

  if (!node) return <div className="sidebar-item-skeleton" />;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={node ? displayName : 'Loading recent'}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onKeyDown={handleKeyDown}
      className={`sidebar-recent-item ${isActive ? 'active' : ''}`}
    >
      <div className="sidebar-recent-block">
        <div className="sidebar-item-breadcrumbs-wrapper">
          <NodeBreadcrumbs
            nodeUuid={node.uuid}
            nodeType="page"
            compact
            onNavigate={onNavigate}
          />
        </div>
        <NodeInline
          name={node.name}
          displayText={displayName}
          icon={effectiveIcon}
          isPage={node.is_page}
          nodeUuid={node.uuid}
          showBullet={true}
          suppressColor={true}
          draggable={true}
        />
      </div>
      <Button
        aria-label="Remove from recents"
        icon="mdi mdi-close"
        size="xs"
        variant="ghost"
        className="sidebar-recent-remove hover-reveal"
        onClick={(e) => {
          e.stopPropagation();
          onRequestRemove(nodeUuid);
        }}
        title="Remove from recents"
      />
    </div>
  );
});

interface SidebarRecentsProps {
  onContextMenu: (nodeUuid: string, e: React.MouseEvent) => void;
  onItemClick?: () => void;
}

export function SidebarRecents({ onContextMenu, onItemClick }: SidebarRecentsProps) {
  const [expanded, setExpanded] = useState(true);
  const [pendingRemoveUuid, setPendingRemoveUuid] = useState<string | null>(null);
  const { data: recentsData } = useRecents();
  const recents = recentsData ?? [];
  const { data: pendingRemoveNode } = useNodeByUuid(pendingRemoveUuid);
  const {
    mainViewType,
    currentNodeUuid,
    openNode,
    isSidebarCollapsed,
    toggleSidebar,
  } = useNavigationStore(
    useShallow((s) => ({
      mainViewType: s.mainViewType,
      currentNodeUuid: s.currentNodeUuid,
      openNode: s.openNode,
      isSidebarCollapsed: s.isSidebarCollapsed,
      toggleSidebar: s.toggleSidebar,
    }))
  );
  const isMobile = useIsMobile();

  const closeMobileDrawer = useCallback(() => {
    if (isMobile && !isSidebarCollapsed) toggleSidebar();
  }, [isMobile, isSidebarCollapsed, toggleSidebar]);

  const handleNavigate = useCallback((nodeUuid: string) => {
    openNode(nodeUuid);
    closeMobileDrawer();
    onItemClick?.();
  }, [openNode, closeMobileDrawer, onItemClick]);

  const handleBreadcrumbNavigate = useCallback((nodeUuid: string) => {
    openNode(nodeUuid);
    closeMobileDrawer();
    onItemClick?.();
  }, [openNode, closeMobileDrawer, onItemClick]);

  const handleConfirmRemove = useCallback(() => {
    if (pendingRemoveUuid) {
      removeRecent(pendingRemoveUuid);
    }
    setPendingRemoveUuid(null);
  }, [pendingRemoveUuid]);

  const handleCancelRemove = useCallback(() => {
    setPendingRemoveUuid(null);
  }, []);

  return (
    <div className="sidebar-section">
      <button
        className="sidebar-section-header"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDownIcon size="xs" /> : <ChevronRightIcon size="xs" />}
        <ClockIcon size="xs" />
        <span className="sidebar-section-title">Recents</span>
      </button>
      {expanded && (
        <div className="sidebar-recents-list">
          {recents.length === 0 ? (
            <div className="sidebar-empty-message">
              No recent pages yet
            </div>
          ) : (
            recents.map((recent) => (
              <RecentItem
                key={recent.nodeUuid}
                nodeUuid={recent.nodeUuid}
                isActive={currentNodeUuid === recent.nodeUuid && mainViewType === 'node'}
                onClick={() => handleNavigate(recent.nodeUuid)}
                onNavigate={handleBreadcrumbNavigate}
                onRequestRemove={setPendingRemoveUuid}
                onContextMenu={(e) => onContextMenu(recent.nodeUuid, e)}
              />
            ))
          )}
        </div>
      )}
      <ConfirmationModal
        isOpen={pendingRemoveUuid !== null}
        title="Remove from recents"
        message={`Remove "${nodeNameToDisplayText(pendingRemoveNode) || 'Untitled'}" from recents?`}
        secondaryMessage="The page itself will not be deleted."
        confirmLabel="Remove"
        cancelLabel="Cancel"
        onConfirm={handleConfirmRemove}
        onCancel={handleCancelRemove}
      />
    </div>
  );
}
