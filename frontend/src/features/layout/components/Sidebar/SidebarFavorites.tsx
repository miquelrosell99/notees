import { useState, useCallback, memo, useEffect } from 'react';
import { useNavigationStore } from '@/stores';
import { useShallow } from 'zustand/react/shallow';
import { useIsMobile } from '@/hooks';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useNodeByUuid } from '@/features/content';
import { nodeNameToText } from '@/features/queries';
import { useListDragSort } from '@/hooks/useListDragSort';
import { useFavorites, useAddFavoriteMutation, useRemoveFavoriteMutation, useReorderFavoritesMutation, removeFavorite, useNodeDisplay, NodeInline, NodeBreadcrumbs } from '@/features/content';
import { isApiError } from '@/api/client';
import { Button } from '@/components/ui/Button';
import {
  StarIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DragVerticalIcon,
} from '@/components/ui/icons';

interface SortableFavoriteItemProps {
  nodeUuid: string;
  workspaceId: string | undefined;
  index: number;
  isActive: boolean;
  isDragging: boolean;
  style: React.CSSProperties;
  onDragStart: (index: number, e: React.MouseEvent) => void;
  onNavigate: (nodeUuid: string) => void;
  onRemove: (nodeUuid: string) => void;
  onContextMenu: (nodeUuid: string, e: React.MouseEvent) => void;
}

const SortableFavoriteItem = memo(function SortableFavoriteItem({
      nodeUuid,
      workspaceId,
      index,
      isActive,
      isDragging,
      style,
      onDragStart,
      onNavigate,
      onRemove,
      onContextMenu }: SortableFavoriteItemProps) {
  const { data: node, error } = useNodeByUuid(nodeUuid, { meta: { skipGlobalError: true } });
  const { effectiveIcon } = useNodeDisplay(node);

  // Auto-remove stale favorites for deleted nodes
  useEffect(() => {
    if (error && isApiError(error) && error.response?.status === 404) {
      removeFavorite(workspaceId, nodeUuid).catch(() => {});
    }
  }, [error, workspaceId, nodeUuid]);

  const handleClick = useCallback((e: React.MouseEvent | { target?: never }) => {
    // Don't navigate if clicking drag handle, remove button, or breadcrumbs
    const target = (e as React.MouseEvent).target as HTMLElement | undefined;
    if (target?.closest('.sidebar-drag-handle, .sidebar-favorite-remove, .sidebar-item-breadcrumbs-wrapper')) {
      return;
    }
    if (!node) return;
    onNavigate(node.uuid);
  }, [node, onNavigate]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    // Don't show context menu if clicking drag handle or remove button
    if ((e.target as HTMLElement).closest('.sidebar-drag-handle, .sidebar-favorite-remove')) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (!node) return;
    onContextMenu(node.uuid, e);
  }, [node, onContextMenu]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!node) return;
      onNavigate(node.uuid);
    }
  }, [node, onNavigate]);

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
    <div
      role="button"
      tabIndex={0}
      aria-label={node ? nodeNameToText(node.name) || 'Untitled' : 'Loading favorite'}
      className={`sidebar-favorite-item ${isActive ? 'active' : ''} ${isDragging ? 'dragging' : ''}`}
      style={style}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onKeyDown={handleKeyDown}
    >
      {/* Drag handle */}
      <button
        type="button"
        aria-label="Drag to reorder"
        className="sidebar-drag-handle"
        onMouseDown={handleDragHandleMouseDown}
        onClick={(e) => e.stopPropagation()}
      >
        <DragVerticalIcon size="xs" />
      </button>

      {/* Breadcrumbs + node name */}
      <div className="sidebar-favorite-block">
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

      {/* Remove button */}
      <Button aria-label="Remove from favorites"
        icon={"mdi mdi-close"}
        size="xs"
        variant="ghost"
        className="sidebar-favorite-remove hover-reveal"
        onClick={(e) => {
          e.stopPropagation();
          onRemove(nodeUuid);
        }}
        title="Remove from favorites"
      />
    </div>
  );
});

interface SidebarFavoritesProps {
  onContextMenu: (nodeUuid: string, e: React.MouseEvent) => void;
  onItemClick?: () => void;
}

export function SidebarFavorites({ onContextMenu, onItemClick }: SidebarFavoritesProps) {
  const [expanded, setExpanded] = useState(true);
  const workspaceId = useCurrentWorkspaceUuid();
  const { data: favoritesData } = useFavorites(workspaceId ?? undefined);
  const favorites = favoritesData ?? [];
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

  const removeFavoriteMutation = useRemoveFavoriteMutation(workspaceId ?? undefined);
  const addFavoriteMutation = useAddFavoriteMutation(workspaceId ?? undefined);
  const reorderFavoritesMutation = useReorderFavoritesMutation(workspaceId ?? undefined);

  const currentPageIsFavoritable = mainViewType === 'node' && currentNode?.is_page === true;
  const currentPageIsFavorited = currentPageIsFavoritable && currentNodeUuid !== null
    && favorites.includes(currentNodeUuid);

  const handleToggleFavoriteCurrent = useCallback(() => {
    if (!currentPageIsFavoritable || !currentNodeUuid) return;
    if (currentPageIsFavorited) {
      removeFavoriteMutation.mutate(currentNodeUuid);
    } else {
      addFavoriteMutation.mutate(currentNodeUuid);
    }
  }, [currentPageIsFavoritable, currentPageIsFavorited, currentNodeUuid, addFavoriteMutation, removeFavoriteMutation]);

  const handleRemove = useCallback((nodeUuid: string) => {
    removeFavoriteMutation.mutate(nodeUuid);
  }, [removeFavoriteMutation]);

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
      reorderFavoritesMutation.mutate({ fromIndex, toIndex });
    },
  });

  return (
    <div className="sidebar-section">
      <div className="sidebar-section-header-row">
        <button
          className="sidebar-section-header"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDownIcon size="xs" /> : <ChevronRightIcon size="xs" />}
          <StarIcon size="xs" />
          <span className="sidebar-section-title">Favorites</span>
        </button>
        {currentPageIsFavoritable && (
          <Button
            aria-label={currentPageIsFavorited ? 'Remove current page from favorites' : 'Add current page to favorites'}
            icon={currentPageIsFavorited ? 'mdi mdi-star' : 'mdi mdi-star-outline'}
            size="xs"
            variant="ghost"
            className="sidebar-section-action"
            onClick={handleToggleFavoriteCurrent}
            title={currentPageIsFavorited ? 'Remove current page from favorites' : 'Add current page to favorites'}
          />
        )}
      </div>
      {expanded && (
        <div
          ref={containerRef}
          className={`sidebar-favorites-list ${dragState ? 'dragging' : ''} ${isSettling ? 'settling' : ''}`}
        >
          {favorites.length === 0 ? (
            <div className="sidebar-empty-message">
              No favorites yet. Right-click a page header to add one.
            </div>
          ) : (
            favorites.map((fav, index) => (
              <SortableFavoriteItem
                key={fav}
                nodeUuid={fav}
                workspaceId={workspaceId ?? undefined}
                index={index}
                isActive={currentNodeUuid === fav && mainViewType === 'node'}
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
