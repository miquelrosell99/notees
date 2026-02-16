/**
 * AccountMenu Component
 * 
 * Square button with user profile initial that shows a dropdown menu
 * with User Settings, Manage Graphs, and Log Out actions.
 */
import { useState, useRef } from 'react';
import { useAuthStore, useAppStore } from '@/stores';
import { mdiCog, mdiLogout, mdiDatabaseOutline } from '@mdi/js';
import Icon from '@mdi/react';
import { Card } from '../core/Card';
import { useClickOutside } from '@/hooks/useClickOutside';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import './AccountMenu.css';

interface AccountMenuProps {
  onOpenUserSettings: () => void;
}

export function AccountMenu({ onOpenUserSettings }: AccountMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { user, logout } = useAuthStore();
  const { setShowDbManagement } = useAppStore();

  useClickOutside(menuRef, () => setIsOpen(false));
  useEscapeKey(() => setIsOpen(false));

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
    <div className="account-menu" ref={menuRef}>
      <button
        className={`account-menu__trigger ${isOpen ? 'account-menu__trigger--open' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        title={user?.username || 'Account'}
      >
        <span className="account-menu__avatar">{initial}</span>
      </button>

      {isOpen && (
        <Card className="account-menu__dropdown" elevation="high" padding={false}>
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
        </Card>
      )}
    </div>
  );
}

export default AccountMenu;
