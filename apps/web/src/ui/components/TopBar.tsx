/**
 * TopBar — the slim, transparent shell header in three sections:
 *  LEFT   dock-left (sidebar show/hide at every width), the workspace
 *         selector (the wordmark's permanent replacement — owner
 *         2026-10-06), and icon-only New + search buttons to its right;
 *         sync status rides the section's end
 *  CENTER the in-app Back/Forward arrows + the current node's breadcrumbs,
 *         left-aligned within the section
 *  RIGHT  undo/redo (the session journal, topbar buttons + the
 *         history chevron), calendar, right-sidebar show/hide
 */

import type { ReactNode, RefObject } from "react";

import type { SyncStatusSnapshot } from "@/core/workspace-client.js";
import type { UndoUiState } from "@/core/undo-journal.js";

import { Icon } from "../Icon.js";
import { Button } from "../components/ui/Button.js";
import { HoverRevealButton } from "../components/ui/HoverRevealButton.js";
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
  /**
   * The in-app Back/Forward arrows (owner 2026-10-14): window.history
   * back/forward through the App's OWN navigation stack (tracked in the App
   * layer — the browser stack reaches beyond the app). Undefined hides the
   * pair (boot screens); the disabled states ride the stack cursor.
   */
  canGoBack = false,
  canGoForward = false,
  onGoBack,
  onGoForward,
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
  /**
   * The session-only page-layout toggle (owner 2026-10-12, never stored):
   * the icon names the CURRENT mode — the split icon is the panelled
   * default (the properties sidebar rides the first column), the agenda
   * icon the in-flow sections layout. Undefined hides the button (boot
   * screens, and the app hides it while no node is open).
   */
  sectionsLayout = false,
  onToggleLayout,
}: {
  syncStatus: SyncStatusSnapshot;
  /** Opens the sync details modal; undefined on boot screens. */
  onOpenSyncDetails?: (() => void) | undefined;
  /** The current node's breadcrumb trail (center section). */
  breadcrumbs?: ReactNode;
  sidebarOpen: boolean;
  rightPanelOpen: boolean;
  /** In-app navigation stack cursor: false at the oldest entry. */
  canGoBack?: boolean | undefined;
  /** In-app navigation stack cursor: false at the newest entry. */
  canGoForward?: boolean | undefined;
  onGoBack?: (() => void) | undefined;
  onGoForward?: (() => void) | undefined;
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
  /** The session-only layout toggle's current mode (false = panelled sidebar). */
  sectionsLayout?: boolean | undefined;
  /** Flips the session layout mode; undefined hides the toggle. */
  onToggleLayout?: (() => void) | undefined;
}) {
  return (
    <header className="nt-topbar">
      <div className="nt-topbar-left">
        <Button
          type="button"
          variant="outline"
          size="sm"
          icon="mdi mdi-dock-left"
          aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          aria-pressed={sidebarOpen}
          title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          active={sidebarOpen}
          onClick={onToggleSidebar}
        />
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
      <div className="nt-topbar-center">
        {(onGoBack !== undefined || onGoForward !== undefined) && (
          <span className="nt-topbar-nav" role="group" aria-label="Back and forward">
            <button
              type="button"
              className="nt-icon-btn"
              disabled={!canGoBack}
              title="Back (Alt+←)"
              aria-label="Back"
              onClick={onGoBack}
            >
              <Icon path="mdi-arrow-left" size={1} />
            </button>
            <button
              type="button"
              className="nt-icon-btn"
              disabled={!canGoForward}
              title="Forward (Alt+→)"
              aria-label="Forward"
              onClick={onGoForward}
            >
              <Icon path="mdi-arrow-right" size={1} />
            </button>
          </span>
        )}
        {breadcrumbs}
      </div>
      <div className="nt-topbar-right">
        {onToggleLayout !== undefined && (
          <button
            type="button"
            className={sectionsLayout ? "nt-icon-btn nt-icon-btn-active" : "nt-icon-btn"}
            title={sectionsLayout ? "Switch to sidebar layout" : "Switch to sections layout"}
            aria-label={sectionsLayout ? "Switch to sidebar layout" : "Switch to sections layout"}
            aria-pressed={!sectionsLayout}
            onClick={onToggleLayout}
          >
            <Icon path={sectionsLayout ? "mdi-view-agenda-outline" : "mdi-view-split-vertical"} size={1} />
          </button>
        )}
        {undoState !== undefined && (
          <span className="nt-topbar-undo ui-hover-reveal-group" role="group" aria-label="Undo and redo">
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
            <HoverRevealButton
              ref={historyButtonRef}
              className="nt-topbar-undo__chevron"
              title="History (Ctrl+Shift+H)"
              aria-label="Toggle history"
              aria-haspopup="menu"
              onClick={onToggleHistory}
            >
              <Icon path="mdi-chevron-down" size={0.8} />
            </HoverRevealButton>
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
        <Button
          type="button"
          variant="outline"
          size="sm"
          icon="mdi mdi-dock-right"
          title={rightPanelOpen ? "Hide right sidebar" : "Show right sidebar"}
          aria-label="Toggle right sidebar"
          aria-pressed={rightPanelOpen}
          active={rightPanelOpen}
          onClick={onToggleRightPanel}
        />
      </div>
    </header>
  );
}
