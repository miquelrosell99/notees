/**
 * UserSettingsModal Component
 *
 * Modal for user-level settings: appearance, editor, general preferences,
 * account (profile, API keys, sign-out), security, support, about.
 * Recovered from the archived user settings modal:
 * - appearance (theme / OLED / accent) is device-local and applies live via
 *   data-* attributes on <html> (see deviceSettings.ts);
 * - API keys talk to the real /api-keys endpoints through ApiKeysSection
 *   (the existing SettingsPanel section component);
 * - sign-out calls the real /auth/logout flow provided by the shell;
 * - controls with no v2 backend (profile edit, password change, 2FA,
 *   encryption) are honestly inert with a "not available in this build" note;
 * - remaining preferences persist device-local under `notees.settings.*`.
 */
import { useEffect, useState } from "react";

import type { AccountUser } from "@/core/auth-api.js";

import { Modal } from "../ui/Modal.js";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";
import { BooleanToggle } from "../ui/BooleanToggle.js";
import { SelectionButton } from "../ui/SelectionButton.js";
import { Tabs } from "../ui/Tabs.js";
import { Icon } from "../../Icon.js";
import { ApiKeysSection } from "../../SettingsPanel.js";
import {
  ACCENT_COLOR_OPTIONS,
  applyAppearance,
  getContrastColor,
  isValidHexColor,
  resolveTheme,
  useDeviceSetting,
  type AccentColor,
  type ThemePreference,
} from "./deviceSettings.js";

import "./settingsModal.css";
import "./UserSettingsModal.css";

export interface UserSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  serverUrl: string;
  token: string;
  user: AccountUser;
  onSignOut: () => void;
}

type BuiltInSettingsTab =
  | "appearance"
  | "editor"
  | "general"
  | "account"
  | "security"
  | "support"
  | "about";

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

const FIRST_DAY_OF_WEEK_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 6, label: "Saturday" },
];

/** Sponsorship and support channels (official project links). */
const SPONSORSHIP_CHANNELS: { id: string; name: string; description: string; url: string; icon: string }[] = [
  {
    id: "github-sponsors",
    name: "GitHub Sponsors",
    description: "Recurring support with public recognition.",
    url: "https://github.com/sponsors/miquelrosell99",
    icon: "mdi-github",
  },
  {
    id: "ko-fi",
    name: "Ko-fi",
    description: "One-time tip for users who prefer not to subscribe.",
    url: "https://ko-fi.com/miquelrosell",
    icon: "mdi-coffee",
  },
];

