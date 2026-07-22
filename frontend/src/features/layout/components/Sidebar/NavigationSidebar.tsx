/**
 * Sidebar components with workspace switcher, navigation, favorites, and recents
 *
 * Desktop layout uses two adjacent panels:
 * - `<SidebarRail />`: persistent icon rail on the far left.
 * - `<Sidebar />`: collapsible content panel with workspace switcher, favorites, recents.
 *
 * Mobile layout renders `<Sidebar collapsed={false} />` inside a full-width drawer
 * (no rail). The drawer's sidebar reuses the rail's bottom tools so archived,
 * trash, settings, and account remain reachable.
 */
import { useState, useCallback, useMemo } from 'react';
import { useNavigationStore } from '@/stores';
import { useShallow } from 'zustand/react/shallow';

import { useIsMobile } from '@/hooks';
import { useNodeByUuid, useDailyNote } from '@/features/content';

import { WorkspaceSwitcher, useWorkspaceSettings, useEmptyTrash } from '@/features/workspace';
import { GraphSettingsModal, UserSettingsModal, SystemSettingsModal } from '@/features/layout/components/Modals';
import { AccountMenu } from '@/features/layout/components/AccountMenu';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { PageContextMenu } from '@/features/content';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu';
import { ConfirmationModal } from '@/components/ui/ConfirmationModal';
import { SidebarFavorites } from './SidebarFavorites';
import { SidebarRecents } from './SidebarRecents';
import { SidebarPinnedPages } from './SidebarPinnedPages';
import { SupportBadge } from '@/features/support';
import { SYSTEM_PAGE_UUIDS } from '@/constants/systemProperties';
import './NavigationSidebar.css';

interface SidebarProps {
  collapsed?: boolean;
}

/* ================================================================
   SidebarTools — bottom tool group shared between rail and mobile drawer
   ================================================================ */

interface SidebarToolsProps {
  layout: 'rail' | 'footer';
}

function SidebarTools({ layout }: SidebarToolsProps) {
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [isUserSettingsOpen, setIsUserSettingsOpen] = useState(false);
  const [isSystemSettingsOpen, setIsSystemSettingsOpen] = useState(false);
  const [trashContextMenuPos, setTrashContextMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [showEmptyTrashConfirm, setShowEmptyTrashConfirm] = useState(false);

  const { mainViewType, setMainViewType } = useNavigationStore(
    useShallow((s) => ({
      mainViewType: s.mainViewType,
      setMainViewType: s.setMainViewType,
    }))
  );

  const { data: workspaceSettings } = useWorkspaceSettings();
  const hasActiveWorkspace = !!workspaceSettings;

  const isRail = layout === 'rail';
  const itemClass = isRail ? 'sidebar-rail__btn' : 'sidebar-footer__item';

  const handleTrashContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setTrashContextMenuPos({ x: e.clientX, y: e.clientY });
  }, []);

  const emptyTrashMutation = useEmptyTrash();

  const trashContextMenuItems: ContextMenuItem[] = useMemo(() => [
    {
      id: 'empty-trash',
      label: 'Empty Trash',
      icon: 'mdi mdi-trash-can-outline',
      danger: true,
      onClick: () => {
        setTrashContextMenuPos(null);
        setShowEmptyTrashConfirm(true);
      },
    },
  ], []);

  return (
    <>
      <div className={isRail ? 'sidebar-rail__bottom' : 'sidebar-footer'}>
        <Button
          className={itemClass}
          variant="ghost"
          size={isRail ? 'md' : 'sm'}
          icon="mdi mdi-archive"
          fullWidth
          active={mainViewType === 'archived'}
          onClick={() => setMainViewType('archived')}
          aria-label="Archived"
          title="Archived"
        >
          {!isRail && 'Archived'}
        </Button>
        <Button
          className={itemClass}
          variant="ghost"
          size={isRail ? 'md' : 'sm'}
          icon="mdi mdi-trash-can-outline"
          fullWidth
          active={mainViewType === 'trash'}
          onClick={() => setMainViewType('trash')}
          onContextMenu={handleTrashContextMenu}
          aria-label="Trash"
          title="Trash"
        >
          {!isRail && 'Trash'}
        </Button>
        <AccountMenu
          className={isRail ? 'sidebar-rail__account' : 'sidebar-footer__item sidebar-account'}
          onOpenUserSettings={() => setIsUserSettingsOpen(true)}
          onOpenSystemSettings={() => setIsSystemSettingsOpen(true)}
          onOpenSettings={hasActiveWorkspace ? () => setIsSettingsModalOpen(true) : undefined}
          onOpenShares={() => setMainViewType('shares')}
          placement="top"
          align="left"
          renderTrigger={({ ref, onClick, isOpen, label }) => (
            <Button
              ref={ref}
              className={itemClass}
              variant="ghost"
              size={isRail ? 'md' : 'sm'}
              icon="mdi mdi-account"
              fullWidth
              active={isOpen}
              onClick={onClick}
              aria-label={label}
              title={label}
            >
              {!isRail && label}
            </Button>
          )}
        />
        <SupportBadge compact={isRail} className={isRail ? 'sidebar-rail__support' : 'sidebar-support-badge'} />
      </div>

      {/* Modals */}
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
        onConfirm={async () => {
          await emptyTrashMutation.mutateAsync(undefined);
          setShowEmptyTrashConfirm(false);
        }}
        title="Empty Trash"
        message="This will permanently delete all items in the trash. This action cannot be undone."
        confirmLabel="Empty Trash"
        variant="danger"
      />
    </>
  );
}

