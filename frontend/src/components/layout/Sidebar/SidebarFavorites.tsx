import { useState, useCallback, memo, useEffect } from 'react';
import { useNavigationStore, useFavoritesStore } from '@/stores';
import { useNode, useIsMobile } from '@/hooks';
import { isApiError } from '@/api/client';
import { useNodeDisplay } from '@/hooks/useNodeDisplay';
import { useListDragSort } from '@/hooks/useListDragSort';
import { Button } from '@/components/core/Button';
import { NodeInline } from '@/components/blocks/NodeInline';
import {
  StarIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DragVerticalIcon,
} from '@/components/core/icons';

interface SortableFavoriteItemProps {
  nodeId: number;
  index: number;
  isActive: boolean;
  isDragging: boolean;
  style: React.CSSProperties;
  onDragStart: (index: number, e: React.MouseEvent) => void;
  onNavigate: (nodeId: number) => void;
  onRemove: (nodeId: number) => void;
  onContextMenu: (nodeId: number, e: React.MouseEvent) => void;
}

const SortableFavoriteItem = memo(function SortableFavoriteItem({
  nodeId,
  index,
  isActive,
  isDragging,
  style,
  onDragStart,
  onNavigate,
  onRemove,
  onContextMenu,
}: SortableFavoriteItemProps) {
  const { data: node, error } = useNode(nodeId, { meta: { skipGlobalError: true } });
  const { effectiveIcon } = useNodeDisplay(node);

  // Auto-remove stale favorites for deleted nodes
  useEffect(() => {
    if (error && isApiError(error) && error.response?.status === 404) {
      useFavoritesStore.getState().removeFavorite(nodeId);
    }
  }, [error, nodeId]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    // Don't navigate if clicking drag handle or remove button
    if ((e.target as HTMLElement).closest('.sidebar-drag-handle, .sidebar-favorite-remove')) {
      return;
    }
    onNavigate(nodeId);
  }, [nodeId, onNavigate]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    // Don't show context menu if clicking drag handle or remove button
    if ((e.target as HTMLElement).closest('.sidebar-drag-handle, .sidebar-favorite-remove')) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    onContextMenu(nodeId, e);
  }, [nodeId, onContextMenu]);

  const handleDragHandleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onDragStart(index, e);
  }, [index, onDragStart]);

  // Deleted node — render nothing so it auto-removes from the list
  if (error && isApiError(error) && error.response?.status === 404) {
    return null;
  }

  if (!node) return (
    <div className={`sidebar-favorite-item ${isDragging ? 'dragging' : ''}`} style={style}>
      <div className="sidebar-item-skeleton" />
    </div>
  );

  return (
    <div role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }}
      className={`sidebar-favorite-item ${isActive ? 'active' : ''} ${isDragging ? 'dragging' : ''}`}
      style={style}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      {/* Drag handle */}
      <span role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }}
        className="sidebar-drag-handle"
        onMouseDown={handleDragHandleMouseDown}
        onClick={(e) => e.stopPropagation()}
      >
        <DragVerticalIcon size="xs" />
      </span>

      {/* Node name in readonly mode */}
      <div className="sidebar-favorite-block">
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

      {/* Remove button */}
      <Button
        icon={"mdi mdi-close"}
        size="xs"
        variant="ghost"
        className="sidebar-favorite-remove"
        onClick={(e) => {
          e.stopPropagation();
          onRemove(nodeId);
        }}
        title="Remove from favorites"
      />
    </div>
  );
});

interface SidebarFavoritesProps {
  onContextMenu: (nodeId: number, e: React.MouseEvent) => void;
}

export function SidebarFavorites({ onContextMenu }: SidebarFavoritesProps) {
  const [expanded, setExpanded] = useState(true);
  const favorites = useFavoritesStore((state) => state.favorites);
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

  const handleRemove = useCallback((nodeId: number) => {
    useFavoritesStore.getState().removeFavorite(nodeId);
  }, []);

  const {
    containerRef,
    dragState,
    isSettling,
    handleDragStart,
    getItemStyle,
  } = useListDragSort({
    itemCount: favorites.length,
    itemSelector: '.sidebar-favorite-item',
    onReorder: (fromIndex, toIndex) => {
      useFavoritesStore.getState().reorderFavorites(fromIndex, toIndex);
    },
  });

  return (
    <div className="sidebar-section">
      <button
        className="sidebar-section-header"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDownIcon size="xs" /> : <ChevronRightIcon size="xs" />}
        <StarIcon size="xs" />
        <h3 className="sidebar-section-title">Favorites</h3>
      </button>
      {expanded && (
        <div
          ref={containerRef}
          className={`sidebar-favorites-list ${dragState ? 'dragging' : ''} ${isSettling ? 'settling' : ''}`}
        >
          {favorites.length === 0 ? (
            <div className="sidebar-empty-message">
              No favorites yet. Right-click a page header to add.
            </div>
          ) : (
            favorites.map((fav, index) => (
              <SortableFavoriteItem
                key={fav.nodeId}
                nodeId={fav.nodeId}
                index={index}
                isActive={currentNodeId === fav.nodeId && mainViewType === 'node'}
                isDragging={dragState?.dragIndex === index}
                style={getItemStyle(index)}
                onDragStart={handleDragStart}
                onNavigate={handleNavigate}
                onRemove={handleRemove}
                onContextMenu={onContextMenu}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
