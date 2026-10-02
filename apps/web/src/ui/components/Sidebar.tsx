/**
 * Sidebar — the 260px workspace navigator on the background canvas.
 *
 * Original information architecture: the workspace switcher + search icon on
 * top; NAVIGATION rows switch the main view (Journal / Inbox / Pages /
 * Whiteboards / Tasks hubs — never an inline page dump); FAVORITES and
 * RECENTS are device-local; MORE reveals the class list. Favorites/recents
 * live here (moved out of App).
 */

import { useEffect, useState } from "react";

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { AccountUser } from "@/core/auth-api.js";
import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client.js";

import { displayNameForSettings } from "../dateDisplay.js";
import { Icon } from "../Icon.js";
import { classIconMap, nodeIcon } from "../iconFor.js";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher.js";
import { SidebarItemMenu, type SidebarItemMenuState } from "./SidebarItemMenu.js";
import { ConfirmationModal } from "./ui/ConfirmationModal.js";
import { useDeviceSetting } from "./modals/deviceSettings.js";
import "./Sidebar.css";

export type AnyClient = WorkspaceClient | WorkerClient;

export type NavKey = "journal" | "inbox" | "pages" | "classes" | "whiteboards" | "tasks" | "assets";

export const NAV_ENTRIES: Array<{ key: NavKey; label: string; icon: string }> = [
  { key: "journal", label: "Journal", icon: "mdi-calendar-clock" },
  { key: "inbox", label: "Inbox", icon: "mdi-tray-arrow-down" },
  { key: "pages", label: "Pages", icon: "mdi-book-open-page-variant" },
  { key: "classes", label: "Classes", icon: "mdi-shape-outline" },
  { key: "whiteboards", label: "Whiteboards", icon: "mdi-presentation" },
  { key: "tasks", label: "Tasks", icon: "mdi-format-list-checks" },
  { key: "assets", label: "Assets", icon: "mdi-folder-multiple-image" },
];

const STORAGE_KEYS = {
  favorites: "notees.favorites",
  recents: "notees.recents",
} as const;

function readStoredJson(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Record a page open in the device-local Recents list (the sidebar section).
 * Every open surface funnels through App.openPage, which calls this; the
 * write broadcasts `notees:recents` so the sidebar refreshes live (same
 * pattern as the favorites broadcast from the node context menu).
 */
export function recordRecent(id: string): void {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEYS.recents) || "[]");
    const previous = Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
    const next = [id, ...previous.filter((entry) => entry !== id)].slice(0, 12);
    localStorage.setItem(STORAGE_KEYS.recents, JSON.stringify(next));
  } catch {
    // Storage unavailable; the list just won't persist.
  }
  window.dispatchEvent(new Event("notees:recents"));
}

/**
 * Remove a page from the device-local Recents list (the row context menu).
 * Same broadcast contract as recordRecent so every listener refreshes live.
 */
export function removeRecent(id: string): void {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEYS.recents) || "[]");
    const previous = Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
    localStorage.setItem(STORAGE_KEYS.recents, JSON.stringify(previous.filter((entry) => entry !== id)));
  } catch {
    // Storage unavailable; the list just won't persist.
  }
  window.dispatchEvent(new Event("notees:recents"));
}

