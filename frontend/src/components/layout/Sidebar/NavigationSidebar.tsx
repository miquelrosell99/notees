/**
 * Sidebar component with graph switcher, navigation, favorites, and recents
 *
 * Matches the UI shown in screenshots with:
 * - Graph switcher at top
 * - Journal, All Pages, Graph View navigation
 * - FAVORITES section with user-favorited pages (draggable for reordering)
 * - RECENTS section with recently accessed pages
 */
import { useState, useCallback, useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigationStore } from '@/stores';
import { useNode, useIsMobile } from '@/hooks';
import {
  buildTasksQueryAST,
  buildTodayQueryAST,
  buildUpcomingQueryAST,
} from '@/utils/taskQueries';
import { nodeKeys } from '@/hooks/useNodes';
import { emptyTrash } from '@/api/nodes';
import { WorkspaceSwitcher } from '@/components/workspace/WorkspaceSwitcher';
import { WorkspaceModal } from '@/components/workspace/WorkspaceModal';
import { GraphSettingsModal } from '../Modals';
import { Card } from '@/components/core/Card';
import { Button } from '@/components/core/Button';
import { PageContextMenu } from '@/components/nodes/NodeContextMenu';
import { ContextMenu, type ContextMenuItem } from '@/components/core/ContextMenu';
import { ConfirmationModal } from '@/components/core/ConfirmationModal';
import { SidebarFavorites } from './SidebarFavorites';
import { SidebarRecents } from './SidebarRecents';
import { ChevronDownIcon, ChevronRightIcon } from '@/components/core/icons';
import './NavigationSidebar.css';

interface SidebarProps {
  collapsed: boolean;
}

const SIDEBAR_TOP_EXPANDED_KEY = 'notees:sidebar-top-expanded';
const SIDEBAR_BOTTOM_EXPANDED_KEY = 'notees:sidebar-bottom-expanded';

function useSidebarSectionState(key: string, defaultValue: boolean = true) {
  const [expanded, setExpanded] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored !== null ? JSON.parse(stored) : defaultValue;
    } catch {
      return defaultValue;
    }
  });

  const toggle = useCallback(() => {
    setExpanded((prev: boolean) => {
      const next = !prev;
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Ignore localStorage errors
      }
      return next;
    });
  }, [key]);

  return [expanded, toggle] as const;
}

