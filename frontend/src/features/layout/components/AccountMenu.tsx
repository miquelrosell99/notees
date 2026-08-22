/**
 * AccountMenu Component
 * 
 * Square button with user profile initial that shows a dropdown menu
 * with User Settings, Workspaces, and Log Out actions.
 */
import { useState, useRef, useEffect, useLayoutEffect, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { autoUpdate, computePosition, flip, offset, shift, type Placement } from '@floating-ui/dom';
import { useAuthStore } from '@/stores';
import { useCapabilities } from '@/config/capabilities';
import { useNotifications } from '@/hooks/useNotifications';
import { NotificationPanel } from './NotificationBell';

import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useClickOutside } from '@/hooks/useClickOutside';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { useOverlaySurface } from '@/hooks/useOverlaySurface';
import { cn } from '@/utils/cn';
import './AccountMenu.css';
import { Icon } from '@/components/ui/icons';

/** Space between the trigger and the floating menu/panel. */
const MENU_GAP = 8;

type MenuPlacement = 'bottom' | 'top';
type MenuAlign = 'left' | 'right';

/** Map placement + alignment props to a Floating UI placement. */
const toPlacement = (placement: MenuPlacement, align: MenuAlign): Placement =>
  `${placement}-${align === 'left' ? 'start' : 'end'}`;

/**
 * Anchor a portaled (position:fixed) floating element to a reference element
 * with Floating UI. autoUpdate repositions on scroll (any ancestor), resize,
 * element resize, and layout shifts; styles are written straight to the
 * floating element, so repositioning never goes through React renders.
 */
function useAnchoredPopup(
  enabled: boolean,
  referenceRef: RefObject<HTMLElement | null>,
  floatingRef: RefObject<HTMLElement | null>,
  placement: Placement,
  fallbackPlacement: Placement,
) {
  useLayoutEffect(() => {
    if (!enabled) return;
    const reference = referenceRef.current;
    const floating = floatingRef.current;
    if (!reference || !floating) return;

    const update = () => {
      computePosition(reference, floating, {
        placement,
        strategy: 'fixed',
        middleware: [
          offset(MENU_GAP),
          flip({ padding: MENU_GAP, fallbackPlacements: [fallbackPlacement] }),
          shift({ padding: MENU_GAP, crossAxis: true }),
        ],
      }).then(({ x, y }) => {
        floating.style.left = `${x}px`;
        floating.style.top = `${y}px`;
        floating.style.visibility = 'visible';
      });
    };

    update();
    return autoUpdate(reference, floating, update);
  }, [enabled, referenceRef, floatingRef, placement, fallbackPlacement]);
}

interface AccountMenuProps {
  onOpenUserSettings: () => void;
  onOpenSystemSettings?: () => void;
  /** Open workspace/graph-level Settings (e.g. date format, sidebar visibility). */
  onOpenSettings?: () => void;
  /** Open the shared pages view. */
  onOpenShares?: () => void;
  className?: string;
  /** Custom trigger button. Receives a ref that must be attached to a button element. */
  renderTrigger?: (props: {
    ref: React.RefObject<HTMLButtonElement | null>;
    onClick: () => void;
    isOpen: boolean;
    label: string;
  }) => ReactNode;
  /** Dropdown placement relative to the trigger. Defaults to opening below. */
  placement?: MenuPlacement;
  /** Horizontal alignment of the dropdown relative to the trigger. Defaults to right. */
  align?: MenuAlign;
}

