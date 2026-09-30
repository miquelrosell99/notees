/**
 * WorkspaceSettingsModal Component
 *
 * Modal for workspace-level settings: rename (PATCH /workspaces/:id,
 * owner-only), date format, sidebar visibility, data retention, sources,
 * and a shortcuts reference. Recovered from the archived graph settings
 * modal; where the archive wrote workspace settings through a server
 * settings endpoint that no longer exists, controls are device-local
 * (localStorage `notees.settings.*`) or honestly inert with a
 * "not available in this build" note.
 */
import { useState } from "react";

import { Modal } from "../ui/Modal.js";
import { BooleanToggle } from "../ui/BooleanToggle.js";
import { Dropdown } from "../ui/Dropdown.js";
import { Tabs } from "../ui/Tabs.js";
import { TextField } from "../ui/TextField.js";
import { renameWorkspace } from "./workspaceApi.js";
import { useDeviceSetting } from "./deviceSettings.js";

import "./settingsModal.css";

export interface WorkspaceSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  serverUrl: string;
  credential: string;
  workspaceId: string;
  workspaceName: string;
  /** Membership role from the workspace list ("owner" may rename). */
  workspaceRole: string;
  /** Called after a successful rename so the shell can update its label. */
  onRenamed?: ((name: string) => void) | undefined;
}

type DateFormat =
  | "YYYY/MM/DD"
  | "YYYY-MM-DD"
  | "DD/MM/YYYY"
  | "DD-MM-YYYY"
  | "MM/DD/YYYY"
  | "MM-DD-YYYY";

const DATE_FORMAT_OPTIONS: { value: DateFormat; label: string; example: string }[] = [
  { value: "YYYY/MM/DD", label: "YYYY/MM/DD", example: "2026/01/15" },
  { value: "YYYY-MM-DD", label: "YYYY-MM-DD", example: "2026-01-15" },
  { value: "DD/MM/YYYY", label: "DD/MM/YYYY", example: "15/01/2026" },
  { value: "DD-MM-YYYY", label: "DD-MM-YYYY", example: "15-01-2026" },
  { value: "MM/DD/YYYY", label: "MM/DD/YYYY", example: "01/15/2026" },
  { value: "MM-DD-YYYY", label: "MM-DD-YYYY", example: "01-15-2026" },
];

const TRASH_RETENTION_OPTIONS = [
  { value: 30, label: "30 days" },
  { value: 7, label: "7 days" },
  { value: 90, label: "90 days" },
  { value: 0, label: "Never" },
  { value: 365, label: "1 year" },
];

/** Static reference table of the shell's keyboard shortcuts. */
const SHORTCUT_GROUPS: { title: string; shortcuts: { description: string; keys: string }[] }[] = [
  {
    title: "Global",
    shortcuts: [
      { description: "Open command palette", keys: "Ctrl/⌘ + K" },
      { description: "Quick add note", keys: "Ctrl/⌘ + Shift + N" },
    ],
  },
  {
    title: "Editor",
    shortcuts: [
      { description: "Bold", keys: "Ctrl/⌘ + B" },
      { description: "Italic", keys: "Ctrl/⌘ + I" },
      { description: "Strikethrough", keys: "Ctrl/⌘ + Shift + X" },
      { description: "Open link", keys: "Ctrl/⌘ + K" },
    ],
  },
  {
    title: "Search",
    shortcuts: [{ description: "Find & replace in page", keys: "Ctrl/⌘ + Shift + F" }],
  },
];