export function Sidebar({
  client,
  workspaceName,
  workspaceId,
  serverUrl,
  credential,
  user,
  offline,
  showSettings,
  onOpenSettings,
  selectedPageId,
  activeNav,
  onSelectNav,
  onOpenPage,
  onRequestSearch,
  onSwitchWorkspace,
  onManageWorkspaces,
  onSignOut,
  onRenameWorkspace,
  onOpenInSidebar,
}: {
  client: AnyClient;
  workspaceName: string;
  workspaceId: string;
  serverUrl: string;
  credential: string;
  user: AccountUser | null;
  offline: boolean;
  showSettings: boolean;
  onOpenSettings: () => void;
  selectedPageId: string | null;
  activeNav: NavKey;
  onSelectNav: (key: NavKey) => void;
  onOpenPage: (nodeId: string) => void;
  onRequestSearch: () => void;
  onSwitchWorkspace: (workspaceId: string, name: string) => void;
  /** Opens the Manage Workspaces view from the switcher popup. */
  onManageWorkspaces: () => void;
  onSignOut: () => void;
  onRenameWorkspace?: ((workspaceId: string, name: string) => void) | undefined;
  /** Peek the node as a right-sidebar card (the row context menu). */
  onOpenInSidebar?: ((nodeId: string) => void) | undefined;
}) {
  const [favorites, setFavorites] = useState<string[]>(() => readStoredJson(STORAGE_KEYS.favorites));
  const [recents, setRecents] = useState<string[]>(() => readStoredJson(STORAGE_KEYS.recents));
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  const [accountMenu, setAccountMenu] = useState(false);
  /** Right-click menu over a Favorites/Recents row. */
  const [rowMenu, setRowMenu] = useState<SidebarItemMenuState | null>(null);
  /** Delete confirmation target (lives here so it survives the menu closing). */
  const [deleteTarget, setDeleteTarget] = useState<ClientNode | null>(null);

  // Refresh the device-local lists when any surface writes them: the node
  // context menu broadcasts notees:favorites; recordRecent broadcasts
  // notees:recents. (Without this the sections stayed stale until reload.)
  useEffect(() => {
    const refresh = () => {
      setFavorites(readStoredJson(STORAGE_KEYS.favorites));
      setRecents(readStoredJson(STORAGE_KEYS.recents));
    };
    window.addEventListener("notees:favorites", refresh);
    window.addEventListener("notees:recents", refresh);
    return () => {
      window.removeEventListener("notees:favorites", refresh);
      window.removeEventListener("notees:recents", refresh);
    };
  }, []);

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
  // Workspace-settings sidebar visibility toggles (device-local).
  const [showJournals] = useDeviceSetting("sidebarShowJournals", true);
  const [showInbox] = useDeviceSetting("sidebarShowInbox", true);

  const openRow = (id: string): void => {
    // Recents recording lives in App.openPage (the single navigation funnel —
    // breadcrumbs, links and sidebar rows alike); see recordRecent.
    onOpenPage(id);
  };

  const toggleFavorite = (id: string): void => {
    setFavorites((previous) => {
      const next = previous.includes(id) ? previous.filter((entry) => entry !== id) : [...previous, id];
      try {
        localStorage.setItem(STORAGE_KEYS.favorites, JSON.stringify(next));
      } catch {
        // Storage unavailable; the list just won't persist.
      }
      return next;
    });
  };

  // Asset-class nodes are library objects, not pages — out of every list.
  const classes = client.listClasses();
  const assetClassId =
    classes.find((cls) => cls.name === "asset")?.id ?? SYSTEM_CLASS_UUIDS.asset;
  const pages = client.listPages().filter((page) => !page.classIds.includes(assetClassId));
  const byId = new Map<string, ClientNode>([...pages, ...classes].map((node) => [node.id, node]));
  const iconsByClass = classIconMap(classes);
  const rowIconFor = (node: ClientNode): string | null => nodeIcon(node, iconsByClass);
  const favoritePages = favorites
    .map((id) => byId.get(id))
    .filter((node): node is ClientNode => node !== undefined);
  const recentPages = recents
    .map((id) => byId.get(id))
    .filter((node): node is ClientNode => node !== undefined)
    .slice(0, 12);

  const renderRow = (node: ClientNode, icon?: string | null, list?: "favorites" | "recents") => (
    <li
      key={node.id}
      className="nt-side-row"
      onContextMenu={(event) => {
        if (list === undefined) return;
        event.preventDefault();
        setRowMenu({ x: event.clientX, y: event.clientY, node, list });
      }}
    >
      <button
        type="button"
        className={node.id === selectedPageId ? "nt-side-item nt-side-item-active" : "nt-side-item"}
        onClick={() => openRow(node.id)}
      >
        {icon !== null && icon !== undefined && (
          <Icon path={icon} size={1} className="nt-side-item-icon" />
        )}
        <span className="nt-side-item-label">{displayNameForSettings(node) || node.id}</span>
      </button>
      <button
        type="button"
        className="nt-side-star"
        title={favorites.includes(node.id) ? "Remove from favorites" : "Add to favorites"}
        onClick={() => toggleFavorite(node.id)}
      >
        <Icon path={favorites.includes(node.id) ? "mdi-star" : "mdi-star-outline"} size={0.9} />
      </button>
    </li>
  );

  const section = (
    title: string,
    rows: React.ReactNode[],
    options: { icon?: string; defaultCollapsed?: boolean; collapsible?: boolean } = {},
  ) => {
    if (rows.length === 0) return null;
    const collapsible = options.collapsible !== false;
    const collapsed = collapsible && collapsedSections[title] === true;
    return (
      <section className="nt-side-section">
        {collapsible ? (
          <button
            type="button"
            className="nt-side-header nt-side-header-toggle"
            aria-expanded={!collapsed}
            onClick={() =>
              setCollapsedSections((previous) => ({ ...previous, [title]: !collapsed }))
            }
          >
            <Icon
              path={collapsed ? "mdi-chevron-right" : "mdi-chevron-down"}
              size={0.8}
              className="nt-side-header-chevron"
            />
            {options.icon !== undefined && (
              <Icon path={options.icon} size={0.8} className="nt-side-header-icon" />
            )}
            <span>{title}</span>
          </button>
        ) : (
          <h3 className="nt-side-header">
            {options.icon !== undefined && (
              <Icon path={options.icon} size={0.8} className="nt-side-header-icon" />
            )}
            <span>{title}</span>
          </h3>
        )}
        {!collapsed && <ul className="nt-side-list">{rows}</ul>}
      </section>
    );
  };

  return (
    <aside className="nt-sidebar">
      <div className="nt-sidebar-top">
        {offline ? (
          <span className="nt-ws-offline">{(workspaceName || "This device").toUpperCase()}</span>
        ) : (
          <WorkspaceSwitcher
            serverUrl={serverUrl}
            credential={credential}
            activeWorkspaceId={workspaceId}
            activeName={workspaceName}
            onSwitch={onSwitchWorkspace}
            onManageWorkspaces={onManageWorkspaces}
            onRenamed={onRenameWorkspace}
          />
        )}
        <button
          type="button"
          className="nt-icon-btn"
          title="Search (Ctrl+K)"
          aria-label="Search"
          onClick={onRequestSearch}
        >
          <Icon path="mdi-magnify" size={1} />
        </button>
      </div>
      <nav className="nt-sidebar-nav">
        {section(
          "Navigation",
          NAV_ENTRIES.filter(
            (entry) =>
              (entry.key !== "journal" || showJournals) && (entry.key !== "inbox" || showInbox),
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
        )}
        {section(
          "Favorites",
          favoritePages.map((node) => renderRow(node, null, "favorites")),
          { icon: "mdi-star-outline" },
        )}
        {section(
          "Recents",
          recentPages.map((node) => renderRow(node, rowIconFor(node), "recents")),
        )}
      </nav>
      <div className="nt-sidebar-bottom">
        <button
          type="button"
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
          </span>
          <span className="nt-profile-text">
            <span className="nt-profile-name">{displayLine}</span>
            <span className="nt-profile-email">{user?.email ?? "Offline workspace"}</span>
          </span>
        </button>
        {showSettings && (
          <button
            type="button"
            className="nt-icon-btn"
            title="Settings"
            aria-label="Settings"
            onClick={onOpenSettings}
          >
            <Icon path="mdi-cog-outline" size={1} />
          </button>
        )}
        {accountMenu && (
          <div className="nt-account-menu" role="menu">
            <span className="nt-account-email">{user?.email ?? "Offline workspace"}</span>
            <button
              type="button"
              role="menuitem"
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
      {rowMenu !== null && (
        <SidebarItemMenu
          state={rowMenu}
          isFavorited={favorites.includes(rowMenu.node.id)}
          onClose={() => setRowMenu(null)}
          onOpen={(id) => {
            setRowMenu(null);
            openRow(id);
          }}
          onOpenInSidebar={onOpenInSidebar}
          onToggleFavorite={(id) => {
            toggleFavorite(id);
          }}
          onRemoveFromRecents={(id) => {
            removeRecent(id);
          }}
          onRequestDelete={() => {
            setDeleteTarget(rowMenu.node);
            setRowMenu(null);
          }}
        />
      )}
      {deleteTarget !== null && (
        <ConfirmationModal
          isOpen
          variant="danger"
          title="Delete node?"
          message={`"${deleteTarget.id}" and its subtree will be moved to the trash.`}
          confirmLabel="Delete"
          onConfirm={() => {
            const target = deleteTarget;
            setDeleteTarget(null);
            void client.deleteObject(target.id).then(() => {
              // The store notification re-renders the lists (deleted nodes
              // drop out of byId); purge stale list entries too.
              removeRecent(target.id);
              if (readStoredJson(STORAGE_KEYS.favorites).includes(target.id)) {
                toggleFavorite(target.id);
              }
            });
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </aside>
  );
}
