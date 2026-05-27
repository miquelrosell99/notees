import { useState, useCallback, memo } from 'react';
import { useNavigationStore, useFavoritesStore } from '@/stores';
import { useNode, useIsMobile } from '@/hooks';
import { useNodeDisplay } from '@/hooks/useNodeDisplay';
import { NodeInline } from '@/components/blocks/NodeInline';
import {
  ClockIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from '@/components/core/icons';

interface RecentItemProps {
  nodeId: number;
  isActive: boolean;
  onClick: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
}

const RecentItem = memo(function RecentItem({ nodeId, isActive, onClick, onContextMenu }: RecentItemProps) {
  const { data: node } = useNode(nodeId);
  const { effectiveIcon } = useNodeDisplay(node);

  if (!node) return <div className="sidebar-item-skeleton" />;

  return (
    <div onContextMenu={onContextMenu} className={`sidebar-recent-item ${isActive ? 'active' : ''}`}>
      <div className="sidebar-recent-block">
        <NodeInline
          name={node.name}
          icon={effectiveIcon}
          isPage={node.is_page}
          nodeId={node.id}
          nodeUuid={node.uuid}
          showBullet={true}
          onClick={onClick}
          suppressColor={true}
          draggable={true}
        />
      </div>
    </div>
  );
});

interface SidebarRecentsProps {
  onContextMenu: (nodeId: number, e: React.MouseEvent) => void;
}

export function SidebarRecents({ onContextMenu }: SidebarRecentsProps) {
  const [expanded, setExpanded] = useState(true);
  const recents = useFavoritesStore((state) => state.recents);
  const {
    mainViewType,
    currentNodeId,
    openNode,
    isSidebarCollapsed,
    toggleSidebar,
  } = useNavigationStore();
  const isMobile = useIsMobile();

  const closeMobileDrawer = useCallback(() => {
    if (isMobile && !isSidebarCollapsed) toggleSidebar();
  }, [isMobile, isSidebarCollapsed, toggleSidebar]);

  const handleNavigate = useCallback((nodeId: number) => {
    openNode(nodeId);
    closeMobileDrawer();
  }, [openNode, closeMobileDrawer]);

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
              No recent pages yet.
            </div>
          ) : (
            recents.map((recent) => (
              <RecentItem
                key={recent.nodeId}
                nodeId={recent.nodeId}
                isActive={currentNodeId === recent.nodeId && mainViewType === 'node'}
                onClick={() => handleNavigate(recent.nodeId)}
                onContextMenu={(e) => onContextMenu(recent.nodeId, e)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
