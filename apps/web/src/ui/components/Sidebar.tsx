/**
 * Sidebar — the 260px transparent workspace navigator that sits directly on
 * the background canvas (hairline right border, no surface fill on desktop).
 *
 * Hosts the workspace switcher, the workspace search, the static navigation
 * rows (Journal / Inbox / Pages / Whiteboards / Tasks), Favorites, Recents,
 * the filtered page list and the Classes list, plus the footer (account +
 * store mode). Favorites/recents/nav-filter are device-local UI state and
 * live here now (moved out of App.tsx). Extracted from App.tsx.
 */

import { useState } from "react";

import { deriveDisplayName, SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { Icon } from "../Icon.js";
import { SearchBox } from "../SearchBox.js";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher.js";
import "./Sidebar.css";

type AnyClient = WorkspaceClient | WorkerClient;

type NavFilter = "journal" | "inbox" | "pages" | "whiteboards" | "tasks";

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

function writeStoredJson(key: string, value: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable (private mode); the lists just won't persist.
  }
}

export function Sidebar({
  client,
  cacheVersion,
  workspaceName,
  workspaceId,
  serverUrl,
  credential,
  userEmail,
  offline,
  storeMode,
  selectedPageId,
  onOpenPage,
  onSwitchWorkspace,
  onSignOut,
}: {
  client: AnyClient;
  /** Bumped by the App on every client notification (SearchBox cache refresh). */
  cacheVersion: number;
  workspaceName: string;
  workspaceId: string;
  serverUrl: string;
  credential: string;
  userEmail: string | null;
  offline: boolean;
  storeMode: "worker" | "in-process";
  selectedPageId: string | null;
  onOpenPage: (nodeId: string) => void;
  onSwitchWorkspace: (workspaceId: string, name: string) => void;
  onSignOut: () => void;
}) {
  const [navFilter, setNavFilter] = useState<NavFilter>("pages");
  const [favorites, setFavorites] = useState<string[]>(() => readStoredJson(STORAGE_KEYS.favorites));
  const [recents, setRecents] = useState<string[]>(() => readStoredJson(STORAGE_KEYS.recents));

  const openRow = (id: string): void => {
    onOpenPage(id);
    setRecents((previous) => {
      const next = [id, ...previous.filter((entry) => entry !== id)].slice(0, 8);
      writeStoredJson(STORAGE_KEYS.recents, next);
      return next;
    });
  };

  const toggleFavorite = (id: string): void => {
    setFavorites((previous) => {
      const next = previous.includes(id) ? previous.filter((entry) => entry !== id) : [...previous, id];
      writeStoredJson(STORAGE_KEYS.favorites, next);
      return next;
    });
  };

  // Asset-class nodes (uploaded files linked via the attachments property)
  // are library objects, not pages — keep them out of the page sidebar.
  const classes = client.listClasses();
  const assetClassId =
    classes.find((cls) => cls.name === "asset")?.id ?? SYSTEM_CLASS_UUIDS.asset;
  const pages = client.listPages().filter((page) => !page.classIds.includes(assetClassId));
  const dateClassIds: string[] = [
    SYSTEM_CLASS_UUIDS.day,
    SYSTEM_CLASS_UUIDS.month,
    SYSTEM_CLASS_UUIDS.year,
  ];
  const journalPages = pages.filter((page) => page.classIds.some((c) => dateClassIds.includes(c)));
  const whiteboardPages = pages.filter((page) => page.classIds.includes(SYSTEM_CLASS_UUIDS.whiteboard));
  const taskPages = pages.filter((page) => page.classIds.includes(SYSTEM_CLASS_UUIDS.task));
  const sectionIds = new Set([...journalPages, ...whiteboardPages, ...taskPages].map((p) => p.id));
  const inboxPages = pages.filter((page) => !sectionIds.has(page.id) && page.classIds.length === 0);
  const browsePages = pages.filter((page) => !sectionIds.has(page.id) && page.classIds.length > 0);
  const favoritePages = favorites
    .map((id) => pages.find((page) => page.id === id))
    .filter((page): page is (typeof pages)[number] => page !== undefined);
  const recentPages = recents
    .map((id) => pages.find((page) => page.id === id))
    .filter((page): page is (typeof pages)[number] => page !== undefined)
    .slice(0, 8);

  const renderRow = (node: (typeof pages)[number], icon?: string | null) => (
    <li key={node.id} className="nt-side-row">
      <button
        type="button"
        className={
          node.id === selectedPageId ? "nt-side-item nt-side-item-active" : "nt-side-item"
        }
        onClick={() => openRow(node.id)}
      >
        {icon !== null && icon !== undefined && (
          <Icon path={icon} size={1} className="nt-side-item-icon" />
        )}
        <span className="nt-side-item-label">{deriveDisplayName(node) || node.id}</span>
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

  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});

  const renderSection = (title: string, rows: ReturnType<typeof renderRow>[]) => {
    if (rows.length === 0) return null;
    const collapsed = collapsedSections[title] === true;
    return (
      <section className="nt-side-section">
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
          <span>{title}</span>
        </button>
        {!collapsed && <ul className="nt-side-list">{rows}</ul>}
      </section>
    );
  };

  const navRow = (key: NavFilter, label: string, icon: string) => (
    <li key={key} className="nt-side-row">
      <button
        type="button"
        className={navFilter === key ? "nt-side-item nt-side-item-active" : "nt-side-item"}
        onClick={() => setNavFilter(key)}
      >
        <Icon path={icon} size={1} className="nt-side-item-icon" />
        <span className="nt-side-item-label">{label}</span>
      </button>
    </li>
  );

  const filteredTitle =
    navFilter === "journal"
      ? "Journal"
      : navFilter === "inbox"
        ? "Inbox"
        : navFilter === "whiteboards"
          ? "Whiteboards"
          : navFilter === "tasks"
            ? "Tasks"
            : "Pages";
  const filteredPages =
    navFilter === "journal"
      ? journalPages
      : navFilter === "inbox"
        ? inboxPages
        : navFilter === "whiteboards"
          ? whiteboardPages
          : navFilter === "tasks"
            ? taskPages
            : browsePages;

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
            onSignOut={onSignOut}
          />
        )}
      </div>
      <div className="nt-sidebar-search">
        <SearchBox client={client} onOpenNode={openRow} cacheVersion={cacheVersion} />
      </div>
      <nav className="nt-sidebar-nav">
        {renderSection("Navigation", [
          navRow("journal", "Journal", "mdi-calendar-clock"),
          navRow("inbox", "Inbox", "mdi-tray-arrow-down"),
          navRow("pages", "Pages", "mdi-book-open-page-variant"),
          navRow("whiteboards", "Whiteboards", "mdi-presentation"),
          navRow("tasks", "Tasks", "mdi-format-list-checks"),
        ])}
        {renderSection("Favorites", favoritePages.map((page) => renderRow(page)))}
        {renderSection("Recents", recentPages.map((page) => renderRow(page)))}
        {renderSection(
          filteredTitle,
          filteredPages.map((page) =>
            renderRow(page, classes.find((cls) => page.classIds.includes(cls.id))?.icon ?? null),
          ),
        )}
        {classes.length > 0 &&
          renderSection("Classes", classes.map((cls) => renderRow(cls, cls.icon)))}
      </nav>
      <div className="nt-sidebar-footer">
        <span className="nt-sidebar-user">{userEmail ?? "Offline"}</span>
        <span className="nt-sidebar-store">
          {offline ? "local workspace" : storeMode === "worker" ? "Worker + OPFS" : "in-process store"}
        </span>
      </div>
    </aside>
  );
}
