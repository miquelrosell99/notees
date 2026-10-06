/**
 * TopBar — the slim, transparent shell header in three sections:
 *  LEFT   hamburger (sidebar show/hide at every width), the workspace
 *         selector (the wordmark's permanent replacement — owner
 *         2026-10-06), and icon-only New + search buttons to its right;
 *         sync status rides the section's end
 *  CENTER the current node's breadcrumbs, left-aligned within the section
 *  RIGHT  undo/redo (the session journal, topbar buttons + the
 *         history chevron), calendar, right-sidebar show/hide
 */

import type { ReactNode, RefObject } from "react";

import type { SyncStatusSnapshot } from "@/core/workspace-client.js";
import type { UndoUiState } from "@/core/undo-journal.js";

import { Icon } from "../Icon.js";
import "./TopBar.css";

/**
 * SyncDot — the overall sync indicator: a colored dot only. Click opens the
 * sync details modal in the App layer (it needs the client); when no handler
 * is wired (boot screens) the dot renders as a plain status span.
 */
function SyncDot({
  snapshot,
  onOpen,
}: {
  snapshot: SyncStatusSnapshot;
  onOpen?: (() => void) | undefined;
}) {
  const backlog = snapshot.pending + snapshot.failed;
  const state =
    snapshot.status === "error" ? "error" : snapshot.status === "syncing" ? "syncing" : backlog > 0 ? "backlog" : "idle";
  if (onOpen === undefined) {
    return (
      <span className={`nt-sync-dot nt-sync-dot-${state}`} role="status">
        <span className="nt-sync-dot-disc" aria-hidden="true" />
        <span className="sr-only">{`Sync: ${state}`}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`nt-sync-dot nt-sync-dot-${state}`}
      aria-label={`Sync: ${state}. Open sync details`}
      title={`Sync: ${state} — open details`}
      onClick={onOpen}
    >
      <span className="nt-sync-dot-disc" aria-hidden="true" />
    </button>
  );
}

export function TopBar({
  syncStatus,
  onOpenSyncDetails,
  breadcrumbs,
  sidebarOpen,
  rightPanelOpen,
  calendarOpen = false,
  onToggleCalendar,
  calendarButtonRef,
  /** The session journal's topbar buttons (undo + redo + history). */
  undoState,
  onUndo,
  onRedo,
  onToggleHistory,
  historyButtonRef,
  onToggleSidebar,
  onToggleRightPanel,
  /**
   * The collapsed-sidebar-era left cluster is permanent now (owner
   * 2026-10-06): icon-only New + search buttons ride the top bar at every
   * sidebar state, to the workspace selector's right. `workspaceSwitcher`
   * replaces the wordmark.
   */
  onNewNode,
  onRequestSearch,
  newButtonRef,
  workspaceSwitcher,
}: {
  syncStatus: SyncStatusSnapshot;
  /** Opens the sync details modal; undefined on boot screens. */
  onOpenSyncDetails?: (() => void) | undefined;
  /** The current node's breadcrumb trail (center section). */
  breadcrumbs?: ReactNode;
  sidebarOpen: boolean;
  rightPanelOpen: boolean;
  /** Calendar popup state; the popup itself renders in the App layer (it needs the client). */
  calendarOpen?: boolean;
  onToggleCalendar?: (() => void) | undefined;
  calendarButtonRef?: RefObject<HTMLButtonElement | null> | undefined;
  /**
   * The journal state slice: the undo/redo buttons disable when
   * empty and take the live labels ("Undo edit text") as their titles.
   * Undefined hides the cluster (the boot screens' TopBar never gets it).
   */
  undoState?: UndoUiState | undefined;
  onUndo?: (() => void) | undefined;
  onRedo?: (() => void) | undefined;
  /** Opens/closes the browsable history popup (the undo button's chevron). */
  onToggleHistory?: (() => void) | undefined;
  historyButtonRef?: RefObject<HTMLButtonElement | null> | undefined;
  onToggleSidebar: () => void;
  onToggleRightPanel: () => void;
  /** Opens the class-picker "New" popup (App layer); undefined hides the button. */
  onNewNode?: (() => void) | undefined;
  /** Opens the search palette (App layer); undefined hides the button. */
  onRequestSearch?: (() => void) | undefined;
  /** The New button's anchor for the class-picker popup. */
  newButtonRef?: RefObject<HTMLButtonElement | null> | undefined;
  /** The workspace selector element (wordmark replacement, collapsed sidebar). */
  workspaceSwitcher?: ReactNode;
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
        {workspaceSwitcher !== undefined ? (
          workspaceSwitcher
        ) : (
          <span className="nt-wordmark">Notees</span>
        )}
        {onNewNode !== undefined && (
          <button
            ref={newButtonRef}
            type="button"
            className="nt-icon-btn"
            title="New (pick a class)"
            aria-label="New node"
            onClick={onNewNode}
          >
            <Icon path="mdi-plus" size={1} />
          </button>
        )}
        {onRequestSearch !== undefined && (
          <button
            type="button"
            className="nt-icon-btn"
            title="Search (Ctrl+K)"
            aria-label="Search"
            onClick={onRequestSearch}
          >
            <Icon path="mdi-magnify" size={1} />
          </button>
        )}

        <SyncDot snapshot={syncStatus} onOpen={onOpenSyncDetails} />
      </div>
      <div className="nt-topbar-center">{breadcrumbs}</div>
      <div className="nt-topbar-right">
        {undoState !== undefined && (
          <span className="nt-topbar-undo" role="group" aria-label="Undo and redo">
            <button
              type="button"
              className="nt-icon-btn"
              disabled={!undoState.canUndo}
              title={undoState.undoLabel ?? "Undo"}
              aria-label={undoState.undoLabel ?? "Undo"}
              onClick={onUndo}
            >
              <Icon path="mdi-undo-variant" size={1} />
            </button>
            <button
              type="button"
              ref={historyButtonRef}
              className="nt-icon-btn nt-topbar-undo__chevron"
              title="History (Ctrl+Shift+H)"
              aria-label="Toggle history"
              aria-haspopup="menu"
              onClick={onToggleHistory}
            >
              <Icon path="mdi-chevron-down" size={0.8} />
            </button>
            <button
              type="button"
              className="nt-icon-btn"
              disabled={!undoState.canRedo}
              title={undoState.redoLabel ?? "Redo"}
              aria-label={undoState.redoLabel ?? "Redo"}
              onClick={onRedo}
            >
              <Icon path="mdi-redo-variant" size={1} />
            </button>
          </span>
        )}
        {onToggleCalendar !== undefined && (
          <button
            type="button"
            ref={calendarButtonRef}
            className={calendarOpen ? "nt-icon-btn nt-icon-btn-active" : "nt-icon-btn"}
            title={calendarOpen ? "Close calendar" : "Open calendar"}
            aria-label="Toggle calendar"
            aria-expanded={calendarOpen}
            onClick={onToggleCalendar}
          >
            <Icon path="mdi-calendar-month-outline" size={1} />
          </button>
        )}
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
