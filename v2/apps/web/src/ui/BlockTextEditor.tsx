/**
 * BlockTextEditor — the editable mode of a block row: a contentEditable span
 * holding the block's prose (plain-text projection of its token stream; marks
 * render read-only via InlineTokens, SCHEMA.md grammar).
 *
 * Draft vs saved state: typing only mutates the DOM + a local draft ref —
 * never React state — so the caret is never clobbered by re-renders (the
 * naive client notification refreshes the tree on every apply). Saves are
 * debounced (~400 ms) and flushed on blur and unmount; a flush is skipped
 * when the draft equals the current prose (so touching a block whose
 * contentAst carries non-prose tokens — mentions, chips, marks on split runs
 * — never flattens it).
 *
 * Marks editing (edit-apply.ts / marks.ts): saves apply the draft
 * structurally, so untouched runs keep their marks and identity. Mark
 * commands (Ctrl/Cmd+B/I/Shift+X, the floating MarkToolbar, or typing `**`
 * over a selection) read the DOM selection, map it to prose offsets, split
 * the covered runs, and write the new token array directly — the prose does
 * not change, so the debounced flush is not involved and cannot clobber the
 * marks. Edit mode stays plain-text visual by design (per-run DOM rendering
 * would break caret stability); marks render in read mode as today.
 *
 * Keyboard contract (docs/ux.md "The outliner"):
 * - Enter        → prevent default, save, create an empty sibling AFTER this
 *                  block (create-then-move: the create appends at the END of
 *                  the parent's order, object.move with afterId=this lands it
 *                  right after this block), move the caret there.
 * - Shift+Enter  → allow the contentEditable newline; the flush stores it as
 *                  `hard_break` tokens (the only break token in the grammar).
 * - Backspace at an empty block → delete the block (soft delete) and hand the
 *                  caret to the previous sibling (or the parent).
 * - Tab          → indent under the previous sibling (object.move, appended as
 *                  its last child).
 * - Shift+Tab    → outdent to the grandparent, placed right after the current
 *                  parent (object.move with afterId=parent).
 * - Ctrl/Cmd+B/I/Shift+X → toggle bold/italic/strike on the selection.
 * - `**` over a selection → toggle bold (markdown shortcut; the asterisks
 *                  are swallowed, they are not stored).
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";

import type { Mark } from "@notees/protocol";

import { focusAtPoint, focusWithCaret, type CaretPlacement } from "@/editor/caret.js";
import { proseFromAst } from "@/editor/prose.js";
import { applyTextEdit } from "@/editor/edit-apply.js";
import { applyMarkToRange, marksOnRange, removeMarkFromRange } from "@/editor/marks.js";
import type { ClientNode } from "@/core/workspace-client.js";

import { MarkToolbar } from "./MarkToolbar.js";
import { useOutliner } from "./outliner-context.js";

/** Debounce cadence for content saves (v1 used 150 ms; M1 uses ~400 ms). */
export const SAVE_DEBOUNCE_MS = 400;

/** How the caret should land when the editor mounts. */
export type EditorCaret = CaretPlacement | { x: number; y: number };

interface BlockTextEditorProps {
  node: ClientNode;
  caret: EditorCaret;
  onExitEdit: () => void;
}

/**
 * Prose offset of a DOM position inside the editor. The editor DOM is a
 * flat run of text nodes (no React children, no per-run elements), so the
 * offset is the summed text lengths of the preceding siblings plus the
 * in-node offset. Null when the position is not inside the editor.
 */
function domOffsetToProse(el: HTMLElement, node: Node, offset: number): number | null {
  if (node === el) return offset;
  if (node.parentNode !== el) return null;
  let total = 0;
  for (let n = el.firstChild; n !== null && n !== node; n = n.nextSibling) {
    total += n.textContent?.length ?? 0;
  }
  return total + offset;
}

