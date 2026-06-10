/**
 * Sidebar component with workspace switcher, navigation, favorites, and recents
 *
 * Features:
 * - Workspace switcher at top
 * - Journal, Inbox, Pages (hub), Whiteboards, Tasks navigation
 * - FAVORITES section with user-favorited pages (draggable for reordering)
 * - RECENTS section with recently accessed pages
 */
import { useState, useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigationStore } from '@/stores';
import type { MainViewType } from '@/stores';
import { useNode, useIsMobile, useNodeByUuid } from '@/hooks';

import { nodeKeys } from '@/hooks/useNodes';
import { workspaceSettingsKeys } from '@/hooks/queryKeys';
import { emptyTrash } from '@/api/nodes';
import { getWorkspaceSettings } from '@/features/workspace/api/workspaces';
import { WorkspaceSwitcher } from '@/features/workspace/components/WorkspaceSwitcher';
import { WorkspaceModal } from '@/features/workspace/components/WorkspaceModal';
import { GraphSettingsModal } from '../Modals';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { PageContextMenu } from '@/features/content/components/nodes/NodeContextMenu';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu';
import { ConfirmationModal } from '@/components/ui/ConfirmationModal';
import { SidebarFavorites } from './SidebarFavorites';
import { SidebarRecents } from './SidebarRecents';
import { ChevronDownIcon, ChevronRightIcon } from '@/components/ui/icons';
import { SYSTEM_PAGE_UUIDS } from '@/constants/systemProperties';
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
    openNode,
    openNodeInNewTab,
    isSidebarCollapsed,
    toggleSidebar,
  } = useNavigationStore();

  // Fetch workspace settings for sidebar visibility toggles
  const { data: workspaceSettings } = useQuery({
    queryKey: workspaceSettingsKeys.all,
    queryFn: getWorkspaceSettings,
    staleTime: 1000 * 60 * 5,
  });

  const showJournals = (workspaceSettings?.sidebar_show_journals as boolean | undefined) ?? true;
  const showInbox = (workspaceSettings?.sidebar_show_inbox as boolean | undefined) ?? true;
  const showWhiteboards = (workspaceSettings?.sidebar_show_whiteboards as boolean | undefined) ?? true;
  const showTasks = (workspaceSettings?.sidebar_show_tasks as boolean | undefined) ?? true;

  // Fetch the Inbox system page by its fixed UUID
  // Suppress global error: old workspaces may not have an Inbox page
  const { data: inboxNode } = useNodeByUuid(SYSTEM_PAGE_UUIDS.inbox, {
    meta: { skipGlobalError: true },
  });

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

  // Open the real Inbox system page
  const handleOpenInbox = useCallback((e?: React.MouseEvent) => {
    if (inboxNode?.id) {
      if (e?.ctrlKey || e?.metaKey) {
        openNodeInNewTab(inboxNode.id);
      } else {
        openNode(inboxNode.id);
      }
      closeMobileDrawer();
    }
  }, [inboxNode, openNode, openNodeInNewTab, closeMobileDrawer]);

  const emptyTrashMutation = useMutation({
    mutationFn: emptyTrash,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trash'] });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      queryClient.invalidateQueries({ queryKey: ['nodes', 'linked-refs'], refetchType: 'active' });
      queryClient.invalidateQueries({ queryKey: ['nodes', 'property-backlinks'], refetchType: 'active' });
      queryClient.invalidateQueries({ queryKey: ['nodes', 'backlinks'], refetchType: 'active' });
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

  const topNavItems = useMemo(() => {
    const items: Array<{ icon: string; label: string; view?: string; action?: () => void }> = [
      { icon: "mdi mdi-book-open-page-variant", label: 'Pages', view: 'pages' as const },
    ];
    if (showWhiteboards) {
      items.push({ icon: "mdi mdi-view-dashboard-outline", label: 'Whiteboards', view: 'whiteboards' as const });
    }
    if (showTasks) {
      items.push({ icon: "mdi mdi-checkbox-marked-circle-outline", label: 'Tasks', view: 'tasks' as const });
    }
    return items;
  }, [showWhiteboards, showTasks]);

  const bottomNavItems = useMemo(() => [
    { icon: "mdi mdi-share-variant", label: 'Shares', view: 'shares' as const },
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
              {showJournals && (
                <Button
                  variant="ghost"
                  size="md"
                  icon="mdi mdi-notebook-outline"
                  fullWidth
                  active={mainViewType === 'journals'}
                  onClick={() => {
                    setMainViewType('journals');
                    closeMobileDrawer();
                  }}
                  title="Journal"
                >
                  Journal
                </Button>
              )}
              {showInbox && (
                <Button
                  variant="ghost"
                  size="md"
                  icon="mdi mdi-inbox-arrow-down"
                  fullWidth
                  disabled={!inboxNode}
                  onClick={handleOpenInbox}
                  title="Inbox"
                >
                  Inbox
                </Button>
              )}
              {topNavItems.map((item) => {
                const isPagesItem = item.view === 'pages';
                const isActive = isPagesItem
                  ? mainViewType === 'pages' || mainViewType === 'all-pages' || mainViewType === 'graph' || mainViewType === 'timeline'
                  : item.view ? mainViewType === item.view : false;
                return (
                  <Button
                    key={item.view ?? item.label}
                    variant="ghost"
                    size="md"
                    icon={item.icon}
                    fullWidth
                    active={isActive}
                    onClick={() => {
                      if (item.action) {
                        item.action();
                      } else if (item.view) {
                        setMainViewType(item.view as MainViewType);
                      }
                      closeMobileDrawer();
                    }}
                    title={item.label}
                  >
                    {item.label}
                  </Button>
                );
              })}
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
                      setMainViewType(item.view as MainViewType);
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
