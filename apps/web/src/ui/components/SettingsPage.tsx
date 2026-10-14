/**
 * SettingsPage — the full settings surface: the eight settings sections
 * (appearance/editor/general/sync/account/security/support/about) with a
 * sidebar section nav, rendered in the PageCard slot of the app shell.
 * Deep-linkable at /settings/<section> (unknown sections land on
 * appearance); section changes ride window.history so back/forward and
 * reloads work like every other surface.
 *
 * The quick tweaks modal (UserSettingsModal) composes the shared
 * ThemeModeControl / AccentColorPicker from this module — one
 * implementation, two homes.
 */
import { useState } from "react";

import type { AccountUser } from "@/core/auth-api.js";

import { Button } from "./ui/Button.js";
import { Card } from "./ui/Card.js";
import { BooleanToggle } from "./ui/BooleanToggle.js";
import { SelectionButton } from "./ui/SelectionButton.js";
import { TextField } from "./ui/TextField.js";
import { ConfirmationModal } from "./ui/ConfirmationModal.js";
import { Icon } from "../Icon.js";
import { ApiKeysSection } from "../SettingsPanel.js";
import {
  ACCENT_COLOR_OPTIONS,
  applyAppearance,
  useDeviceSetting,
  type AccentColor,
  type ThemePreference,
  type UiFontPreference,
} from "./modals/deviceSettings.js";

import "./modals/settingsModal.css";
import "./SettingsPage.css";

export type SettingsSection =
  | "appearance"
  | "editor"
  | "general"
  | "sync"
  | "account"
  | "security"
  | "support"
  | "about";

export const SETTINGS_SECTIONS: readonly { id: SettingsSection; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "editor", label: "Editor" },
  { id: "general", label: "General" },
  { id: "sync", label: "Sync" },
  { id: "account", label: "Account" },
  { id: "security", label: "Security" },
  { id: "support", label: "Support" },
  { id: "about", label: "About" },
];

const SECTION_IDS = new Set<string>(SETTINGS_SECTIONS.map((section) => section.id));

/** Unknown (or absent) sections land on appearance. */
export function normalizeSettingsSection(value: string | null | undefined): SettingsSection {
  return value !== null && value !== undefined && SECTION_IDS.has(value)
    ? (value as SettingsSection)
    : "appearance";
}

/** Parse a /settings/<section> path; null when the path is not a settings route. */
export function settingsSectionFromPath(pathname: string): SettingsSection | null {
  const match = /^\/settings(?:\/([^/]+))?\/?$/.exec(pathname);
  if (match === null) return null;
  return normalizeSettingsSection(match[1]?.toLowerCase());
}

export function pathForSettingsSection(section: SettingsSection): string {
  return `/settings/${section}`;
}

// --- Shared appearance controls (the quick modal + the page) --------------------

/** The theme control's four options over the unchanged storage keys:
 *  Light → theme:light; Dark → theme:dark, oled:false; OLED → theme:dark,
 *  oled:true; Auto → theme:system, oled:false. A stored system+OLED combo
 *  resolves to Auto until the next save (no migration). */
export type ThemeMode = "light" | "dark" | "oled" | "auto";

export function currentThemeMode(theme: ThemePreference, oled: boolean): ThemeMode {
  if (theme === "light") return "light";
  if (theme === "system") return "auto";
  return oled ? "oled" : "dark";
}

export function ThemeModeControl({ id }: { id: string }) {
  const [theme, setTheme] = useDeviceSetting<ThemePreference>("theme", "system");
  const [oled, setOled] = useDeviceSetting("oledMode", false);
  return (
    <SelectionButton
      id={id}
      options={[
        { value: "light", icon: "mdi-weather-sunny", label: "Light theme" },
        { value: "dark", icon: "mdi-weather-night", label: "Dark theme" },
        { value: "oled", icon: "mdi-overscan", label: "OLED theme" },
        { value: "auto", icon: "mdi-monitor", label: "Auto theme" },
      ]}
      value={currentThemeMode(theme, oled)}
      onChange={(value) => {
        const mode = value as ThemeMode;
        setTheme(mode === "light" ? "light" : mode === "auto" ? "system" : "dark");
        setOled(mode === "oled");
        applyAppearance();
      }}
      size="sm"
    />
  );
}

