import { useState, useCallback, memo } from 'react';
import { useNavigationStore } from '@/stores';
import { useNode, useIsMobile } from '@/hooks';
import { nodeNameToText } from '@/features/queries';
import { useRecents, useNodeDisplay, NodeInline, NodeBreadcrumbs } from '@/features/content';
import {
  ClockIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from '@/components/ui/icons';

interface RecentItemProps {
  nodeId: number;
  isActive: boolean;
  onClick: (event: React.MouseEvent) => void;
  onNavigate: (nodeId: number) => void;
  onContextMenu?: (event: React.MouseEvent) => void;
}

const RecentItem = memo(function RecentItem({ nodeId, isActive, onClick, onNavigate, onContextMenu }: RecentItemProps) {
  const { data: node } = useNode(nodeId);
  const { effectiveIcon } = useNodeDisplay(node);

  const handleClick = useCallback((e: React.MouseEvent | { target?: never }) => {
    // Don't navigate if clicking breadcrumbs
    const target = (e as React.MouseEvent).target as HTMLElement | undefined;
    if (target?.closest('.sidebar-item-breadcrumbs-wrapper')) {
      return;
    }
    onClick(e as React.MouseEvent);
  }, [onClick]);

  if (!node) return <div className="sidebar-item-skeleton" />;

  return (
    <button
      type="button"
      aria-label={node ? nodeNameToText(node.name) || 'Untitled' : 'Loading recent'}
      onClick={handleClick}
      onContextMenu={onContextMenu}
      className={`sidebar-recent-item ${isActive ? 'active' : ''}`}
    >
      <div className="sidebar-recent-block">
        <div className="sidebar-item-breadcrumbs-wrapper">
          <NodeBreadcrumbs
            nodeId={node.id}
            nodeType="page"
            compact
            onNavigate={onNavigate}
          />
        </div>
        <NodeInline
          name={node.name}
          icon={effectiveIcon}
          isPage={node.is_page}
          nodeId={node.id}
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
  onContextMenu: (nodeId: number, e: React.MouseEvent) => void;
  onItemClick?: () => void;
}

export function SidebarRecents({ onContextMenu, onItemClick }: SidebarRecentsProps) {
  const [expanded, setExpanded] = useState(true);
  const { data: recentsData } = useRecents();
  const recents = recentsData ?? [];
  const {
    mainViewType,
    currentNodeId,
    openNode,
    openNodeInNewTab,
    isSidebarCollapsed,
    toggleSidebar,
  } = useNavigationStore();
  const isMobile = useIsMobile();

  const closeMobileDrawer = useCallback(() => {
    if (isMobile && !isSidebarCollapsed) toggleSidebar();
  }, [isMobile, isSidebarCollapsed, toggleSidebar]);

  const handleNavigate = useCallback((nodeId: number, e?: React.MouseEvent) => {
    if (e?.ctrlKey || e?.metaKey) {
      openNodeInNewTab(nodeId);
    } else {
      openNode(nodeId);
      closeMobileDrawer();
    }
    onItemClick?.();
  }, [openNode, openNodeInNewTab, closeMobileDrawer, onItemClick]);

  const handleBreadcrumbNavigate = useCallback((nodeId: number) => {
    openNode(nodeId);
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
        <h3 className="sidebar-section-title">Recents</h3>
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
                key={recent.nodeId}
                nodeId={recent.nodeId}
                isActive={currentNodeId === recent.nodeId && mainViewType === 'node'}
                onClick={(e) => handleNavigate(recent.nodeId, e)}
                onNavigate={handleBreadcrumbNavigate}
                onContextMenu={(e) => onContextMenu(recent.nodeId, e)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
