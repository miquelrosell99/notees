/**
 * UserSettingsModal Component
 * 
 * Modal for user-level settings: date format, theme, account info.
 * Separate from graph/workspace settings.
 */
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore, useSettingsStore, applyTheme, DATE_FORMAT_OPTIONS, FIRST_DAY_OF_WEEK_OPTIONS, ACCENT_COLOR_OPTIONS } from '@/stores';
import type { ThemePreference, DateFormat, HashtagPasteMode, DefaultView, QuickAddDestination, FirstDayOfWeek, AccentColor } from '@/stores';
import { setSetting } from '@/features/workspace/api/workspaces';
import { updateMe, createApiKey, listApiKeys, revokeApiKey } from '@/features/auth/api/auth';
import { TextField } from '@/components/ui/TextField';
import type { ApiKey } from '@/types';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { SelectionButton } from '@/components/ui/SelectionButton';
import { BooleanToggle } from '@/components/ui/BooleanToggle';
import { Separator } from '@/components/ui/Separator';
import './UserSettingsModal.css';

interface UserSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type UserSettingsTab = 'appearance' | 'editor' | 'general' | 'account' | 'about';

export function UserSettingsModal({ isOpen, onClose }: UserSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<UserSettingsTab>('appearance');
  const { user, logout, setUser, changePassword } = useAuthStore();
  const [editName, setEditName] = useState(user?.name ?? '');
  const [editSurnames, setEditSurnames] = useState(user?.surnames ?? '');
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [apiKeysLoading, setApiKeysLoading] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeySecret, setNewKeySecret] = useState<string | null>(null);
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const navigate = useNavigate();
  const { theme, oledMode, accentColor, dateFormat, hashtagPasteMode, defaultView, quickAddDestination, linkedRefsCollapseLevel, showDevOptions, firstDayOfWeek, setTheme, setOledMode, setAccentColor, setDateFormat, setHashtagPasteMode, setDefaultView, setQuickAddDestination, setLinkedRefsCollapseLevel, setShowDevOptions, setFirstDayOfWeek } = useSettingsStore();

  const loadApiKeys = async () => {
    setApiKeysLoading(true);
    setApiKeyError(null);
    try {
      const keys = await listApiKeys();
      setApiKeys(keys);
    } catch (err) {
      setApiKeyError(err instanceof Error ? err.message : 'Failed to load API keys');
    } finally {
      setApiKeysLoading(false);
    }
  };

  const handleCreateApiKey = async () => {
    const name = newKeyName.trim();
    if (!name) return;
    setApiKeyError(null);
    try {
      const created = await createApiKey({ name });
      setNewKeySecret(created.key);
      setNewKeyName('');
      await loadApiKeys();
    } catch (err) {
      setApiKeyError(err instanceof Error ? err.message : 'Failed to create API key');
    }
  };

  const handleRevokeApiKey = async (keyId: string) => {
    setApiKeyError(null);
    try {
      await revokeApiKey(keyId);
      await loadApiKeys();
    } catch (err) {
      setApiKeyError(err instanceof Error ? err.message : 'Failed to revoke API key');
    }
  };

  useEffect(() => {
    if (isOpen && activeTab === 'account') {
      loadApiKeys();
    }
  }, [isOpen, activeTab]);

  if (!isOpen) return null;

  const handleLogout = () => {
    logout();
    onClose();
  };

  const handleSaveProfile = async () => {
    setIsSavingProfile(true);
    setProfileError(null);
    try {
      const updated = await updateMe({
        name: editName.trim() || null,
        surnames: editSurnames.trim() || null,
      });
      setUser(updated);
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : 'Failed to update profile');
    } finally {
      setIsSavingProfile(false);
    }
  };

  const handleChangePassword = async () => {
    setPasswordError(null);
    setPasswordSuccess(false);
    if (!currentPassword || !newPassword) {
      setPasswordError('Please fill in all fields');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match');
      return;
    }
    setIsChangingPassword(true);
    try {
      await changePassword(currentPassword, newPassword);
      setPasswordSuccess(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      // The backend revoked all refresh tokens and API keys; log out locally
      // and force re-authentication with the new password.
      setTimeout(() => {
        logout();
        navigate('/auth');
      }, 1500);
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : 'Failed to change password');
    } finally {
      setIsChangingPassword(false);
    }
  };

  const handleThemeChange = (newTheme: ThemePreference) => {
    setTheme(newTheme);
    applyTheme(newTheme, oledMode);
    setSetting('theme', newTheme).catch(console.error);
  };

  const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  const handleOledModeChange = (enabled: boolean) => {
    setOledMode(enabled);
    setSetting('oled_mode', enabled).catch(console.error);
  };

  const handleAccentColorChange = (color: AccentColor) => {
    setAccentColor(color);
    setSetting('accent_color', color).catch(console.error);
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

  const handleFirstDayOfWeekChange = (day: FirstDayOfWeek) => {
    setFirstDayOfWeek(day);
    setSetting('first_day_of_week', day).catch(console.error);
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
                    { value: 'light', icon: "mdi mdi-weather-sunny", label: 'Light theme' },
                    { value: 'dark', icon: "mdi mdi-weather-night", label: 'Dark theme' },
                    { value: 'system', icon: "mdi mdi-monitor", label: 'System theme' },
                  ]}
                  value={theme}
                  onChange={(value) => handleThemeChange(value as ThemePreference)}
                  size="sm"
                />
              </div>

              <div className="settings-item">
                <div className="settings-item__info">
                  <label className="settings-item__label">
                    Pure Black
                    {!isDark && (
                      <span className="settings-badge">Dark only</span>
                    )}
                  </label>
                  <p className="settings-item__description">
                    Pure black backgrounds for OLED displays
                  </p>
                </div>
                <BooleanToggle
                  checked={oledMode}
                  onChange={() => handleOledModeChange(!oledMode)}
                  disabled={!isDark}
                  size="md"
                />
              </div>

              <div className="settings-item">
                <div className="settings-item__info">
                  <label className="settings-item__label">Accent Color</label>
                  <p className="settings-item__description">
                    Functional accent for tags, badges, and active states
                  </p>
                </div>
                <div className="settings-accent-options">
                  {ACCENT_COLOR_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={`settings-accent-swatch ${accentColor === option.value ? 'settings-accent-swatch--active' : ''}`}
                      style={{ backgroundColor: option.hex }}
                      onClick={() => handleAccentColorChange(option.value)}
                      aria-label={option.label}
                      title={option.label}
                    />
                  ))}
                </div>
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
                    { value: '0', icon: "mdi mdi-close-circle-outline", label: 'Disabled' },
                    { value: '1', icon: "mdi mdi-numeric-1", label: 'Level 1' },
                    { value: '2', icon: "mdi mdi-numeric-2", label: 'Level 2' },
                    { value: '3', icon: "mdi mdi-numeric-3", label: 'Level 3' },
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
                    { value: 'inline-tag', icon: "mdi mdi-tag", label: 'Inline tag (node link with is_tag)' },
                    { value: 'inline-class', icon: "mdi mdi-shape-outline", label: 'Inline class (class reference)' },
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
                  <label className="settings-item__label">First day of week</label>
                  <p className="settings-item__description">
                    Choose which day starts the week in calendars
                  </p>
                </div>
                <select
                  className="settings-item__select"
                  value={firstDayOfWeek}
                  onChange={(e) => handleFirstDayOfWeekChange(parseInt(e.target.value, 10) as FirstDayOfWeek)}
                >
                  {FIRST_DAY_OF_WEEK_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
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
                    { value: 'today', icon: "mdi mdi-calendar-today", label: "Today's Page" },
                    { value: 'inbox', icon: "mdi mdi-inbox", label: 'Inbox' },
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
                    Show dev tools in command palette and other places.
                  </p>
                </div>
                <BooleanToggle
                  checked={showDevOptions}
                  onChange={(e) => handleShowDevOptionsChange(e.target.checked)}
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
                    {(user?.name || user?.email || '?').charAt(0).toUpperCase()}
                  </div>
                  <div className="settings-user-details">
                    <p className="settings-user-name">{user?.name || user?.email || 'User'}</p>
                    <p className="settings-user-id">{user?.email || 'Unknown'}</p>
                  </div>
                </div>

                <div className="settings-account-meta">
                  <div className="settings-meta-item">
                    <span className="settings-meta-label">Account Type</span>
                    <span className="settings-meta-value">{user?.role === 'admin' ? 'Admin' : 'Standard'}</span>
                  </div>
                  <div className="settings-meta-item">
                    <span className="settings-meta-label">Status</span>
                    <span className="settings-meta-value settings-meta-value--active">Active</span>
                  </div>
                </div>
              </div>

              <Separator orientation="horizontal" size="lg" spacing="lg" />

              <div className="settings-section">
                <h4 className="settings-section__title">Edit Profile</h4>
                <div className="settings-form-row">
                  <label className="settings-form-label" htmlFor="profile-name">Name</label>
                  <input
                    id="profile-name"
                    type="text"
                    className="settings-form-input"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    placeholder="Your name"
                  />
                </div>
                <div className="settings-form-row">
                  <label className="settings-form-label" htmlFor="profile-surnames">Surnames</label>
                  <input
                    id="profile-surnames"
                    type="text"
                    className="settings-form-input"
                    value={editSurnames}
                    onChange={(e) => setEditSurnames(e.target.value)}
                    placeholder="Your surnames"
                  />
                </div>
                {profileError && <div className="settings-error">{profileError}</div>}
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleSaveProfile}
                  disabled={isSavingProfile}
                >
                  {isSavingProfile ? 'Saving...' : 'Save Profile'}
                </Button>
              </div>

              <Separator orientation="horizontal" size="lg" spacing="lg" />

              <div className="settings-section">
                <h4 className="settings-section__title">Change Password</h4>
                <p className="settings-section__description">
                  Changing your password will sign you out everywhere and revoke all API keys.
                </p>

                <div className="settings-form-stack">
                  <TextField
                    id="current-password"
                    type="password"
                    label="Current password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    autoComplete="current-password"
                  />
                  <TextField
                    id="new-password"
                    type="password"
                    label="New password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    autoComplete="new-password"
                  />
                  <TextField
                    id="confirm-password"
                    type="password"
                    label="Confirm new password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    autoComplete="new-password"
                  />
                </div>

                {passwordError && <div className="settings-error">{passwordError}</div>}
                {passwordSuccess && (
                  <div className="settings-success">Password changed. Signing you out…</div>
                )}

                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleChangePassword}
                  disabled={isChangingPassword || !currentPassword || !newPassword || !confirmPassword}
                >
                  {isChangingPassword ? 'Changing…' : 'Change Password'}
                </Button>
              </div>

              <Separator orientation="horizontal" size="lg" spacing="lg" />

              <div className="settings-section">
                <h4 className="settings-section__title">Device Access (API Keys)</h4>
                <p className="settings-section__description">
                  API keys allow mobile apps and background services to access your data without keeping a web session open.
                </p>

                {newKeySecret && (
                  <div className="settings-api-key-secret">
                    <p className="settings-api-key-secret__label">Your new API key (copy it now — it won't be shown again):</p>
                    <code className="settings-api-key-secret__value">{newKeySecret}</code>
                    <Button variant="default" size="sm" onClick={() => { navigator.clipboard.writeText(newKeySecret); }}>
                      Copy to Clipboard
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setNewKeySecret(null)}>
                      Dismiss
                    </Button>
                  </div>
                )}

                <div className="settings-form-row">
                  <input
                    type="text"
                    className="settings-form-input"
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                    placeholder="e.g., My Android Phone"
                  />
                  <Button variant="primary" size="sm" onClick={handleCreateApiKey} disabled={!newKeyName.trim()}>
                    Generate Key
                  </Button>
                </div>

                {apiKeyError && <div className="settings-error">{apiKeyError}</div>}

                <div className="settings-api-key-list">
                  {apiKeysLoading ? (
                    <p className="settings-api-key-list__empty">Loading...</p>
                  ) : apiKeys.length === 0 ? (
                    <p className="settings-api-key-list__empty">No API keys yet.</p>
                  ) : (
                    apiKeys.map((key) => (
                      <div key={key.id} className="settings-api-key-item">
                        <div className="settings-api-key-item__info">
                          <span className="settings-api-key-item__name">{key.name}</span>
                          <span className="settings-api-key-item__meta">
                            Created {new Date(key.created_at).toLocaleDateString()}
                            {key.last_used_at && ` • Last used ${new Date(key.last_used_at).toLocaleDateString()}`}
                          </span>
                        </div>
                        <Button variant="danger" size="xs" onClick={() => handleRevokeApiKey(key.id)}>
                          Revoke
                        </Button>
                      </div>
                    ))
                  )}
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
                <p className="settings-about__copyright">
                  © {new Date().getFullYear()} Miquel Rosell Tarragó
                </p>
              </div>

              <Separator orientation="horizontal" size="lg" spacing="md" />

              <div className="settings-privacy-card">
                <h4 className="settings-privacy-card__title">Privacy</h4>
                <p className="settings-privacy-card__text">
                  No cloud. All data stays on your device.
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