export function AccentColorPicker() {
  const [accentColor, setAccentColor] = useDeviceSetting<AccentColor>("accentColor", "margin");
  return (
    <div className="settings-accent-options" role="group" aria-label="Accent Color">
      {ACCENT_COLOR_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`settings-accent-swatch ${option.value === "monochrome" ? "settings-accent-swatch--monochrome" : ""} ${accentColor === option.value ? "settings-accent-swatch--active" : ""}`}
          style={{ backgroundColor: option.value === "monochrome" ? undefined : option.hex }}
          onClick={() => {
            setAccentColor(option.value);
            applyAppearance();
          }}
          aria-label={option.label}
          title={option.label}
        />
      ))}
    </div>
  );
}

// --- Sections --------------------------------------------------------------------

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

function AppearanceSection() {
  const [uiFont, setUiFont] = useDeviceSetting<UiFontPreference>("uiFont", "bundled");
  return (
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
          <ThemeModeControl id="user-theme" />
        </div>

        <div className="settings-item">
          <div className="settings-item__info">
            <label htmlFor="user-ui-font" className="settings-item__label">
              Font
            </label>
            <p className="settings-item__description">
              Bundled ships Instrument Sans, Newsreader, and JetBrains Mono with the
              app; System uses the platform&apos;s own font stack.
            </p>
          </div>
          <SelectionButton
            id="user-ui-font"
            options={[
              { value: "bundled", icon: "mdi-format-font", label: "Bundled (Instrument Sans)" },
              { value: "system", icon: "mdi-monitor", label: "System stack" },
            ]}
            value={uiFont}
            onChange={(value) => {
              setUiFont(value as UiFontPreference);
              applyAppearance();
            }}
            size="sm"
          />
        </div>

        <div className="settings-item">
          <div className="settings-item__info">
            <label className="settings-item__label">Accent Color</label>
            <p className="settings-item__description">
              Functional accent for tags, badges, and active states
            </p>
          </div>
          <AccentColorPicker />
        </div>
      </Card>
    </div>
  );
}

function EditorSection() {
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
  return (
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
  );
}

function GeneralSection() {
  const [firstDayOfWeek, setFirstDayOfWeek] = useDeviceSetting("firstDayOfWeek", 1);
  const [dateFormat, setDateFormat] = useDeviceSetting<DateFormat>("dateFormat", "YYYY-MM-DD");
  const [defaultView, setDefaultView] = useDeviceSetting("defaultView", "today");
  const [quickAddDestination, setQuickAddDestination] = useDeviceSetting(
    "quickAddDestination",
    "inbox",
  );
  const [showDevOptions, setShowDevOptions] = useDeviceSetting("showDevOptions", false);
  return (
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
            <option value="today">Today&apos;s Page</option>
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
  );
}

interface SyncSectionProps {
  serverUrl: string;
  syncConnected: boolean;
  onForgetServer: () => void;
  onConnectServer: (url: string) => void;
}

function SyncSection({ serverUrl, syncConnected, onForgetServer, onConnectServer }: SyncSectionProps) {
  const [syncServerDraft, setSyncServerDraft] = useState(serverUrl);
  const [forgetConfirmOpen, setForgetConfirmOpen] = useState(false);
  return (
    <>
      <div className="settings-section">
        <h3 className="settings-section__title">Sync Server</h3>
        <Card>
          <div className="settings-item">
            <div className="settings-item__info">
              <span className="settings-item__label">Current server</span>
              <p className="settings-item__description">{serverUrl}</p>
            </div>
            <span
              className={
                syncConnected
                  ? "settings-meta-value settings-meta-value--active"
                  : "settings-meta-value"
              }
            >
              {syncConnected ? "Connected" : "Unavailable"}
            </span>
          </div>
        </Card>
      </div>

      <div className="settings-section">
        <h3 className="settings-section__title">Disconnect</h3>
        <Card>
          <p className="settings-section__description">
            Forgetting this server signs you out on this device; local data stays.
          </p>
          <Button variant="danger" size="md" onClick={() => setForgetConfirmOpen(true)}>
            Disconnect &amp; forget this server
          </Button>
        </Card>
      </div>

      <div className="settings-section">
        <h3 className="settings-section__title">Connect to a Different Server</h3>
        <Card>
          <p className="settings-section__description">
            Probe a different sync server — on success you sign in there.
          </p>
          <div className="settings-item">
            <TextField
              label="Server URL"
              size="sm"
              value={syncServerDraft}
              onChange={(e) => setSyncServerDraft(e.target.value)}
              placeholder="https://notees.example.com"
            />
            <Button
              variant="primary"
              size="md"
              disabled={syncServerDraft.trim() === ""}
              onClick={() => onConnectServer(syncServerDraft.trim())}
            >
              Connect
            </Button>
          </div>
        </Card>
      </div>

      <ConfirmationModal
        isOpen={forgetConfirmOpen}
        variant="danger"
        title="Disconnect from this server?"
        message="You will be signed out and this server's address forgotten on this device."
        confirmLabel="Disconnect"
        onConfirm={() => {
          setForgetConfirmOpen(false);
          onForgetServer();
        }}
        onCancel={() => setForgetConfirmOpen(false)}
      />
    </>
  );
}

