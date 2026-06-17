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
import { useGraphSettings } from '@/features/workspace';
import { useQueryClient } from '@tanstack/react-query';
import { useNotifications } from '@/stores/notificationStore';
import { DEFAULT_SHORTCUTS, formatShortcutKey } from '@/stores/keyboardStore';
import type { ShortcutContext } from '@/stores/commandRegistry';
import { ConfirmationModal } from '@/components/ui/ConfirmationModal';
import { Modal } from '@/components/ui/Modal';
import { Spinner } from '@/components/ui/Spinner';
import { BooleanToggle } from '@/components/ui/BooleanToggle';
import { Dropdown } from '@/components/ui/Dropdown';
import { TextField } from '@/components/ui/TextField';
import { Tabs } from '@/components/ui/Tabs';
import { nodeKeys } from '@/hooks/queryKeys';
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

const TRASH_RETENTION_OPTIONS = [
  { value: 0, label: 'Never' },
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
  { value: 365, label: '1 year' },
];

const DEFAULT_RETENTION = {
  trash_retention_days: 30,
  activity_log_retention_enabled: true,
  activity_log_retention_days: 90,
  task_completion_retention_enabled: true,
  task_completion_retention_days: 365,
};

function parseRetentionValue(
  value: unknown,
  key: keyof typeof DEFAULT_RETENTION,
): typeof DEFAULT_RETENTION[keyof typeof DEFAULT_RETENTION] {
  if (key.endsWith('_enabled') && typeof value === 'boolean') {
    return value;
  }
  if (!key.endsWith('_enabled') && typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return DEFAULT_RETENTION[key];
}

function getRetentionSetting(
  settings: Record<string, unknown> | undefined,
  key: keyof typeof DEFAULT_RETENTION,
): typeof DEFAULT_RETENTION[keyof typeof DEFAULT_RETENTION] {
  if (settings == null || !(key in settings)) {
    return DEFAULT_RETENTION[key];
  }
  return parseRetentionValue(settings[key], key);
}

export function GraphSettingsModal({ isOpen, onClose }: GraphSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const { dateFormat, setDateFormat } = useSettingsStore();
  const [isUpdatingDateFormat, setIsUpdatingDateFormat] = useState(false);
  const [showDateFormatConfirm, setShowDateFormatConfirm] = useState(false);
  const [pendingDateFormat, setPendingDateFormat] = useState<DateFormat | null>(null);
  const queryClient = useQueryClient();
  const { success, error: notifyError, warning } = useNotifications();

  // Workspace settings for sidebar visibility toggles
  const { settings: workspaceSettings, updateSetting: updateSettingMutation } = useGraphSettings();

  const handleToggleChange = (key: string, value: boolean) => {
    updateSettingMutation.mutate({ key, value });
  };

  const handleNumberChange = (key: string, value: string) => {
    const parsed = parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      updateSettingMutation.mutate({ key, value: parsed });
    }
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
        queryClient.invalidateQueries({ queryKey: nodeKeys.all });
        queryClient.invalidateQueries({ queryKey: nodeKeys.allPages() });
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

  const trashRetentionDays = getRetentionSetting(workspaceSettings, 'trash_retention_days') as number;
  const activityLogEnabled = getRetentionSetting(workspaceSettings, 'activity_log_retention_enabled') as boolean;
  const activityLogDays = getRetentionSetting(workspaceSettings, 'activity_log_retention_days') as number;
  const taskCompletionEnabled = getRetentionSetting(workspaceSettings, 'task_completion_retention_enabled') as boolean;
  const taskCompletionDays = getRetentionSetting(workspaceSettings, 'task_completion_retention_days') as number;

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

                <h3 className="settings-section__title settings-section__title--spaced">Sidebar Visibility</h3>

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

                <h3 className="settings-section__title settings-section__title--spaced">Data Retention</h3>

                <div className="settings-item">
                  <div className="settings-item__info">
                    <label htmlFor="trash-retention" className="settings-item__label">Trash auto-empty</label>
                    <p className="settings-item__description">
                      Automatically and permanently delete items that have been in trash for longer than this period
                    </p>
                  </div>
                  <Dropdown
                    id="trash-retention"
                    options={TRASH_RETENTION_OPTIONS}
                    value={trashRetentionDays}
                    onChange={(value) => {
                      if (value !== null) {
                        updateSettingMutation.mutate({ key: 'trash_retention_days', value });
                      }
                    }}
                    size="sm"
                  />
                </div>

                <div className="settings-item retention-toggle-item">
                  <BooleanToggle
                    label="Activity log retention"
                    description="Automatically delete activity log entries older than the selected number of days"
                    checked={activityLogEnabled}
                    onChange={(e) => handleToggleChange('activity_log_retention_enabled', e.target.checked)}
                    labelPosition="left"
                  />
                  {activityLogEnabled && (
                    <TextField
                      type="number"
                      min={1}
                      value={String(activityLogDays)}
                      onChange={(e) => handleNumberChange('activity_log_retention_days', e.target.value)}
                      size="sm"
                      wrapperClassName="retention-days-input"
                      aria-label="Activity log retention days"
                    />
                  )}
                </div>

                <div className="settings-item retention-toggle-item">
                  <BooleanToggle
                    label="Task completion retention"
                    description="Automatically delete task completion history older than the selected number of days"
                    checked={taskCompletionEnabled}
                    onChange={(e) => handleToggleChange('task_completion_retention_enabled', e.target.checked)}
                    labelPosition="left"
                  />
                  {taskCompletionEnabled && (
                    <TextField
                      type="number"
                      min={1}
                      value={String(taskCompletionDays)}
                      onChange={(e) => handleNumberChange('task_completion_retention_days', e.target.value)}
                      size="sm"
                      wrapperClassName="retention-days-input"
                      aria-label="Task completion retention days"
                    />
                  )}
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
