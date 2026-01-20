/**
 * Sidebar component with database switcher, navigation, favorites, and recents
 * 
 * Matches the UI shown in screenshots with:
 * - Database switcher at top
 * - Journal, All Pages, Graph View navigation
 * - FAVORITES section with user-favorited pages (draggable for reordering)
 * - RECENTS section with recently accessed pages
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { useNodesStore, useFavoritesStore } from '@/stores';
import { useNode } from '@/hooks';
import { DatabaseSwitcher } from './DatabaseSwitcher';
import { DatabaseModal } from './DatabaseModal';
import { SettingsModal } from './SettingsModal';
import { Block } from './Block';
import { Card } from './core/Card';
import { ContextMenu } from './core/ContextMenu';
import { 
  JournalIcon, 
  AllPagesIcon, 
  GraphIcon,
  SettingsIcon,
  StarIcon,
  ClockIcon,
  PageIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from './icons';
import './Sidebar.css';

interface SidebarProps {
  collapsed: boolean;
}

interface FavoriteItemProps {
  nodeId: number;
  name: string;
  icon?: string | null;
  isActive: boolean;
  onClick: () => void;
  onRemove: () => void;
  onDragStart: (e: React.DragEvent, index: number) => void;
  onDragOver: (e: React.DragEvent, index: number) => void;
  onDragEnd: () => void;
  index: number;
  isDragOver: boolean;
}

function FavoriteItem({ 
  nodeId,
  name, 
  icon, 
  isActive, 
  onClick, 
  onRemove,
  onDragStart,
  onDragOver,
  onDragEnd,
  index,
  isDragOver,
}: FavoriteItemProps) {
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });
  const contextMenuRef = useRef<HTMLDivElement>(null);
  
  // Fetch the node directly using useNode for real-time updates
  const { data: node } = useNode(nodeId);
  
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenuPos({ x: e.clientX, y: e.clientY });
    setShowContextMenu(true);
  };
  
  useEffect(() => {
    if (!showContextMenu) return;
    
    const handleClickOutside = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setShowContextMenu(false);
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showContextMenu]);
  
  // If node data is available, render using Block like RecentItem
  if (node) {
    return (
      <>
        <div 
          className={`sidebar-favorite-item ${isActive ? 'active' : ''} ${isDragOver ? 'drag-over' : ''}`}
          onClick={onClick}
          onContextMenu={handleContextMenu}
          draggable
          onDragStart={(e) => onDragStart(e, index)}
          onDragOver={(e) => onDragOver(e, index)}
          onDragEnd={onDragEnd}
        >
          <Block
            block={node}
            parentId={null}
            onContentChange={() => {}}
            readOnly={true}
          />
        </div>
        
        {showContextMenu && (
          <ContextMenu
            items={[
              {
                id: 'remove-favorite',
                label: 'Remove from Favorites',
                icon: undefined,
                onClick: () => {
                  onRemove();
                  setShowContextMenu(false);
                },
              }
            ]}
            position={contextMenuPos}
            onClose={() => setShowContextMenu(false)}
          />
        )}
      </>
    );
  }
  
  // Fallback to simple rendering if node data not yet loaded
  
  return (
    <>
      <button
        className={`sidebar-nav-item sidebar-favorite-item ${isActive ? 'active' : ''} ${isDragOver ? 'drag-over' : ''}`}
        onClick={onClick}
        onContextMenu={handleContextMenu}
        draggable
        onDragStart={(e) => onDragStart(e, index)}
        onDragOver={(e) => onDragOver(e, index)}
        onDragEnd={onDragEnd}
      >
        {icon ? (
          <span className="sidebar-item-icon">{icon}</span>
        ) : (
          <PageIcon size="sm" />
        )}
        <span>{name || 'Untitled'}</span>
      </button>
      
      {showContextMenu && (
        <ContextMenu
          items={[
            {
              id: 'remove-favorite',
              label: 'Remove from Favorites',
              icon: undefined,
              onClick: () => {
                onRemove();
                setShowContextMenu(false);
              },
            }
          ]}
          position={contextMenuPos}
          onClose={() => setShowContextMenu(false)}
        />
      )}
    </>
  );
}

interface RecentItemProps {
  nodeId: number;
  isActive: boolean;
  onClick: () => void;
}

function RecentItem({ nodeId, isActive, onClick }: RecentItemProps) {
  // Fetch the node directly using useNode for real-time updates
  const { data: node } = useNode(nodeId);
  
  // Don't render if node not yet loaded
  if (!node) return null;
  
  return (
    <div 
      className={`sidebar-recent-item ${isActive ? 'active' : ''}`}
      onClick={onClick}
    >
      <Block
        block={node}
        parentId={null}
        onContentChange={() => {}}
        readOnly={true}
      />
    </div>
  );
}

export function Sidebar({ collapsed }: SidebarProps) {
  const [isDatabaseModalOpen, setIsDatabaseModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [favoritesExpanded, setFavoritesExpanded] = useState(true);
  const [recentsExpanded, setRecentsExpanded] = useState(true);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragIndexRef = useRef<number | null>(null);
  
  const { 
    mainViewType,
    setMainViewType,
    openNode,
    currentNodeId,
  } = useNodesStore();
  
  // Use individual selectors for data to ensure proper reactivity
  const favorites = useFavoritesStore((state) => state.favorites);
  const recents = useFavoritesStore((state) => state.recents);
  
  // Use callbacks that access store via getState() for stability
  const handleRemoveFavorite = useCallback((nodeId: number) => {
    useFavoritesStore.getState().removeFavorite(nodeId);
  }, []);
  
  const handleReorderFavorites = useCallback((fromIndex: number, toIndex: number) => {
    useFavoritesStore.getState().reorderFavorites(fromIndex, toIndex);
  }, []);
  
  // Handle drag start
  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    dragIndexRef.current = index;
    e.dataTransfer.effectAllowed = 'move';
  }, []);
  
  // Handle drag over
  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
  }, []);
  
  // Handle drag end
  const handleDragEnd = useCallback(() => {
    if (dragIndexRef.current !== null && dragOverIndex !== null && dragIndexRef.current !== dragOverIndex) {
      handleReorderFavorites(dragIndexRef.current, dragOverIndex);
    }
    dragIndexRef.current = null;
    setDragOverIndex(null);
  }, [dragOverIndex, handleReorderFavorites]);
  
  // Handle navigating to a page
  const handleNavigateToPage = useCallback((nodeId: number) => {
    openNode(nodeId, 'page');
  }, [openNode]);

  return (
    <>
      <Card className={`sidebar ${collapsed ? 'sidebar--collapsed' : 'sidebar--expanded'}`} padding={false} elevation="medium">
        {/* Database Switcher at Top */}
        <div className="sidebar-header">
          <DatabaseSwitcher onAddDatabase={() => setIsDatabaseModalOpen(true)} />
        </div>

        {/* Main Navigation */}
        <div className="sidebar-content">
          <nav className="sidebar-nav">
            <button 
              className={`sidebar-nav-item ${mainViewType === 'journals' ? 'active' : ''}`}
              onClick={() => setMainViewType('journals')}
            >
              <JournalIcon size="sm" />
              <span>Journal</span>
            </button>
            
            <button 
              className={`sidebar-nav-item ${mainViewType === 'all-pages' ? 'active' : ''}`}
              onClick={() => setMainViewType('all-pages')}
            >
              <AllPagesIcon size="sm" />
              <span>All Pages</span>
            </button>
            
            <button 
              className={`sidebar-nav-item ${mainViewType === 'graph' ? 'active' : ''}`}
              onClick={() => setMainViewType('graph')}
            >
              <GraphIcon size="sm" />
              <span>Graph View</span>
            </button>
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
              <nav className="sidebar-nav sidebar-favorites-list">
                {favorites.length === 0 ? (
                  <div className="sidebar-empty-message">
                    No favorites yet. Right-click a page header to add.
                  </div>
                ) : (
                  favorites.map((fav, index) => (
                    <FavoriteItem
                      key={fav.nodeId}
                      nodeId={fav.nodeId}
                      name=""
                      icon={null}
                      isActive={currentNodeId === fav.nodeId && mainViewType === 'node'}
                      onClick={() => handleNavigateToPage(fav.nodeId)}
                      onRemove={() => handleRemoveFavorite(fav.nodeId)}
                      onDragStart={handleDragStart}
                      onDragOver={handleDragOver}
                      onDragEnd={handleDragEnd}
                      index={index}
                      isDragOver={dragOverIndex === index}
                    />
                  ))
                )}
              </nav>
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
                    />
                  ))
                )}
              </nav>
            )}
          </div>
          
        </div>
        
        {/* Footer - Settings */}
        <div className="sidebar-footer">
          <button 
            className="sidebar-settings-btn"
            onClick={() => setIsSettingsModalOpen(true)}
            title="Settings"
          >
            <SettingsIcon size="sm" />
            <span>Settings</span>
          </button>
        </div>
      </Card>

      {/* Modals */}
      <DatabaseModal
        isOpen={isDatabaseModalOpen}
        onClose={() => setIsDatabaseModalOpen(false)}
      />
      <SettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
      />
    </>
  );
}
