import { useState, useCallback, memo, useEffect } from 'react';
import { useNavigationStore, usePinnedPagesStore } from '@/stores';
import { useShallow } from 'zustand/react/shallow';
import { useIsMobile } from '@/hooks';
import { useNodeByUuid } from '@/features/content';
import { nodeNameToText } from '@/features/queries';
import { useNodeDisplay, NodeInline, NodeBreadcrumbs } from '@/features/content';
import { isApiError } from '@/api/client';
import { Button } from '@/components/ui/Button';
import {
  PinIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from '@/components/ui/icons';

interface PinnedItemProps {
  nodeUuid: string;
  isActive: boolean;
  onClick: (event: React.MouseEvent) => void;
  onNavigate: (nodeUuid: string) => void;
  onUnpin: (nodeUuid: string) => void;
  onContextMenu?: (event: React.MouseEvent) => void;
}

const PinnedItem = memo(function PinnedItem({ nodeUuid, isActive, onClick, onNavigate, onUnpin, onContextMenu }: PinnedItemProps) {
  const { data: node, error } = useNodeByUuid(nodeUuid, { meta: { skipGlobalError: true } });
  const { effectiveIcon } = useNodeDisplay(node);

  // Auto-unpin stale entries for deleted nodes
  useEffect(() => {
    if (error && isApiError(error) && error.response?.status === 404) {
      onUnpin(nodeUuid);
    }
  }, [error, nodeUuid, onUnpin]);

  const handleClick = useCallback((e: React.MouseEvent | { target?: never }) => {
    // Don't navigate if clicking the unpin button or breadcrumbs
    const target = (e as React.MouseEvent).target as HTMLElement | undefined;
    if (target?.closest('.sidebar-pinned-remove, .sidebar-item-breadcrumbs-wrapper')) {
      return;
    }
    onClick(e as React.MouseEvent);
  }, [onClick]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.sidebar-pinned-remove')) {
      return;
    }
    onContextMenu?.(e);
  }, [onContextMenu]);

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
      aria-label={node ? nodeNameToText(node.name) || 'Untitled' : 'Loading pinned page'}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onKeyDown={handleKeyDown}
      className={`sidebar-pinned-item ${isActive ? 'active' : ''}`}
    >
      <div className="sidebar-pinned-block">
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
      <Button
        aria-label="Unpin page"
        icon="mdi mdi-close"
        size="xs"
        variant="ghost"
        className="sidebar-pinned-remove hover-reveal"
        onClick={(e) => {
          e.stopPropagation();
          onUnpin(nodeUuid);
        }}
        title="Unpin page"
      />
    </button>
  );
});

interface SidebarPinnedPagesProps {
  onContextMenu: (nodeUuid: string, e: React.MouseEvent) => void;
  onItemClick?: () => void;
}

export function SidebarPinnedPages({ onContextMenu, onItemClick }: SidebarPinnedPagesProps) {
  const [expanded, setExpanded] = useState(true);
  const pinnedPages = usePinnedPagesStore((s) => s.pinnedPages);
  const togglePin = usePinnedPagesStore((s) => s.togglePin);
  const unpinPage = usePinnedPagesStore((s) => s.unpinPage);
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
  const { data: currentNode } = useNodeByUuid(
    mainViewType === 'node' ? currentNodeUuid : null,
    { meta: { skipGlobalError: true } }
  );

  const closeMobileDrawer = useCallback(() => {
    if (isMobile && !isSidebarCollapsed) toggleSidebar();
  }, [isMobile, isSidebarCollapsed, toggleSidebar]);

  const handleNavigate = useCallback((nodeUuid: string) => {
    openNode(nodeUuid);
    closeMobileDrawer();
    onItemClick?.();
  }, [openNode, closeMobileDrawer, onItemClick]);

  const handleUnpin = useCallback((nodeUuid: string) => {
    unpinPage(nodeUuid);
  }, [unpinPage]);

  const currentPageIsPinnable = mainViewType === 'node' && currentNode?.is_page === true;
  const currentPageIsPinned = currentPageIsPinnable && currentNodeUuid !== null
    && pinnedPages.includes(currentNodeUuid);

  const handleTogglePinCurrent = useCallback(() => {
    if (currentPageIsPinnable && currentNodeUuid) {
      togglePin(currentNodeUuid);
    }
  }, [currentPageIsPinnable, currentNodeUuid, togglePin]);

  return (
    <div className="sidebar-section">
      <div className="sidebar-section-header-row">
        <button
          className="sidebar-section-header"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDownIcon size="xs" /> : <ChevronRightIcon size="xs" />}
          <PinIcon size="xs" />
          <span className="sidebar-section-title">Pinned</span>
        </button>
        {currentPageIsPinnable && (
          <Button
            aria-label={currentPageIsPinned ? 'Unpin current page' : 'Pin current page'}
            icon={currentPageIsPinned ? 'mdi mdi-pin' : 'mdi mdi-pin-outline'}
            size="xs"
            variant="ghost"
            className="sidebar-section-action"
            onClick={handleTogglePinCurrent}
            title={currentPageIsPinned ? 'Unpin current page' : 'Pin current page'}
          />
        )}
      </div>
      {expanded && (
        <div className="sidebar-pinned-list">
          {pinnedPages.length === 0 ? (
            <div className="sidebar-empty-message">
              No pinned pages. Open a page and click the pin button to keep it here for this session.
            </div>
          ) : (
            pinnedPages.map((nodeUuid) => (
              <PinnedItem
                key={nodeUuid}
                nodeUuid={nodeUuid}
                isActive={currentNodeUuid === nodeUuid && mainViewType === 'node'}
                onClick={() => handleNavigate(nodeUuid)}
                onNavigate={handleNavigate}
                onUnpin={handleUnpin}
                onContextMenu={(e) => onContextMenu(nodeUuid, e)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
