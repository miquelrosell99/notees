/**
 * UserSettingsModal Component
 * 
 * Modal for user-level settings: date format, theme, font size, account info.
 * Separate from graph/workspace settings.
 */
import { useState } from 'react';
import { useAuthStore, useSettingsStore, applyTheme, DATE_FORMAT_OPTIONS } from '@/stores';
import type { ThemePreference, DateFormat } from '@/stores';
import { setSetting } from '@/api/workspaces';
import { Modal } from '../core/Modal';
import { Button } from '../core/Button';
import { Separator } from '../core/Separator';
import './UserSettingsModal.css';

interface UserSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type UserSettingsTab = 'preferences' | 'account' | 'about';

export function UserSettingsModal({ isOpen, onClose }: UserSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<UserSettingsTab>('preferences');
  const { user, logout } = useAuthStore();
  const { theme, dateFormat, fontSize, setTheme, setDateFormat, setFontSize } = useSettingsStore();

  if (!isOpen) return null;

  const handleLogout = () => {
    logout();
    onClose();
  };

  const handleThemeChange = (newTheme: ThemePreference) => {
    setTheme(newTheme);
    applyTheme(newTheme);
    setSetting('theme', newTheme).catch(console.error);
  };

  const handleDateFormatChange = (newFormat: DateFormat) => {
    if (newFormat === dateFormat) return;
    setDateFormat(newFormat);
    setSetting('date_format', newFormat).catch(console.error);
  };

  const handleFontSizeChange = (newSize: 'small' | 'medium' | 'large') => {
    setFontSize(newSize);
    setSetting('font_size', newSize).catch(console.error);
  };

  const tabs: { id: UserSettingsTab; label: string }[] = [
    { id: 'preferences', label: 'Preferences' },
    { id: 'account', label: 'Account' },
    { id: 'about', label: 'About' },
  ];

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="User Settings"
      size="lg"
      closeOnBackdrop={true}
      closeOnEscape={true}
      contentClassName="settings-modal__body"
    >
      <div className="settings-modal__container">
        <nav className="settings-modal__nav">
          {tabs.map((tab) => (
            <Button
              key={tab.id}
              className={`settings-modal__nav-item ${activeTab === tab.id ? 'settings-modal__nav-item--active' : ''}`}
              variant="ghost"
              size="sm"
              active={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
            >
              <span className="settings-modal__nav-label">{tab.label}</span>
            </Button>
          ))}
        </nav>

        <div className="settings-modal__content">
          {activeTab === 'preferences' && (
            <div className="settings-section">
              <h3 className="settings-section__title">User Preferences</h3>
              <p className="settings-section__subtitle">
                These settings apply to your account across all graphs.
              </p>

              <div className="settings-item">
                <div className="settings-item__info">
                  <label className="settings-item__label">Theme</label>
                  <p className="settings-item__description">
                    Choose your preferred color theme
                  </p>
                </div>
                <div className="settings-theme-buttons">
                  <Button
                    className="settings-theme-btn"
                    variant={theme === 'light' ? 'default' : 'ghost'}
                    size="sm"
                    active={theme === 'light'}
                    onClick={() => handleThemeChange('light')}
                  >
                    Light
                  </Button>
                  <Button
                    className="settings-theme-btn"
                    variant={theme === 'dark' ? 'default' : 'ghost'}
                    size="sm"
                    active={theme === 'dark'}
                    onClick={() => handleThemeChange('dark')}
                  >
                    Dark
                  </Button>
                  <Button
                    className="settings-theme-btn"
                    variant={theme === 'system' ? 'default' : 'ghost'}
                    size="sm"
                    active={theme === 'system'}
                    onClick={() => handleThemeChange('system')}
                  >
                    System
                  </Button>
                </div>
              </div>

              <div className="settings-item">
                <div className="settings-item__info">
                  <label className="settings-item__label">Default date format</label>
                  <p className="settings-item__description">
                    Default format for new graphs. Each graph can override this.
                  </p>
                </div>
                <select
                  className="settings-item__select"
                  value={dateFormat}
                  onChange={(e) => handleDateFormatChange(e.target.value as DateFormat)}
                >
                  {DATE_FORMAT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label} ({option.example})
                    </option>
                  ))}
                </select>
              </div>

              <div className="settings-item">
                <div className="settings-item__info">
                  <label className="settings-item__label">Font size</label>
                  <p className="settings-item__description">
                    Adjust the base font size
                  </p>
                </div>
                <select
                  className="settings-item__select"
                  value={fontSize}
                  onChange={(e) => handleFontSizeChange(e.target.value as 'small' | 'medium' | 'large')}
                >
                  <option value="small">Small</option>
                  <option value="medium">Medium</option>
                  <option value="large">Large</option>
                </select>
              </div>
            </div>
          )}

          {activeTab === 'account' && (
            <div className="settings-section">
              <h3 className="settings-section__title">Account</h3>

              <div className="settings-user-card">
                <div className="settings-user-info">
                  <div className="settings-user-avatar">
                    {user?.username?.charAt(0).toUpperCase() || '?'}
                  </div>
                  <div className="settings-user-details">
                    <p className="settings-user-name">{user?.username || 'User'}</p>
                    <p className="settings-user-id">User ID: {user?.id || 'Unknown'}</p>
                  </div>
                </div>

                <div className="settings-account-meta">
                  <div className="settings-meta-item">
                    <span className="settings-meta-label">Account Type</span>
                    <span className="settings-meta-value">Standard</span>
                  </div>
                  <div className="settings-meta-item">
                    <span className="settings-meta-label">Status</span>
                    <span className="settings-meta-value settings-meta-value--active">Active</span>
                  </div>
                </div>
              </div>

              <Separator orientation="horizontal" size="lg" spacing="lg" />

              <div className="settings-actions">
                <h4 className="settings-actions__title">Account Actions</h4>
                <Button className="settings-btn settings-btn--logout" variant="danger" size="md" onClick={handleLogout}>
                  Log out
                </Button>
              </div>
            </div>
          )}

          {activeTab === 'about' && (
            <div className="settings-section">
              <h3 className="settings-section__title">About Notees</h3>

              <div className="settings-about">
                <div className="settings-about__logo">N</div>
                <h4 className="settings-about__name">Notees</h4>
                <p className="settings-about__version">Version 1.0.0</p>
                <p className="settings-about__description">
                  A powerful note-taking app with graph visualization,
                  bidirectional linking, and more.
                </p>
              </div>

              <Separator orientation="horizontal" size="lg" spacing="md" />

              <div className="settings-links">
                <a href="#" className="settings-link">Documentation</a>
                <a href="#" className="settings-link">Report a bug</a>
                <a href="#" className="settings-link">Feature request</a>
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

export default UserSettingsModal;