export function AccountMenu({
  onOpenUserSettings,
  onOpenSystemSettings,
  onOpenSettings,
  onOpenShares,
  className,
  renderTrigger,
  placement = 'bottom',
  align = 'right',
}: AccountMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [notificationPanel, setNotificationPanel] = useState<{ open: boolean; filter?: string; title?: string }>({ open: false });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const capabilities = useCapabilities();
  const { data: notificationsData } = useNotifications(false);

  // Register the main menu and notification panel with the global overlay stack
  // so Escape closes the topmost one in the correct order.
  useOverlaySurface({
    type: 'popup',
    enabled: isOpen,
    onClose: () => setIsOpen(false),
  });
  useOverlaySurface({
    type: 'popup',
    enabled: notificationPanel.open,
    onClose: () => setNotificationPanel({ open: false }),
  });

  // Trap focus inside the account dropdown while it is open and return focus on close.
  // Escape handling is owned by the global overlay stack.
  useFocusTrap(menuRef, {
    enabled: isOpen,
    onEscape: undefined,
    restoreFocus: true,
  });

  const unreadCount = notificationsData?.unread_count ?? 0;
  const unreadMentions = (notificationsData?.notifications ?? []).filter(
    (n) => n.type === 'mention' && !n.is_read
  ).length;

  useClickOutside([triggerRef, menuRef], () => setIsOpen(false), isOpen);

  // Keep the dropdown and notification panel anchored to the trigger; flip to
  // the opposite side when they would overflow the viewport.
  const resolvedPlacement = toPlacement(placement, align);
  const fallbackPlacement = toPlacement(placement === 'bottom' ? 'top' : 'bottom', align);
  useAnchoredPopup(isOpen, triggerRef, menuRef, resolvedPlacement, fallbackPlacement);
  useAnchoredPopup(notificationPanel.open, triggerRef, notifRef, resolvedPlacement, fallbackPlacement);

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

  const handleSettings = () => {
    setIsOpen(false);
    onOpenSettings?.();
  };

  const handleShares = () => {
    setIsOpen(false);
    onOpenShares?.();
  };

  const handleLogout = () => {
    setIsOpen(false);
    logout();
  };

  const handleOpenNotifications = (filter?: string, title?: string) => {
    setIsOpen(false);
    setNotificationPanel({ open: true, filter, title });
  };

  const displayName = user?.name || user?.email?.split('@')[0] || 'User';
  const initial = displayName.charAt(0).toUpperCase() || '?';

  return (
    <div className={cn('account-menu', className)}>
      {renderTrigger ? (
        renderTrigger({
          ref: triggerRef,
          onClick: () => setIsOpen(!isOpen),
          isOpen,
          label: displayName,
        })
      ) : (
        <Button
          ref={triggerRef}
          variant="ghost"
          size="sm"
          icon="mdi mdi-account"
          onClick={() => setIsOpen(!isOpen)}
          title={displayName}
          active={isOpen}
          badges={unreadCount > 0 ? [{ count: unreadCount, position: 'top-right' }] : undefined}
        >
          {displayName}
        </Button>
      )}

      {isOpen && createPortal(
        <Card
          ref={menuRef}
          className="account-menu__dropdown"
          elevation="high"
          radius="floating"
          padding={false}
          // top/left are set imperatively by Floating UI; hidden until the
          // first computePosition has positioned the menu
          style={{ visibility: 'hidden' }}
        >
          <div className="account-menu__user-info">
            <span className="account-menu__user-avatar">{initial}</span>
            <span className="account-menu__username">{displayName}</span>
          </div>
          <div className="account-menu__divider" />
          {capabilities.notifications && (
            <>
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
            </>
          )}
          {capabilities.shares && onOpenShares && (
            <>
              <button className="account-menu__item" onClick={handleShares}>
                <Icon path={"mdi mdi-share-variant"} size={0.7} />
                <span>Shares</span>
              </button>
              <div className="account-menu__divider" />
            </>
          )}
          <button className="account-menu__item" onClick={handleUserSettings}>
            <Icon path={"mdi mdi-account-outline"} size={0.7} />
            <span>User Settings</span>
          </button>
          {onOpenSettings && (
            <button className="account-menu__item" onClick={handleSettings}>
              <Icon path={"mdi mdi-cog"} size={0.7} />
              <span>Graph Settings</span>
            </button>
          )}
          {capabilities.admin && user?.role === 'admin' && onOpenSystemSettings && (
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
        </Card>,
        document.body
      )}

      {notificationPanel.open && createPortal(
        <div
          ref={notifRef}
          className="account-menu__notification-panel"
          // top/left are set imperatively by Floating UI; hidden until the
          // first computePosition has positioned the panel
          style={{ visibility: 'hidden' }}
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

