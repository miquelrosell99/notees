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
import { useNavigationStore, useModalStore } from '@/stores';
import { useNode, useIsMobile } from '@/hooks';
import { nodeKeys } from '@/hooks/useNodes';
import { emptyTrash } from '@/api/nodes';
import { WorkspaceSwitcher } from '@/components/workspace/WorkspaceSwitcher';
import { WorkspaceModal } from '@/components/workspace/WorkspaceModal';
import { GraphSettingsModal } from '../GraphSettingsModal';
import { Card } from '@/components/core/Card';
import { Button } from '@/components/core/Button';
import { PageContextMenu } from '@/components/nodes/NodeContextMenu';
import { ContextMenu, type ContextMenuItem } from '@/components/core/ContextMenu';
import { ConfirmationModal } from '@/components/core/ConfirmationModal';
import { SidebarFavorites } from './SidebarFavorites';
import { SidebarRecents } from './SidebarRecents';
import './NavigationSidebar.css';

interface SidebarProps {
  collapsed: boolean;
}

export function Sidebar({ collapsed }: SidebarProps) {
  const [isWorkspaceModalOpen, setIsWorkspaceModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [contextMenuNode, setContextMenuNode] = useState<number | null>(null);
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });
  const [trashContextMenuPos, setTrashContextMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [showEmptyTrashConfirm, setShowEmptyTrashConfirm] = useState(false);
  const queryClient = useQueryClient();

  const {
    mainViewType,
    setMainViewType,
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
              variant="ghost"
              size="md"
              icon={"mdi mdi-magnify"}
              fullWidth
              onClick={() => {
                useModalStore.getState().setCommandPaletteOpen(true);
                closeMobileDrawer();
              }}
            >
              Search
            </Button>

            <Button
              variant="ghost"
              size="md"
              icon={"mdi mdi-notebook-outline"}
              fullWidth
              active={mainViewType === 'journals'}
              onClick={() => { setMainViewType('journals'); closeMobileDrawer(); }}
            >
              Journal
            </Button>

            <Button
              variant="ghost"
              size="md"
              icon={"mdi mdi-book-open-page-variant"}
              fullWidth
              active={mainViewType === 'all-pages'}
              onClick={() => { setMainViewType('all-pages'); closeMobileDrawer(); }}
            >
              All Pages
            </Button>

            <Button
              variant="ghost"
              size="md"
              icon={"mdi mdi-graph-outline"}
              fullWidth
              active={mainViewType === 'graph'}
              onClick={() => { setMainViewType('graph'); closeMobileDrawer(); }}
            >
              Graph View
            </Button>

            <Button
              variant="ghost"
              size="md"
              icon={"mdi mdi-timeline-clock-outline"}
              fullWidth
              active={mainViewType === 'timeline'}
              onClick={() => { setMainViewType('timeline'); closeMobileDrawer(); }}
            >
              Timeline View
            </Button>
          </nav>

          {/* Favorites Section */}
          <SidebarFavorites onContextMenu={handleFavoriteContextMenu} />

          {/* Recents Section */}
          <SidebarRecents onContextMenu={handleRecentContextMenu} />

        </div>

        {/* Footer - Archived, Trash, Settings & Account */}
        <div className="sidebar-footer">
          <Button
            variant="ghost"
            size="md"
            icon={"mdi mdi-archive"}
            fullWidth
            onClick={() => { setMainViewType('archived'); closeMobileDrawer(); }}
            active={mainViewType === 'archived'}
            title="Archived"
          >
            Archived
          </Button>
          <Button
            variant="ghost"
            size="md"
            icon={"mdi mdi-trash-can-outline"}
            fullWidth
            onClick={() => { setMainViewType('trash'); closeMobileDrawer(); }}
            onContextMenu={handleTrashContextMenu}
            active={mainViewType === 'trash'}
            title="Trash"
          >
            Trash
          </Button>
          <Button
            variant="ghost"
            size="md"
            icon={"mdi mdi-cog"}
            fullWidth
            onClick={() => { setIsSettingsModalOpen(true); closeMobileDrawer(); }}
            title="Graph Settings"
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
