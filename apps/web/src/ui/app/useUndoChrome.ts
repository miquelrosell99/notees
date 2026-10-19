/**
 * useUndoChrome — the session undo journal's chrome state (availability +
 * labels) plus the shared undo/redo runners. The snapshot refreshes on a
 * macrotask coalescer off every client notification (the worker round-trip
 * is cheap; the journal lives worker-side, per tab). App owns the
 * client-subscribe effect that bumps pagesVersion and drives the refresh.
 */

import { useCallback, useRef, useState, type RefObject } from "react";

import { EMPTY_UNDO_STATE, type UndoUiState } from "@/core/undo-journal.js";
import type { AnyClient } from "./clients.js";

export interface UndoChrome {
  undoUi: UndoUiState;
  setUndoUi: (state: UndoUiState) => void;
  /** The sync snapshot the keymap chord reads synchronously (may lag the
   *  worker by a macrotask — an undo on an empty journal no-ops honestly). */
  undoUiRef: RefObject<UndoUiState>;
  scheduleUndoRefresh: () => void;
  /** The shared undo/redo runners (top bar, palette, key chords). */
  runUndo: () => void;
  runRedo: () => void;
}

export function useUndoChrome(clientRef: RefObject<AnyClient | null>): UndoChrome {
  /**
   * The session undo journal's chrome state (availability + labels).
   * Refreshed on a macrotask coalescer off every client notification (the
   * worker round-trip is cheap; the journal lives worker-side, per tab).
   */
  const [undoUi, setUndoUi] = useState<UndoUiState>(EMPTY_UNDO_STATE);
  /** The sync snapshot the keymap chord reads synchronously (may lag the
   *  worker by a macrotask — an undo on an empty journal no-ops honestly). */
  const undoUiRef = useRef<UndoUiState>(EMPTY_UNDO_STATE);
  const undoRefreshTimer = useRef<number | null>(null);
  const scheduleUndoRefresh = useCallback(() => {
    if (undoRefreshTimer.current !== null) return;
    undoRefreshTimer.current = window.setTimeout(() => {
      undoRefreshTimer.current = null;
      const live = clientRef.current;
      void Promise.resolve(live === null ? EMPTY_UNDO_STATE : live.undoState()).then(
        (resolved) => {
          undoUiRef.current = resolved;
          setUndoUi(resolved);
        },
      );
    }, 0);
  }, [clientRef]);
  /** The shared undo/redo runners (top bar, palette, key chords). */
  const runUndo = useCallback(() => {
    const live = clientRef.current;
    if (live === null) return;
    void live.undo().catch((error: unknown) => {
      console.error("undo failed:", error);
    });
    scheduleUndoRefresh();
  }, [clientRef, scheduleUndoRefresh]);
  const runRedo = useCallback(() => {
    const live = clientRef.current;
    if (live === null) return;
    void live.redo().catch((error: unknown) => {
      console.error("redo failed:", error);
    });
    scheduleUndoRefresh();
  }, [clientRef, scheduleUndoRefresh]);
  return { undoUi, setUndoUi, undoUiRef, scheduleUndoRefresh, runUndo, runRedo };
}