/* ================================================================
   SidebarRail — persistent icon-only navigation rail
   ================================================================ */

interface SidebarRailProps {
  hidden?: boolean;
}

export function SidebarRail({ hidden }: SidebarRailProps) {
  const {
    mainViewType,
    setMainViewType,
    openNode,
  } = useNavigationStore(
    useShallow((s) => ({
      mainViewType: s.mainViewType,
      setMainViewType: s.setMainViewType,
      openNode: s.openNode,
    }))
  );

  const { data: workspaceSettings } = useWorkspaceSettings();
  const showJournals = (workspaceSettings?.sidebar_show_journals as boolean | undefined) ?? true;
  const showInbox = (workspaceSettings?.sidebar_show_inbox as boolean | undefined) ?? true;

  const { data: inboxNode } = useNodeByUuid(SYSTEM_PAGE_UUIDS.inbox, {
    meta: { skipGlobalError: true },
  });

  const { refetch: refetchToday } = useDailyNote(new Date());

  const handleOpenInbox = useCallback(() => {
    if (inboxNode?.uuid) {
      openNode(inboxNode.uuid);
    }
  }, [inboxNode, openNode]);

  const handleGoToToday = useCallback(async () => {
    const result = await refetchToday();
    if (result.data) {
      openNode(result.data.uuid);
    }
  }, [refetchToday, openNode]);

  const isPagesActive = mainViewType === 'pages' || mainViewType === 'all-pages' || mainViewType === 'graph' || mainViewType === 'timeline';
  const isClassesActive = mainViewType === 'classes';

  if (hidden) return null;

  return (
    <Card className="sidebar-rail layout-card" padding={false} elevation="medium">
      <div className="sidebar-rail__top">
        {showJournals && (
          <Button
            className="sidebar-rail__btn"
            variant="ghost"
            size="md"
            icon="mdi mdi-notebook-outline"
            fullWidth
            active={mainViewType === 'journals'}
            onClick={() => setMainViewType('journals')}
            aria-label="Journal"
            title="Journal"
          />
        )}
        <Button
          className="sidebar-rail__btn"
          variant="ghost"
          size="md"
          icon="mdi mdi-calendar-today"
          fullWidth
          onClick={handleGoToToday}
          aria-label="Go to today"
          title="Go to today"
        />
        <Button
          className="sidebar-rail__btn"
          variant="ghost"
          size="md"
          icon="mdi mdi-book-open-page-variant"
          fullWidth
          active={isPagesActive}
          onClick={() => setMainViewType('pages')}
          aria-label="Pages"
          title="Pages"
        />
        <Button
          className="sidebar-rail__btn"
          variant="ghost"
          size="md"
          icon="mdi mdi-shape-outline"
          fullWidth
          active={isClassesActive}
          onClick={() => setMainViewType('classes')}
          aria-label="Classes"
          title="Classes"
        />
        {showInbox && (
          <Button
            className="sidebar-rail__btn"
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
      </div>

      <SidebarTools layout="rail" />
    </Card>
  );
}

/* ================================================================
   Sidebar — collapsible content panel
   ================================================================ */

export function Sidebar({ collapsed }: SidebarProps) {
  const [contextMenuNode, setContextMenuNode] = useState<string | null>(null);
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });
  const isMobile = useIsMobile();

  const handleFavoriteContextMenu = useCallback((nodeUuid: string, e: React.MouseEvent) => {
    setContextMenuNode(nodeUuid);
    setContextMenuPos({ x: e.clientX, y: e.clientY });
  }, []);

  const handleRecentContextMenu = useCallback((nodeUuid: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenuNode(nodeUuid);
    setContextMenuPos({ x: e.clientX, y: e.clientY });
  }, []);

  const handleCloseContextMenu = useCallback(() => {
    setContextMenuNode(null);
  }, []);

  const { data: contextNode } = useNodeByUuid(contextMenuNode);

  return (
    <>
      <Card className={`sidebar ${collapsed ? 'sidebar--collapsed' : 'sidebar--expanded'} layout-card`} padding={false} elevation="medium">
        {/* Workspace Switcher at Top */}
        <div className="sidebar-header">
          <WorkspaceSwitcher />
        </div>

        {/* Scrollable content - favorites, recents and pinned pages */}
        <div className="sidebar-content">
          <SidebarFavorites onContextMenu={handleFavoriteContextMenu} />
          <SidebarRecents onContextMenu={handleRecentContextMenu} />
          <SidebarPinnedPages onContextMenu={handleFavoriteContextMenu} />
        </div>

        {isMobile && (
          <div className="sidebar-footer-section">
            <SidebarTools layout="footer" />
          </div>
        )}
      </Card>

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
