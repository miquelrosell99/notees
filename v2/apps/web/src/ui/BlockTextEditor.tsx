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
 * — never flattens it). Saves also refresh every typed_link mark's
 * candidateSpans (capture.ts: nearest mention targets, record-don't-resolve).
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
 * Capture gestures (owner-refined 2026-09-26):
 * - `@`  mention/link: inline popup over nodes (pages/blocks/classes);
 *   Enter inserts `{type:"mention", targetNodeId, text, linkId}` at the
 *   caret; no match + Enter strips the trigger (plain-text fallback);
 *   Esc closes.
 * - `#`  tag: popup over classes as tag vocabulary; Enter assigns the picked
 *   (or auto-created, class.create) class to the node — OR-set class_ids add,
 *   immediate write; Shift+Enter inserts a render-only class_chip token
 *   instead (no assignment).
 * - `+`  class picker: same popup over EXISTING classes only (no auto-create);
 *   Enter assigns, Shift+Enter inserts the chip.
 * - Verb on selection: MarkToolbar → button / Cmd+K opens the VerbPopover
 *   (free-string verb + optional locator); commit wraps the covered prose in
 *   a typed_link mark via spliceTokens.
 * All capture commits build on the current draft through applyTextEdit (so
 * unflushed typing is preserved), splice tokens through spliceTokens, then
 * write the result directly with client.updateObject and re-sync the DOM.
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
 * - Cmd/Ctrl+K   → open the typed-link verb popover over the selection.
 * - `**` over a selection → toggle bold (markdown shortcut; the asterisks
 *                  are swallowed, they are not stored).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import type { ContentAst, Mark } from "@notees/protocol";
import { uuidv7 } from "uuidv7";

import { focusAtPoint, focusWithCaret, type CaretPlacement } from "@/editor/caret.js";
import { proseFromAst } from "@/editor/prose.js";
import { applyTextEdit, spliceTokens } from "@/editor/edit-apply.js";
import { applyMarkToRange, marksOnRange, removeMarkFromRange } from "@/editor/marks.js";
import { withCandidateSpans } from "@/editor/capture.js";
import type { ClientNode } from "@/core/workspace-client.js";

import { CapturePopup, type CaptureCandidate } from "./CapturePopup.js";
import { MarkToolbar } from "./MarkToolbar.js";
import { VerbPopover } from "./VerbPopover.js";
import { useOutliner } from "./outliner-context.js";

/** Debounce cadence for content saves (v1 used 150 ms; M1 uses ~400 ms). */
export const SAVE_DEBOUNCE_MS = 400;

/** How the caret should land when the editor mounts. */
export type EditorCaret = CaretPlacement | { x: number; y: number };

/** Which capture trigger opened the popup. */
type CaptureKind = "mention" | "tag" | "class";

const TRIGGER_CHAR: Record<CaptureKind, string> = { mention: "@", tag: "#", class: "+" };

interface CaptureState {
  kind: CaptureKind;
  /** Prose offset of the trigger character. */
  start: number;
  /** Draft text between the trigger and the caret. */
  query: string;
  /** Selected candidate row. */
  index: number;
}

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

/** Collapsed-caret prose offset within the editor (null when the selection is a range/foreign). */
function caretOffset(el: HTMLElement): number | null {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!range.collapsed) return null;
  if (!el.contains(range.startContainer)) return null;
  return domOffsetToProse(el, range.startContainer, range.startOffset);
}

/** Collapse the caret to a prose offset (focusWithCaret clamps to child-node counts; this must not). */
function placeCaret(el: HTMLElement, offset: number): void {
  el.focus();
  try {
    const selection = window.getSelection();
    if (selection === null) return;
    const range = document.createRange();
    const node = el.firstChild;
    if (node !== null && typeof node.textContent === "string") {
      range.setStart(node, Math.max(0, Math.min(offset, node.textContent.length)));
    } else {
      range.selectNodeContents(el);
    }
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  } catch {
    // jsdom / edge layouts: focus() alone is enough.
  }
}

/** Viewport anchor for the toolbar/popups (jsdom rects are zero — harmless). */
function selectionAnchor(): { top: number; left: number } {
  try {
    const selection = window.getSelection();
    if (selection !== null && selection.rangeCount > 0) {
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      return { top: rect.top, left: rect.left + rect.width / 2 };
    }
  } catch {
    // jsdom / edge layouts: the popup lands at the viewport origin.
  }
  return { top: 0, left: 0 };
}

