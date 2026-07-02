import { useState, useCallback, memo } from 'react';
import { useNavigationStore } from '@/stores';
import { useShallow } from 'zustand/react/shallow';
import { useIsMobile } from '@/hooks';
import { useNodeByUuid } from '@/features/content';
import { nodeNameToText } from '@/features/queries';
import { useRecents, useNodeDisplay, NodeInline, NodeBreadcrumbs } from '@/features/content';
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
  onContextMenu?: (event: React.MouseEvent) => void;
}

const RecentItem = memo(function RecentItem({ nodeUuid, isActive, onClick, onNavigate, onContextMenu }: RecentItemProps) {
  const { data: node } = useNodeByUuid(nodeUuid);
  const { effectiveIcon } = useNodeDisplay(node);

  const handleClick = useCallback((e: React.MouseEvent | { target?: never }) => {
    // Don't navigate if clicking breadcrumbs
    const target = (e as React.MouseEvent).target as HTMLElement | undefined;
    if (target?.closest('.sidebar-item-breadcrumbs-wrapper')) {
      return;
    }
    onClick(e as React.MouseEvent);
  }, [onClick]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onNavigate(nodeUuid);
    }
  }, [nodeUuid, onNavigate]);

  if (!node) return <div className="sidebar-item-skeleton" />;

  return (
    <button
      type="button"
      aria-label={node ? nodeNameToText(node.name) || 'Untitled' : 'Loading recent'}
      onClick={handleClick}
      onContextMenu={onContextMenu}
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
          icon={effectiveIcon}
          isPage={node.is_page}
          nodeUuid={node.uuid}
          showBullet={true}
          suppressColor={true}
          draggable={true}
        />
      </div>
    </button>
  );
});

interface SidebarRecentsProps {
  onContextMenu: (nodeUuid: string, e: React.MouseEvent) => void;
  onItemClick?: () => void;
}

export function SidebarRecents({ onContextMenu, onItemClick }: SidebarRecentsProps) {
  const [expanded, setExpanded] = useState(true);
  const { data: recentsData } = useRecents();
  const recents = recentsData ?? [];
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

  return (
    <div className="sidebar-section">
      <button
        className="sidebar-section-header"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDownIcon size="xs" /> : <ChevronRightIcon size="xs" />}
        <ClockIcon size="xs" />
        <h2 className="sidebar-section-title">Recents</h2>
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
                onContextMenu={(e) => onContextMenu(recent.nodeUuid, e)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
