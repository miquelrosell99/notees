/**
 * GraphSettingsModal Component
 * 
 * Modal for graph/workspace-level settings only.
 * User-level settings (theme, account) are in UserSettingsModal.
 */
import { useState } from 'react';
import { useSettingsStore, DATE_FORMAT_OPTIONS } from '@/stores';
import type { DateFormat } from '@/stores';
import { updateDateFormat } from '@/api/nodes';
import { getWorkspaceSettings, setWorkspaceSetting } from '@/features/workspace/api/workspaces';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useNotifications } from '@/stores/notificationStore';
import { DEFAULT_SHORTCUTS, formatShortcutKey } from '@/stores/keyboardStore';
import type { ShortcutContext } from '@/stores/commandRegistry';
import { ConfirmationModal } from '@/components/ui/ConfirmationModal';
import { Modal } from '@/components/ui/Modal';
import { Spinner } from '@/components/ui/Spinner';
import { BooleanToggle } from '@/components/ui/BooleanToggle';
import { Tabs } from '@/components/ui/Tabs';
import { workspaceSettingsKeys } from '@/hooks/queryKeys';
import './GraphSettingsModal.css';

interface GraphSettingsModalProps {
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

export function GraphSettingsModal({ isOpen, onClose }: GraphSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const { dateFormat, setDateFormat } = useSettingsStore();
  const [isUpdatingDateFormat, setIsUpdatingDateFormat] = useState(false);
  const [showDateFormatConfirm, setShowDateFormatConfirm] = useState(false);
  const [pendingDateFormat, setPendingDateFormat] = useState<DateFormat | null>(null);
  const queryClient = useQueryClient();
  const { success, error: notifyError, warning } = useNotifications();

  // Workspace settings for sidebar visibility toggles
  const { data: workspaceSettings } = useQuery({
    queryKey: workspaceSettingsKeys.all,
    queryFn: getWorkspaceSettings,
    staleTime: 1000 * 60 * 5,
  });

  const updateSettingMutation = useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) => setWorkspaceSetting(key, value),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workspaceSettingsKeys.all });
    },
  });

  const handleToggleChange = (key: string, value: boolean) => {
    updateSettingMutation.mutate({ key, value });
  };

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
    } catch {
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
          <Tabs value={activeTab} onChange={setActiveTab}>
            <Tabs.List>
              {tabs.map((tab) => (
                <Tabs.Tab key={tab.id} value={tab.id}>
                  {tab.label}
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </Tabs>

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
                    <label htmlFor="graph-date-format" className="settings-item__label">Date format</label>
                    <p className="settings-item__description">
                      Format used for daily and monthly notes in this graph
                    </p>
                  </div>
                  <select
                    id="graph-date-format"
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
                    <span className="settings-item__loading"><Spinner size="sm" label="Updating..." /></span>
                  )}
                </div>

                <h3 className="settings-section__title" style={{ marginTop: 'var(--spacing-6)' }}>Sidebar Visibility</h3>

                <div className="settings-item">
                  <BooleanToggle
                    label="Journals"
                    description="Show the Journals button in the sidebar"
                    checked={(workspaceSettings?.sidebar_show_journals as boolean | undefined) ?? true}
                    onChange={(e) => handleToggleChange('sidebar_show_journals', e.target.checked)}
                    labelPosition="left"
                  />
                </div>

                <div className="settings-item">
                  <BooleanToggle
                    label="Inbox"
                    description="Show the Inbox button in the sidebar"
                    checked={(workspaceSettings?.sidebar_show_inbox as boolean | undefined) ?? true}
                    onChange={(e) => handleToggleChange('sidebar_show_inbox', e.target.checked)}
                    labelPosition="left"
                  />
                </div>

                <div className="settings-item">
                  <BooleanToggle
                    label="Whiteboards"
                    description="Show the Whiteboards button in the sidebar"
                    checked={(workspaceSettings?.sidebar_show_whiteboards as boolean | undefined) ?? true}
                    onChange={(e) => handleToggleChange('sidebar_show_whiteboards', e.target.checked)}
                    labelPosition="left"
                  />
                </div>

                <div className="settings-item">
                  <BooleanToggle
                    label="Tasks"
                    description="Show the Tasks button in the sidebar"
                    checked={(workspaceSettings?.sidebar_show_tasks as boolean | undefined) ?? true}
                    onChange={(e) => handleToggleChange('sidebar_show_tasks', e.target.checked)}
                    labelPosition="left"
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
