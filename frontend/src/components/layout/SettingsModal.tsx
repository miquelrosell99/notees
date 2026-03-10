/**
 * SettingsModal Component
 * 
 * Modal for graph/workspace-level settings only.
 * User-level settings (theme, account) are in UserSettingsModal.
 */
import { useState } from 'react';
import { useSettingsStore, DATE_FORMAT_OPTIONS } from '@/stores';
import type { DateFormat } from '@/stores';
import { updateDateFormat } from '@/api/nodes';
import { useQueryClient } from '@tanstack/react-query';
import { useNotifications } from '@/stores/notificationStore';
import { DEFAULT_SHORTCUTS, formatShortcutKey } from '@/stores/keyboardStore';
import type { ShortcutContext } from '@/stores/keyboardStore';
import { ConfirmationModal } from '../core/ConfirmationModal';
import { Modal } from '../core/Modal';
import { Button } from '../core/Button';
import { BooleanToggle } from '../core/BooleanToggle';
import './SettingsModal.css';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type SettingsTab = 'general' | 'shortcuts';

const SHORTCUT_CONTEXT_LABELS: Record<ShortcutContext, string> = {
  global: 'Global',
  editor: 'Editor',
  selection: 'Selection',
  modal: 'Modal',
  sidebar: 'Sidebar',
  search: 'Search',
};

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const { dateFormat, setDateFormat } = useSettingsStore();
  const [isUpdatingDateFormat, setIsUpdatingDateFormat] = useState(false);
  const [showDateFormatConfirm, setShowDateFormatConfirm] = useState(false);
  const [pendingDateFormat, setPendingDateFormat] = useState<DateFormat | null>(null);
  const queryClient = useQueryClient();
  const { success, error: notifyError, warning } = useNotifications();

  if (!isOpen) return null;

  const handleDateFormatChange = async (newFormat: DateFormat) => {
    if (newFormat === dateFormat) return;
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
        queryClient.invalidateQueries({ queryKey: ['nodes'] });
        queryClient.invalidateQueries({ queryKey: ['page'] });
        success('Date format updated', 'Daily and monthly notes now use the new format.');
      }
      if (result.errors.length > 0) {
        warning('Some dates could not be updated', `${result.errors.length} item(s) failed to migrate.`);
      }
    } catch (error) {
      notifyError('Failed to update date format', 'Please try again.');
    } finally {
      setIsUpdatingDateFormat(false);
      setPendingDateFormat(null);
    }
  };

  const handleDateFormatCancel = () => {
    setShowDateFormatConfirm(false);
    setPendingDateFormat(null);
  };

  const tabs: { id: SettingsTab; label: string; }[] = [
    { id: 'general', label: 'General'},
    { id: 'shortcuts', label: 'Shortcuts'},
  ];

  const shortcutsByContext = DEFAULT_SHORTCUTS.reduce<Record<string, typeof DEFAULT_SHORTCUTS>>((acc, s) => {
    const label = SHORTCUT_CONTEXT_LABELS[s.context] ?? s.context;
    if (!acc[label]) acc[label] = [];
    acc[label].push(s);
    return acc;
  }, {});

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Settings"
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
            {activeTab === 'shortcuts' && (
              <div className="settings-section">
                {Object.entries(shortcutsByContext).map(([group, shortcuts]) => (
                  <div key={group} className="settings-shortcuts__group">
                    <h3 className="settings-shortcuts__group-title">{group}</h3>
                    <table className="settings-shortcuts__table">
                      <tbody>
                        {shortcuts.map(s => (
                          <tr key={s.id} className="settings-shortcuts__row">
                            <td className="settings-shortcuts__description">{s.description}</td>
                            <td className="settings-shortcuts__key">
                              <kbd className="settings-shortcuts__kbd">{formatShortcutKey(s)}</kbd>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            )}
            {activeTab === 'general' && (
              <div className="settings-section">
                <h3 className="settings-section__title">Graph Settings</h3>
                
                <div className="settings-item">
                  <div className="settings-item__info">
                    <label className="settings-item__label">Date format</label>
                    <p className="settings-item__description">
                      Format used for daily and monthly notes in this graph
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
          </div>
        </div>
      </Modal>
      <ConfirmationModal
        isOpen={showDateFormatConfirm}
        title="Change Date Format"
        message={`This will rename all date and month pages to the new format (${pendingDateFormat}).\n\nThis action cannot be undone. Continue?`}
        confirmLabel="Aceptar"
        cancelLabel="Cancelar"
        variant="primary"
        onConfirm={handleDateFormatConfirm}
        onCancel={handleDateFormatCancel}
      />
    </>
  );
}

export default SettingsModal;