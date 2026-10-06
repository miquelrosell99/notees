/**
 * useBlockSelectionSurface — the block multi-selection gestures for
 * the editable page body (the outline tree).
 *
 * - Plain mousedown on a row + a small vertical drag → drag selection: the
 *   anchor row is selected first, then every row the pointer arches over
 *   extends the range (document order, inclusive). The trailing click after
 *   a drag is swallowed (one-shot flag) so it never enters edit mode.
 * - Shift+click / Ctrl+click are handled by BlockRow's click handler; this
 *   hook only preventDefaults their mousedown so the browser doesn't start
 *   a text selection or place a caret.
 * - Escape clears the selection; a mousedown outside the tree (and outside
 *   the action bar / picker popups) clears it too.
 *
 * Session-local display state only — never an op. The hook receives the
 * context value (it runs in PageView, above the provider) and keeps a ref
 * so the document listeners stay stable.
 */

import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type RefObject } from "react";

import type { OutlinerContextValue } from "./outliner-context.js";

/** Pixels of vertical travel before a press becomes a drag selection. */
const DRAG_THRESHOLD = 4;

interface DragState {
  startId: string;
  startX: number;
  startY: number;
  dragging: boolean;
  lastExtendId: string | null;
}

export function useBlockSelectionSurface(
  outliner: OutlinerContextValue,
  rootRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): { onMouseDownCapture: (event: ReactMouseEvent<HTMLDivElement>) => void } {
  const outlinerRef = useRef(outliner);
  outlinerRef.current = outliner;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const dragRef = useRef<DragState | null>(null);

  useEffect(() => {
    const handleMouseMove = (event: globalThis.MouseEvent) => {
      const drag = dragRef.current;
      if (drag === null) return;
      const live = outlinerRef.current;
      if (!drag.dragging) {
        if (Math.abs(event.clientY - drag.startY) < DRAG_THRESHOLD) return;
        drag.dragging = true;
        live.replaceSelection(new Set([drag.startId]), drag.startId);
      }
      const target = event.target;
      if (!(target instanceof Element)) return;
      const row = target.closest("[data-block-id]");
      const id = row?.getAttribute("data-block-id") ?? null;
      if (id === null || id === drag.lastExtendId) return;
      drag.lastExtendId = id;
      live.replaceSelection(new Set(live.rangeBetween(drag.startId, id)), drag.startId);
    };
    const handleMouseUp = () => {
      const drag = dragRef.current;
      dragRef.current = null;
      // Swallow the click that follows a drag so it doesn't enter edit mode.
      if (drag?.dragging === true) outlinerRef.current.signalDragClick();
    };
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  // Outside click clears the selection (the action bar and the picker popup
  // are portaled outside the tree — both are exempt).
  useEffect(() => {
    const handleMouseDown = (event: globalThis.MouseEvent) => {
      const live = outlinerRef.current;
      if (!enabledRef.current || live.selection.size === 0) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".nt-selection-bar")) return;
      if (target.closest("[data-editor-companion]")) return;
      const root = rootRef.current;
      if (root !== null && root.contains(target)) return;
      live.clearSelection();
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [rootRef]);

  // Escape clears the selection (form fields and popups keep the keystroke).
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const live = outlinerRef.current;
      if (!enabledRef.current || live.selection.size === 0) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("input, textarea, select, [contenteditable], [data-editor-companion]")
      ) {
        return;
      }
      live.clearSelection();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const onMouseDownCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!enabledRef.current) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    // The grip drags the block (dnd), buttons/pills/links have their own
    // press semantics, and an active editor keeps normal text selection.
    if (target.closest(".nt-block-grip, button, a, input, [contenteditable]")) return;
    const row = target.closest("[data-block-id]");
    const id = row?.getAttribute("data-block-id") ?? null;
    if (id === null) return;
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
      // Modifier clicks select on the click event; preventDefault only stops
      // the browser's native shift-selection / caret placement.
      if (event.shiftKey) event.preventDefault();
      return;
    }
    // A plain press: block the caret/text-selection now; if it grows into a
    // drag the move handler takes over, otherwise the click edits as usual.
    event.preventDefault();
    dragRef.current = {
      startId: id,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      lastExtendId: null,
    };
  };

  return { onMouseDownCapture };
}