export function Sidebar({ collapsed }: SidebarProps) {
  const [isWorkspaceModalOpen, setIsWorkspaceModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [contextMenuNode, setContextMenuNode] = useState<number | null>(null);
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });
  const [trashContextMenuPos, setTrashContextMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [showEmptyTrashConfirm, setShowEmptyTrashConfirm] = useState(false);
  const [topExpanded, toggleTopExpanded] = useSidebarSectionState(SIDEBAR_TOP_EXPANDED_KEY, true);
  const [bottomExpanded, toggleBottomExpanded] = useSidebarSectionState(SIDEBAR_BOTTOM_EXPANDED_KEY, true);
  const queryClient = useQueryClient();

  const {
    mainViewType,
    setMainViewType,
    openNodeCollection,
    isSidebarCollapsed,
    toggleSidebar,
  } = useNavigationStore();

  // Fetch the context menu node data
  const { data: contextNode } = useNode(contextMenuNode);

  const isMobile = useIsMobile();

  // Close the sidebar drawer on mobile (no-op on desktop where sidebar is always visible)
  const closeMobileDrawer = useCallback(() => {
    if (isMobile && !isSidebarCollapsed) toggleSidebar();
  }, [isMobile, isSidebarCollapsed, toggleSidebar]);

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

  // Trash context menu
  const handleTrashContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setTrashContextMenuPos({ x: e.clientX, y: e.clientY });
  }, []);

  const emptyTrashMutation = useMutation({
    mutationFn: emptyTrash,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trash'] });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      setShowEmptyTrashConfirm(false);
    },
  });

  const trashContextMenuItems: ContextMenuItem[] = useMemo(() => [
    {
      id: 'empty-trash',
      label: 'Empty Trash',
      icon: "mdi mdi-trash-can-outline",
      danger: true,
      onClick: () => {
        setTrashContextMenuPos(null);
        setShowEmptyTrashConfirm(true);
      },
    },
  ], []);

  const topNavItems = useMemo(() => [
    { icon: "mdi mdi-notebook-outline", label: 'Journal', view: 'journals' as const },
    { icon: "mdi mdi-book-open-page-variant", label: 'All Pages', view: 'all-pages' as const },
    { icon: "mdi mdi-graph-outline", label: 'Graph View', view: 'graph' as const },
    { icon: "mdi mdi-timeline-clock-outline", label: 'Timeline View', view: 'timeline' as const },
    { icon: "mdi mdi-inbox-arrow-down", label: 'Inbox', view: 'inbox' as const },
    { icon: "mdi mdi-checkbox-marked-circle-outline", label: 'Tasks', action: () => { openNodeCollection('Tasks', buildTasksQueryAST()); } },
    { icon: "mdi mdi-calendar-today", label: 'Today', action: () => { openNodeCollection('Today', buildTodayQueryAST()); } },
    { icon: "mdi mdi-calendar-arrow-right", label: 'Upcoming', action: () => { openNodeCollection('Upcoming', buildUpcomingQueryAST()); } },
  ], [openNodeCollection]);

  const bottomNavItems = useMemo(() => [
    { icon: "mdi mdi-archive", label: 'Archived', view: 'archived' as const },
    { icon: "mdi mdi-trash-can-outline", label: 'Trash', view: 'trash' as const, onContextMenu: handleTrashContextMenu },
    { icon: "mdi mdi-cog", label: 'Settings', action: () => setIsSettingsModalOpen(true) },
  ], [handleTrashContextMenu]);

  return (
    <>
      <Card className={`sidebar ${collapsed ? 'sidebar--collapsed' : 'sidebar--expanded'}`} padding={false} elevation="medium">
        {/* Graph Switcher at Top */}
        <div className="sidebar-header">
          <WorkspaceSwitcher />
        </div>

        {/* Top Navigation - Collapsible, not scrollable */}
        <div className="sidebar-nav-section">
          <button
            className="sidebar-section-header"
            onClick={toggleTopExpanded}
            title={topExpanded ? 'Collapse navigation' : 'Expand navigation'}
          >
            {topExpanded ? <ChevronDownIcon size="xs" /> : <ChevronRightIcon size="xs" />}
            <h3 className="sidebar-section-title">Navigation</h3>
          </button>
          {topExpanded && (
            <nav className="sidebar-nav">
              {topNavItems.map((item) => (
                <Button
                  key={item.view ?? item.label}
                  variant="ghost"
                  size="md"
                  icon={item.icon}
                  fullWidth
                  active={item.view ? mainViewType === item.view : false}
                  onClick={() => {
                    if (item.action) {
                      item.action();
                    } else if (item.view) {
                      setMainViewType(item.view);
                    }
                    closeMobileDrawer();
                  }}
                  title={item.label}
                >
                  {item.label}
                </Button>
              ))}
            </nav>
          )}
        </div>

        {/* Scrollable middle content - only favorites and recents */}
        <div className="sidebar-content">
          {/* Favorites Section */}
          <SidebarFavorites onContextMenu={handleFavoriteContextMenu} />

          {/* Recents Section */}
          <SidebarRecents onContextMenu={handleRecentContextMenu} />
        </div>

        {/* Bottom Footer - Collapsible, not scrollable */}
        <div className="sidebar-footer-section">
          <button
            className="sidebar-section-header"
            onClick={toggleBottomExpanded}
            title={bottomExpanded ? 'Collapse tools' : 'Expand tools'}
          >
            {bottomExpanded ? <ChevronDownIcon size="xs" /> : <ChevronRightIcon size="xs" />}
            <h3 className="sidebar-section-title">More</h3>
          </button>
          {bottomExpanded && (
            <div className="sidebar-footer">
              {bottomNavItems.map((item) => (
                <Button
                  key={item.label}
                  variant="ghost"
                  size="md"
                  icon={item.icon}
                  fullWidth
                  active={item.view ? mainViewType === item.view : false}
                  onClick={() => {
                    if (item.action) {
                      item.action();
                    } else if (item.view) {
                      setMainViewType(item.view);
                    }
                    closeMobileDrawer();
                  }}
                  onContextMenu={item.onContextMenu}
                  title={item.label}
                >
                  {item.label}
                </Button>
              ))}
            </div>
          )}
        </div>
      </Card>

      {/* Modals */}
      <WorkspaceModal
        isOpen={isWorkspaceModalOpen}
        onClose={() => setIsWorkspaceModalOpen(false)}
      />
      <GraphSettingsModal
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

      {/* Trash context menu */}
      {trashContextMenuPos && (
        <ContextMenu
          items={trashContextMenuItems}
          position={trashContextMenuPos}
          onClose={() => setTrashContextMenuPos(null)}
        />
      )}

      {/* Empty trash confirmation */}
      <ConfirmationModal
        isOpen={showEmptyTrashConfirm}
        onCancel={() => setShowEmptyTrashConfirm(false)}
        onConfirm={() => emptyTrashMutation.mutate()}
        title="Empty Trash"
        message="This will permanently delete all items in the trash. This action cannot be undone."
        confirmLabel="Empty Trash"
        variant="danger"
      />
    </>
  );
}
