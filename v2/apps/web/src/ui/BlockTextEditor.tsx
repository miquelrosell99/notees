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
 */

import { useCallback, useEffect, useRef, type KeyboardEvent } from "react";

import { focusAtPoint, focusWithCaret, type CaretPlacement } from "@/editor/caret.js";
import { astFromProse, proseFromAst } from "@/editor/prose.js";
import type { ClientNode } from "@/core/workspace-client.js";

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

export function BlockTextEditor({ node, caret, onExitEdit }: BlockTextEditorProps) {
  const { client, positions, requestFocus } = useOutliner();
  const spanRef = useRef<HTMLSpanElement>(null);
  const nodeRef = useRef(node);
  nodeRef.current = node;
  const draftRef = useRef(proseFromAst(node.contentAst));
  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    const next = astFromProse(draft, current);
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    void client.updateObject(nodeRef.current.id, { contentAst: next });
  }, [client]);

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
  );
}
