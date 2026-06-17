/**
 * Sidebar component with workspace switcher, navigation, favorites, and recents
 *
 * Features:
 * - Workspace switcher at top
 * - Journal, Inbox, Pages (hub), Whiteboards, Tasks navigation
 * - FAVORITES section with user-favorited pages (draggable for reordering)
 * - RECENTS section with recently accessed pages
 */
import { useState, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useNavigationStore } from '@/stores';
import type { MainViewType } from '@/stores';
import { useNode, useIsMobile, useNodeByUuid } from '@/hooks';

import { WorkspaceSwitcher, WorkspaceModal, useWorkspaceSettings, useEmptyTrash } from '@/features/workspace';
import { GraphSettingsModal, UserSettingsModal, SystemSettingsModal } from '@/features/layout/components/Modals';
import { AccountMenu } from '@/features/layout/components/AccountMenu';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { PageContextMenu } from '@/features/content/components/nodes/NodeContextMenu';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu';
import { ConfirmationModal } from '@/components/ui/ConfirmationModal';
import { useClickOutside } from '@/hooks/useClickOutside';
import { SidebarFavorites } from './SidebarFavorites';
import { SidebarRecents } from './SidebarRecents';
import { SupportBadge } from '@/features/support';
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

interface CollapsedSidebarViewProps {
  showJournals: boolean;
  showInbox: boolean;
  showWhiteboards: boolean;
  showTasks: boolean;
  inboxNode?: { id: number } | null;
  mainViewType: MainViewType;
  setMainViewType: (view: MainViewType) => void;
  openNode: (id: number) => void;
  openNodeInNewTab: (id: number) => void;
  closeMobileDrawer: () => void;
  onFavoriteContextMenu: (nodeId: number, e: React.MouseEvent) => void;
  onRecentContextMenu: (nodeId: number, e: React.MouseEvent) => void;
  onTrashContextMenu: (e: React.MouseEvent) => void;
  onOpenGraphSettings: () => void;
  onOpenUserSettings: () => void;
  onOpenSystemSettings: () => void;
  onOpenShares: () => void;
}

function SidebarPopup({
  isOpen,
  triggerRef,
  popupRef,
  children,
}: {
  isOpen: boolean;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  popupRef: React.RefObject<HTMLDivElement | null>;
  children: React.ReactNode;
}) {
  const rect = triggerRef.current?.getBoundingClientRect();
  const style: React.CSSProperties = rect
    ? { position: 'fixed', top: rect.top, left: rect.right + 8 }
    : { position: 'fixed' };

  if (!isOpen) return null;
  return createPortal(
    <Card
      ref={popupRef}
      className="sidebar-collapsed-popup"
      elevation="high"
      padding={false}
      style={style}
    >
      {children}
    </Card>,
    document.body
  );
}

