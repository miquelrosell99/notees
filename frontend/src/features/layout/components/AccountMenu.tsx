/**
 * AccountMenu Component
 * 
 * Square button with user profile initial that shows a dropdown menu
 * with User Settings, Workspaces, and Log Out actions.
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useAuthStore, useModalStore } from '@/stores';
import { useNotifications } from '@/hooks/useNotifications';
import { NotificationPanel } from './NotificationBell';

import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useClickOutside } from '@/hooks/useClickOutside';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { isAndroidApp } from '@/hooks/useAndroidBridge';
import './AccountMenu.css';
import { Icon } from '@/components/ui/icons';

interface AccountMenuProps {
  onOpenUserSettings: () => void;
  onOpenSystemSettings?: () => void;
}

export function AccountMenu({ onOpenUserSettings, onOpenSystemSettings }: AccountMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [notificationPanel, setNotificationPanel] = useState<{ open: boolean; filter?: string; title?: string }>({ open: false });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);
  const { user, logout } = useAuthStore();
  const { setShowWorkspaceManager } = useModalStore();
  const { data: notificationsData } = useNotifications(false);

  const unreadCount = notificationsData?.unread_count ?? 0;
  const unreadMentions = (notificationsData?.notifications ?? []).filter(
    (n) => n.type === 'mention' && !n.is_read
  ).length;

  useClickOutside([triggerRef, menuRef], () => setIsOpen(false), isOpen);
  useEscapeKey(() => {
    setIsOpen(false);
    setNotificationPanel({ open: false });
  });

  // Compute portal position when opened
  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setMenuPos({
      top: rect.bottom + 8,
      left: rect.right,
    });
  }, []);

  useEffect(() => {
    if (isOpen) {
      updatePosition();
    }
  }, [isOpen, updatePosition]);

  // Close notification panel when clicking outside
  useEffect(() => {
    if (!notificationPanel.open) return;
    function handleClickOutside(e: MouseEvent) {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setNotificationPanel({ open: false });
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [notificationPanel.open]);

  const handleUserSettings = () => {
    setIsOpen(false);
    onOpenUserSettings();
  };

  const handleSystemSettings = () => {
    setIsOpen(false);
    onOpenSystemSettings?.();
  };

  const handleManageGraphs = () => {
    setIsOpen(false);
    setShowWorkspaceManager(true);
  };

  const handleLogout = () => {
    setIsOpen(false);
    logout();
  };

  const handleChangeServer = () => {
    setIsOpen(false);
    window.Android?.showServerSettings();
  };

  const handleOpenNotifications = (filter?: string, title?: string) => {
    setIsOpen(false);
    setNotificationPanel({ open: true, filter, title });
  };

  const displayName = user?.name || user?.email?.split('@')[0] || 'User';
  const initial = displayName.charAt(0).toUpperCase() || '?';

  return (
    <div className="account-menu">
      <Button
        ref={triggerRef}
        variant="ghost"
        size="sm"
        onClick={() => setIsOpen(!isOpen)}
        title={displayName}
        active={isOpen}
      >
        <span className="account-menu__button-inner">
          {initial}
          {unreadCount > 0 && <span className="account-menu__notification-dot" />}
        </span>
      </Button>

      {isOpen && menuPos && createPortal(
        <Card
          ref={menuRef}
          className="account-menu__dropdown"
          elevation="high"
          padding={false}
          style={{
            position: 'fixed',
            top: `${menuPos.top}px`,
            right: `${window.innerWidth - menuPos.left}px`,
          }}
        >
          <div className="account-menu__user-info">
            <span className="account-menu__user-avatar">{initial}</span>
            <span className="account-menu__username">{displayName}</span>
          </div>
          <div className="account-menu__divider" />
          <button className="account-menu__item" onClick={() => handleOpenNotifications(undefined, 'Notifications')}>
            <Icon path={"mdi mdi-bell-outline"} size={0.7} />
            <span>Notifications</span>
            {unreadCount > 0 && <span className="account-menu__badge">{unreadCount}</span>}
          </button>
          <button className="account-menu__item" onClick={() => handleOpenNotifications('mention', 'Mentions')}>
            <Icon path={"mdi mdi-at"} size={0.7} />
            <span>Mentions</span>
            {unreadMentions > 0 && <span className="account-menu__badge">{unreadMentions}</span>}
          </button>
          <div className="account-menu__divider" />
          <button className="account-menu__item" onClick={handleUserSettings}>
            <Icon path={"mdi mdi-cog"} size={0.7} />
            <span>User Settings</span>
          </button>
          <button className="account-menu__item" onClick={handleManageGraphs}>
            <Icon path={"mdi mdi-database-outline"} size={0.7} />
            <span>Workspaces</span>
          </button>
          {user?.role === 'admin' && onOpenSystemSettings && (
            <button className="account-menu__item" onClick={handleSystemSettings}>
              <Icon path={"mdi mdi-account-cog"} size={0.7} />
              <span>System Settings</span>
            </button>
          )}
          <div className="account-menu__divider" />
          <button className="account-menu__item account-menu__item--danger" onClick={handleLogout}>
            <Icon path={"mdi mdi-logout"} size={0.7} />
            <span>Log out</span>
          </button>
          {isAndroidApp() && (
            <>
              <div className="account-menu__divider" />
              <button className="account-menu__item" onClick={handleChangeServer}>
                <Icon path={"mdi mdi-server-network"} size={0.7} />
                <span>Change server</span>
              </button>
            </>
          )}
        </Card>,
        document.body
      )}

      {notificationPanel.open && menuPos && createPortal(
        <div
          ref={notifRef}
          className="account-menu__notification-panel"
          style={{
            position: 'fixed',
            top: `${menuPos.top}px`,
            right: `${window.innerWidth - menuPos.left}px`,
          }}
        >
          <NotificationPanel
            filterType={notificationPanel.filter}
            title={notificationPanel.title}
            onClose={() => setNotificationPanel({ open: false })}
          />
        </div>,
        document.body
      )}
    </div>
  );
}

