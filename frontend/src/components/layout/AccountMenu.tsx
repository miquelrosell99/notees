/**
 * AccountMenu Component
 * 
 * Square button with user profile initial that shows a dropdown menu
 * with User Settings, Manage Graphs, and Log Out actions.
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useAuthStore, useAppStore } from '@/stores';
import { mdiCog, mdiLogout, mdiDatabaseOutline } from '@mdi/js';
import Icon from '@mdi/react';
import { Card } from '../core/Card';
import { Button } from '../core/Button';
import { useClickOutside } from '@/hooks/useClickOutside';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import './AccountMenu.css';

interface AccountMenuProps {
  onOpenUserSettings: () => void;
}

export function AccountMenu({ onOpenUserSettings }: AccountMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { user, logout } = useAuthStore();
  const { setShowDbManagement } = useAppStore();

  useClickOutside([triggerRef, menuRef], () => setIsOpen(false), isOpen);
  useEscapeKey(() => setIsOpen(false));

  // Compute portal position when opened
  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setMenuPos({
      top: rect.bottom - /* menu approx height */ 0,
      left: rect.right + 8,
    });
  }, []);

  useEffect(() => {
    if (isOpen) {
      updatePosition();
    }
  }, [isOpen, updatePosition]);

  const handleUserSettings = () => {
    setIsOpen(false);
    onOpenUserSettings();
  };

  const handleManageGraphs = () => {
    setIsOpen(false);
    setShowDbManagement(true);
  };

  const handleLogout = () => {
    setIsOpen(false);
    logout();
  };

  const initial = user?.username?.charAt(0).toUpperCase() || '?';

  return (
    <div className="account-menu">
      <Button
        ref={triggerRef}
        variant="ghost"
        size="sm"
        onClick={() => setIsOpen(!isOpen)}
        title={user?.username || 'Account'}
        active={isOpen}
      >
        {initial}
      </Button>

      {isOpen && menuPos && createPortal(
        <Card
          ref={menuRef}
          className="account-menu__dropdown"
          elevation="high"
          padding={false}
          style={{
            position: 'fixed',
            bottom: `${window.innerHeight - menuPos.top}px`,
            left: `${menuPos.left}px`,
          }}
        >
          <div className="account-menu__user-info">
            <span className="account-menu__user-avatar">{initial}</span>
            <span className="account-menu__username">{user?.username || 'User'}</span>
          </div>
          <div className="account-menu__divider" />
          <button className="account-menu__item" onClick={handleUserSettings}>
            <Icon path={mdiCog} size={0.7} />
            <span>User Settings</span>
          </button>
          <button className="account-menu__item" onClick={handleManageGraphs}>
            <Icon path={mdiDatabaseOutline} size={0.7} />
            <span>Manage Graphs</span>
          </button>
          <div className="account-menu__divider" />
          <button className="account-menu__item account-menu__item--danger" onClick={handleLogout}>
            <Icon path={mdiLogout} size={0.7} />
            <span>Log out</span>
          </button>
        </Card>,
        document.body
      )}
    </div>
  );
}

export default AccountMenu;
