/**
 * TopBar — the slim, transparent shell header in three sections:
 *  LEFT   dock-left (sidebar show/hide at every width), the workspace
 *         selector (the wordmark's permanent replacement — owner
 *         2026-10-06), and icon-only New + search buttons to its right;
 *         the sync indicator left the top bar 2026-10-19 — it rides the
 *         sidebar profile circle's corner now
 *  CENTER the current node's breadcrumbs, left-aligned within the section
 *  RIGHT  the in-app Back/Forward arrows (owner 2026-10-14: relocated
 *         from the center, beside the breadcrumbs — they now open the
 *         section), the focus-mode toggle, the condensed-layer toggle
 *         (owner 2026-10-15, beside focus), the session layout toggle,
 *         undo/redo (the session journal, topbar buttons + the history
 *         chevron), calendar, right-sidebar show/hide
 */

import type { ReactNode, RefObject } from "react";

import type { UndoUiState } from "@/core/undo-journal.js";

import { Icon } from "../Icon.js";
import { Button } from "../../components/ui/fleet/Button.js";
import { HoverRevealButton } from "../../components/ui/fleet/HoverRevealButton.js";
import "./TopBar.css";

export function TopBar({
  breadcrumbs,
  sidebarOpen,
  rightPanelOpen,
  /**
   * The in-app Back/Forward arrows (owner 2026-10-14): window.history
   * back/forward through the App's OWN navigation stack (tracked in the App
   * layer — the browser stack reaches beyond the app). Undefined hides the
   * pair (boot screens); the disabled states ride the stack cursor. The
   * pair rides the RIGHT section (owner 2026-10-14: moved off the center,
   * which now carries the breadcrumbs alone).
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
  /**
   * Focus mode (#12): the device-local display state; the crop-free bracket
   * icon names the mode either way — the active chrome carries the on/off
   * state (the calendar button's precedent). Undefined hides the button
   * (boot screens); Esc exits focus mode regardless. Relocated from the
   * quick settings modal (owner 2026-10-14).
   */
  focusMode = false,
  dayNav = undefined,
  onToggleFocusMode,
  /**
   * The condensed layer toggle (owner 2026-10-15): rides directly beside the
   * focus-mode button, the same icon-button idiom (the pressed chrome
   * carries the on/off state). It acts on the ACTIVE page's per-page pref
   * (`condensed.<pageId>` — the App layer owns the write, placement does not
   * change the model). Undefined hides the button — the App passes none
   * where there is no eligible main-surface page (no selection, embedded /
   * preview surfaces), the `onToggleLayout` gating idiom.
   */
  condensedActive = false,
  onToggleCondensed,
}: {
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
  /** Focus mode's current state (drives the pressed/active chrome). */
  focusMode?: boolean | undefined;
  /** The day-page stepping cluster (AppTopBar builds it for day pages). */
  dayNav?: import("react").ReactNode | undefined;
  /** Flips focus mode (the App layer owns the device-setting write). */
  onToggleFocusMode?: (() => void) | undefined;
  /** The condensed layer's current state for the ACTIVE page (pressed chrome). */
  condensedActive?: boolean | undefined;
  /** Flips the active page's condensed pref (the App layer owns the write). */
  onToggleCondensed?: (() => void) | undefined;
}) {
  return (
    <header className="nt-topbar">
      <div className="nt-topbar-left">
        <Button
          type="button"
          variant="ghost"
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
          <Button
            ref={newButtonRef}
            type="button"
            variant="ghost"
            size="sm"
            icon="mdi mdi-plus"
            title="New (pick a class)"
            aria-label="New node"
            onClick={onNewNode}
          />
        )}
        {onRequestSearch !== undefined && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            icon="mdi mdi-magnify"
            title="Search (Ctrl+K)"
            aria-label="Search"
            onClick={onRequestSearch}
          />
        )}
      </div>
      <div className="nt-topbar-center">
        {breadcrumbs}
      </div>
      <div className="nt-topbar-right">
        {/* The day-stepping cluster while a day page is open (owner
           2026-10-24): first in the right cluster, Today bordered between
           the chevrons. */}
        {dayNav}
        {(onGoBack !== undefined || onGoForward !== undefined) && (
          <span className="nt-topbar-nav" role="group" aria-label="Back and forward">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              icon="mdi mdi-arrow-left"
              disabled={!canGoBack}
              title="Back (Alt+←)"
              aria-label="Back"
              onClick={onGoBack}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              icon="mdi mdi-arrow-right"
              disabled={!canGoForward}
              title="Forward (Alt+→)"
              aria-label="Forward"
              onClick={onGoForward}
            />
          </span>
        )}
        {onToggleFocusMode !== undefined && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            icon="mdi mdi-crop-free"
            active={focusMode}
            title={focusMode ? "Exit focus mode (Esc)" : "Focus mode (Ctrl+Alt+F)"}
            aria-label={focusMode ? "Exit focus mode" : "Focus mode"}
            aria-pressed={focusMode}
            onClick={onToggleFocusMode}
          />
        )}
        {onToggleCondensed !== undefined && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            icon="mdi mdi-unfold-less-horizontal"
            active={condensedActive}
            title={condensedActive ? "Condensed: exit" : "Condensed: enter"}
            aria-label={condensedActive ? "Exit condensed mode" : "Condensed mode"}
            aria-pressed={condensedActive}
            onClick={onToggleCondensed}
          />
        )}
        {onToggleLayout !== undefined && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            icon={sectionsLayout ? "mdi mdi-view-agenda-outline" : "mdi mdi-view-split-vertical"}
            active={sectionsLayout}
            title={sectionsLayout ? "Switch to sidebar layout" : "Switch to sections layout"}
            aria-label={sectionsLayout ? "Switch to sidebar layout" : "Switch to sections layout"}
            aria-pressed={!sectionsLayout}
            onClick={onToggleLayout}
          />
        )}
        {undoState !== undefined && (
          <span className="nt-topbar-undo ui-hover-reveal-group" role="group" aria-label="Undo and redo">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              icon="mdi mdi-undo-variant"
              disabled={!undoState.canUndo}
              title={undoState.undoLabel ?? "Undo"}
              aria-label={undoState.undoLabel ?? "Undo"}
              onClick={onUndo}
            />
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
            <Button
              type="button"
              variant="ghost"
              size="sm"
              icon="mdi mdi-redo-variant"
              disabled={!undoState.canRedo}
              title={undoState.redoLabel ?? "Redo"}
              aria-label={undoState.redoLabel ?? "Redo"}
              onClick={onRedo}
            />
          </span>
        )}
        {onToggleCalendar !== undefined && (
          <Button
            type="button"
            ref={calendarButtonRef}
            variant="ghost"
            size="sm"
            icon="mdi mdi-calendar-month-outline"
            active={calendarOpen}
            title={calendarOpen ? "Close calendar" : "Open calendar"}
            aria-label="Toggle calendar"
            aria-expanded={calendarOpen}
            onClick={onToggleCalendar}
          />
        )}
        <Button
          type="button"
          variant="ghost"
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