function CollapsedSidebarView({
  showJournals,
  showInbox,
  showWhiteboards,
  showTasks,
  inboxNode,
  mainViewType,
  setMainViewType,
  openNode,
  openNodeInNewTab,
  closeMobileDrawer,
  onFavoriteContextMenu,
  onRecentContextMenu,
  onTrashContextMenu,
  onOpenGraphSettings,
  onOpenUserSettings,
  onOpenSystemSettings,
  onOpenShares,
}: CollapsedSidebarViewProps) {
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  const [recentsOpen, setRecentsOpen] = useState(false);
  const favoritesBtnRef = useRef<HTMLButtonElement>(null);
  const recentsBtnRef = useRef<HTMLButtonElement>(null);
  const favoritesPopupRef = useRef<HTMLDivElement>(null);
  const recentsPopupRef = useRef<HTMLDivElement>(null);

  useClickOutside(
    [favoritesBtnRef as React.RefObject<HTMLElement>, favoritesPopupRef as React.RefObject<HTMLElement>],
    () => setFavoritesOpen(false),
    favoritesOpen
  );
  useClickOutside(
    [recentsBtnRef as React.RefObject<HTMLElement>, recentsPopupRef as React.RefObject<HTMLElement>],
    () => setRecentsOpen(false),
    recentsOpen
  );

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

  const isPagesActive = mainViewType === 'pages' || mainViewType === 'all-pages' || mainViewType === 'graph' || mainViewType === 'timeline';

  const toggleFavorites = useCallback(() => {
    setFavoritesOpen((open) => !open);
    setRecentsOpen(false);
  }, []);

  const toggleRecents = useCallback(() => {
    setRecentsOpen((open) => !open);
    setFavoritesOpen(false);
  }, []);

  return (
    <div className="sidebar-collapsed">
      <div className="sidebar-collapsed__nav">
        {showJournals && (
          <Button
            className="sidebar-collapsed__btn"
            variant="ghost"
            size="md"
            icon="mdi mdi-notebook-outline"
            fullWidth
            active={mainViewType === 'journals'}
            onClick={() => {
              setMainViewType('journals');
              closeMobileDrawer();
            }}
            aria-label="Journal"
            title="Journal"
          />
        )}
        {showInbox && (
          <Button
            className="sidebar-collapsed__btn"
            variant="ghost"
            size="md"
            icon="mdi mdi-inbox-arrow-down"
            fullWidth
            disabled={!inboxNode}
            onClick={handleOpenInbox}
            aria-label="Inbox"
            title="Inbox"
          />
        )}
        <Button
          className="sidebar-collapsed__btn"
          variant="ghost"
          size="md"
          icon="mdi mdi-book-open-page-variant"
          fullWidth
          active={isPagesActive}
          onClick={() => {
            setMainViewType('pages');
            closeMobileDrawer();
          }}
          aria-label="Pages"
          title="Pages"
        />
        {showWhiteboards && (
          <Button
            className="sidebar-collapsed__btn"
            variant="ghost"
            size="md"
            icon="mdi mdi-view-dashboard-outline"
            fullWidth
            active={mainViewType === 'whiteboards'}
            onClick={() => {
              setMainViewType('whiteboards');
              closeMobileDrawer();
            }}
            aria-label="Whiteboards"
            title="Whiteboards"
          />
        )}
        {showTasks && (
          <Button
            className="sidebar-collapsed__btn"
            variant="ghost"
            size="md"
            icon="mdi mdi-checkbox-marked-circle-outline"
            fullWidth
            active={mainViewType === 'tasks'}
            onClick={() => {
              setMainViewType('tasks');
              closeMobileDrawer();
            }}
            aria-label="Tasks"
            title="Tasks"
          />
        )}
        <div className="sidebar-collapsed__divider" />
        <Button
          ref={favoritesBtnRef}
          className="sidebar-collapsed__btn"
          variant="ghost"
          size="md"
          icon="mdi mdi-star-outline"
          fullWidth
          active={favoritesOpen}
          onClick={toggleFavorites}
          aria-label="Favorites"
          title="Favorites"
        />
        <Button
          ref={recentsBtnRef}
          className="sidebar-collapsed__btn"
          variant="ghost"
          size="md"
          icon="mdi mdi-clock-outline"
          fullWidth
          active={recentsOpen}
          onClick={toggleRecents}
          aria-label="Recents"
          title="Recents"
        />
        <div className="sidebar-collapsed__divider" />
      </div>

      <div className="sidebar-collapsed__footer">
        <Button
          className="sidebar-collapsed__btn"
          variant="ghost"
          size="md"
          icon="mdi mdi-archive"
          fullWidth
          active={mainViewType === 'archived'}
          onClick={() => {
            setMainViewType('archived');
            closeMobileDrawer();
          }}
          aria-label="Archived"
          title="Archived"
        />
        <Button
          className="sidebar-collapsed__btn"
          variant="ghost"
          size="md"
          icon="mdi mdi-trash-can-outline"
          fullWidth
          active={mainViewType === 'trash'}
          onClick={() => {
            setMainViewType('trash');
            closeMobileDrawer();
          }}
          onContextMenu={onTrashContextMenu}
          aria-label="Trash"
          title="Trash"
        />
        <Button
          className="sidebar-collapsed__btn"
          variant="ghost"
          size="md"
          icon="mdi mdi-cog"
          fullWidth
          onClick={onOpenGraphSettings}
          aria-label="Settings"
          title="Settings"
        />
        <AccountMenu
          className="sidebar-collapsed__account"
          onOpenUserSettings={onOpenUserSettings}
          onOpenSystemSettings={onOpenSystemSettings}
          onOpenShares={onOpenShares}
          placement="top"
          align="left"
          renderTrigger={({ ref, onClick, isOpen, label }) => (
            <Button
              ref={ref}
              className="sidebar-collapsed__btn"
              variant="ghost"
              size="md"
              icon="mdi mdi-account"
              fullWidth
              active={isOpen}
              onClick={onClick}
              aria-label={label}
              title={label}
            />
          )}
        />
        <SupportBadge compact className="sidebar-collapsed__support" />
      </div>

      <SidebarPopup
        isOpen={favoritesOpen}
        triggerRef={favoritesBtnRef}
        popupRef={favoritesPopupRef}
      >
        <SidebarFavorites
          onContextMenu={onFavoriteContextMenu}
          onItemClick={() => setFavoritesOpen(false)}
        />
      </SidebarPopup>
      <SidebarPopup
        isOpen={recentsOpen}
        triggerRef={recentsBtnRef}
        popupRef={recentsPopupRef}
      >
        <SidebarRecents
          onContextMenu={onRecentContextMenu}
          onItemClick={() => setRecentsOpen(false)}
        />
      </SidebarPopup>
    </div>
  );
}

