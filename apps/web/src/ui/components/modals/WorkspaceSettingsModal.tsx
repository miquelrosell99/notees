/**
 * WorkspaceSettingsModal Component
 *
 * Modal for workspace-level settings: rename (PATCH /workspaces/:id,
 * owner-only), date format, sidebar visibility, calendar quick-create chip
 * classes (per-workspace device-local), data retention, sources, and a
 * shortcuts reference. Recovered from the archived graph settings modal;
 * where the archive wrote workspace settings through a server settings
 * endpoint that no longer exists, controls are device-local (localStorage
 * `notees.settings.*`) or honestly inert with a "not available in this
 * build" note.
 */
import { useEffect, useMemo, useState } from "react";

import type { WorkspaceFeature } from "@notees/protocol";
import {
  SYSTEM_CLASS_ICONS,
  SYSTEM_CLASS_UUIDS,
  WORKSPACE_FEATURE_MAP,
} from "@notees/domain";

import type { AnyClient } from "../Sidebar.js";
import { displayNameFromClient } from "../../dateDisplay.js";
import { Modal } from "../ui/Modal.js";
import { BooleanToggle } from "../ui/BooleanToggle.js";
import { Button } from "../ui/Button.js";
import { Dropdown } from "../ui/Dropdown.js";
import { Icon } from "../../Icon.js";
import { Tabs } from "../ui/Tabs.js";
import { TextField } from "../ui/TextField.js";
import { ToggleSwitch } from "../ui/ToggleSwitch.js";
import { cssColorFor } from "../ui/colorPresets.js";
import { renameWorkspace } from "./workspaceApi.js";
import { PluginsSettingsTab } from "./PluginsSettingsTab.js";
import { useDeviceSetting } from "./deviceSettings.js";
import { isClassFamilyEnabled } from "../featureGates.js";
import { dateChipCandidates } from "../calendarViewUtils.js";
import {
  resolveQuickCreateChipClasses,
  useQuickCreateClassesSetting,
} from "../calendarQuickCreateSettings.js";

import "./settingsModal.css";

/**
 * LOCKSTEP-PENDING (§34.35 protocol batch, part 1): the feature toggles READ
 * through the shipped `workspace.feature.set` op + `workspace_feature`
 * derived table (store applier, canonical fixtures, both web clients), but
 * the WRITE path stays inert until the GTK/Flutter clients ship the op —
 * nothing may author it into a live log while older clients fail loud on
 * unknown opTypes. The tab renders the live state with disabled switches;
 * the write (a `workspace.feature.set` through the normal client op path,
 * with the F3 "N existing objects keep their data" confirmation when
 * instances exist) lands with the lockstep release.
 */
const FEATURE_TOGGLE_WRITES_ENABLED = true; // lockstep SHIPPED: GTK/Flutter v3.0.0

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
  /**
   * The active workspace's client — powers the Calendar quick-create
   * section's eligible-class enumeration. Only sections whose workspaceId
   * matches the client's are configurable; without a client (or for another
   * workspace's settings) the section renders an honest note instead.
   */
  client?: AnyClient | undefined;
}

