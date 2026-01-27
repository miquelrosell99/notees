/**
 * Sidebar component with database switcher, navigation, favorites, and recents
 * 
 * Matches the UI shown in screenshots with:
 * - Database switcher at top
 * - Journal, All Pages, Graph View navigation
 * - FAVORITES section with user-favorited pages (draggable for reordering)
 * - RECENTS section with recently accessed pages
 */
import { useState, useCallback, useMemo } from 'react';
import { useNodesStore, useFavoritesStore } from '@/stores';
import { useNode } from '@/hooks';
import { mdiClose, mdiNotebookOutline, mdiBookOpenPageVariant, mdiGraphOutline, mdiTimelineClockOutline, mdiCog } from '@mdi/js';
import { DatabaseSwitcher } from '../databases/DatabaseSwitcher';
import { DatabaseModal } from '../databases/DatabaseModal';
import { SettingsModal } from '../SettingsModal';
import { Card } from '../core/Card';
import { Button } from '../core/Button';
import { ListSortable } from '../core/ListSortable';
import { Bullet } from '../blocks/Bullet';
import { BlockPreview } from '../blocks/BlockPreview';
import { 
  StarIcon,
  ClockIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from '../icons';
import './NavigationSidebar.css';

interface SidebarProps {
  collapsed: boolean;
}

// Helper to get node name for display
function getNodeDisplayName(node: { name?: string | null } | undefined): string {
  return node?.name || 'Untitled';
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
    <BlockPreview
      node={node}
      showBullet={true}
      onClick={onClick}
      className={`sidebar-recent-item ${isActive ? 'active' : ''}`}
      suppressColor={true}
    />
  );
}

// Wrapper to provide node data to ListSortable render functions
interface FavoriteListItem {
  id: number;
  nodeId: number;
}

// Component to render favorite item icon (needs to fetch node data)
function FavoriteItemIcon({ nodeId }: { nodeId: number }) {
  const { data: node } = useNode(nodeId);
  return (
    <Bullet
      nodeId={nodeId}
      icon={node?.icon}
      isPage={node?.is_page}
      interactive={false}
      size="sm"
    />
  );
}

// Component to render favorite item text (needs to fetch node data)
function FavoriteItemText({ nodeId }: { nodeId: number }) {
  const { data: node } = useNode(nodeId);
  return <span className="sidebar-item-name">{getNodeDisplayName(node)}</span>;
}

export function Sidebar({ collapsed }: SidebarProps) {
  const [isDatabaseModalOpen, setIsDatabaseModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [favoritesExpanded, setFavoritesExpanded] = useState(true);
  const [recentsExpanded, setRecentsExpanded] = useState(true);
  
  const { 
    mainViewType,
    setMainViewType,
    openNode,
    currentNodeId,
  } = useNodesStore();
  
  // Use individual selectors for data to ensure proper reactivity
  const favorites = useFavoritesStore((state) => state.favorites);
  const recents = useFavoritesStore((state) => state.recents);
  
  // Convert favorites to ListSortable format
  const favoriteItems = useMemo<FavoriteListItem[]>(() => 
    favorites.map(fav => ({ id: fav.nodeId, nodeId: fav.nodeId })),
    [favorites]
  );
  
  // Use callbacks that access store via getState() for stability
  const handleRemoveFavorite = useCallback((nodeId: number) => {
    useFavoritesStore.getState().removeFavorite(nodeId);
  }, []);
  
  const handleReorderFavorites = useCallback((fromIndex: number, toIndex: number) => {
    useFavoritesStore.getState().reorderFavorites(fromIndex, toIndex);
  }, []);
  
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
            <Button 
              className={`sidebar-nav-item ${mainViewType === 'journals' ? 'active' : ''}`}
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
              className={`sidebar-nav-item ${mainViewType === 'all-pages' ? 'active' : ''}`}
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
              className={`sidebar-nav-item ${mainViewType === 'graph' ? 'active' : ''}`}
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
              className={`sidebar-nav-item ${mainViewType === 'timeline' ? 'active' : ''}`}
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
              <div className="sidebar-favorites-list">
                {favoriteItems.length === 0 ? (
                  <div className="sidebar-empty-message">
                    No favorites yet. Right-click a page header to add.
                  </div>
                ) : (
                  <ListSortable
                    items={favoriteItems}
                    onReorder={handleReorderFavorites}
                    onItemClick={(item) => handleNavigateToPage(item.nodeId)}
                    showDragHandle={true}
                    itemClassName={`sidebar-favorite-item ${mainViewType === 'node' ? 'sidebar-favorite-item--check-active' : ''}`}
                    renderIcon={(item) => <FavoriteItemIcon nodeId={item.nodeId} />}
                    renderText={(item) => <FavoriteItemText nodeId={item.nodeId} />}
                    renderAction={(item) => (
                      <Button
                        icon={mdiClose}
                        size="xs"
                        variant="ghost"
                        className="sidebar-favorite-remove"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemoveFavorite(item.nodeId);
                        }}
                        title="Remove from favorites"
                      />
                    )}
                  />
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
                    />
                  ))
                )}
              </nav>
            )}
          </div>
          
        </div>
        
        {/* Footer - Settings */}
        <div className="sidebar-footer">
          <Button 
            className="sidebar-settings-btn"
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
