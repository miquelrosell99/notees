import { useState, useCallback, memo, useEffect } from 'react';
import { useNavigationStore } from '@/stores';
import { useNode, useIsMobile } from '@/hooks';
import { nodeNameToText } from '@/features/queries';
import {
  useFavorites,
  useRemoveFavoriteMutation,
  useReorderFavoritesMutation,
  removeFavorite,
  useNodeDisplay,
  useListDragSort,
  NodeInline,
  NodeBreadcrumbs,
} from '@/features/content';
import { isApiError } from '@/api/client';
import { Button } from '@/components/ui/Button';
import {
  StarIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DragVerticalIcon,
} from '@/components/ui/icons';

interface SortableFavoriteItemProps {
  nodeId: number;
  index: number;
  isActive: boolean;
  isDragging: boolean;
  style: React.CSSProperties;
  onDragStart: (index: number, e: React.MouseEvent) => void;
  onNavigate: (nodeId: number, e?: React.MouseEvent) => void;
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
      removeFavorite(nodeId).catch(() => {});
    }
  }, [error, nodeId]);

  const handleClick = useCallback((e: React.MouseEvent | { target?: never }) => {
    // Don't navigate if clicking drag handle, remove button, or breadcrumbs
    const target = (e as React.MouseEvent).target as HTMLElement | undefined;
    if (target?.closest('.sidebar-drag-handle, .sidebar-favorite-remove, .sidebar-item-breadcrumbs-wrapper')) {
      return;
    }
    onNavigate(nodeId, e as React.MouseEvent);
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
    <button
      type="button"
      aria-label={node ? nodeNameToText(node.name) || 'Untitled' : 'Loading favorite'}
      className={`sidebar-favorite-item ${isActive ? 'active' : ''} ${isDragging ? 'dragging' : ''}`}
      style={style}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
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

      {/* Remove button */}
      <Button aria-label="Remove from favorites"
        icon={"mdi mdi-close"}
        size="xs"
        variant="ghost"
        className="sidebar-favorite-remove hover-reveal"
        onClick={(e) => {
          e.stopPropagation();
          onRemove(nodeId);
        }}
        title="Remove from favorites"
      />
    </button>
  );
});

interface SidebarFavoritesProps {
  onContextMenu: (nodeId: number, e: React.MouseEvent) => void;
  onItemClick?: () => void;
}

export function SidebarFavorites({ onContextMenu, onItemClick }: SidebarFavoritesProps) {
  const [expanded, setExpanded] = useState(true);
  const { data: favoritesData } = useFavorites();
  const favorites = favoritesData ?? [];
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

  const removeFavoriteMutation = useRemoveFavoriteMutation();
  const reorderFavoritesMutation = useReorderFavoritesMutation();

  const handleRemove = useCallback((nodeId: number) => {
    removeFavoriteMutation.mutate(nodeId);
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
              No favorites yet. Right-click a page header to add one.
            </div>
          ) : (
            favorites.map((fav, index) => (
              <SortableFavoriteItem
                key={fav}
                nodeId={fav}
                index={index}
                isActive={currentNodeId === fav && mainViewType === 'node'}
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
