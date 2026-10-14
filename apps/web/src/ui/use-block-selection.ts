/**
 * useBlockSelectionSurface — the block multi-selection gestures for
 * the editable page body (the outline tree).
 *
 * - Plain mousedown on a row + the pointer leaving that row's borders →
 *   drag selection: the anchor row is selected first, then every row the
 *   pointer arches over extends the range (document order, inclusive).
 *   While the pointer stays inside the pressed block nothing is selected —
 *   read-mode content is user-select:none (app.css), so the gesture never
 *   produces a text selection, and the block range arms only on the border
 *   exit. A press inside the EDITING block keeps native text selection
 *   until the pointer exits the contentEditable's borders, then the in-
 *   block text selection is dropped and the same block-range drag takes
 *   over (selection between blocks is impossible — text selection exists
 *   only inside the block being edited). The trailing click after a drag
 *   is swallowed (one-shot flag) so it never enters edit mode.
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

interface DragState {
  startId: string;
  /** The row element the press landed on — the border-exit bounds. */
  startRow: HTMLElement;
  /** The contentEditable the press started inside (edit mode), else null. */
  startEditable: HTMLElement | null;
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
        // Arm only when the pointer exits the pressed block's borders:
        // inside them an edit-mode press is a plain text selection and a
        // read-mode press selects nothing (user-select:none) — nothing may
        // happen until the gesture crosses the border.
        const bounds = (drag.startEditable ?? drag.startRow).getBoundingClientRect();
        const inside =
          event.clientX >= bounds.left &&
          event.clientX <= bounds.right &&
          event.clientY >= bounds.top &&
          event.clientY <= bounds.bottom;
        if (inside) return;
        drag.dragging = true;
        if (drag.startEditable !== null) {
          // The drag began as a text selection inside the editor: drop the
          // native selection and keep it dropped — the default action of
          // the moves that follow would re-extend it across blocks.
          window.getSelection()?.removeAllRanges();
          event.preventDefault();
        }
        live.replaceSelection(new Set([drag.startId]), drag.startId);
      } else if (drag.startEditable !== null) {
        // Block-select phase of an edit-mode drag: suppress the native
        // text-selection default for the rest of the gesture.
        event.preventDefault();
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
      // Swallow only the RELEASE row's trailing click (the click that ends
      // the drag must not enter edit mode); a later click on any other row
      // is deliberate and edits normally.
      if (drag?.dragging === true) outlinerRef.current.signalDragClick(drag.lastExtendId ?? drag.startId);
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
    // press semantics — untouched by the selection surface.
    if (target.closest(".nt-block-grip, button, a, input")) return;
    const editable = target.closest("[contenteditable]");
    if (editable !== null) {
      // Edit mode: the press places the caret / starts a text selection
      // inside the block (never preventDefaulted). Record the press so the
      // move handler can convert the gesture into a block-range drag the
      // moment the pointer exits the contentEditable's borders.
      const row = target.closest("[data-block-id]");
      const id = row?.getAttribute("data-block-id") ?? null;
      if (id === null) return;
      dragRef.current = {
        startId: id,
        startRow: row as HTMLElement,
        startEditable: editable as HTMLElement,
        dragging: false,
        lastExtendId: null,
      };
      return;
    }
    // The press lives on a read-mode row. The preventDefault below (and the
    // shift+click guard's) keeps read-mode content unselectable — and also
    // suppresses the browser's default focus shift, so a block still editing
    // elsewhere would keep its caret while the selection surface takes over
    // (owner 2026-10-14: selecting blocks must exit edit mode). Blur the
    // active editor explicitly; its blur flushes and hands back to read
    // mode. Modifier clicks (selection gestures), plain clicks that enter
    // edit on another row, and drag-select arming all ride this path.
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest("[contenteditable]") !== null) {
      active.blur();
    }
    const row = target.closest("[data-block-id]");
    const id = row?.getAttribute("data-block-id") ?? null;
    if (id === null) return;
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
      // Modifier clicks select on the click event; preventDefault only stops
      // the browser's native shift-selection / caret placement.
      if (event.shiftKey) event.preventDefault();
      return;
    }
    // A plain read-mode press: block the caret/text-selection now; if the
    // pointer later exits the row's borders the move handler turns the
    // gesture into a block-range drag, otherwise the click edits as usual.
    event.preventDefault();
    dragRef.current = {
      startId: id,
      startRow: row as HTMLElement,
      startEditable: null,
      dragging: false,
      lastExtendId: null,
    };
  };

  return { onMouseDownCapture };
}
