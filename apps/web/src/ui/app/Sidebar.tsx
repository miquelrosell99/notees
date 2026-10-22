/**
 * Sidebar — the 260px workspace navigator on the background canvas. The
 * SHELL: the nav register (NAV_ENTRIES — labels, icons, `/`-paths for every
 * hub; the tab title and the URL table read it) + the user profile / account
 * popup at the foot.
 *
 * Information architecture (owner 2026-10-19): the workspace switcher +
 * New + search icons live in the top bar; NAVIGATION rows switch the main
 * view (Today / Journal / Inbox / Pages / Whiteboards / Tasks hubs — never
 * an inline page dump); FAVORITES and RECENTS are cross-device UI state —
 * the server per-user prefs store is the authority, device-local cache
 * offline (see nodePrefs.ts); the two lists render through
 * features/sidebar/FavoritesRecents.tsx, composed below (extracted
 * owner 2026-10-21). Trash and Shares LEFT the nav list: they open from the
 * account popup now (the v1 account-menu shape) — their NAV_ENTRIES rows
 * survive with `menuOnly` (labels, paths, tab titles).
 *
 * The bottom row is the user profile: avatar + name + email (the identity
 * line, owner restore 2026-10-19) with a sync-state badge on the avatar's
 * corner (the sync dot relocated off the top bar). Click opens the account
 * popup — user header, sync details entry, Shares / Trash, Settings,
 * admin-only workspace settings, Sign out. A settings gear rides beside
 * the profile for one-click access (owner 2026-10-19: the shortcut-only
 * door was rejected — the button is the quick path, the popup entry and
 * the Ctrl/Cmd+, chord are the alternates).
 */

import { useRef, useState } from "react";

import type { AccountUser } from "@/core/auth-api.js";
import type { SyncStatusSnapshot } from "@/core/workspace-client/index.js";

import { Icon } from "../Icon.js";

import { FavoritesRecents, sidebarSection } from "../../features/sidebar/FavoritesRecents.js";
import type { AnyClient } from "../../features/sidebar/FavoritesRecents.js";
import { Button } from "../../components/ui/fleet/Button.js";
import { Separator } from "../../components/ui/fleet/Separator.js";
import { useDeviceSetting } from "../../features/settings/deviceSettings.js";
import { usePopupDismissal } from "../../components/ui/fleet/usePopupDismissal.js";
import "./Sidebar.css";

export type { AnyClient };

export type NavKey = "today" | "journal" | "calendar" | "inbox" | "pages" | "classes" | "whiteboards" | "tasks" | "assets" | "queries" | "graph" | "trash" | "archived" | "shares";

/**
 * The nav register: labels, icons, and `/`-paths for every hub — the tab
 * title and the URL table read it. `menuOnly` marks hubs that don't render
 * a sidebar row: they open from the account popup (Trash, Archived, Shares
 * — owner 2026-10-19 / the classes-gallery batch 2026-10-22), but they keep
 * their entry so the routing/title machinery names them.
 */
export const NAV_ENTRIES: Array<{ key: NavKey; label: string; icon: string; menuOnly?: boolean }> = [
  { key: "today", label: "Today", icon: "mdi-calendar-today-outline" },
  { key: "journal", label: "Journal", icon: "mdi-calendar-clock" },
  { key: "calendar", label: "Calendar", icon: "mdi-calendar-today" },
  { key: "inbox", label: "Inbox", icon: "mdi-tray-arrow-down" },
  { key: "pages", label: "Pages", icon: "mdi-book-open-page-variant" },
  { key: "classes", label: "Classes", icon: "mdi-shape-outline" },
  { key: "whiteboards", label: "Whiteboards", icon: "mdi-presentation" },
  { key: "tasks", label: "Tasks", icon: "mdi-format-list-checks" },
  { key: "assets", label: "Assets", icon: "mdi-folder-multiple-image" },
  { key: "queries", label: "Queries", icon: "mdi-database-search-outline" },
  { key: "graph", label: "Graph", icon: "mdi-graph-outline" },
  { key: "trash", label: "Trash", icon: "mdi-delete-outline", menuOnly: true },
  { key: "archived", label: "Archived", icon: "mdi-archive-outline", menuOnly: true },
  { key: "shares", label: "Shares", icon: "mdi-share-variant", menuOnly: true },
];