export function WorkspaceSettingsModal({
  isOpen,
  onClose,
  serverUrl,
  credential,
  workspaceId,
  workspaceName,
  workspaceRole,
  onRenamed,
}: WorkspaceSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<"general" | "shortcuts">("general");
  const [dateFormat, setDateFormat] = useDeviceSetting<DateFormat>("dateFormat", "YYYY-MM-DD");
  const [showJournals, setShowJournals] = useDeviceSetting("sidebarShowJournals", true);
  const [showInbox, setShowInbox] = useDeviceSetting("sidebarShowInbox", true);

  // Rename: edited in a local draft, persisted on blur/Enter when valid.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameSuccess, setRenameSuccess] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const canRename = workspaceRole === "owner";

  if (!isOpen) return null;

  const currentName = workspaceName || "Workspace";

  const commitRename = () => {
    if (nameDraft === null) return;
    const trimmed = nameDraft.trim();
    setNameDraft(null);
    if (trimmed === "" || trimmed === currentName) return;
    setRenaming(true);
    setRenameError(null);
    setRenameSuccess(false);
    renameWorkspace(serverUrl, credential, workspaceId, trimmed)
      .then((result) => {
        setRenaming(false);
        setRenameSuccess(true);
        onRenamed?.(result.name ?? trimmed);
      })
      .catch((err: unknown) => {
        setRenaming(false);
        setRenameError(err instanceof Error ? err.message : String(err));
      });
  };

  const handleDateFormatChange = (newFormat: DateFormat) => {
    if (newFormat !== dateFormat) {
      setDateFormat(newFormat);
    }
  };

  const tabs = [
    { id: "general" as const, label: "General" },
    { id: "shortcuts" as const, label: "Shortcuts" },
  ];

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Workspace Settings"
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
          {activeTab === "shortcuts" && (
            <div className="settings-section">
              {SHORTCUT_GROUPS.map((group) => (
                <div key={group.title} className="settings-shortcuts__group">
                  <h3 className="settings-shortcuts__group-title">{group.title}</h3>
                  <table className="settings-shortcuts__table">
                    <tbody>
                      {group.shortcuts.map((shortcut) => (
                        <tr key={shortcut.description} className="settings-shortcuts__row">
                          <td className="settings-shortcuts__description">
                            {shortcut.description}
                          </td>
                          <td className="settings-shortcuts__key">
                            <kbd className="settings-shortcuts__kbd">{shortcut.keys}</kbd>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}

          {activeTab === "general" && (
            <div className="settings-section">
              <h3 className="settings-section__title">Workspace</h3>

              <div className="settings-form-row">
                <label className="settings-form-label" htmlFor="workspace-settings-name">
                  Name
                </label>
                <input
                  id="workspace-settings-name"
                  type="text"
                  className="settings-form-input"
                  value={nameDraft ?? currentName}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                  }}
                  disabled={!canRename || renaming}
                />
                {!canRename && (
                  <p className="settings-item__description">
                    Only the workspace owner can rename this workspace.
                  </p>
                )}
              </div>
              {renameError && <div className="settings-error">{renameError}</div>}
              {renameSuccess && <div className="settings-success">Workspace renamed.</div>}

              <h3 className="settings-section__title settings-section__title--spaced">
                Graph Settings
              </h3>

              <div className="settings-item">
                <div className="settings-item__info">
                  <label htmlFor="graph-date-format" className="settings-item__label">
                    Date format
                  </label>
                  <p className="settings-item__description">
                    Format used for daily and monthly notes in this workspace
                  </p>
                </div>
                <select
                  id="graph-date-format"
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

              <h3 className="settings-section__title settings-section__title--spaced">
                Sidebar Visibility
              </h3>

              <div className="settings-item">
                <BooleanToggle
                  label="Journals"
                  description="Show the Journals button in the sidebar"
                  checked={showJournals}
                  onChange={(e) => setShowJournals(e.target.checked)}
                  labelPosition="left"
                />
              </div>

              <div className="settings-item">
                <BooleanToggle
                  label="Inbox"
                  description="Show the Inbox button in the sidebar"
                  checked={showInbox}
                  onChange={(e) => setShowInbox(e.target.checked)}
                  labelPosition="left"
                />
              </div>

              <h3 className="settings-section__title settings-section__title--spaced">
                Data Retention
              </h3>

              <div className="settings-item">
                <div className="settings-item__info">
                  <label htmlFor="trash-retention" className="settings-item__label">
                    Trash auto-empty
                  </label>
                  <p className="settings-item__description">
                    Automatically and permanently delete items that have been in trash for longer
                    than this period
                  </p>
                  <p className="settings-item__description">Not available in this build.</p>
                </div>
                <Dropdown
                  id="trash-retention"
                  options={TRASH_RETENTION_OPTIONS}
                  value={30}
                  onChange={() => undefined}
                  size="sm"
                  disabled
                />
              </div>

              <div className="settings-item retention-toggle-item">
                <BooleanToggle
                  label="Activity log retention"
                  description="Automatically delete activity log entries older than the selected number of days"
                  checked={false}
                  onChange={() => undefined}
                  labelPosition="left"
                  disabled
                />
                <span className="settings-unavailable">Not available in this build.</span>
              </div>

              <div className="settings-item retention-toggle-item">
                <BooleanToggle
                  label="Task completion retention"
                  description="Automatically delete task completion history older than the selected number of days"
                  checked={false}
                  onChange={() => undefined}
                  labelPosition="left"
                  disabled
                />
                <span className="settings-unavailable">Not available in this build.</span>
              </div>

              <h3 className="settings-section__title settings-section__title--spaced">Sources</h3>

              <div className="settings-item">
                <div className="settings-item__info">
                  <label htmlFor="citekey-pattern" className="settings-item__label">
                    Citekey pattern
                  </label>
                  <p className="settings-item__description">
                    Pattern used when import integrations fill an empty citekey. Tokens:{" "}
                    <code>family_name</code>, <code>organization_name</code>, <code>year</code>,{" "}
                    <code>title_word</code> with <code>:lower</code>/<code>:upper</code> modifiers.
                    Existing citekeys are never recomputed — changes apply only to future
                    generations.
                  </p>
                  <p className="settings-item__description">Not available in this build.</p>
                </div>
                <TextField
                  id="citekey-pattern"
                  value="{family_name:lower}{year}"
                  onChange={() => undefined}
                  size="sm"
                  aria-label="Citekey pattern"
                  disabled
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