export function UserSettingsModal({
  isOpen,
  onClose,
  serverUrl,
  token,
  user,
  onSignOut,
}: UserSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<BuiltInSettingsTab>("appearance");

  // Appearance — device-local, applied live to <html> data-* attributes.
  const [theme, setTheme] = useDeviceSetting<ThemePreference>("theme", "system");
  const [oledMode, setOledMode] = useDeviceSetting("oledMode", false);
  const [accentColor, setAccentColor] = useDeviceSetting<AccentColor>("accentColor", "monochrome");
  const [customAccentHex, setCustomAccentHex] = useDeviceSetting("customAccentHex", "#404040");
  const [customHexInput, setCustomHexInput] = useState(customAccentHex);

  // Editor / general preferences — device-local.
  const [treeEditMode, setTreeEditMode] = useDeviceSetting<"direct" | "logical">(
    "treeEditMode",
    "logical",
  );
  const [linkedRefsCollapseLevel, setLinkedRefsCollapseLevel] = useDeviceSetting(
    "linkedRefsCollapseLevel",
    0,
  );
  const [hashtagPasteMode, setHashtagPasteMode] = useDeviceSetting<"inline-tag" | "inline-class">(
    "hashtagPasteMode",
    "inline-tag",
  );
  const [showBulletThread, setShowBulletThread] = useDeviceSetting("bulletThread", true);
  const [firstDayOfWeek, setFirstDayOfWeek] = useDeviceSetting("firstDayOfWeek", 1);
  const [dateFormat, setDateFormat] = useDeviceSetting<DateFormat>("dateFormat", "YYYY-MM-DD");
  const [defaultView, setDefaultView] = useDeviceSetting("defaultView", "today");
  const [quickAddDestination, setQuickAddDestination] = useDeviceSetting("quickAddDestination", "inbox");
  const [showDevOptions, setShowDevOptions] = useDeviceSetting("showDevOptions", false);

  // Support preferences — device-local.
  const [supportBadgeHidden, setSupportBadgeHidden] = useDeviceSetting("supportBadgeHidden", false);
  const [supportBadgeHiddenUntil, setSupportBadgeHiddenUntil] = useDeviceSetting<number | null>(
    "supportBadgeHiddenUntil",
    null,
  );

  // Keep the custom hex text input in sync with the persisted value.
  useEffect(() => {
    setCustomHexInput(customAccentHex);
  }, [customAccentHex]);

  if (!isOpen) return null;

  const isDark = resolveTheme(theme) === "dark";
  const supportBadgeVisible =
    !supportBadgeHidden || (supportBadgeHiddenUntil !== null && supportBadgeHiddenUntil <= Date.now());

  const handleThemeChange = (newTheme: ThemePreference) => {
    setTheme(newTheme);
    applyAppearance();
  };

  const handleOledModeChange = (enabled: boolean) => {
    setOledMode(enabled);
    applyAppearance();
  };

  const handleAccentColorChange = (color: AccentColor) => {
    setAccentColor(color);
    applyAppearance();
  };

  const handleCustomAccentChange = (value: string) => {
    const hex = value.startsWith("#") ? value : `#${value}`;
    setCustomHexInput(hex);
    if (!isValidHexColor(hex)) return;
    setCustomAccentHex(hex);
    if (accentColor === "custom") {
      applyAppearance();
    }
  };

  const handleCustomHexBlur = () => {
    if (!isValidHexColor(customHexInput)) {
      setCustomHexInput(customAccentHex);
    }
  };

  const handleLogout = () => {
    onSignOut();
    onClose();
  };

  const builtInTabs: { id: BuiltInSettingsTab; label: string }[] = [
    { id: "appearance", label: "Appearance" },
    { id: "editor", label: "Editor" },
    { id: "general", label: "General" },
    { id: "account", label: "Account" },
    { id: "security", label: "Security" },
    { id: "support", label: "Support" },
    { id: "about", label: "About" },
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
        <Tabs value={activeTab} onChange={setActiveTab}>
          <Tabs.List>
            {builtInTabs.map((tab) => (
              <Tabs.Tab key={tab.id} value={tab.id}>
                {tab.label}
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs>

        <div className="settings-modal__content">
          {activeTab === "appearance" && (
            <div className="settings-section">
              <h3 className="settings-section__title">Appearance</h3>
              <Card>
                <div className="settings-item">
                  <div className="settings-item__info">
                    <label htmlFor="user-theme" className="settings-item__label">
                      Theme
                    </label>
                    <p className="settings-item__description">Choose your preferred color theme</p>
                  </div>
                  <SelectionButton
                    id="user-theme"
                    options={[
                      { value: "light", icon: "mdi-weather-sunny", label: "Light theme" },
                      { value: "dark", icon: "mdi-weather-night", label: "Dark theme" },
                      { value: "system", icon: "mdi-monitor", label: "System theme" },
                    ]}
                    value={theme}
                    onChange={(value) => handleThemeChange(value as ThemePreference)}
                    size="sm"
                  />
                </div>

                <div className="settings-item">
                  <div className="settings-item__info">
                    <label htmlFor="user-oled-mode" className="settings-item__label">
                      Pure Black
                      {!isDark && <span className="settings-badge">Dark only</span>}
                    </label>
                    <p className="settings-item__description">
                      Pure black backgrounds for OLED displays
                    </p>
                  </div>
                  <BooleanToggle
                    id="user-oled-mode"
                    checked={oledMode}
                    onChange={() => handleOledModeChange(!oledMode)}
                    disabled={!isDark}
                    size="md"
                  />
                </div>

                <div className="settings-item">
                  <div className="settings-item__info">
                    <label htmlFor="user-accent-color" className="settings-item__label">
                      Accent Color
                    </label>
                    <p className="settings-item__description">
                      Functional accent for tags, badges, and active states
                    </p>
                  </div>
                  <div
                    id="user-accent-color"
                    className="settings-accent-options"
                    role="group"
                    aria-label="Accent Color"
                  >
                    {ACCENT_COLOR_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className={`settings-accent-swatch ${accentColor === option.value ? "settings-accent-swatch--active" : ""}`}
                        style={{ backgroundColor: option.hex }}
                        onClick={() => handleAccentColorChange(option.value)}
                        aria-label={option.label}
                        title={option.label}
                      />
                    ))}
                    <button
                      type="button"
                      className={`settings-accent-swatch settings-accent-swatch--custom ${accentColor === "custom" ? "settings-accent-swatch--active" : ""}`}
                      style={{ backgroundColor: customAccentHex }}
                      onClick={() => handleAccentColorChange("custom")}
                      aria-label="Custom accent color"
                      title="Custom accent color"
                    >
                      <span
                        className="settings-accent-swatch__icon"
                        style={{ color: getContrastColor(customAccentHex) }}
                      >
                        <Icon path="mdi-palette" size={0.8} />
                      </span>
                    </button>
                  </div>
                </div>

                {accentColor === "custom" && (
                  <div className="settings-item settings-item--indented">
                    <div className="settings-item__info">
                      <label className="settings-item__label" htmlFor="custom-accent-hex">
                        Custom Hex Color
                      </label>
                      <p className="settings-item__description">Enter any #RRGGBB color</p>
                    </div>
                    <div className="settings-accent-custom-input">
                      <input
                        id="custom-accent-hex"
                        type="color"
                        className="settings-accent-color-picker"
                        value={customAccentHex}
                        onChange={(e) => handleCustomAccentChange(e.target.value)}
                        aria-label="Custom accent color picker"
                      />
                      <input
                        type="text"
                        className="settings-form-input settings-accent-hex-input"
                        value={customHexInput}
                        onChange={(e) => handleCustomAccentChange(e.target.value)}
                        onBlur={handleCustomHexBlur}
                        placeholder="#527051"
                        maxLength={7}
                        aria-label="Custom accent hex value"
                      />
                    </div>
                  </div>
                )}
              </Card>
            </div>
          )}

          {activeTab === "editor" && (
            <div className="settings-section">
              <h3 className="settings-section__title">Editor</h3>
              <Card>
                <div className="settings-item">
                  <div className="settings-item__info">
                    <label htmlFor="user-tree-edit-mode" className="settings-item__label">
                      Outdent behavior
                    </label>
                    <p className="settings-item__description">
                      Direct moves only the outdented block up one level; Logical preserves
                      category grouping by moving subsequent siblings under the outdented block.
                    </p>
                  </div>
                  <SelectionButton
                    id="user-tree-edit-mode"
                    options={[
                      { value: "direct", icon: "mdi-arrow-collapse-right", label: "Direct" },
                      { value: "logical", icon: "mdi-file-tree", label: "Logical" },
                    ]}
                    value={treeEditMode}
                    onChange={(value) => setTreeEditMode(value as "direct" | "logical")}
                    size="sm"
                  />
                </div>

                <div className="settings-item">
                  <div className="settings-item__info">
                    <label htmlFor="user-linked-refs-collapse" className="settings-item__label">
                      Linked refs collapse level
                    </label>
                    <p className="settings-item__description">
                      Auto-collapse nodes at this depth in linked references (0 = disabled)
                    </p>
                  </div>
                  <SelectionButton
                    id="user-linked-refs-collapse"
                    options={[
                      { value: "0", icon: "mdi-close-circle-outline", label: "Disabled" },
                      { value: "1", icon: "mdi-numeric-1", label: "Level 1" },
                      { value: "2", icon: "mdi-numeric-2", label: "Level 2" },
                      { value: "3", icon: "mdi-numeric-3", label: "Level 3" },
                    ]}
                    value={linkedRefsCollapseLevel.toString()}
                    onChange={(value) => setLinkedRefsCollapseLevel(parseInt(value, 10))}
                    size="sm"
                  />
                </div>

                <div className="settings-item">
                  <div className="settings-item__info">
                    <label htmlFor="user-hashtag-paste" className="settings-item__label">
                      Hashtag paste behavior
                    </label>
                    <p className="settings-item__description">
                      How #hashtag patterns in pasted text should be interpreted
                    </p>
                  </div>
                  <SelectionButton
                    id="user-hashtag-paste"
                    options={[
                      { value: "inline-tag", icon: "mdi-tag", label: "Inline tag (node link with is_tag)" },
                      { value: "inline-class", icon: "mdi-shape-outline", label: "Inline class (class reference)" },
                    ]}
                    value={hashtagPasteMode}
                    onChange={(value) => setHashtagPasteMode(value as "inline-tag" | "inline-class")}
                    size="sm"
                  />
                </div>

                <div className="settings-item">
                  <div className="settings-item__info">
                    <label htmlFor="user-bullet-thread" className="settings-item__label">
                      Bullet thread
                    </label>
                    <p className="settings-item__description">
                      Highlight the active editing path with guide lines and a connecting thread
                    </p>
                  </div>
                  <BooleanToggle
                    id="user-bullet-thread"
                    checked={showBulletThread}
                    onChange={(e) => setShowBulletThread(e.target.checked)}
                    size="sm"
                  />
                </div>
              </Card>
            </div>
          )}

          {activeTab === "general" && (
            <div className="settings-section">
              <h3 className="settings-section__title">General</h3>
              <Card>
                <div className="settings-item">
                  <div className="settings-item__info">
                    <label htmlFor="user-first-day" className="settings-item__label">
                      First day of week
                    </label>
                    <p className="settings-item__description">
                      Choose which day starts the week in calendars
                    </p>
                  </div>
                  <select
                    id="user-first-day"
                    className="settings-item__select"
                    value={firstDayOfWeek}
                    onChange={(e) => setFirstDayOfWeek(parseInt(e.target.value, 10))}
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
                    <label htmlFor="user-date-format" className="settings-item__label">
                      Default date format
                    </label>
                    <p className="settings-item__description">
                      Default format for daily and monthly notes. Each workspace can override
                      this.
                    </p>
                  </div>
                  <select
                    id="user-date-format"
                    className="settings-item__select"
                    value={dateFormat}
                    onChange={(e) => setDateFormat(e.target.value as DateFormat)}
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
                    <label htmlFor="user-default-view" className="settings-item__label">
                      Default view
                    </label>
                    <p className="settings-item__description">
                      Choose what to show when opening a workspace
                    </p>
                  </div>
                  <select
                    id="user-default-view"
                    className="settings-item__select"
                    value={defaultView}
                    onChange={(e) => setDefaultView(e.target.value)}
                  >
                    <option value="today">Today's Page</option>
                    <option value="journal">Journal</option>
                    <option value="all-pages">All Pages</option>
                    <option value="graph">Graph View</option>
                  </select>
                </div>

                <div className="settings-item">
                  <div className="settings-item__info">
                    <label htmlFor="user-quick-add" className="settings-item__label">
                      Quick add destination
                    </label>
                    <p className="settings-item__description">Where to send quick add notes</p>
                  </div>
                  <SelectionButton
                    id="user-quick-add"
                    options={[
                      { value: "today", icon: "mdi-calendar-today", label: "Today's Page" },
                      { value: "inbox", icon: "mdi-inbox", label: "Inbox" },
                    ]}
                    value={quickAddDestination}
                    onChange={(value) => setQuickAddDestination(value)}
                    size="sm"
                  />
                </div>

                <div className="settings-item">
                  <div className="settings-item__info">
                    <label htmlFor="user-dev-options" className="settings-item__label">
                      Developer options
                    </label>
                    <p className="settings-item__description">
                      Show dev tools in command palette and other places.
                    </p>
                  </div>
                  <BooleanToggle
                    id="user-dev-options"
                    checked={showDevOptions}
                    onChange={(e) => setShowDevOptions(e.target.checked)}
                    size="sm"
                  />
                </div>
              </Card>
            </div>
          )}

          {activeTab === "account" && (
            <>
              <div className="settings-section">
                <h3 className="settings-section__title">Account</h3>
                <Card>
                  <div className="settings-user-card">
                    <div className="settings-user-info">
                      <div className="settings-user-avatar">
                        {(user.displayName || user.email || "?").charAt(0).toUpperCase()}
                      </div>
                      <div className="settings-user-details">
                        <p className="settings-user-name">
                          {user.displayName || user.email || "User"}
                        </p>
                        <p className="settings-user-id">{user.email || "Unknown"}</p>
                      </div>
                    </div>

                    <div className="settings-account-meta">
                      <div className="settings-meta-item">
                        <span className="settings-meta-label">Account Type</span>
                        <span className="settings-meta-value">
                          {user.isAdmin ? "Admin" : "Standard"}
                        </span>
                      </div>
                      <div className="settings-meta-item">
                        <span className="settings-meta-label">Status</span>
                        <span className="settings-meta-value settings-meta-value--active">
                          Active
                        </span>
                      </div>
                    </div>
                  </div>
                </Card>
              </div>

              <div className="settings-section">
                <h3 className="settings-section__title">Edit Profile</h3>
                <Card>
                  <p className="settings-section__subtitle">
                    Editing your profile is not available in this build.
                  </p>
                </Card>
              </div>

              <div className="settings-section">
                <h3 className="settings-section__title">Change Password</h3>
                <Card>
                  <p className="settings-section__description">
                    Changing your password will sign you out everywhere and revoke all API keys.
                  </p>
                  <p className="settings-section__subtitle">
                    Changing your password is not available in this build.
                  </p>
                </Card>
              </div>

              <div className="settings-section">
                <h3 className="settings-section__title">Device Access (API Keys)</h3>
                <Card>
                  <ApiKeysSection serverUrl={serverUrl} token={token} />
                </Card>
              </div>

              <div className="settings-section">
                <h3 className="settings-section__title">Account Actions</h3>
                <Card>
                  <Button
                    className="settings-btn settings-btn--logout"
                    variant="danger"
                    size="md"
                    onClick={handleLogout}
                  >
                    Log out
                  </Button>
                </Card>
              </div>
            </>
          )}

          {activeTab === "security" && (
            <>
              <div className="settings-section">
                <h3 className="settings-section__title">Two-Factor Authentication</h3>
                <Card>
                  <p className="settings-section__subtitle">
                    Two-factor authentication is not available in this build.
                  </p>
                </Card>
              </div>

              <div className="settings-section">
                <h3 className="settings-section__title">Encryption at Rest</h3>
                <Card>
                  <p className="settings-section__subtitle">
                    Local-cache encryption is not available in this build.
                  </p>
                </Card>
              </div>
            </>
          )}

          {activeTab === "support" && (
            <>
              <div className="settings-section">
                <h3 className="settings-section__title">Support Preferences</h3>
                <Card>
                  <div className="settings-item">
                    <div className="settings-item__info">
                      <label htmlFor="support-badge-toggle" className="settings-item__label">
                        Show support badge
                      </label>
                      <p className="settings-item__description">
                        Display a small "Support Notees" reminder in the sidebar.
                      </p>
                    </div>
                    <BooleanToggle
                      id="support-badge-toggle"
                      checked={supportBadgeVisible}
                      onChange={(e) => {
                        const show = e.target.checked;
                        setSupportBadgeHidden(!show);
                        if (show) {
                          setSupportBadgeHiddenUntil(null);
                        }
                      }}
                      size="md"
                    />
                  </div>
                </Card>
              </div>

              <div className="settings-section">
                <h3 className="settings-section__title">Sponsor the Project</h3>
                <Card>
                  <p className="settings-section__subtitle">
                    Notees is free, open source, and funded by people like you. If you find it
                    useful, consider sponsoring development.
                  </p>

                  <div className="settings-support-channels">
                    {SPONSORSHIP_CHANNELS.map((channel) => (
                      <a
                        key={channel.id}
                        href={channel.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="settings-support-channel"
                      >
                        <span className="settings-support-channel__icon" aria-hidden="true">
                          <Icon path={channel.icon} size={1.2} />
                        </span>
                        <div className="settings-support-channel__info">
                          <span className="settings-support-channel__name">{channel.name}</span>
                          <span className="settings-support-channel__description">
                            {channel.description}
                          </span>
                        </div>
                        <span className="settings-support-channel__arrow" aria-hidden="true">
                          <Icon path="mdi-open-in-new" size={0.9} />
                        </span>
                      </a>
                    ))}
                  </div>
                </Card>
              </div>
            </>
          )}

          {activeTab === "about" && (
            <>
              <div className="settings-section">
                <h3 className="settings-section__title">About Notees</h3>
                <Card>
                  <div className="settings-about">
                    <img src="/notees-icon.svg" alt="" className="settings-about__logo" />
                    <h4 className="settings-about__name">Notees</h4>
                    <p className="settings-about__description">
                      A self-hosted, privacy-first, local-first personal information environment:
                      one object graph whose only authority is an immutable operation log.
                    </p>
                    <p className="settings-about__copyright">
                      © {new Date().getFullYear()} Miquel Rosell Tarragó
                    </p>
                  </div>
                </Card>
              </div>

              <div className="settings-section">
                <h3 className="settings-section__title">Privacy</h3>
                <Card>
                  <div className="settings-privacy-card">
                    <p className="settings-privacy-card__text">
                      No cloud. All data stays on your server.
                    </p>
                  </div>
                </Card>
              </div>

              <div className="settings-section">
                <h3 className="settings-section__title">Links</h3>
                <Card>
                  <div className="settings-links">
                    <a
                      href="https://github.com/miquelrosell99/notees#readme"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="settings-link"
                    >
                      Documentation
                    </a>
                    <a
                      href="https://github.com/miquelrosell99/notees/issues"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="settings-link"
                    >
                      Report a bug
                    </a>
                    <a
                      href="https://github.com/miquelrosell99/notees/issues/new"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="settings-link"
                    >
                      Feature request
                    </a>
                  </div>
                </Card>
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