export function Sidebar({ collapsed }: SidebarProps) {
  const [isWorkspaceModalOpen, setIsWorkspaceModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [isUserSettingsOpen, setIsUserSettingsOpen] = useState(false);
  const [isSystemSettingsOpen, setIsSystemSettingsOpen] = useState(false);
  const [contextMenuNode, setContextMenuNode] = useState<number | null>(null);
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });
  const [trashContextMenuPos, setTrashContextMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [showEmptyTrashConfirm, setShowEmptyTrashConfirm] = useState(false);
  const [topExpanded, toggleTopExpanded] = useSidebarSectionState(SIDEBAR_TOP_EXPANDED_KEY, true);
  const [bottomExpanded, toggleBottomExpanded] = useSidebarSectionState(SIDEBAR_BOTTOM_EXPANDED_KEY, true);

  const {
    mainViewType,
    setMainViewType,
    openNode,
    openNodeInNewTab,
    isSidebarCollapsed,
    toggleSidebar,
  } = useNavigationStore();

  // Fetch workspace settings for sidebar visibility toggles
  const { data: workspaceSettings } = useWorkspaceSettings();

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

  const handleOpenShares = useCallback(() => {
    setMainViewType('shares');
    closeMobileDrawer();
  }, [setMainViewType, closeMobileDrawer]);

  const handleOpenGraphSettings = useCallback(() => {
    setIsSettingsModalOpen(true);
  }, []);

  const handleOpenUserSettings = useCallback(() => {
    setIsUserSettingsOpen(true);
  }, []);

  const handleOpenSystemSettings = useCallback(() => {
    setIsSystemSettingsOpen(true);
  }, []);

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

  const emptyTrashMutation = useEmptyTrash();

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
    { icon: "mdi mdi-archive", label: 'Archived', view: 'archived' as const },
    { icon: "mdi mdi-trash-can-outline", label: 'Trash', view: 'trash' as const, onContextMenu: handleTrashContextMenu },
  ], [handleTrashContextMenu]);

  return (
    <>
      <Card className={`sidebar ${collapsed ? 'sidebar--collapsed' : 'sidebar--expanded'}`} padding={false} elevation="medium">
        {collapsed ? (
          <CollapsedSidebarView
            showJournals={showJournals}
            showInbox={showInbox}
            showWhiteboards={showWhiteboards}
            showTasks={showTasks}
            inboxNode={inboxNode}
            mainViewType={mainViewType}
            setMainViewType={setMainViewType}
            openNode={openNode}
            openNodeInNewTab={openNodeInNewTab}
            closeMobileDrawer={closeMobileDrawer}
            onFavoriteContextMenu={handleFavoriteContextMenu}
            onRecentContextMenu={handleRecentContextMenu}
            onTrashContextMenu={handleTrashContextMenu}
            onOpenGraphSettings={handleOpenGraphSettings}
            onOpenUserSettings={handleOpenUserSettings}
            onOpenSystemSettings={handleOpenSystemSettings}
            onOpenShares={handleOpenShares}
          />
        ) : (
          <>
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
                      className="sidebar-footer__item"
                      variant="ghost"
                      size="md"
                      icon={item.icon}
                      fullWidth
                      active={item.view ? mainViewType === item.view : false}
                      onClick={() => {
                        if (item.view) {
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
                  <Button
                    className="sidebar-footer__item"
                    variant="ghost"
                    size="md"
                    icon="mdi mdi-cog"
                    fullWidth
                    onClick={handleOpenGraphSettings}
                    title="Settings"
                  >
                    Settings
                  </Button>
                  <AccountMenu
                    className="sidebar-footer__item sidebar-account"
                    onOpenUserSettings={handleOpenUserSettings}
                    onOpenSystemSettings={handleOpenSystemSettings}
                    onOpenShares={handleOpenShares}
                    placement="top"
                    align="left"
                    renderTrigger={({ ref, onClick, isOpen, label }) => (
                      <Button
                        ref={ref}
                        variant="ghost"
                        size="md"
                        icon="mdi mdi-account"
                        fullWidth
                        active={isOpen}
                        onClick={onClick}
                        title={label}
                      >
                        {label}
                      </Button>
                    )}
                  />
                </div>
              )}
            </div>

            <SupportBadge className="sidebar-support-badge" />
          </>
        )}
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
      <UserSettingsModal
        isOpen={isUserSettingsOpen}
        onClose={() => setIsUserSettingsOpen(false)}
      />
      <SystemSettingsModal
        isOpen={isSystemSettingsOpen}
        onClose={() => setIsSystemSettingsOpen(false)}
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
        onConfirm={() =>
          emptyTrashMutation.mutate(undefined, {
            onSuccess: () => setShowEmptyTrashConfirm(false),
          })
        }
        title="Empty Trash"
        message="This will permanently delete all items in the trash. This action cannot be undone."
        confirmLabel="Empty Trash"
        variant="danger"
      />
    </>
  );
}
