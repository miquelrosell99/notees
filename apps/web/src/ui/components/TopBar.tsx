/**
 * TopBar — the slim, transparent shell header that sits directly on the
 * background canvas with only a hairline bottom border. Hosts the sidebar
 * hamburger (mobile), the wordmark, the new-page action, the sync status,
 * the command-palette trigger, the theme toggle, settings (session only)
 * and sign out. Extracted from App.tsx.
 */

import type { SyncStatusSnapshot } from "@/core/workspace-client.js";

import { Icon } from "../Icon.js";
import { ThemeToggle } from "../ThemeToggle.js";
import "./TopBar.css";

/** Subtle sync line: engine state, undelivered backlog, realtime indicator. */
function SyncStatusLine({ snapshot }: { snapshot: SyncStatusSnapshot }) {
  const backlog = snapshot.pending + snapshot.failed;
  const label =
    snapshot.status === "idle"
      ? `Sync: idle · ${backlog} pending`
      : snapshot.status === "syncing"
        ? `Sync: syncing… · ${backlog} pending`
        : `Sync error${snapshot.error ? `: ${snapshot.error}` : ""} · ${backlog} pending`;
  return (
    <span
      className={
        snapshot.status === "error" ? "nt-sync-status nt-sync-status-error" : "nt-sync-status"
      }
      title={snapshot.error ?? undefined}
    >
      {label}
      {snapshot.realtime ? "" : " · realtime off"}
    </span>
  );
}

export function TopBar({
  syncStatus,
  onToggleSidebar,
  onNewPage,
  onOpenPalette,
  showSettings,
  onOpenSettings,
  onSignOut,
}: {
  syncStatus: SyncStatusSnapshot;
  onToggleSidebar: () => void;
  onNewPage: () => void;
  onOpenPalette: () => void;
  /** Settings requires a live session on a server workspace (API-key admin). */
  showSettings: boolean;
  onOpenSettings: () => void;
  onSignOut: () => void;
}) {
  return (
    <header className="nt-topbar">
      <button
        type="button"
        className="nt-icon-btn nt-topbar-burger"
        aria-label="Toggle sidebar"
        onClick={onToggleSidebar}
      >
        <Icon path="mdi-menu" size={1} />
      </button>
      <span className="nt-wordmark">Notees</span>
      <span className="nt-status-dot" aria-hidden="true" />
      <button
        type="button"
        className="nt-icon-btn"
        title="New page"
        aria-label="New page"
        onClick={onNewPage}
      >
        <Icon path="mdi-plus" size={1} />
      </button>
      <span className="nt-topbar-spacer" />
      <SyncStatusLine snapshot={syncStatus} />
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
    </header>
  );
}