export function Sidebar({
  client,
  user,
  offline,
  showSettings,
  onOpenSettings,
  selectedPageId,
  activeNav,
  onSelectNav,
  onOpenPage,
  onSignOut,
  onOpenInSidebar,
  /** The live sync snapshot — drives the profile-circle badge. */
  syncStatus,
  /** Opens the sync details modal (the popup's Sync entry); undefined hides it. */
  onOpenSyncDetails,
  /** Opens the workspace admin settings (admin users only); undefined hides the entry. */
  onOpenAdminSettings,
}: {
  client: AnyClient;
  user: AccountUser | null;
  offline: boolean;
  showSettings: boolean;
  onOpenSettings: () => void;
  selectedPageId: string | null;
  activeNav: NavKey;
  onSelectNav: (key: NavKey) => void;
  onOpenPage: (nodeId: string) => void;
  onSignOut: () => void;
  /** Peek the node as a right-sidebar card (the row context menu). */
  onOpenInSidebar?: ((nodeId: string) => void) | undefined;
  syncStatus?: SyncStatusSnapshot | undefined;
  onOpenSyncDetails?: (() => void) | undefined;
  onOpenAdminSettings?: (() => void) | undefined;
}) {
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  const [accountMenu, setAccountMenu] = useState(false);

  /** The account popup + its trigger — the shared dismissal layer anchors. */
  const profileButtonRef = useRef<HTMLButtonElement>(null);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  usePopupDismissal({
    popupRef: accountMenuRef,
    anchorRefs: [profileButtonRef],
    isOpen: accountMenu,
    onClose: () => setAccountMenu(false),
  });

  const fullName =
    user !== null ? [user.name, user.surnames].filter((part) => part !== null && part !== "").join(" ").trim() : "";
  const displayLine =
    fullName !== ""
      ? fullName
      : (user?.displayName ?? "") !== ""
        ? user!.displayName
        : (user?.email.split("@")[0] ?? "Offline");
  const initials =
    fullName !== ""
      ? fullName
          .split(/\s+/)
          .slice(0, 2)
          .map((part) => part[0]!.toUpperCase())
          .join("")
      : null;
  /**
   * The sync badge state (the top bar's old SyncDot logic, relocated):
   * error > syncing > backlog (pending + failed ops) > idle. Undefined
   * snapshot (boot screens never reach here, tests) renders no badge.
   */
  const syncBacklog = syncStatus === undefined ? 0 : syncStatus.pending + syncStatus.failed;
  const syncState =
    syncStatus === undefined
      ? null
      : syncStatus.status === "error"
        ? "error"
        : syncStatus.status === "syncing"
          ? "syncing"
          : syncBacklog > 0
            ? "backlog"
            : "idle";
  const syncStateLabel =
    syncState === "backlog"
      ? `${syncBacklog} waiting`
      : syncState === "idle"
        ? "up to date"
        : (syncState ?? "");
  // Workspace-settings sidebar visibility toggles (device-local).
  const [showJournals] = useDeviceSetting("sidebarShowJournals", true);
  const [showInbox] = useDeviceSetting("sidebarShowInbox", true);
  const [showCalendar] = useDeviceSetting("sidebarShowCalendar", true);

  const toggleSection = (title: string): void => {
    setCollapsedSections((previous) => ({ ...previous, [title]: previous[title] !== true }));
  };

  return (
    <aside className="nt-sidebar">
      {/* No top row (owner 2026-10-06): the workspace selector and the
          New/Search buttons live in the top bar — the sidebar starts with
          the Navigation section. */}
      <nav className="nt-sidebar-nav">
        {sidebarSection(
          "Navigation",
          [
            ...NAV_ENTRIES.filter(
              (entry) =>
                !entry.menuOnly &&
                (entry.key !== "journal" || showJournals) &&
                (entry.key !== "inbox" || showInbox) &&
                (entry.key !== "calendar" || showCalendar) &&
                // The Tasks hub is task-family chrome — hidden while
                // the family is off (live read; absent row = enabled).
                (entry.key !== "tasks" || client.isFeatureEnabled("tasks")) &&
                // The journal surfaces ride the journal toggle (owner ruling
                // 2026-10-22): the journal view AND Today-page management
                // hide while it is off — the date classes stay always-on.
                (entry.key !== "journal" && entry.key !== "today" || client.isFeatureEnabled("journal")),
            ).map((entry) => (
              <li key={entry.key} className="nt-side-row">
                <button
                  type="button"
                  className={
                    activeNav === entry.key && selectedPageId === null
                      ? "nt-side-item nt-side-item-active"
                      : "nt-side-item"
                  }
                  onClick={() => onSelectNav(entry.key)}
                >
                  <Icon path={entry.icon} size={1} className="nt-side-item-icon" />
                  <span className="nt-side-item-label">{entry.label}</span>
                </button>
              </li>
            )),
          ],
          {},
          collapsedSections,
          toggleSection,
        )}
        <FavoritesRecents
          client={client}
          selectedPageId={selectedPageId}
          onOpenPage={onOpenPage}
          onOpenInSidebar={onOpenInSidebar}
          collapsedSections={collapsedSections}
          onToggleCollapse={toggleSection}
        />
      </nav>
      <div className="nt-sidebar-bottom">
        <button
          type="button"
          ref={profileButtonRef}
          className="nt-profile"
          title={user?.email ?? "Account"}
          aria-label="Account"
          onClick={() => setAccountMenu((open) => !open)}
        >
          <span className="nt-profile-avatar" aria-hidden="true">
            {user?.avatarUrl ? (
              <img src={user.avatarUrl} alt="" />
            ) : initials !== null ? (
              initials
            ) : (
              <Icon path="mdi-account-outline" size={1} />
            )}
            {syncState !== null && (
              <span
                className={`nt-profile-sync nt-profile-sync--${syncState}`}
                title={`Sync: ${syncStateLabel}`}
                aria-hidden="true"
              />
            )}
          </span>
          <span className="nt-profile-text">
            <span className="nt-profile-name">{displayLine}</span>
            <span className="nt-profile-email">{user?.email ?? "Offline workspace"}</span>
          </span>
          {syncState !== null && <span className="sr-only">{`Sync: ${syncStateLabel}`}</span>}
        </button>
        {showSettings && (
          /* The quick-access gear (owner 2026-10-19 — restored after one
             popup-only day: the owner doesn't want a shortcut as the
             settings door). Same target as the popup's Settings entry. */
          <Button
            type="button"
            variant="ghost"
            size="sm"
            icon="mdi mdi-cog-outline"
            title="Settings"
            aria-label="Settings"
            onClick={onOpenSettings}
          />
        )}
        {accountMenu && (
          <div
            className="nt-account-menu"
            role="menu"
            ref={accountMenuRef}
            // Escape owned by the popup's own interior (the shared layer
            // skips keydowns that originate inside the popup): close here.
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.stopPropagation();
              setAccountMenu(false);
            }}
          >
            <div className="nt-account-header">
              <span className="nt-profile-avatar" aria-hidden="true">
                {user?.avatarUrl ? (
                  <img src={user.avatarUrl} alt="" />
                ) : initials !== null ? (
                  initials
                ) : (
                  <Icon path="mdi-account-outline" size={1} />
                )}
              </span>
              <span className="nt-account-identity">
                <span className="nt-profile-name">{displayLine}</span>
                <span className="nt-profile-email">{user?.email ?? "Offline workspace"}</span>
              </span>
            </div>
            <Separator />
            {syncState !== null && onOpenSyncDetails !== undefined && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setAccountMenu(false);
                  onOpenSyncDetails();
                }}
              >
                <Icon path="mdi-sync" size={0.9} />
                <span>Sync</span>
                <span className="nt-account-item-caption">{syncStateLabel}</span>
              </button>
            )}
            {!offline && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setAccountMenu(false);
                  onSelectNav("shares");
                }}
              >
                <Icon path="mdi-share-variant" size={0.9} />
                <span>Shares</span>
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setAccountMenu(false);
                onSelectNav("trash");
              }}
            >
              <Icon path="mdi-delete-outline" size={0.9} />
              <span>Trash</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setAccountMenu(false);
                onSelectNav("archived");
              }}
            >
              <Icon path="mdi-archive-outline" size={0.9} />
              <span>Archived</span>
            </button>
            <Separator />
            {showSettings && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setAccountMenu(false);
                  onOpenSettings();
                }}
              >
                <Icon path="mdi-cog-outline" size={0.9} />
                <span>Settings</span>
              </button>
            )}
            {onOpenAdminSettings !== undefined && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setAccountMenu(false);
                  onOpenAdminSettings();
                }}
              >
                <Icon path="mdi-account-cog" size={0.9} />
                <span>Admin settings</span>
              </button>
            )}
            <Separator />
            <button
              type="button"
              role="menuitem"
              className="nt-account-item--danger"
              onClick={() => {
                setAccountMenu(false);
                onSignOut();
              }}
            >
              <Icon path="mdi-logout-variant" size={0.9} />
              <span>Sign out</span>
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