interface AccountSectionProps {
  serverUrl: string;
  token: string;
  user: AccountUser;
  onSignOut: () => void;
}

function AccountSection({ serverUrl, token, user, onSignOut }: AccountSectionProps) {
  return (
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
            onClick={onSignOut}
          >
            Log out
          </Button>
        </Card>
      </div>
    </>
  );
}

function SecuritySection() {
  return (
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
  );
}

function SupportSection() {
  const [supportBadgeHidden, setSupportBadgeHidden] = useDeviceSetting("supportBadgeHidden", false);
  const [supportBadgeHiddenUntil, setSupportBadgeHiddenUntil] = useDeviceSetting<number | null>(
    "supportBadgeHiddenUntil",
    null,
  );
  const supportBadgeVisible =
    !supportBadgeHidden ||
    (supportBadgeHiddenUntil !== null && supportBadgeHiddenUntil <= Date.now());
  return (
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
                Display a small &quot;Support Notees&quot; reminder in the sidebar.
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
  );
}

function AboutSection() {
  return (
    <>
      <div className="settings-section">
        <h3 className="settings-section__title">About Notees</h3>
        <Card>
          <div className="settings-about">
            <img src="/app-icon-512.svg" alt="" className="settings-about__logo" />
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
  );
}

export interface SettingsPageProps {
  section: SettingsSection;
  /** Push a section change (state + URL) — the App owns history. */
  onNavigate: (section: SettingsSection) => void;
  serverUrl: string;
  token: string;
  user: AccountUser;
  onSignOut: () => void;
  /** Reachability of the configured sync server, derived by the parent from
   *  its sync status snapshot. */
  syncConnected: boolean;
  /** Disconnect & forget: clears the stored server + credentials and signs
   *  out; the parent owns the transition back to the boot form. */
  onForgetServer: () => void;
  /** Connect to a different sync server; the parent owns the probe. */
  onConnectServer: (url: string) => void;
}

export function SettingsPage({
  section,
  onNavigate,
  serverUrl,
  token,
  user,
  onSignOut,
  syncConnected,
  onForgetServer,
  onConnectServer,
}: SettingsPageProps) {
  return (
    <div className="settings-page">
      <nav className="settings-page__nav" aria-label="Settings sections">
        {SETTINGS_SECTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`settings-page__nav-item ${section === item.id ? "settings-page__nav-item--active" : ""}`}
            aria-current={section === item.id ? "page" : undefined}
            onClick={() => onNavigate(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="settings-page__content">
        {section === "appearance" && <AppearanceSection />}
        {section === "editor" && <EditorSection />}
        {section === "general" && <GeneralSection />}
        {section === "sync" && (
          <SyncSection
            serverUrl={serverUrl}
            syncConnected={syncConnected}
            onForgetServer={onForgetServer}
            onConnectServer={onConnectServer}
          />
        )}
        {section === "account" && (
          <AccountSection serverUrl={serverUrl} token={token} user={user} onSignOut={onSignOut} />
        )}
        {section === "security" && <SecuritySection />}
        {section === "support" && <SupportSection />}
        {section === "about" && <AboutSection />}
      </div>
    </div>
  );
}