export function WorkspaceSettingsModal({
  isOpen,
  onClose,
  serverUrl,
  credential,
  workspaceId,
  workspaceName,
  workspaceRole,
  onRenamed,
  client,
}: WorkspaceSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<"general" | "features" | "plugins" | "shortcuts">("general");
  const [dateFormat, setDateFormat] = useDeviceSetting<DateFormat>("dateFormat", "YYYY-MM-DD");
  const [showJournals, setShowJournals] = useDeviceSetting("sidebarShowJournals", true);
  const [showInbox, setShowInbox] = useDeviceSetting("sidebarShowInbox", true);
  const [showCalendar, setShowCalendar] = useDeviceSetting("sidebarShowCalendar", true);

  // Rename: edited in a local draft, persisted on blur/Enter when valid.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameSuccess, setRenameSuccess] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const canRename = workspaceRole === "owner";

  // --- Calendar quick-create (per-workspace device-local chip list) --------
  // The enumeration follows the live store (bindings can be authored while
  // the modal is open); the setting read/write rides deviceSettings.
  const clientMatches = client !== undefined && client.getWorkspaceId() === workspaceId;
  const [, setClassesVersion] = useState(0);
  useEffect(() => {
    if (client === undefined) return;
    return client.subscribe(() => setClassesVersion((v) => v + 1));
  }, [client]);
  const [storedChips, setStoredChips] = useQuickCreateClassesSetting(
    clientMatches ? workspaceId : null,
  );
  const eligibleChips = useMemo(() => {
    if (client === undefined) return [];
    const classes = client
      .listClasses()
      .map((cls) => ({ id: cls.id, name: displayNameFromClient(client, cls.id) }));
    return dateChipCandidates(classes, (classId) => client.getClassBindings(classId)).filter((chip) =>
      isClassFamilyEnabled(client, chip.classId),
    );
    // classesVersion keeps the enumeration fresh across store notifications.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, storedChips, setClassesVersion]);
  const effectiveChipIds = resolveQuickCreateChipClasses(
    storedChips,
    eligibleChips.map((chip) => chip.classId),
  );
  const toggleChip = (classId: string, checked: boolean) => {
    const next = checked
      ? [...effectiveChipIds, classId]
      : effectiveChipIds.filter((id) => id !== classId);
    setStoredChips(next);
  };

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
    { id: "features" as const, label: "Features" },
    { id: "plugins" as const, label: "Plugins" },
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
          {activeTab === "features" && (
            <div className="settings-section">
              <h3 className="settings-section__title">Features</h3>
              <p className="settings-item__description">
                Core class families, one toggle each. Turning a family off hides its classes
                from pickers, search, and hubs — existing objects keep their data and stay in
                the graph. Family changes cascade to subclasses (events off hides meetings and
                birthdays too).
              </p>
              {clientMatches ? (
                <>
                  {(
                    Object.entries(WORKSPACE_FEATURE_MAP) as Array<
                      [WorkspaceFeature, (typeof WORKSPACE_FEATURE_MAP)[WorkspaceFeature]]
                    >
                  ).map(([feature, spec]) => {
                    const enabled = client!.isFeatureEnabled(feature);
                    const instances = client!.getFeatureInstanceCount(feature);
                    const classId = SYSTEM_CLASS_UUIDS[spec.baseClass];
                    const classNode = client!.getNodeRaw(classId);
                    const icon = classNode?.icon ?? SYSTEM_CLASS_ICONS[spec.baseClass];
                    const color = client!.effectiveClassColor(classId);
                    return (
                      <div className="settings-item settings-feature-row" key={feature}>
                        <span
                          className="settings-feature-row__icon"
                          style={
                            color !== null
                              ? { color: cssColorFor(color), borderColor: cssColorFor(color) }
                              : undefined
                          }
                        >
                          <Icon path={icon} size={1} />
                        </span>
                        <span className="settings-feature-row__text">
                          <span className="settings-feature-row__title">
                            {classNode ? displayNameFromClient(client!, classId) : spec.label}
                          </span>
                          <span className="settings-feature-row__powers">
                            {spec.powers}
                            {instances > 0
                              ? ` — ${instances} existing object${instances === 1 ? "" : "s"}`
                              : ""}
                          </span>
                        </span>
                        <ToggleSwitch
                          leftLabel="Off"
                          rightLabel="On"
                          checked={enabled}
                          onChange={(next) => {
                            if (client === null) return;
                            void client.setFeatureEnabled(feature, next).catch((error: unknown) => {
                              console.warn(`[features] setFeatureEnabled (${feature}) failed:`, error);
                            });
                          }}
                          disabled={!FEATURE_TOGGLE_WRITES_ENABLED || client === null}
                          size="sm"
                          aria-label={`${spec.label} feature`}
                        />
                      </div>
                    );
                  })}
                  {/* The write issues a workspace.feature.set through the
                      normal client op path (lockstep SHIPPED: GTK/Flutter
                      v3.0.0). F3's "N existing objects keep their data"
                      confirmation rides a follow-up; the instance count
                      shows beside the powers line meanwhile. */}
                </>
              ) : (
                <p className="settings-item__description">
                  Open this workspace to see its feature toggles.
                </p>
              )}
            </div>
          )}

          {activeTab === "plugins" && (
            <PluginsSettingsTab serverUrl={serverUrl} credential={credential} />
          )}

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

              <div className="settings-item">
                <BooleanToggle
                  label="Calendar"
                  description="Show the Calendar button in the sidebar"
                  checked={showCalendar}
                  onChange={(e) => setShowCalendar(e.target.checked)}
                  labelPosition="left"
                />
              </div>

              <h3 className="settings-section__title settings-section__title--spaced">
                Calendar Quick-Create
              </h3>

              {clientMatches ? (
                <>
                  <p className="settings-item__description">
                    Classes offered as quick-create chips on the Calendar day view. By default
                    every class with a date property appears — today that means the Task class.
                    Uncheck to narrow the list for this workspace.
                  </p>
                  {eligibleChips.length === 0 ? (
                    <p className="settings-item__description">
                      No classes with a date property yet. The Task class appears here once the
                      workspace has one — open the Calendar or Tasks view once to author it.
                    </p>
                  ) : (
                    eligibleChips.map((chip) => (
                      <div className="settings-item" key={chip.classId}>
                        <BooleanToggle
                          label={chip.label}
                          {...(chip.propertyName !== null ? { description: chip.propertyName } : {})}
                          checked={effectiveChipIds.includes(chip.classId)}
                          onChange={(e) => toggleChip(chip.classId, e.target.checked)}
                          labelPosition="left"
                        />
                      </div>
                    ))
                  )}
                  {storedChips !== null && (
                    <div className="settings-item">
                      <Button variant="ghost" size="sm" onClick={() => setStoredChips(null)}>
                        Reset to defaults
                      </Button>
                    </div>
                  )}
                </>
              ) : (
                <p className="settings-item__description">
                  Open this workspace to configure its calendar quick-create chips.
                </p>
              )}

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
