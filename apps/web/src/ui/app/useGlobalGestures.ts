/**
 * useGlobalGestures — the App's document-level gesture wiring: the global
 * key chords (quick add, present, today, search, history back/forward, the
 * keymap-breadth chords, undo/redo, history popup, focus mode + Esc exit,
 * Ctrl/Cmd+Alt+P add-property) and the narrow-width tap-outside drawer
 * dismissal. The handler factories live in keymap.ts (unit-tested); this
 * hook just wires them to the App's state and unwires on cleanup. Effect
 * deps are the originals.
 */

import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";

import type { UndoUiState } from "@/core/undo-journal.js";
import { toggleFocusMode } from "../../features/settings/deviceSettings.js";
import { requestPropertyCreate } from "../../features/metadata/PropertyCreateHost.js";
import { rendersWithDocumentChrome } from "@notees/domain";
import {
  addPropertyKeyHandler,
  drawerDismissHandler,
  focusModeExitHandler,
  focusModeKeyHandler,
  historyKeyHandler,
  historyNavKeyHandler,
  keymapChordHandler,
  openTodayKeyHandler,
  searchKeyHandler,
  undoRedoKeyHandler,
} from "./keymap.js";
import type { AnyClient } from "./clients.js";
import { parentlessBlockResolverOf } from "../renderStateLabel.js";
import type { SettingsSection } from "../../features/settings/SettingsPage.js";

export interface GlobalGestureDeps {
  sidebarOpen: boolean;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  clientRef: RefObject<AnyClient | null>;
  openPage: (nodeId: string) => void;
  openSettingsSection: (section: SettingsSection) => void;
  openSearchPage: () => void;
  setQuickAddOpen: Dispatch<SetStateAction<boolean>>;
  setPresentingId: Dispatch<SetStateAction<string | null>>;
  selectedPageIdRef: RefObject<string | null>;
  undoUiRef: RefObject<UndoUiState>;
  scheduleUndoRefresh: () => void;
  setHistoryOpen: Dispatch<SetStateAction<boolean>>;
  focusMode: boolean;
  setFocusMode: (value: boolean) => void;
}

export function useGlobalGestures(deps: GlobalGestureDeps): void {
  const {
    sidebarOpen,
    setSidebarOpen,
    clientRef,
    openPage,
    openSettingsSection,
    openSearchPage,
    setQuickAddOpen,
    setPresentingId,
    selectedPageIdRef,
    undoUiRef,
    scheduleUndoRefresh,
    setHistoryOpen,
    focusMode,
    setFocusMode,
  } = deps;

  /**
   * Tap-outside drawer dismissal — the
   * predicate lives in the exported drawerDismissHandler (unit-tested); the
   * effect just wires it to the sidebar state.
   */
  useEffect(() => {
    if (!sidebarOpen) return;
    const onPress = drawerDismissHandler({
      isSidebarOpen: () => sidebarOpen,
      closeSidebar: () => setSidebarOpen(false),
    });
    document.addEventListener("pointerdown", onPress);
    return () => document.removeEventListener("pointerdown", onPress);
  }, [sidebarOpen]);

  // Ctrl/Cmd+Shift+N — the global quick-capture shortcut (Quick Add).
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "n" || !event.shiftKey || !(event.ctrlKey || event.metaKey)) {
        return;
      }
      const target = event.target as HTMLElement | null;
      // Don't steal the gesture from text fields (the browser needs
      // Ctrl+Shift+N nowhere else, but a focused editor should keep typing).
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      event.preventDefault();
      setQuickAddOpen(true);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Ctrl/Cmd+Alt+Enter — present the open page. Capacities'
  // Ctrl+Alt+P collides with the reserved "add property" chord (and the
  // browser's private-window binding); Ctrl+Alt+Enter is free in both the
  // keymap row and the tree.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || !event.altKey || !(event.ctrlKey || event.metaKey)) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      const openId = selectedPageIdRef.current;
      if (openId === null) return;
      const live = clientRef.current;
      const node = live?.getNode(openId);
      if (
        live === null ||
        live === undefined ||
        node === undefined ||
        !rendersWithDocumentChrome(node, live.getNode(node.parentId ?? ""), parentlessBlockResolverOf(live))
      )
        return;
      event.preventDefault();
      setPresentingId(openId);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Ctrl/Cmd+Shift+T — open today's daily page.
  useEffect(() => {
    const handler = openTodayKeyHandler({
      client: () => clientRef.current,
      openPage,
    });
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Ctrl/Cmd+Shift+F — the full-page search surface (/search).
  useEffect(() => {
    const handler = searchKeyHandler({ onOpen: () => openSearchPage() });
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Alt+← / Alt+→ — in-app Back/Forward through the history stack.
  useEffect(() => {
    const handler = historyNavKeyHandler();
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Ctrl/Cmd+N / Ctrl/Cmd+, / Ctrl/Cmd+\ — the keymap-breadth chords.
  useEffect(() => {
    const handler = keymapChordHandler({
      client: () => clientRef.current,
      openPage,
      // The quick-tweaks modal is gone (owner 2026-10-14): the chord opens
      // the full settings page at Appearance, like the sidebar gear.
      openSettings: () => openSettingsSection("appearance"),
      toggleSidebar: () => setSidebarOpen((open) => !open),
    });
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Ctrl/Cmd+Z undo / Ctrl/Cmd+Shift+Z (or Ctrl/Cmd+Y) redo — the session
  // journal chords. The chord handler reads the coalesced undo
  // snapshot synchronously; the write itself runs through the normal path
  // and the worker's "changed" notification re-syncs the snapshot.
  useEffect(() => {
    const handler = undoRedoKeyHandler({
      undoState: () => undoUiRef.current,
      onUndo: () => {
        const live = clientRef.current;
        if (live === null) return;
        void live.undo().catch((error: unknown) => {
          console.error("undo failed:", error);
        });
        scheduleUndoRefresh();
      },
      onRedo: () => {
        const live = clientRef.current;
        if (live === null) return;
        void live.redo().catch((error: unknown) => {
          console.error("redo failed:", error);
        });
        scheduleUndoRefresh();
      },
    });
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [scheduleUndoRefresh]);

  // Ctrl/Cmd+Shift+H — the history popup chord. Toggles the popup;
  // the popup itself closes on its own dismissal layer.
  useEffect(() => {
    const handler = historyKeyHandler({
      onToggle: () => setHistoryOpen((open) => !open),
    });
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Ctrl/Cmd+Alt+F — the focus-mode toggle chord (#12). The shared toggle
  // persists, applies the data attribute, and broadcasts the change.
  useEffect(() => {
    const handler = focusModeKeyHandler({
      onToggle: () => setFocusMode(toggleFocusMode()),
    });
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [setFocusMode]);

  // Esc — exit focus mode (#12); registered only while the mode is on.
  useEffect(() => {
    const handler = focusModeExitHandler({
      focusMode: () => focusMode,
      onExit: () => setFocusMode(false),
    });
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [focusMode, setFocusMode]);

  // Ctrl/Cmd+Alt+P — the global "Add property" chord (owner ruling
  // 2026-10-20): the S1 creation modal opens without context via the
  // app-level host's module-level request.
  useEffect(() => {
    const handler = addPropertyKeyHandler({
      onOpen: () => requestPropertyCreate({}),
    });
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);
}
