/**
 * keymap — the global key-chord handler factories (framework-free).
 *
 * Every chord is document-level and guarded from form fields / the outliner
 * editor (text fields keep the keystroke — the guard matches across all
 * chords). Each factory returns the listener so the App's effects can wire
 * and unwire it; exported for the keymap/dismissal test suites.
 */

import type { UndoUiState } from "@/core/undo-journal.js";
import { todayIsoLocal } from "../../features/calendar/calendarViewUtils.js";
import type { AnyClient } from "./clients.js";

/**
 * Ctrl/Cmd+Shift+T — open today's daily page (the keymap row reserves
 * the chord for "today"). Local-midnight today (never
 * the UTC .slice pattern), ensure-chain (idempotent get-or-create) + open.
 * Text fields keep the keystroke — the guard matches the other global
 * chords. Note: browsers reserve Ctrl+Shift+T for "reopen closed tab", so
 * the chord fires only where the browser yields it (and under Cmd on macOS);
 * exported for the day-features tests.
 */
export function openTodayKeyHandler(opts: {
  client: () => AnyClient | null;
  openPage: (nodeId: string) => void;
}): (event: KeyboardEvent) => void {
  return (event) => {
    if (event.key.toLowerCase() !== "t" || !event.shiftKey || !(event.ctrlKey || event.metaKey)) {
      return;
    }
    // Document-level dispatch (and window) has no Element target — only
    // element targets can sit inside a text field.
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest("input, textarea, select, [contenteditable]")
    ) {
      return;
    }
    const live = opts.client();
    if (live === null) return;
    event.preventDefault();
    void live.ensureDateChain(todayIsoLocal()).then(({ day }) => opts.openPage(day));
  };
}

/**
 * Alt+← / Alt+→ — in-app Back/Forward. Desktop browsers use
 * the same chords for history natively and still deliver keydown to the
 * page, so preventDefault stops the native jump and window.history drives
 * the EXISTING nav state: the popstate effect maps the stack entry exactly
 * like a deep-link navigation. Form fields keep the keystroke (the guard
 * matches the other global chords); exported for the keymap tests.
 */
export function historyNavKeyHandler(): (event: KeyboardEvent) => void {
  return (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest("input, textarea, select, [contenteditable]")
    ) {
      return;
    }
    event.preventDefault();
    if (event.key === "ArrowLeft") window.history.back();
    else window.history.forward();
  };
}

/**
 * Ctrl/Cmd+N new page, Ctrl/Cmd+, settings, Ctrl/Cmd+\ sidebar toggle —
 * the keymap-breadth chords. Every chord is guarded from form
 * fields (the guard matches the other global chords). Ctrl+N is browser-
 * reserved on desktop builds (new window), so it fires only where the
 * browser yields the keystroke; Ctrl+, and Ctrl+\ are unclaimed in
 * Chrome/Firefox/Safari. Ctrl+Shift+N (quick add) and Ctrl+Shift+T (today)
 * own their shifted variants; exported for the keymap tests.
 */
export function keymapChordHandler(opts: {
  client: () => AnyClient | null;
  openPage: (nodeId: string) => void;
  openSettings: () => void;
  toggleSidebar: () => void;
}): (event: KeyboardEvent) => void {
  return (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (!mod || event.altKey) return;
    const key = event.key;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest("input, textarea, select, [contenteditable]")
    ) {
      return;
    }
    if (!event.shiftKey && key.toLowerCase() === "n") {
      const live = opts.client();
      if (live === null) return;
      event.preventDefault();
      void live
        .createObject({ isEmbedded: false, name: "Untitled" })
        .then((id) => opts.openPage(id));
      return;
    }
    if (event.shiftKey) return;
    if (key === ",") {
      // The panel itself gates on a live session (signed-in user, online);
      // setting the flag is an honest no-op otherwise.
      event.preventDefault();
      opts.openSettings();
      return;
    }
    if (key === "\\") {
      event.preventDefault();
      opts.toggleSidebar();
    }
  };
}

/**
 * Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z (or Ctrl/Cmd+Y) redo — the session
 * journal chords. The editor-interaction rule (docs/ux.md "Undo and
 * redo"): while a text field or the outliner editor (contentEditable) owns
 * the focus, the local text behavior keeps the keystroke and the global
 * journal stays out of the way; every other focus runs the journal. The
 * guard therefore yields to ALL contenteditables — the outliner editor's
 * native text undo is text-scoped by design, and structural gestures are
 * journaled the moment focus leaves the editor. preventDefault fires only
 * when the journal has something to (re)apply; exported for the keymap tests.
 */