export function BlockTextEditor({ node, caret, onExitEdit }: BlockTextEditorProps) {
  const { client, positions, requestFocus, capture: captureApi } = useOutliner();
  const rootRef = useRef<HTMLSpanElement>(null);
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
  const [capture, setCapture] = useState<CaptureState | null>(null);
  const [verb, setVerb] = useState<{ start: number; end: number; top: number; left: number } | null>(
    null,
  );

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
    // Structural apply (untouched runs keep marks/identity) + fresh
    // candidateSpans on every typed_link mark (record-don't-resolve).
    const next = withCandidateSpans(applyTextEdit(current, draft));
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

  // --- capture gestures -------------------------------------------------------

  /** Filtered popup rows for the active capture (recomputed per keystroke). */
  const captureItems = useMemo<CaptureCandidate[]>(() => {
    if (capture === null) return [];
    const query = capture.query.trim();
    const q = query.toLowerCase();
    if (capture.kind === "mention") {
      const nodes: ClientNode[] =
        query === ""
          ? [...captureApi.searchNodes(""), ...captureApi.listClasses()]
          : captureApi.searchNodes(query);
      const seen = new Set<string>();
      const items: CaptureCandidate[] = [];
      for (const node of nodes) {
        if (seen.has(node.id)) continue;
        seen.add(node.id);
        items.push({ id: node.id, label: captureApi.displayName(node.id) ?? node.id });
        if (items.length >= 8) break;
      }
      return items;
    }
    const items: CaptureCandidate[] = [];
    for (const cls of captureApi.listClasses()) {
      const label = captureApi.displayName(cls.id) ?? cls.id;
      if (q !== "" && !label.toLowerCase().includes(q)) continue;
      items.push({ id: cls.id, label });
      if (items.length >= 8) break;
    }
    return items;
  }, [capture, captureApi]);

  /**
   * Reconcile the capture popup with the draft + caret: close when the
   * trigger was backspaced over or the caret left the query; open when a
   * trigger char was just typed at a word boundary.
   */
  const updateCapture = (draft: string, caret: number | null) => {
    setCapture((current) => {
      if (current !== null) {
        const trigger = TRIGGER_CHAR[current.kind];
        const stillOpen =
          caret !== null &&
          caret >= current.start + 1 &&
          draft[current.start] === trigger &&
          caret >= current.start;
        if (!stillOpen) return null;
        return { ...current, query: draft.slice(current.start + 1, caret) };
      }
      if (caret === null || caret === 0) return null;
      const ch = draft[caret - 1]!;
      const boundary = caret === 1 || /\s/.test(draft[caret - 2]!);
      if (!boundary) return null;
      if (ch === "@") return { kind: "mention", start: caret - 1, query: "", index: 0 };
      if (ch === "#") return { kind: "tag", start: caret - 1, query: "", index: 0 };
      if (ch === "+") return { kind: "class", start: caret - 1, query: "", index: 0 };
      return null;
    });
  };

  /**
   * Write an AST computed by a capture gesture: re-sync the DOM to the new
   * prose, drop the pending debounce (this write supersedes it), land the
   * caret, and push the token array. Direct write — the flush's
   * draft-equals-prose guard would skip a prose-identical draft.
   */
  const commitAst = (next: ContentAst, caretAfter: number) => {
    const el = spanRef.current;
    if (el === null) return;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const prose = proseFromAst(next);
    el.textContent = prose;
    draftRef.current = prose;
    dirtyRef.current = false;
    placeCaret(el, caretAfter);
    void client.updateObject(nodeRef.current.id, { contentAst: next });
  };

  /**
   * Capture-splice: bring the AST up to date with the unflushed draft
   * (applyTextEdit), then replace the trigger span [start, end) with the
   * given tokens (spliceTokens). Offsets are draft-prose offsets.
   */
  const applySplice = (
    start: number,
    end: number,
    tokens: readonly unknown[],
    caretAfter: number,
  ) => {
    const base = applyTextEdit(nodeRef.current.contentAst, draftRef.current);
    commitAst(withCandidateSpans(spliceTokens(base, start, end, tokens)), caretAfter);
  };

  /**
   * Plain-text fallback: strip only the trigger sigil — the typed query
   * falls back to plain prose, the caret lands where the sigil was.
   */
  const plainFallback = (start: number) => {
    applySplice(start, start + 1, [], start);
  };

  /** Assign gesture: consume the whole trigger + query (a command, not prose). */
  const stripTrigger = (start: number, end: number) => {
    applySplice(start, end, [], start);
  };

  const chipToken = (classId: string) => ({ type: "class_chip", classId });

  /**
   * Enter/Shift+Enter (or click) on a capture row. `candidate` is undefined
   * when the query has no rows — the per-kind fallback (mention/+: plain
   * fallback keeping the query; #: auto-create + assign, or + chip on
   * Shift+Enter).
   */
  const commitCapture = (candidate: CaptureCandidate | undefined, shiftKey: boolean) => {
    const state = capture;
    const el = spanRef.current;
    if (state === null || el === null) return;
    const caret = caretOffset(el);
    if (caret === null) {
      setCapture(null);
      return;
    }
    const { start, query } = state;
    const trimmed = query.trim();
    setCapture(null);
    if (state.kind === "mention") {
      if (candidate === undefined) {
        plainFallback(start);
        return;
      }
      const token = {
        type: "mention",
        targetNodeId: candidate.id,
        text: candidate.label,
        linkId: uuidv7(),
      };
      applySplice(start, caret, [token], start + candidate.label.length);
      return;
    }
    if (state.kind === "tag") {
      const assign = (classId: string) => {
        void client.assignClass(nodeRef.current.id, classId).catch((error: unknown) => {
          console.warn(`[capture] assignClass (${classId}) failed:`, error);
        });
      };
      if (candidate !== undefined) {
        if (shiftKey) {
          applySplice(start, caret, [chipToken(candidate.id)], start);
        } else {
          assign(candidate.id);
          stripTrigger(start, caret);
        }
        return;
      }
      if (trimmed === "") return; // bare "#" — nothing to create, keep the text
      // Auto-create the tag class, then assign (Enter) or chip (Shift+Enter).
      void client
        .createObject({ nodeType: "class", name: trimmed })
        .then((classId) => {
          if (!shiftKey) assign(classId);
          applySplice(start, caret, shiftKey ? [chipToken(classId)] : [], start);
        })
        .catch((error: unknown) => {
          console.warn(`[capture] class.create "${trimmed}" failed:`, error);
        });
      return;
    }
    // "+" picker: existing classes only, no auto-create.
    if (candidate === undefined) {
      plainFallback(start);
      return;
    }
    if (shiftKey) {
      applySplice(start, caret, [chipToken(candidate.id)], start);
    } else {
      void client.assignClass(nodeRef.current.id, candidate.id).catch((error: unknown) => {
        console.warn(`[capture] assignClass (${candidate.id}) failed:`, error);
      });
      stripTrigger(start, caret);
    }
  };

  // --- typed-link verb gesture --------------------------------------------------

  const openVerb = () => {
    const el = spanRef.current;
    if (el === null) return;
    const range = selectionOffsets(el);
    if (range === null || range.start === range.end) return;
    setCapture(null);
    setVerb({ ...range, ...selectionAnchor() });
  };

  const commitVerb = (verbStr: string, locator: string) => {
    const state = verb;
    if (state === null) return;
    setVerb(null);
    const base = applyTextEdit(nodeRef.current.contentAst, draftRef.current);
    const covered = proseFromAst(base).slice(state.start, state.end);
    if (covered === "") return;
    const metadata: Record<string, unknown> = {};
    if (locator !== "") metadata.locator = locator;
    const token = { type: "typed_link", verb: verbStr, text: covered, metadata };
    const next = withCandidateSpans(spliceTokens(base, state.start, state.end, [token]));
    const el = spanRef.current;
    commitAst(next, state.start + covered.length);
    el?.focus();
  };

  const cancelVerb = () => {
    const state = verb;
    setVerb(null);
    const el = spanRef.current;
    if (el !== null && state !== null) {
      el.focus();
      placeCaret(el, state.end);
    }
  };

  // --- DOM events ---------------------------------------------------------------

  const handleInput = () => {
    const el = spanRef.current;
    if (el === null) return;
    draftRef.current = el.textContent ?? "";
    dirtyRef.current = true;
    updateCapture(draftRef.current, caretOffset(el));
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      flush();
    }, SAVE_DEBOUNCE_MS);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    // Capture popup keys (the editor keeps the caret; the popup is visual).
    if (capture !== null) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setCapture({
          ...capture,
          index: Math.max(0, Math.min(capture.index + delta, Math.max(captureItems.length - 1, 0))),
        });
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        commitCapture(captureItems[Math.min(capture.index, captureItems.length - 1)], event.shiftKey);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setCapture(null);
        return;
      }
    }
    const mod = event.metaKey || event.ctrlKey;
    if (mod && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === "b" || key === "i" || (key === "x" && event.shiftKey)) {
        event.preventDefault();
        toggleMark(key === "b" ? "bold" : key === "i" ? "italic" : "strike");
        return;
      }
      if (key === "k") {
        event.preventDefault();
        openVerb();
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
    <span ref={rootRef} className="nt-editor-root">
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
        onBlur={(event) => {
          flush();
          // Focus moved into the verb popover (its inputs) — stay in edit
          // mode; anything else ends the session (and closes the popups).
          const nextTarget = event.relatedTarget as Node | null;
          if (
            nextTarget !== null &&
            rootRef.current !== null &&
            rootRef.current.contains(nextTarget)
          ) {
            return;
          }
          setCapture(null);
          setVerb(null);
          onExitEdit();
        }}
      />
      {toolbar !== null && (
        <MarkToolbar
          top={toolbar.top}
          left={toolbar.left}
          activeMarks={activeMarks}
          onToggle={toggleMark}
          onVerb={openVerb}
        />
      )}
      {capture !== null && (
        <CapturePopup
          top={selectionAnchor().top}
          left={selectionAnchor().left}
          items={captureItems}
          selectedIndex={Math.min(capture.index, Math.max(captureItems.length - 1, 0))}
          emptyHint="No matches"
          onPick={(id) =>
            commitCapture(
              captureItems.find((item) => item.id === id),
              false,
            )
          }
        />
      )}
      {verb !== null && (
        <VerbPopover
          top={verb.top}
          left={verb.left}
          onSubmit={commitVerb}
          onCancel={cancelVerb}
        />
      )}
    </span>
  );
}
