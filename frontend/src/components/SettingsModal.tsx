/**
 * SettingsModal Component
 * 
 * Modal for app settings, user info, and account management.
 */
import { useState } from 'react';
import { useAuthStore, useSettingsStore, applyTheme, DATE_FORMAT_OPTIONS } from '@/stores';
import type { ThemePreference, DateFormat, QuickAddDestination } from '@/stores';
import { updateDateFormat } from '@/api/nodes';
import { useQueryClient } from '@tanstack/react-query';
import { ConfirmationModal } from './core/ConfirmationModal';
import { ButtonClose } from './core/ButtonClose';
import { Button } from './core/Button';
import { Separator } from './core/Separator';
import { BooleanToggle } from './core/BooleanToggle';
import './SettingsModal.css';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type SettingsTab = 'general' | 'account' | 'appearance' | 'about';

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const { user, logout } = useAuthStore();
  const { theme, dateFormat, defaultView, quickAddDestination, setTheme, setDateFormat, setDefaultView, setQuickAddDestination } = useSettingsStore();
  const [isUpdatingDateFormat, setIsUpdatingDateFormat] = useState(false);
  const [showDateFormatConfirm, setShowDateFormatConfirm] = useState(false);
  const [pendingDateFormat, setPendingDateFormat] = useState<DateFormat | null>(null);
  const queryClient = useQueryClient();

  if (!isOpen) return null;

  const handleLogout = () => {
    logout();
    onClose();
  };

  const handleThemeChange = (newTheme: ThemePreference) => {
    setTheme(newTheme);
    applyTheme(newTheme);
  };

  const handleDateFormatChange = async (newFormat: DateFormat) => {
    if (newFormat === dateFormat) return;
    
    // Show confirmation modal
    setPendingDateFormat(newFormat);
    setShowDateFormatConfirm(true);
  };

  const handleDateFormatConfirm = async () => {
    if (!pendingDateFormat) return;
    
    setShowDateFormatConfirm(false);
    setIsUpdatingDateFormat(true);
    
    try {
      const result = await updateDateFormat(pendingDateFormat);
      if (result.status === 'success') {
        setDateFormat(pendingDateFormat);
        // Invalidate queries to refresh node names
        queryClient.invalidateQueries({ queryKey: ['nodes'] });
        queryClient.invalidateQueries({ queryKey: ['page'] });
      }
      if (result.errors.length > 0) {
        console.error('Some date format updates failed:', result.errors);
      }
    } catch (error) {
      console.error('Failed to update date format:', error);
      alert('Failed to update date format. Please try again.');
    } finally {
      setIsUpdatingDateFormat(false);
      setPendingDateFormat(null);
    }
  };

  const handleDateFormatCancel = () => {
    setShowDateFormatConfirm(false);
    setPendingDateFormat(null);
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const tabs: { id: SettingsTab; label: string; }[] = [
    { id: 'general', label: 'General'},
    { id: 'appearance', label: 'Appearance'},
    { id: 'account', label: 'Account'},
    { id: 'about', label: 'About'},
  ];

  return (
    <div className="modal-backdrop" onClick={handleBackdropClick}>
      <div className="settings-modal">
        <div className="settings-modal__header">
          <h2 className="settings-modal__title">Settings</h2>
          <ButtonClose className="settings-modal__close" onClick={onClose} size="sm" />
        </div>

        <div className="settings-modal__body">
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
            {activeTab === 'general' && (
              <div className="settings-section">
                <h3 className="settings-section__title">General Settings</h3>
                
                <div className="settings-item">
                  <div className="settings-item__info">
                    <label className="settings-item__label">Date format</label>
                    <p className="settings-item__description">
                      Format used for daily and monthly notes
                    </p>
                  </div>
                  <select 
                    className="settings-item__select"
                    value={dateFormat}
                    onChange={(e) => handleDateFormatChange(e.target.value as DateFormat)}
                    disabled={isUpdatingDateFormat}
                  >
                    {DATE_FORMAT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label} ({option.example})
                      </option>
                    ))}
                  </select>
                  {isUpdatingDateFormat && (
                    <span className="settings-item__loading">Updating...</span>
                  )}
                </div>

                <div className="settings-item">
                  <div className="settings-item__info">
                    <label className="settings-item__label">Default view</label>
                    <p className="settings-item__description">
                      Choose what to show when opening the app
                    </p>
                  </div>
                  <select 
                    className="settings-item__select"
                    value={defaultView}
                    onChange={(e) => setDefaultView(e.target.value as 'journal' | 'all-pages' | 'graph' | 'today')}
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
                  <select 
                    className="settings-item__select"
                    value={quickAddDestination}
                    onChange={(e) => setQuickAddDestination(e.target.value as QuickAddDestination)}
                  >
                    <option value="today">Today's Page</option>
                    <option value="inbox">Inbox</option>
                  </select>
                </div>

                <div className="settings-item">
                  <div className="settings-item__info">
                    <label className="settings-item__label">Show daily notes</label>
                    <p className="settings-item__description">
                      Automatically create daily notes
                    </p>
                  </div>
                  <BooleanToggle 
                    checked={true} 
                    onChange={() => {}}
                    size="md"
                  />
                </div>
              </div>
            )}

            {activeTab === 'appearance' && (
              <div className="settings-section">
                <h3 className="settings-section__title">Appearance</h3>
                
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
                    <label className="settings-item__label">Font size</label>
                    <p className="settings-item__description">
                      Adjust the base font size
                    </p>
                  </div>
                  <select className="settings-item__select">
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
                
                <div className="settings-user-info">
                  <div className="settings-user-avatar">
                    {user?.username?.charAt(0).toUpperCase() || '?'}
                  </div>
                  <div className="settings-user-details">
                    <p className="settings-user-name">{user?.username || 'User'}</p>
                    <p className="settings-user-id">ID: {user?.id || 'Unknown'}</p>
                  </div>
                </div>

                <Separator orientation="horizontal" size="lg" spacing="md" />

                <Button className="settings-btn" variant="danger" size="md" onClick={handleLogout}>
                  <span></span>
                  Log out
                </Button>
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
                  <a href="#" className="settings-link">
                    Documentation
                  </a>
                  <a href="#" className="settings-link">
                    Report a bug
                  </a>
                  <a href="#" className="settings-link">
                    Feature request
                  </a>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      <ConfirmationModal
        isOpen={showDateFormatConfirm}
        title="Change Date Format"
        message={`This will rename all date and month pages to the new format (${pendingDateFormat}).\n\nThis action cannot be undone. Continue?`}
        confirmLabel="Aceptar"
        cancelLabel="Cancelar"
        variant="primary"
        onConfirm={handleDateFormatConfirm}
        onCancel={handleDateFormatCancel}
      />    </div>
  );
}

export default SettingsModal;