export function undoRedoKeyHandler(opts: {
  undoState: () => UndoUiState;
  onUndo: () => void;
  onRedo: () => void;
}): (event: KeyboardEvent) => void {
  return (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (!mod || event.altKey) return;
    const key = event.key.toLowerCase();
    const isUndo = key === "z" && !event.shiftKey;
    const isRedo = (key === "z" && event.shiftKey) || (key === "y" && !event.shiftKey);
    if (!isUndo && !isRedo) return;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest("input, textarea, select, [contenteditable]")
    ) {
      return;
    }
    const state = opts.undoState();
    if (isUndo) {
      if (!state.canUndo) return;
      event.preventDefault();
      opts.onUndo();
      return;
    }
    if (!state.canRedo) return;
    event.preventDefault();
    opts.onRedo();
  };
}

/**
 * Ctrl/Cmd+Shift+H — the browsable history popup (the history-menu
 * chord). Same guard as the undo chords: text fields and the outliner editor
 * keep the keystroke (Firefox may reserve it for its own history sidebar;
 * where the browser yields, the popup toggles). Exported for the keymap
 * tests, mirroring undoRedoKeyHandler.
 */
export function historyKeyHandler(opts: {
  onToggle: () => void;
}): (event: KeyboardEvent) => void {
  return (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (!mod || !event.shiftKey || event.altKey) return;
    if (event.key.toLowerCase() !== "h") return;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest("input, textarea, select, [contenteditable]")
    ) {
      return;
    }
    event.preventDefault();
    opts.onToggle();
  };
}

/**
 * Ctrl/Cmd+Shift+F — open the full-page search surface at /search (the
 * Capacities "Extended Search" parity slice). Same guard as the other
 * global chords: text fields and the outliner editor keep the keystroke;
 * the chord is browser-reserved nowhere universal. Exported for the
 * keymap tests, mirroring historyKeyHandler.
 */
export function searchKeyHandler(opts: {
  onOpen: () => void;
}): (event: KeyboardEvent) => void {
  return (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (!mod || !event.shiftKey || event.altKey) return;
    if (event.key.toLowerCase() !== "f") return;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest("input, textarea, select, [contenteditable]")
    ) {
      return;
    }
    event.preventDefault();
    opts.onOpen();
  };
}

/**
 * Ctrl/Cmd+Alt+F — focus mode toggle (#12). The keymap row leaves
 * Alt+F free (the Shift+F find/replace chord owns the shifted variant; the
 * browser's plain Alt+F menu focus is a different binding). Same guard as
 * the other global chords: text fields and the outliner editor keep the
 * keystroke. Exported for the keymap tests.
 */
export function focusModeKeyHandler(opts: {
  onToggle: () => void;
}): (event: KeyboardEvent) => void {
  return (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (!mod || !event.altKey || event.shiftKey) return;
    if (event.key.toLowerCase() !== "f") return;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest("input, textarea, select, [contenteditable]")
    ) {
      return;
    }
    event.preventDefault();
    opts.onToggle();
  };
}

/**
 * Esc — exit focus mode (#12). Registered only while focus mode is on;
 * text fields and the outliner editor keep the keystroke (the guard matches
 * the other global chords). No preventDefault: outside a text field nothing
 * else owns Esc, and the dimmed chrome stays interactive.
 */
export function focusModeExitHandler(opts: {
  focusMode: () => boolean;
  onExit: () => void;
}): (event: KeyboardEvent) => void {
  return (event) => {
    if (event.key !== "Escape" || !opts.focusMode()) return;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest("input, textarea, select, [contenteditable]")
    ) {
      return;
    }
    opts.onExit();
  };
}

/**
 * Tap-outside drawer dismissal: at narrow
 * widths the sidebar is a floating drawer — a pointer press that lands
 * outside the drawer AND outside the topbar (the hamburger toggle lives
 * there) closes it. Desktop layout (drawer docked beside content) never
 * dismisses; environments without matchMedia (jsdom) never dismiss either.
 * Exported for the dismissal tests, mirroring keymapChordHandler.
 */
export function drawerDismissHandler(opts: {
  isSidebarOpen: () => boolean;
  closeSidebar: () => void;
}): (event: PointerEvent) => void {
  return (event) => {
    if (!opts.isSidebarOpen()) return;
    if (typeof window.matchMedia !== "function") return;
    if (!window.matchMedia("(width <= 768px)").matches) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest(".nt-sidebar") !== null) return;
    if (target.closest(".nt-topbar") !== null) return;
    opts.closeSidebar();
  };
}
