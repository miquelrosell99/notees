/**
 * Sidebar component with graph switcher, navigation, favorites, and recents
 * 
 * Matches the UI shown in screenshots with:
 * - Graph switcher at top
 * - Journal, All Pages, Graph View navigation
 * - FAVORITES section with user-favorited pages (draggable for reordering)
 * - RECENTS section with recently accessed pages
 */
import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useAppStore, useFavoritesStore } from '@/stores';
import { useNode } from '@/hooks';
import { mdiClose, mdiNotebookOutline, mdiBookOpenPageVariant, mdiArchive, mdiTrashCanOutline, mdiGraphOutline, mdiTimelineClockOutline, mdiCog } from '@mdi/js';
import { WorkspaceSwitcher } from '../workspace/WorkspaceSwitcher';
import { WorkspaceModal } from '../workspace/WorkspaceModal';
import { SettingsModal } from './SettingsModal';
import { Card } from '../core/Card';
import { Button } from '../core/Button';
import { NodeInline } from '../blocks/NodeInline';
import { PageContextMenu } from '../nodes/NodeContextMenu';
import { 
  StarIcon,
  ClockIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from '../core/icons';
import './NavigationSidebar.css';

interface SidebarProps {
  collapsed: boolean;
}

interface RecentItemProps {
  nodeId: number;
  isActive: boolean;
  onClick: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
}

function RecentItem({ nodeId, isActive, onClick, onContextMenu }: RecentItemProps) {
  // Fetch the node directly using useNode for real-time updates
  const { data: node } = useNode(nodeId);
  
  // Don't render if node not yet loaded
  if (!node) return null;
  
  return (
    <div onContextMenu={onContextMenu}>
      <NodeInline
        name={node.name}
        icon={node.icon}
        isPage={node.is_page}
        nodeId={node.id}
        showBullet={true}
        onClick={onClick}
        className={`sidebar-recent-item ${isActive ? 'active' : ''}`}
        suppressColor={true}
      />
    </div>
  );
}

// Sortable favorite item with drag handle and Block component
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

function SortableFavoriteItem({
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
  const { data: node } = useNode(nodeId);
  
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
  
  if (!node) return null;
  
  return (
    <div
      className={`sidebar-favorite-item ${isActive ? 'active' : ''} ${isDragging ? 'dragging' : ''}`}
      style={style}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      {/* Drag handle */}
      <span 
        className="sidebar-drag-handle"
        onMouseDown={handleDragHandleMouseDown}
        onClick={(e) => e.stopPropagation()}
      >
        ⋮⋮
      </span>
      
      {/* Node name in readonly mode */}
      <div className="sidebar-favorite-block">
        <NodeInline
          name={node.name}
          icon={node.icon}
          isPage={node.is_page}
          nodeId={node.id}
          showBullet={true}
          suppressColor={true}
        />
      </div>
      
      {/* Remove button */}
      <Button
        icon={mdiClose}
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
}

export function Sidebar({ collapsed }: SidebarProps) {
  const [isWorkspaceModalOpen, setIsWorkspaceModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [favoritesExpanded, setFavoritesExpanded] = useState(true);
  const [recentsExpanded, setRecentsExpanded] = useState(true);
  const [contextMenuNode, setContextMenuNode] = useState<number | null>(null);
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });
  
  // Drag state for favorites reordering
  const [dragState, setDragState] = useState<{
    dragIndex: number;
    targetIndex: number;
    mouseYInContent: number;
    grabOffset: number;
  } | null>(null);
  const [isSettling, setIsSettling] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const itemHeightRef = useRef(40);
  const scrollRAF = useRef<number | null>(null);
  const lastClientY = useRef(0);
  
  const { 
    mainViewType,
    setMainViewType,
    openNode,
    currentNodeId,
  } = useAppStore();
  
  // Use individual selectors for data to ensure proper reactivity
  const favorites = useFavoritesStore((state) => state.favorites);
  const recents = useFavoritesStore((state) => state.recents);
  
  // Fetch the context menu node data
  const { data: contextNode } = useNode(contextMenuNode);
  
  // Measure item height
  useEffect(() => {
    if (containerRef.current) {
      const firstItem = containerRef.current.querySelector('.sidebar-favorite-item') as HTMLElement;
      if (firstItem) {
        itemHeightRef.current = firstItem.offsetHeight;
      }
    }
  }, [favorites.length]);
  
  // Handle drag start
  const handleDragStart = useCallback((index: number, e: React.MouseEvent) => {
    const container = containerRef.current;
    if (!container) return;

    const firstItem = container.querySelector('.sidebar-favorite-item') as HTMLElement;
    if (firstItem) {
      itemHeightRef.current = firstItem.offsetHeight;
    }

    const containerRect = container.getBoundingClientRect();
    const itemTop = index * itemHeightRef.current;
    const mouseYInContent = e.clientY - containerRect.top + container.scrollTop;
    const grabOffset = mouseYInContent - itemTop;

    lastClientY.current = e.clientY;

    setDragState({
      dragIndex: index,
      targetIndex: index,
      mouseYInContent,
      grabOffset,
    });
  }, []);
  
  // Main drag effect
  useEffect(() => {
    if (!dragState) return;

    const container = containerRef.current;
    if (!container) return;

    const updateDragPosition = (clientY: number) => {
      const containerRect = container.getBoundingClientRect();
      const mouseYInContent = clientY - containerRect.top + container.scrollTop;
      
      const itemHeight = itemHeightRef.current;
      const draggedItemTop = mouseYInContent - dragState.grabOffset;
      const draggedItemCenter = draggedItemTop + itemHeight / 2;
      const rawTarget = Math.floor(draggedItemCenter / itemHeight);
      const targetIndex = Math.max(0, Math.min(favorites.length - 1, rawTarget));

      setDragState(prev => prev ? {
        ...prev,
        mouseYInContent,
        targetIndex,
      } : null);

      return { containerRect, mouseYInContent };
    };

    const handleMouseMove = (e: MouseEvent) => {
      lastClientY.current = e.clientY;
      const { containerRect } = updateDragPosition(e.clientY);

      const scrollZone = 40;
      const maxSpeed = 6;
      
      const distFromTop = e.clientY - containerRect.top;
      const distFromBottom = containerRect.bottom - e.clientY;
      
      if (scrollRAF.current) {
        cancelAnimationFrame(scrollRAF.current);
        scrollRAF.current = null;
      }

      const canScrollUp = container.scrollTop > 0;
      const canScrollDown = container.scrollTop < container.scrollHeight - container.clientHeight;

      if (distFromTop < scrollZone && canScrollUp) {
        const speed = Math.ceil(((scrollZone - distFromTop) / scrollZone) * maxSpeed);
        
        const doScroll = () => {
          if (container.scrollTop > 0) {
            container.scrollTop -= speed;
            updateDragPosition(lastClientY.current);
            scrollRAF.current = requestAnimationFrame(doScroll);
          }
        };
        scrollRAF.current = requestAnimationFrame(doScroll);
      } else if (distFromBottom < scrollZone && canScrollDown) {
        const speed = Math.ceil(((scrollZone - distFromBottom) / scrollZone) * maxSpeed);
        
        const doScroll = () => {
          if (container.scrollTop < container.scrollHeight - container.clientHeight) {
            container.scrollTop += speed;
            updateDragPosition(lastClientY.current);
            scrollRAF.current = requestAnimationFrame(doScroll);
          }
        };
        scrollRAF.current = requestAnimationFrame(doScroll);
      }
    };

    const handleMouseUp = () => {
      if (scrollRAF.current) {
        cancelAnimationFrame(scrollRAF.current);
        scrollRAF.current = null;
      }

      const { dragIndex, targetIndex } = dragState;
      setIsSettling(true);
      setDragState(null);
      
      if (dragIndex !== targetIndex) {
        useFavoritesStore.getState().reorderFavorites(dragIndex, targetIndex);
      }
      
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setIsSettling(false);
        });
      });
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      if (scrollRAF.current) {
        cancelAnimationFrame(scrollRAF.current);
        scrollRAF.current = null;
      }
    };
  }, [dragState, favorites.length]);
  
  // Get transform style for each item
  const getItemStyle = (index: number): React.CSSProperties => {
    if (!dragState) return {};

    const { dragIndex, targetIndex, mouseYInContent, grabOffset } = dragState;
    const itemHeight = itemHeightRef.current;

    if (index === dragIndex) {
      const naturalTop = dragIndex * itemHeight;
      const desiredTop = mouseYInContent - grabOffset;
      const minTop = 0;
      const maxTop = (favorites.length - 1) * itemHeight;
      const clampedTop = Math.max(minTop, Math.min(maxTop, desiredTop));
      const translateY = clampedTop - naturalTop;
      
      return {
        transform: `translateY(${translateY}px)`,
        zIndex: 100,
        transition: 'none',
      };
    }

    let shift = 0;
    
    if (dragIndex < targetIndex) {
      if (index > dragIndex && index <= targetIndex) {
        shift = -itemHeight;
      }
    } else if (dragIndex > targetIndex) {
      if (index >= targetIndex && index < dragIndex) {
        shift = itemHeight;
      }
    }

    return {
      transform: shift !== 0 ? `translateY(${shift}px)` : undefined,
      zIndex: 1,
      transition: isSettling ? 'none' : 'transform 150ms ease-out',
    };
  };
  
  // Use callbacks that access store via getState() for stability
  const handleRemoveFavorite = useCallback((nodeId: number) => {
    useFavoritesStore.getState().removeFavorite(nodeId);
  }, []);
  
  // Handle navigating to a page
  const handleNavigateToPage = useCallback((nodeId: number) => {
    openNode(nodeId);
  }, [openNode]);
  
  // Handle context menu for favorites
  const handleFavoriteContextMenu = useCallback((nodeId: number, e: React.MouseEvent) => {
    setContextMenuNode(nodeId);
    setContextMenuPos({ x: e.clientX, y: e.clientY });
  }, []);
  
  // Handle context menu for recents
  const handleRecentContextMenu = useCallback((nodeId: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenuNode(nodeId);
    setContextMenuPos({ x: e.clientX, y: e.clientY });
  }, []);
  
  // Close context menu
  const handleCloseContextMenu = useCallback(() => {
    setContextMenuNode(null);
  }, []);

  return (
    <>
      <Card className={`sidebar ${collapsed ? 'sidebar--collapsed' : 'sidebar--expanded'}`} padding={false} elevation="medium">
        {/* Graph Switcher at Top */}
        <div className="sidebar-header">
          <WorkspaceSwitcher onAddWorkspace={() => setIsWorkspaceModalOpen(true)} />
        </div>

        {/* Main Navigation */}
        <div className="sidebar-content">
          <nav className="sidebar-nav">
            <Button 
              className="sidebar-nav-item"
              variant="ghost"
              size="sm"
              icon={mdiNotebookOutline}
              fullWidth
              active={mainViewType === 'journals'}
              onClick={() => setMainViewType('journals')}
            >
              Journal
            </Button>
            
            <Button 
              className="sidebar-nav-item"
              variant="ghost"
              size="sm"
              icon={mdiBookOpenPageVariant}
              fullWidth
              active={mainViewType === 'all-pages'}
              onClick={() => setMainViewType('all-pages')}
            >
              All Pages
            </Button>
            
            <Button 
              className="sidebar-nav-item"
              variant="ghost"
              size="sm"
              icon={mdiArchive}
              fullWidth
              active={mainViewType === 'archived'}
              onClick={() => setMainViewType('archived')}
            >
              Archived
            </Button>
            
            <Button 
              className="sidebar-nav-item"
              variant="ghost"
              size="sm"
              icon={mdiGraphOutline}
              fullWidth
              active={mainViewType === 'graph'}
              onClick={() => setMainViewType('graph')}
            >
              Graph View
            </Button>
            
            <Button 
              className="sidebar-nav-item"
              variant="ghost"
              size="sm"
              icon={mdiTimelineClockOutline}
              fullWidth
              active={mainViewType === 'timeline'}
              onClick={() => setMainViewType('timeline')}
            >
              Timeline View
            </Button>
          </nav>
          
          {/* Favorites Section */}
          <div className="sidebar-section">
            <button 
              className="sidebar-section-header"
              onClick={() => setFavoritesExpanded(!favoritesExpanded)}
            >
              {favoritesExpanded ? <ChevronDownIcon size="xs" /> : <ChevronRightIcon size="xs" />}
              <StarIcon size="xs" />
              <h3 className="sidebar-section-title">Favorites</h3>
            </button>
            {favoritesExpanded && (
              <div 
                ref={containerRef}
                className={`sidebar-favorites-list ${dragState ? 'dragging' : ''}`}
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
                      onNavigate={handleNavigateToPage}
                      onRemove={handleRemoveFavorite}
                      onContextMenu={handleFavoriteContextMenu}
                    />
                  ))
                )}
              </div>
            )}
          </div>
          
          {/* Recents Section */}
          <div className="sidebar-section">
            <button 
              className="sidebar-section-header"
              onClick={() => setRecentsExpanded(!recentsExpanded)}
            >
              {recentsExpanded ? <ChevronDownIcon size="xs" /> : <ChevronRightIcon size="xs" />}
              <ClockIcon size="xs" />
              <h3 className="sidebar-section-title">Recents</h3>
            </button>
            {recentsExpanded && (
              <nav className="sidebar-nav sidebar-recents-list">
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
                      onClick={() => handleNavigateToPage(recent.nodeId)}
                      onContextMenu={(e) => handleRecentContextMenu(recent.nodeId, e)}
                    />
                  ))
                )}
              </nav>
            )}
          </div>
          
        </div>
        
        {/* Footer - Trash & Settings */}
        <div className="sidebar-footer">
          <Button 
            className="sidebar-nav-item"
            variant="ghost"
            size="sm"
            icon={mdiTrashCanOutline}
            fullWidth
            onClick={() => setMainViewType('trash')}
            active={mainViewType === 'trash'}
            title="Trash"
          >
            Trash
          </Button>
          <Button 
            className="sidebar-nav-item"
            variant="ghost"
            size="sm"
            icon={mdiCog}
            fullWidth
            onClick={() => setIsSettingsModalOpen(true)}
            title="Settings"
          >
            Settings
          </Button>
        </div>
      </Card>

      {/* Modals */}
      <WorkspaceModal
        isOpen={isWorkspaceModalOpen}
        onClose={() => setIsWorkspaceModalOpen(false)}
      />
      <SettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
      />
      
      {/* Context Menu for favorites and recents */}
      {contextMenuNode && contextNode && (
        <PageContextMenu
          node={contextNode}
          position={contextMenuPos}
          onClose={handleCloseContextMenu}
        />
      )}
    </>
  );
}
