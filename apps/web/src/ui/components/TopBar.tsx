/**
 * TopBar — the slim, transparent shell header in three sections:
 *  LEFT   hamburger (sidebar show/hide at every width), wordmark, sync status
 *  CENTER the current node's breadcrumbs, left-aligned within the section
 *  RIGHT  palette, theme, settings, sign out, right-sidebar show/hide
 */

import type { ReactNode } from "react";

import type { SyncStatusSnapshot } from "@/core/workspace-client.js";

import { Icon } from "../Icon.js";
import { ThemeToggle } from "../ThemeToggle.js";
import "./TopBar.css";

/** Compact sync indicator: icon only; the full status line is its tooltip. */
function SyncStatusLine({ snapshot }: { snapshot: SyncStatusSnapshot }) {
  const backlog = snapshot.pending + snapshot.failed;
  const label =
    snapshot.status === "idle"
      ? `Sync: idle · ${backlog} pending`
      : snapshot.status === "syncing"
        ? `Sync: syncing… · ${backlog} pending`
        : `Sync error${snapshot.error ? `: ${snapshot.error}` : ""} · ${backlog} pending`;
  const fullTitle = snapshot.realtime ? label : `${label} · realtime off`;
  const icon =
    snapshot.status === "error"
      ? "mdi-cloud-alert-outline"
      : snapshot.status === "syncing"
        ? "mdi-cloud-sync-outline"
        : backlog > 0
          ? "mdi-cloud-upload-outline"
          : "mdi-cloud-check-outline";
  return (
    <span
      className={
        snapshot.status === "error" ? "nt-sync-status nt-sync-status-error" : "nt-sync-status"
      }
      title={fullTitle}
      aria-label={fullTitle}
    >
      <Icon path={icon} size={0.95} />
    </span>
  );
}

export function TopBar({
  syncStatus,
  breadcrumbs,
  sidebarOpen,
  rightPanelOpen,
  onToggleSidebar,
  onToggleRightPanel,
  onNewPage,
  onOpenPalette,
  showSettings,
  onOpenSettings,
  onSignOut,
}: {
  syncStatus: SyncStatusSnapshot;
  /** The current node's breadcrumb trail (center section). */
  breadcrumbs?: ReactNode;
  sidebarOpen: boolean;
  rightPanelOpen: boolean;
  onToggleSidebar: () => void;
  onToggleRightPanel: () => void;
  onNewPage: () => void;
  onOpenPalette: () => void;
  /** Settings requires a live session on a server workspace (API-key admin). */
  showSettings: boolean;
  onOpenSettings: () => void;
  onSignOut: () => void;
}) {
  return (
    <header className="nt-topbar">
      <div className="nt-topbar-left">
        <button
          type="button"
          className="nt-icon-btn"
          aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          aria-pressed={sidebarOpen}
          onClick={onToggleSidebar}
        >
          <Icon path="mdi-menu" size={1} />
        </button>
        <span className="nt-wordmark">Notees</span>
        <span className="nt-status-dot" aria-hidden="true" />
        <SyncStatusLine snapshot={syncStatus} />
      </div>
      <div className="nt-topbar-center">{breadcrumbs}</div>
      <div className="nt-topbar-right">
        <button
          type="button"
          className="nt-icon-btn"
          title="New page"
          aria-label="New page"
          onClick={onNewPage}
        >
          <Icon path="mdi-plus" size={1} />
        </button>
        <button
          type="button"
          className="nt-topbar-search"
          title="Search (Ctrl+K)"
          aria-label="Search pages, classes and actions"
          onClick={onOpenPalette}
        >
          <Icon path="mdi-magnify" size={0.9} />
          <span className="nt-topbar-search-hint">Search</span>
        </button>
        <ThemeToggle />
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
        <button
          type="button"
          className="nt-icon-btn"
          title="Sign out"
          aria-label="Sign out"
          onClick={onSignOut}
        >
          <Icon path="mdi-logout-variant" size={1} />
        </button>
        <button
          type="button"
          className={rightPanelOpen ? "nt-icon-btn nt-icon-btn-active" : "nt-icon-btn"}
          title={rightPanelOpen ? "Hide right sidebar" : "Show right sidebar"}
          aria-label="Toggle right sidebar"
          aria-pressed={rightPanelOpen}
          onClick={onToggleRightPanel}
        >
          <Icon path="mdi-page-layout-sidebar-right" size={1} />
        </button>
      </div>
    </header>
  );
}
