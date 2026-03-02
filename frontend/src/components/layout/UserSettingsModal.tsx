/**
 * UserSettingsModal Component
 * 
 * Modal for user-level settings: date format, theme, account info.
 * Separate from graph/workspace settings.
 */
import { useState } from 'react';
import { useAuthStore, useSettingsStore, applyTheme, DATE_FORMAT_OPTIONS } from '@/stores';
import type { ThemePreference, DateFormat, HashtagPasteMode, DefaultView, QuickAddDestination } from '@/stores';
import { setSetting } from '@/api/workspaces';
import { mdiWeatherSunny, mdiWeatherNight, mdiMonitor, mdiCloseCircleOutline, mdiNumeric1, mdiNumeric2, mdiNumeric3, mdiTag, mdiShapeOutline, mdiCalendarToday, mdiInbox, mdiCheckCircleOutline } from '@mdi/js';
import { Modal } from '../core/Modal';
import { Button } from '../core/Button';
import { SelectionButton } from '../core/SelectionButton';
import { Separator } from '../core/Separator';
import './UserSettingsModal.css';

interface UserSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type UserSettingsTab = 'appearance' | 'editor' | 'general' | 'account' | 'about';

export function UserSettingsModal({ isOpen, onClose }: UserSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<UserSettingsTab>('appearance');
  const { user, logout } = useAuthStore();
  const { theme, dateFormat, hashtagPasteMode, defaultView, quickAddDestination, linkedRefsCollapseLevel, showDevOptions, setTheme, setDateFormat, setHashtagPasteMode, setDefaultView, setQuickAddDestination, setLinkedRefsCollapseLevel, setShowDevOptions } = useSettingsStore();

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

  const handleHashtagPasteModeChange = (mode: HashtagPasteMode) => {
    setHashtagPasteMode(mode);
    setSetting('hashtag_paste_mode', mode).catch(console.error);
  };

  const handleDefaultViewChange = (view: DefaultView) => {
    setDefaultView(view);
    setSetting('default_view', view).catch(console.error);
  };

  const handleQuickAddDestinationChange = (destination: QuickAddDestination) => {
    setQuickAddDestination(destination);
    setSetting('quick_add_destination', destination).catch(console.error);
  };

  const handleShowDevOptionsChange = (show: boolean) => {
    setShowDevOptions(show);
  };

  const handleLinkedRefsCollapseLevelChange = (level: number) => {
    setLinkedRefsCollapseLevel(level);
    setSetting('linked_refs_collapse_level', level).catch(console.error);
  };

  const tabs: { id: UserSettingsTab; label: string }[] = [
    { id: 'appearance', label: 'Appearance' },
    { id: 'editor', label: 'Editor' },
    { id: 'general', label: 'General' },
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
          {activeTab === 'appearance' && (
            <div className="settings-section">
              <div className="settings-item">
                <div className="settings-item__info">
                  <label className="settings-item__label">Theme</label>
                  <p className="settings-item__description">
                    Choose your preferred color theme
                  </p>
                </div>
                <SelectionButton
                  options={[
                    { value: 'light', icon: mdiWeatherSunny, label: 'Light theme' },
                    { value: 'dark', icon: mdiWeatherNight, label: 'Dark theme' },
                    { value: 'system', icon: mdiMonitor, label: 'System theme' },
                  ]}
                  value={theme}
                  onChange={(value) => handleThemeChange(value as ThemePreference)}
                  size="sm"
                />
              </div>
            </div>
          )}

          {activeTab === 'editor' && (
            <div className="settings-section">
              <div className="settings-item">
                <div className="settings-item__info">
                  <label className="settings-item__label">Linked refs collapse level</label>
                  <p className="settings-item__description">
                    Auto-collapse nodes at this depth in linked references (0 = disabled)
                  </p>
                </div>
                <SelectionButton
                  options={[
                    { value: '0', icon: mdiCloseCircleOutline, label: 'Disabled' },
                    { value: '1', icon: mdiNumeric1, label: 'Level 1' },
                    { value: '2', icon: mdiNumeric2, label: 'Level 2' },
                    { value: '3', icon: mdiNumeric3, label: 'Level 3' },
                  ]}
                  value={linkedRefsCollapseLevel.toString()}
                  onChange={(value) => handleLinkedRefsCollapseLevelChange(parseInt(value, 10))}
                  size="sm"
                />
              </div>

              <div className="settings-item">
                <div className="settings-item__info">
                  <label className="settings-item__label">Hashtag paste behavior</label>
                  <p className="settings-item__description">
                    How #hashtag patterns in pasted text should be interpreted
                  </p>
                </div>
                <SelectionButton
                  options={[
                    { value: 'inline-tag', icon: mdiTag, label: 'Inline tag (node link with is_tag)' },
                    { value: 'inline-class', icon: mdiShapeOutline, label: 'Inline class (class reference)' },
                  ]}
                  value={hashtagPasteMode}
                  onChange={(value) => handleHashtagPasteModeChange(value as HashtagPasteMode)}
                  size="sm"
                />
              </div>
            </div>
          )}

          {activeTab === 'general' && (
            <div className="settings-section">
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
                  <label className="settings-item__label">Default view</label>
                  <p className="settings-item__description">
                    Choose what to show when opening a graph
                  </p>
                </div>
                <select
                  className="settings-item__select"
                  value={defaultView}
                  onChange={(e) => handleDefaultViewChange(e.target.value as DefaultView)}
                >
                  <option value="today">Today's Page</option>
                  <option value="journal">Journal</option>
                  <option value="all-pages">All Pages</option>
                  <option value="graph">Graph View</option>
                </select>
              </div>

              <div className="settings-item">
                <div className="settings-item__info">
                  <label className="settings-item__label">Quick add destination</label>
                  <p className="settings-item__description">
                    Where to send quick add notes
                  </p>
                </div>
                <SelectionButton
                  options={[
                    { value: 'today', icon: mdiCalendarToday, label: "Today's Page" },
                    { value: 'inbox', icon: mdiInbox, label: 'Inbox' },
                  ]}
                  value={quickAddDestination}
                  onChange={(value) => handleQuickAddDestinationChange(value as QuickAddDestination)}
                  size="sm"
                />
              </div>

              <div className="settings-item">
                <div className="settings-item__info">
                  <label className="settings-item__label">Developer options</label>
                  <p className="settings-item__description">
                    Show dev tools: AST viewer in node context menu, fix UUID links and create page with manual UUID in command palette
                  </p>
                </div>
                <SelectionButton
                  options={[
                    { value: 'off', icon: mdiCloseCircleOutline, label: 'Hidden' },
                    { value: 'on', icon: mdiCheckCircleOutline, label: 'Visible' },
                  ]}
                  value={showDevOptions ? 'on' : 'off'}
                  onChange={(value) => handleShowDevOptionsChange(value === 'on')}
                  size="sm"
                />
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
