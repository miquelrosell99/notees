/**
 * TopBar — the slim, transparent shell header in three sections:
 *  LEFT   hamburger (sidebar show/hide at every width), wordmark, sync status
 *  CENTER the current node's breadcrumbs, left-aligned within the section
 *  RIGHT  palette, theme, settings, sign out, right-sidebar show/hide
 */

import { useState, type ReactNode } from "react";

import type { SyncStatusSnapshot } from "@/core/workspace-client.js";

import { Icon } from "../Icon.js";
import "./TopBar.css";

/**
 * SyncDot — the overall sync indicator: a colored dot only. Hover opens a
 * small panel with the operational details (state, backlog, cursor,
 * realtime, last error).
 */
function SyncDot({ snapshot }: { snapshot: SyncStatusSnapshot }) {
  const [hover, setHover] = useState(false);
  const backlog = snapshot.pending + snapshot.failed;
  const state =
    snapshot.status === "error" ? "error" : snapshot.status === "syncing" ? "syncing" : backlog > 0 ? "backlog" : "idle";
  const close = () => setHover(false);
  return (
    <span
      className={`nt-sync-dot nt-sync-dot-${state}`}
      role="status"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={close}
      onFocus={() => setHover(true)}
      onBlur={close}
    >
      <span className="nt-sync-dot-disc" aria-hidden="true" />
      <span className="sr-only">{`Sync: ${state}`}</span>
      {hover && (
        <span className="nt-sync-panel" role="tooltip">
          <span className="nt-sync-panel-row">
            <strong>Sync</strong>
            <span>{snapshot.status}{snapshot.realtime ? " · realtime" : " · realtime off"}</span>
          </span>
          <span className="nt-sync-panel-row">
            <span>Backlog</span>
            <span>{snapshot.pending} pending · {snapshot.failed} failed</span>
          </span>
          {snapshot.quarantined > 0 && (
            <span className="nt-sync-panel-row">
              <span>Quarantined</span>
              <span>{snapshot.quarantined}</span>
            </span>
          )}
          <span className="nt-sync-panel-row">
            <span>Server seq</span>
            <span>{snapshot.cursorSeq}</span>
          </span>
          {snapshot.error !== null && (
            <span className="nt-sync-panel-row nt-sync-panel-error">{snapshot.error}</span>
          )}
        </span>
      )}
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
}: {
  syncStatus: SyncStatusSnapshot;
  /** The current node's breadcrumb trail (center section). */
  breadcrumbs?: ReactNode;
  sidebarOpen: boolean;
  rightPanelOpen: boolean;
  onToggleSidebar: () => void;
  onToggleRightPanel: () => void;
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
          <Icon path="mdi-page-layout-sidebar-left" size={1} />
        </button>
        <span className="nt-wordmark">Notees</span>
        
        <SyncDot snapshot={syncStatus} />
      </div>
      <div className="nt-topbar-center">{breadcrumbs}</div>
      <div className="nt-topbar-right">
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