/** Current selection as prose offsets within the editor; null when collapsed/foreign. */
function selectionOffsets(el: HTMLElement): { start: number; end: number } | null {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return null;
  const start = domOffsetToProse(el, range.startContainer, range.startOffset);
  const end = domOffsetToProse(el, range.endContainer, range.endOffset);
  if (start === null || end === null) return null;
  return start <= end ? { start, end } : { start: end, end: start };
}

/** Viewport anchor for the toolbar (jsdom rects are zero — harmless). */
function selectionAnchor(): { top: number; left: number } {
  try {
    const selection = window.getSelection();
    if (selection !== null && selection.rangeCount > 0) {
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      return { top: rect.top, left: rect.left + rect.width / 2 };
    }
  } catch {
    // jsdom / edge layouts: the toolbar lands at the viewport origin.
  }
  return { top: 0, left: 0 };
}

export function BlockTextEditor({ node, caret, onExitEdit }: BlockTextEditorProps) {
  const { client, positions, requestFocus } = useOutliner();
  const spanRef = useRef<HTMLSpanElement>(null);
  const nodeRef = useRef(node);
  nodeRef.current = node;
  const draftRef = useRef(proseFromAst(node.contentAst));
  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Range captured by the first "*" of the `**`-over-selection shortcut. */
  const starRef = useRef<{ start: number; end: number } | null>(null);
  const [toolbar, setToolbar] = useState<{ top: number; left: number } | null>(null);
  const [activeMarks, setActiveMarks] = useState<readonly Mark[]>([]);

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    const el = spanRef.current;
    const draft = el?.textContent ?? draftRef.current;
    draftRef.current = draft;
    const current = nodeRef.current.contentAst;
    // Prose unchanged: leave rich tokens (mentions/chips/marks) untouched.
    if (draft === proseFromAst(current)) return;
    // Structural apply: untouched runs keep their marks and identity.
    const next = applyTextEdit(current, draft);
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    void client.updateObject(nodeRef.current.id, { contentAst: next });
  }, [client]);

  // Selection → toolbar state. Listened on document (selectionchange does
  // not bubble) for the whole edit session.
  const syncSelectionUi = useCallback(() => {
    const el = spanRef.current;
    const range = el === null ? null : selectionOffsets(el);
    if (range === null || range.start === range.end) {
      setToolbar(null);
      setActiveMarks([]);
      return;
    }
    setToolbar(selectionAnchor());
    setActiveMarks([...marksOnRange(nodeRef.current.contentAst, range.start, range.end)]);
  }, []);

  // Toggle a mark over the current selection: remove when every covered run
  // already carries it, apply otherwise. Writes go straight to the client —
  // the prose is unchanged, so the debounced flush stays out of it (and its
  // draft-equals-prose guard would skip anyway).
  const toggleMark = useCallback(
    (mark: Mark) => {
      const el = spanRef.current;
      if (el === null) return;
      const range = selectionOffsets(el);
      if (range === null || range.start === range.end) return;
      const current = nodeRef.current.contentAst;
      const next = marksOnRange(current, range.start, range.end).has(mark)
        ? removeMarkFromRange(current, range.start, range.end, mark)
        : applyMarkToRange(current, range.start, range.end, mark);
      if (JSON.stringify(next) !== JSON.stringify(current)) {
        void client.updateObject(nodeRef.current.id, { contentAst: next });
      }
      // Reflect the toggle immediately: nodeRef still holds the pre-write
      // AST until the client notification re-renders.
      setActiveMarks([...marksOnRange(next, range.start, range.end)]);
    },
    [client],
  );

  useEffect(() => {
    document.addEventListener("selectionchange", syncSelectionUi);
    return () => document.removeEventListener("selectionchange", syncSelectionUi);
  }, [syncSelectionUi]);

  // Mount: hydrate the DOM from the draft and land the caret. No children are
  // rendered (textContent is managed imperatively), so React raises no
  // contentEditable warnings and updates never reset the caret mid-typing.
  useEffect(() => {
    const el = spanRef.current;
    if (el === null) return;
    el.textContent = draftRef.current;
    if (typeof caret === "object") focusAtPoint(el, caret.x, caret.y);
    else focusWithCaret(el, caret);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Unmount flush (dirty draft never dies with the editor).
  useEffect(() => () => flush(), [flush]);

  // External edits (remote sync) rehydrate the DOM only while we are not
  // actively editing it.
  useEffect(() => {
    const el = spanRef.current;
    if (el === null || document.activeElement === el || dirtyRef.current) return;
    const prose = proseFromAst(node.contentAst);
    if (el.textContent !== prose) el.textContent = prose;
  }, [node.contentAst]);

  const handleInput = () => {
    const el = spanRef.current;
    if (el === null) return;
    draftRef.current = el.textContent ?? "";
    dirtyRef.current = true;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      flush();
    }, SAVE_DEBOUNCE_MS);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === "b" || key === "i" || (key === "x" && event.shiftKey)) {
        event.preventDefault();
        toggleMark(key === "b" ? "bold" : key === "i" ? "italic" : "strike");
        return;
      }
    }
    // Markdown shortcut: `**` typed over a selection toggles bold on it (the
    // asterisks are swallowed). The first "*" stashes the range; a second
    // "*" while the range is unchanged toggles.
    if (event.key === "*" && !mod && !event.altKey) {
      const el = spanRef.current;
      const range = el === null ? null : selectionOffsets(el);
      if (range !== null && range.start !== range.end) {
        event.preventDefault();
        const pending = starRef.current;
        if (pending !== null && pending.start === range.start && pending.end === range.end) {
          starRef.current = null;
          toggleMark("bold");
        } else {
          starRef.current = range;
        }
        return;
      }
    }
    if (event.key !== "Shift") starRef.current = null;
    if (event.key === "Enter") {
      if (event.shiftKey) return; // the newline is allowed; flush stores hard_break
      event.preventDefault();
      flush();
      const parentId = nodeRef.current.parentId;
      const currentId = nodeRef.current.id;
      // Placement is create-then-move: the create appends at the END of the
      // parent's order, so object.move with afterId=current lands the new
      // sibling right after this block.
      void client
        .createObject({ nodeType: "block", parentId, contentAst: [] })
        .then((id) =>
          parentId === null
            ? Promise.resolve(id)
            : client.moveObject(id, parentId, currentId).then(() => id),
        )
        .then((id) => requestFocus(id, "start"));
      return;
    }
    if (event.key === "Backspace") {
      const el = spanRef.current;
      if ((el?.textContent ?? "") !== "") return; // ordinary in-text deletion
      event.preventDefault();
      flush(); // clears the block when the draft was just emptied
      const id = nodeRef.current.id;
      const position = positions.get(id);
      const caretTarget = position?.previousSiblingId ?? position?.parentId;
      if (caretTarget !== undefined && caretTarget !== null) {
        requestFocus(caretTarget, "end");
      }
      void client.deleteObject(id);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const id = nodeRef.current.id;
      const position = positions.get(id);
      // Indent: under the previous sibling (append as its last child).
      // Outdent: to the grandparent, placed right after the current parent.
      const target = event.shiftKey ? position?.grandParentId : position?.previousSiblingId;
      if (target === undefined || target === null) return; // page-level edge
      const afterId = event.shiftKey ? (position?.parentId ?? undefined) : undefined;
      void client.moveObject(id, target, afterId).catch((error: unknown) => {
        console.warn(
          `[outliner] ${event.shiftKey ? "outdent" : "indent"} (${id} → ${target}) failed:`,
          error,
        );
      });
    }
  };

  return (
    <>
      <span
        ref={spanRef}
        className="nt-block-text"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Block content"
        // -1: script-focusable (and jsdom-focusable) without entering tab order.
        tabIndex={-1}
        spellCheck={false}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          flush();
          onExitEdit();
        }}
      />
      {toolbar !== null && (
        <MarkToolbar
          top={toolbar.top}
          left={toolbar.left}
          activeMarks={activeMarks}
          onToggle={toggleMark}
        />
      )}
    </>
  );
}
