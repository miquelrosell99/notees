/**
 * SettingsModal Component
 * 
 * Modal for graph/workspace-level settings only.
 * User-level settings (theme, account) are in UserSettingsModal.
 */
import { useState } from 'react';
import { useSettingsStore, DATE_FORMAT_OPTIONS } from '@/stores';
import type { DateFormat, QuickAddDestination } from '@/stores';
import { updateDateFormat } from '@/api/nodes';
import { useQueryClient } from '@tanstack/react-query';
import { ConfirmationModal } from '../core/ConfirmationModal';
import { Modal } from '../core/Modal';
import { Button } from '../core/Button';
import { BooleanToggle } from '../core/BooleanToggle';
import './SettingsModal.css';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type SettingsTab = 'general';

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const { dateFormat, defaultView, quickAddDestination, linkedRefsCollapseLevel, setDateFormat, setDefaultView, setQuickAddDestination, setLinkedRefsCollapseLevel } = useSettingsStore();
  const [isUpdatingDateFormat, setIsUpdatingDateFormat] = useState(false);
  const [showDateFormatConfirm, setShowDateFormatConfirm] = useState(false);
  const [pendingDateFormat, setPendingDateFormat] = useState<DateFormat | null>(null);
  const queryClient = useQueryClient();

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

  const tabs: { id: SettingsTab; label: string; }[] = [
    { id: 'general', label: 'General'},
  ];

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
                    <label className="settings-item__label">Default view</label>
                    <p className="settings-item__description">
                      Choose what to show when opening this graph
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
                    <label className="settings-item__label">Linked refs collapse level</label>
                    <p className="settings-item__description">
                      Auto-collapse nodes at this depth in linked references (0 = disabled)
                    </p>
                  </div>
                  <select 
                    className="settings-item__select"
                    value={linkedRefsCollapseLevel}
                    onChange={(e) => setLinkedRefsCollapseLevel(parseInt(e.target.value, 10))}
                  >
                    <option value="0">Disabled</option>
                    <option value="1">Level 1</option>
                    <option value="2">Level 2</option>
                    <option value="3">Level 3</option>
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