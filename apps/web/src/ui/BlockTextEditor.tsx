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
 * commands (Ctrl/Cmd+B/I/Shift+X, the floating FloatingToolbar, or typing `**`
 * over a selection) read the DOM selection, map it to prose offsets, split
 * the covered runs, and write the new token array directly — the prose does
 * not change, so the debounced flush is not involved and cannot clobber the
 * marks. Edit mode stays plain-text visual by design (per-run DOM rendering
 * would break caret stability); marks render in read mode as today.
 *
 * Capture gestures (owner-refined 2026-09-26; node-picker popups 2026-10-01;
 * @-over-selection + link context menu 2026-10-01):
 * - `@`  mention/link: the node picker popup (ported NodeSelector) opens
 *   anchored at the caret with its own search field — Main/Blocks scope tabs
 *   (document-chrome nodes incl. classes vs inline child blocks, Main first)
 *   scoping the search; picking inserts `{type:"mention", targetNodeId, text, linkId}`
 *   at the trigger; the create row links a new page named by the query; the
 *   typed-date row links the journal chain page ("Link to … page" /
 *   "Create … page"). Esc/click-outside keeps the trigger char as plain text
 *   and hands focus back to the block.
 * - `@` over a selection: the browser default (delete the selection, insert
 *   the sigil) is intercepted at a word boundary; the picker opens with the
 *   selected text as its search query, and the pick splices the mention over
 *   the never-deleted range. Ctrl/Cmd+Enter on a row picks WITH the query as
 *   a custom label (`displayText`). Esc restores the original selection.
 * - Node-link context menu: right-clicking a mention (hit-tested via
 *   caretRangeFromPoint → prose offset → token span) opens the
 *   NodeLinkContextMenu: Open / Open in sidebar navigate; Edit link… opens
 *   the page-level LinkEditModal (retarget + optional custom label);
 *   Remove link replaces the mention with its visible text (the custom
 *   label when set); Delete link drops the token wholesale.
 * - `#`  tag: the same popup over pages; picking assigns the tag to the node
 *   (first-class tag_ids OR-set add) and consumes the trigger; the create row
 *   creates + assigns the page.
 * - `+`  class: the same popup over classes only (no pages, no auto-create of
 *   pages — the create row makes a class); picking assigns it (OR-set add).
 * - `/`  slash commands: the ported TriggerPopup (inline mode) over the
 *   block-type actions the content grammar executes — Text (strip the
 *   trigger), Quote (wrap the block's inline tokens in a quote token),
 *   Task/checkbox (assign the task class, OR-set add), Line break (insert a
 *   hard_break token), Add URL (strip the trigger, then open the page-level
 *   LinkEditModal to author an external_link token at the trigger offset),
 *   Query (§34.31 B1: insert a query token at the caret and open its builder
 *   popover on exit), Date (§34.28 #9: typed date → mention of the daily
 *   page, chain ensured on demand), Template (§34.25 T3: flat unfiltered
 *   template list — the pick instantiates a fresh page through the clone
 *   engine and links it at the caret). No match + Enter falls back to plain
 *   prose (the query text stays).
 * - Verb on selection: FloatingToolbar → link button / Cmd+K opens the
 *   VerbPopover (free-string verb + optional locator); commit wraps the
 *   covered prose in a typed_link mark via spliceTokens. PG1 schema-at-
 *   capture (§34.32): the popover live-matches the verb against the
 *   workspace's property schemas — an exact name hit binds the mark to the
 *   existing schema (`verb: { propertySchemaId }`), a miss offers "Create
 *   property '…' and bind" (propertySchema.create typed object/multi, empty
 *   targetClassFilter). Right-clicking an existing typed-link word opens the
 *   LinkEditModal's verb field (same create-and-bind row).
 * All capture commits build on the current draft through applyTextEdit (so
 * unflushed typing is preserved), splice tokens through spliceTokens, then
 * write the result directly with client.updateObject and re-sync the DOM.
 *
 * Keyboard contract (docs/ux.md "The outliner"; v1-level semantics):
 * - Enter mid-text → split at the caret: head stays, tail moves to a new
 *                  sibling right after.
 * - Enter at start → new empty block BEFORE this one (object.create with
 *                  beforeId — the W1 wire extension).
 * - Enter at end/empty → sibling after; a block WITH CHILDREN takes the new
 *                  block as its FIRST child instead (beforeId against the
 *                  current first child).
 * - Shift+Enter  → allow the contentEditable newline; the flush stores it as
 *                  `hard_break` tokens (the only break token in the grammar).
 * - Backspace at start of text → merge into the previous block (previous
 *                  sibling, or the parent when an only child) past the v1
 *                  guard (same-parent childless / only-child-into-parent);
 *                  otherwise a no-op.
 * - Backspace on an empty block with children → promote the children into
 *                  the block's place, then delete it; empty without children
 *                  → delete the block and hand the caret to the previous
 *                  sibling (or the parent).
 * - Delete at end → merge a childless next sibling into this block.
 * - Tab          → indent under the previous sibling (object.move, appended as
 *                  its last child).
 * - Shift+Tab    → outdent to the grandparent, placed right after the current
 *                  parent. The `treeEditMode` device setting (Settings →
 *                  Editor, default "logical") additionally drags subsequent
 *                  siblings under the outdented block; "direct" moves only it.
 * - Node links render as ATOMIC PILLS (contenteditable=false spans, the
 *   read-mode dashed-underline look): arrows select the pill the caret
 *   reaches; Backspace/Delete with the pill selected — or with the caret
 *   adjacent — deletes the whole link; first click selects, second click
 *   places the caret, double-click opens; Enter opens the target.
 * - Ctrl/Cmd+B/I/Shift+X → toggle bold/italic/strike on the selection.
 * - Cmd/Ctrl+K   → open the typed-link verb popover over the selection.
 * - Ctrl/Cmd+C   → with no selection: copy this block's node link
 *                  (`<origin>/<uuid>`) + toast; with a selection the
 *                  browser's default text copy runs.
 * - Ctrl/Cmd+V   → clipboard holding a node link (`<origin>/<uuid>` or a
 *                  bare uuid) splices a mention token at the caret,
 *                  replacing the selection like the default paste; any
 *                  other text keeps the default plain-text paste.
 * - `@` over a selection → open the node picker with the selected text as
 *                  the query; the pick replaces the selection with the link
 *                  (Ctrl/Cmd+Enter keeps the text as the label); Esc restores
 *                  the selection.
 * - Right-click a node link → Open / Open in sidebar / Edit link… /
 *                  Remove link (keeps the text) / Delete link.
 * - `**` over a selection → toggle bold (markdown shortcut; the asterisks
 *                  are swallowed, they are not stored).
 */

import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";

import type { ContentAst, Mark } from "@notees/protocol";
import { chainNodeIds, rendersAsInlineBlock, SYSTEM_CLASS_UUIDS } from "@notees/domain";
import { uuidv7 } from "uuidv7";

import { focusAtPoint, focusWithCaret, type CaretPlacement } from "@/editor/caret.js";
import {
  caretOffset,
  placeCaret,
  proseOffsetFromPoint,
  selectRange,
  selectionOffsets,
} from "@/editor/selection.js";
import {
  atomFromKey,
  atomKey,
  buildEditableDom,
  editableAtoms,
  editableDomSignature,
  type EditableAtom,
} from "@/editor/editable-dom.js";
import { proseFromAst, proseSpans } from "@/editor/prose.js";
import { applyTextEdit, spliceTokens } from "@/editor/edit-apply.js";
import { applyMarkToRange, marksOnRange, removeMarkFromRange } from "@/editor/marks.js";
import { withCandidateSpans } from "@/editor/capture.js";
import type { ClientNode } from "@/core/workspace-client.js";

import { VerbPopover } from "./VerbPopover.js";
import { useOutliner } from "./outliner-context.js";
import { nodeLinkUrl, parseNodeLink } from "./nodeLink.js";
import { CarrierEnterContext, registerCarrierValue } from "./textCarrier.js";
import { copyToClipboard } from "./components/modals/clipboard.js";
import { readDeviceSetting } from "./components/modals/deviceSettings.js";
import { notificationStore } from "./components/ui/notificationStore.js";
import { FloatingToolbar } from "./editor-popups/FloatingToolbar.js";
import { TriggerPopup, SLASH_COMMANDS, bumpSlashCommandUsage, readSlashCommandUsage } from "./editor-popups/TriggerPopup.js";
import { NodeSelector, type NodePickContext } from "./components/pickers/NodeSelector.js";
import { parseDate } from "./components/pickers/dateParser.js";
import { NodeLinkContextMenu } from "./components/NodeLinkContextMenu.js";
import { useLinkEditModalOpener } from "./editor-popups/LinkEditModal.js";
import { CodeTextarea } from "./components/ui/CodeTextarea.js";
import { requestQueryBuilderOpen } from "./QueryBlockView.js";
import { TemplateListPopup } from "./templates/TemplateListPopup.js";
import { useTemplateInstantiator } from "./templates/useTemplateInstantiator.js";
import { ensureTableFamily } from "./components/tableFamily.js";
import { createTable, DEFAULT_TABLE_COLUMNS, parseTableColumnCount } from "./components/tableGrid.js";

export const SAVE_DEBOUNCE_MS = 400;

/** How the caret should land when the editor mounts. */
export type EditorCaret = CaretPlacement | { x: number; y: number };

/**
 * True when the block IS one code_block token (the `/code` product): the
 * editor swaps the prose contentEditable for the code surface (§34.34 B3
 * owed editor) — the token's `text` is edited verbatim (a textarea, not the
 * prose projection, which skips code tokens) and the language badge stays.
 */
function codeTokenOf(ast: readonly unknown[]): { language?: string; text: string } | null {
  if (ast.length !== 1) return null;
  const token = ast[0];
  if (typeof token !== "object" || token === null) return null;
  const t = token as { type?: unknown; language?: unknown; text?: unknown };
  if (t.type !== "code_block" || typeof t.text !== "string") return null;
  return { ...(typeof t.language === "string" ? { language: t.language } : {}), text: t.text };
}

/**
 * The code_block editing surface — §34.34 B3's owed editor branch. A
 * CodeTextarea-integrated editor (the kit primitive): typing is debounced
 * and writes the token's `text` through the standard content path
 * (client.updateObject, one op per debounce window), the language hint
 * survives untouched, and blur/Esc flushes and hands back to read mode.
 * Draft state is local (like the whiteboard's CardTextEditor) so client
 * notify re-renders never clobber the caret; a clean editor re-syncs from
 * remote edits.
 */
function CodeBlockEditor({
  node,
  client,
  onExit,
}: {
  node: ClientNode;
  client: { getNode(id: string): ClientNode | undefined; updateObject(id: string, fields: { contentAst: ContentAst }): Promise<void> };
  onExit: () => void;
}) {
  const initial = codeTokenOf(node.contentAst);
  const [draft, setDraft] = useState(initial?.text ?? "");
  // The draft lives in state for the controlled textarea and in a ref for the
  // debounced flush (the callback must read the freshest text).
  const draftRefText = useRef(draft);
  draftRefText.current = draft;
  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nodeRef = useRef(node);
  nodeRef.current = node;
  const language = initial?.language ?? null;

  const write = useCallback(
    (text: string) => {
      const current = nodeRef.current;
      const token = codeTokenOf(current.contentAst);
      if (token === null || token.text === text) return;
      const next = [
        {
          type: "code_block" as const,
          ...(token.language !== undefined ? { language: token.language } : {}),
          text,
        },
      ] as ContentAst;
      if (JSON.stringify(next) !== JSON.stringify(current.contentAst)) {
        void client.updateObject(current.id, { contentAst: next });
      }
    },
    [client],
  );

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    write(draftRefText.current);
  }, [write]);

  // Remote edits re-project while the local draft is clean; a dirty draft
  // (the caret is in the textarea) wins until its flush lands.
  useEffect(() => {
    if (dirtyRef.current) return;
    const token = codeTokenOf(nodeRef.current.contentAst);
    setDraft(token?.text ?? "");
  }, [node.contentAst]);

  // Unmount flush (a blurred-away surface never loses its last keystrokes).
  useEffect(() => () => flush(), [flush]);

  return (
    <span className="nt-code-editor" data-editor-companion>
      <span className="nt-code-block">
        {language !== null && <span className="nt-code-block__lang">{language}</span>}
        <CodeTextarea
          value={draft}
          onChange={(value) => {
            dirtyRef.current = true;
            setDraft(value);
            if (timerRef.current !== null) clearTimeout(timerRef.current);
            timerRef.current = setTimeout(() => {
              dirtyRef.current = false;
              write(value);
            }, SAVE_DEBOUNCE_MS);
          }}
          className="nt-code-editor__area"
          label="Code"
          id={`code-editor-${node.id}`}
          autoFocus
          onBlur={() => {
            flush();
            onExit();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              flush();
              onExit();
            }
          }}
        />
      </span>
    </span>
  );
}

/** Which capture trigger opened the popup. */
type CaptureKind = "mention" | "tag" | "class" | "slash";

/** One selectable row of the slash popup (the TriggerPopup's contract). */
interface SlashCandidate {
  id: string;
  label: string;
}

const TRIGGER_CHAR: Record<CaptureKind, string> = { mention: "@", tag: "#", class: "+", slash: "/" };

/** displayText schema bound (content-mark.ts mentionTokenSchema). */
const MENTION_LABEL_MAX = 512;

/**
 * The `/query` slash starter AST — exactly what the query builder composes
 * from its default state, so the token the builder opens on matches one
 * clean Apply cycle (§34.31 B1).
 */
const STARTER_QUERY_AST: Record<string, unknown> = {
  version: 1,
  scope: { type: "entire_workspace" },
  root: { type: "group", logic: "and", children: [] },
};

/** Strict local YYYY-MM-DD for the date chain (mirrors the picker idiom). */
function toIsoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Second-stage state of the `/template` slash flow (the trigger is already consumed). */
interface TemplateStageState {
  /** Draft-prose offset where the instantiated page's mention lands. */
  start: number;
  /** The remainder typed after "template" — the picker's initial filter. */
  filter: string;
}

interface CaptureState {
  kind: CaptureKind;
  /** Prose offset of the trigger character. */
  start: number;
  /**
   * Draft text between the trigger and the caret (slash inline mode) — or,
   * for a mention popup opened over a selection, the selected text, which
   * pre-fills the picker's search field and becomes the custom label on a
   * Ctrl/Cmd+Enter pick.
   */
  query: string;
  /** Selected candidate row (slash inline mode only). */
  index: number;
  /**
   * Mention popup opened by typing `@` over a selection: no trigger char
   * exists in the draft; the pick (or cancel) operates on the prose range
   * [start, replaceEnd) instead.
   */
  replaceEnd?: number;
  /** Viewport anchor captured when a node-picker popup opened (caret line). */
  anchor?: { top: number; left: number };
}

/** A mention token as stored in the content stream (content-mark.ts). */
interface MentionToken {
  type: "mention";
  targetNodeId: string;
  text: string;
  displayText?: string;
  linkId?: string;
}

/** State of the node-link right-click menu (hit-tested to a mention token). */
interface LinkMenuState {
  x: number;
  y: number;
  /** Index of the mention token inside contentAst (validated again on action). */
  tokenIndex: number;
  /** Prose range the token covers in the current draft. */
  start: number;
  end: number;
  targetNodeId: string;
}

/** Inline token types the quote token admits as children (SCHEMA.md grammar). */
const QUOTE_CHILD_TYPES = new Set([
  "text",
  "typed_link",
  "mention",
  "class_chip",
  "external_link",
  "math",
  "hard_break",
]);

interface BlockTextEditorProps {
  node: ClientNode;
  caret: EditorCaret;
  onExitEdit: () => void;
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

/**
 * Viewport anchor for the slash popup: `top` = caret bottom, `caretTop` =
 * caret top (the popup is position: fixed). Same zero-rect jsdom fallback.
 */
function caretLineAnchor(): { top: number; left: number; caretTop: number } {
  try {
    const selection = window.getSelection();
    if (selection !== null && selection.rangeCount > 0) {
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      return { top: rect.bottom, left: rect.left, caretTop: rect.top };
    }
  } catch {
    // jsdom / edge layouts: the popup lands at the viewport origin.
  }
  return { top: 0, left: 0, caretTop: 0 };
}

export function BlockTextEditor({ node, caret, onExitEdit }: BlockTextEditorProps) {
  const {
    client,
    rootId,
    positions,
    requestFocus,
    capture: captureApi,
    openNode,
    openInSidebar,
    ensureTemplateFamily,
  } = useOutliner();
  /** Text-property carrier semantics (§34.80) — provided by the property
   *  cell hosting this block as a carrier; null in the ordinary outline. */
  const carrierEnter = useContext(CarrierEnterContext);
  const rootRef = useRef<HTMLSpanElement>(null);
  const spanRef = useRef<HTMLSpanElement>(null);
  const nodeRef = useRef(node);
  nodeRef.current = node;
  const draftRef = useRef(proseFromAst(node.contentAst));
  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Range captured by the first "*" of the `**`-over-selection shortcut. */
  const starRef = useRef<{ start: number; end: number } | null>(null);
  const [activeMarks, setActiveMarks] = useState<readonly Mark[]>([]);
  const [capture, setCapture] = useState<CaptureState | null>(null);
  const [verb, setVerb] = useState<{ start: number; end: number; top: number; left: number } | null>(
    null,
  );
  /** Right-click menu over a mention token (null = closed). */
  const [linkMenu, setLinkMenu] = useState<LinkMenuState | null>(null);
  /**
   * The atomic pill selected by click/arrow (data-atom-key from the build,
   * validated against the current atom list before every use — a stale key
   * means the draft drifted and the selection is dropped).
   */
  const [selectedAtomKey, setSelectedAtomKey] = useState<string | null>(null);
  /** Slash-command usage counts for this session (ranking ties in the popup). */
  const [slashUsage] = useState(readSlashCommandUsage);
  /** Opens the page-level LinkEditModal (slash "Add URL" flow). */
  const openLinkEditor = useLinkEditModalOpener();
  /**
   * The `/template` slash flow's second stage: the trigger is consumed and
   * the flat template list popup owns the pick. The ref mirrors the state so
   * the instantiator's async onInstantiated lands the mention at the offset
   * captured when the stage opened (the dialog can outlive the state read).
   */
  const [templateStage, setTemplateStage] = useState<TemplateStageState | null>(null);
  const templateStageRef = useRef<TemplateStageState | null>(null);
  /** Open the stage: popup state + the offset the async pick callback reads. */
  const openStage = (stage: TemplateStageState) => {
    templateStageRef.current = stage;
    setTemplateStage(stage);
  };
  /** Close the popup only — the ref survives until the pick instantiates. */
  const closeStagePopup = () => setTemplateStage(null);
  /** Full close (Escape / cancel): popup + the pending offset. */
  const clearStage = () => {
    templateStageRef.current = null;
    setTemplateStage(null);
  };
  /**
   * Shared create-with-template flow (§34.25 T3/T4): family self-heal through
   * the outliner seam (shells without it skip the heal — the graft itself is
   * schema-independent), variables dialog when the template carries
   * {{variables}}, then a fresh page; the mention link lands at the stage
   * offset.
   */
  const templateInstantiator = useTemplateInstantiator({
    client,
    ensure: () => ensureTemplateFamily?.() ?? Promise.resolve(),
    currentPageName: captureApi.displayName(rootId) ?? undefined,
    onInstantiated: (nodeId) => {
      const stage = templateStageRef.current;
      templateStageRef.current = null;
      const el = spanRef.current;
      if (stage === null || el === null) return;
      const label = captureApi.displayName(nodeId) ?? "Untitled";
      applySplice(
        stage.start,
        stage.start,
        [{ type: "mention", targetNodeId: nodeId, text: label, linkId: uuidv7() }],
        stage.start + label.length,
      );
      el.focus();
    },
  });

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

  // --- atomic pills (node links render as single units) -----------------------

  /** The pill selected by click/arrow, validated against the freshest draft. */
  const currentAtom = (): EditableAtom | null => {
    if (selectedAtomKey === null) return null;
    const base = applyTextEdit(nodeRef.current.contentAst, draftRef.current);
    return atomFromKey(editableAtoms(base), selectedAtomKey);
  };

  /** Delete a pill's token wholesale (Backspace/Delete, selected or adjacent). */
  const deleteAtom = (atom: EditableAtom) => {
    setSelectedAtomKey(null);
    applySplice(atom.start, atom.end, [], atom.start);
  };

  /**
   * Backspace-at-start (v1 semantics): merge this block's content into the
   * previous block — the previous SIBLING, or the parent when this block is
   * an only child — but only past the v1 guard (same-parent childless, or an
   * only-child into its parent). Otherwise the key is a no-op. The source's
   * unflushed draft rides along (applyTextEdit); the caret lands at the
   * merge point in the target block.
   */
  const mergeIntoPrevious = (blockId: string) => {
    const node = client.getNode(blockId);
    if (node === undefined) return;
    const position = positions.get(blockId);
    const parent = node.parentId !== null ? client.getNode(node.parentId) : undefined;
    const targetId =
      position?.previousSiblingId ??
      (parent !== undefined && rendersAsInlineBlock(parent) ? parent.id : null);
    if (targetId === null || targetId === undefined) return;
    const target = client.getNode(targetId);
    if (target === undefined) return;
    const sameParentChildless =
      node.parentId === target.parentId && client.getChildren(blockId).length === 0;
    const onlyChildIntoParent =
      node.parentId === targetId && client.getChildren(targetId).length === 1;
    if (!sameParentChildless && !onlyChildIntoParent) return;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    dirtyRef.current = false;
    const sourceText = applyTextEdit(node.contentAst, draftRef.current);
    const caretAt = proseFromAst(target.contentAst).length;
    // Splice at the target's end so adjacent text runs coalesce.
    const merged = withCandidateSpans(
      spliceTokens(target.contentAst, caretAt, caretAt, sourceText),
    );
    void client.updateObject(targetId, { contentAst: merged }).then(() => {
      // The only-child case can still leave children on the source — they
      // follow it under the merge target.
      const orphans = client.getChildren(blockId);
      let after: string | undefined;
      orphans.forEach((orphan) => {
        void client.moveObject(orphan.id, targetId, after);
        after = orphan.id;
      });
      void client.deleteObject(blockId).then(() => requestFocus(targetId, caretAt));
    });
  };

  /**
   * Delete-at-end (v1 semantics): merge the NEXT SIBLING's content into this
   * block when the guard allows (same parent — by construction — and the
   * next block is childless). The caret stays at the merge point.
   */
  const mergeNextInto = (blockId: string) => {
    const node = client.getNode(blockId);
    if (node === undefined || node.parentId === null) return;
    const siblings = client.getChildren(node.parentId);
    const index = siblings.findIndex((sibling) => sibling.id === blockId);
    const next = index >= 0 ? siblings[index + 1] : undefined;
    if (next === undefined) return;
    if (client.getChildren(next.id).length > 0) return;
    const base = applyTextEdit(node.contentAst, draftRef.current);
    const caretAt = proseFromAst(base).length;
    const merged = withCandidateSpans(spliceTokens(base, caretAt, caretAt, next.contentAst));
    commitAst(merged, caretAt);
    void client.deleteObject(next.id);
  };

  // Selection → active-marks state (the FloatingToolbar decides its own
  // visibility/position from the same selectionchange stream). Listened on
  // document (selectionchange does not bubble) for the whole edit session.
  const syncSelectionUi = useCallback(() => {
    const el = spanRef.current;
    const range = el === null ? null : selectionOffsets(el);
    if (range === null || range.start === range.end) {
      setActiveMarks([]);
      return;
    }
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

  // Mount: hydrate the DOM (text runs + atomic pill elements) and land the
  // caret. No React children are rendered (the DOM is managed imperatively),
  // so React raises no contentEditable warnings and updates never reset the
  // caret mid-typing.
  useEffect(() => {
    const el = spanRef.current;
    if (el === null) return;
    buildEditableDom(el, nodeRef.current.contentAst);
    if (typeof caret === "object") focusAtPoint(el, caret.x, caret.y);
    else focusWithCaret(el, caret);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Unmount flush (dirty draft never dies with the editor).
  useEffect(() => () => flush(), [flush]);

  // External edits (remote sync) rehydrate the DOM only while we are not
  // actively editing it. The signature covers prose AND pill structure, so a
  // same-prose token change (a link inserted elsewhere) still rebuilds.
  useEffect(() => {
    const el = spanRef.current;
    if (el === null || document.activeElement === el || dirtyRef.current) return;
    const domSignature = `${el.textContent ?? ""}#${el.querySelectorAll("[data-atom-key]").length}`;
    if (domSignature !== editableDomSignature(node.contentAst)) {
      buildEditableDom(el, node.contentAst);
    }
  }, [node.contentAst]);

  // Pill selection chrome: pills are DOM-built, so the selected class is
  // applied imperatively (re-applied after every rebuild replaces elements).
  useEffect(() => {
    const el = spanRef.current;
    if (el === null) return;
    for (const pill of Array.from(el.querySelectorAll<HTMLElement>("[data-atom-key]"))) {
      pill.classList.toggle("nt-atom--selected", pill.dataset.atomKey === selectedAtomKey);
    }
  }, [selectedAtomKey, node.contentAst]);

  // --- capture gestures -------------------------------------------------------

  /** Filtered popup rows for the active slash capture (recomputed per keystroke). */
  const captureItems = useMemo<SlashCandidate[]>(() => {
    if (capture === null || capture.kind !== "slash") return [];
    // Slash commands: the command word (first token) matches — label match
    // outranks description match, usage breaks ties; the remainder is the
    // command's argument (the ranking contract the TriggerPopup implements).
    const query = capture.query.trim();
    const q = (query.split(/\s+/)[0] ?? "").toLowerCase();
    // Slash commands: label match outranks description match, usage breaks
    // ties (the ranking contract the TriggerPopup rows were designed for).
    return SLASH_COMMANDS.map((cmd) => {
      const labelMatch = cmd.label.toLowerCase().includes(q);
      const idMatch = cmd.id.toLowerCase().includes(q);
      const descMatch = cmd.description.toLowerCase().includes(q);
      const textScore = (labelMatch || idMatch ? 2 : 0) + (descMatch ? 1 : 0);
      return { cmd, textScore, freq: slashUsage[cmd.id] || 0 };
    })
      .filter((s) => s.textScore > 0 || query === "")
      .sort((a, b) => (b.textScore !== a.textScore ? b.textScore - a.textScore : b.freq - a.freq))
      .map((s) => ({ id: s.cmd.id, label: s.cmd.label }));
  }, [capture, slashUsage]);

  /**
   * Reconcile the capture popup with the draft + caret: close when the
   * trigger was backspaced over or the caret left the query; open when a
   * trigger char was just typed at a word boundary. Slash tracks the query
   * inline (the block is the search field); @/#/+ open the node-picker popup
   * with its own search input, anchored at the caret line captured here.
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
        if (current.kind === "slash") {
          return { ...current, query: draft.slice(current.start + 1, caret) };
        }
        // Node-picker popups: the query lives in the popup's input; keep the
        // capture (and the placeholder char) as long as the trigger survives.
        return current;
      }
      if (caret === null || caret === 0) return null;
      const ch = draft[caret - 1]!;
      const boundary = caret === 1 || /\s/.test(draft[caret - 2]!);
      if (!boundary) return null;
      if (ch === "@") {
        const anchor = caretLineAnchor();
        return { kind: "mention", start: caret - 1, query: "", index: 0, anchor: { top: anchor.top, left: anchor.left } };
      }
      if (ch === "#") {
        const anchor = caretLineAnchor();
        return { kind: "tag", start: caret - 1, query: "", index: 0, anchor: { top: anchor.top, left: anchor.left } };
      }
      if (ch === "+") {
        const anchor = caretLineAnchor();
        return { kind: "class", start: caret - 1, query: "", index: 0, anchor: { top: anchor.top, left: anchor.left } };
      }
      if (ch === "/") return { kind: "slash", start: caret - 1, query: "", index: 0 };
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
    buildEditableDom(el, next);
    draftRef.current = prose;
    dirtyRef.current = false;
    setSelectedAtomKey(null);
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

  // --- slash commands -------------------------------------------------------

  /**
   * Execute a slash command picked in the TriggerPopup. The trigger span is
   * [start, caret) of the draft; one blank after the query is consumed so
   * "/quote hello" leaves "hello". Offsets are draft-prose offsets.
   */
  const runSlashCommand = (commandId: string, start: number, caret: number, query: string) => {
    const el = spanRef.current;
    if (el === null) return;
    const draft = draftRef.current;
    const consume = draft[caret] === " " ? 1 : 0;
    const end = caret + consume;
    bumpSlashCommandUsage(commandId);
    if (commandId === "text") {
      applySplice(start, end, [], start);
      return;
    }
    if (commandId === "hard_break") {
      applySplice(start, end, [{ type: "hard_break" }], start + 1);
      return;
    }
    if (commandId === "quote") {
      const base = applyTextEdit(nodeRef.current.contentAst, draft);
      const stripped = spliceTokens(base, start, end, []);
      const children = stripped.filter(
        (token): token is ContentAst[number] =>
          QUOTE_CHILD_TYPES.has(String((token as { type?: string }).type)),
      );
      commitAst([{ type: "quote", children } as ContentAst[number]], start);
      return;
    }
    if (commandId === "checkbox") {
      applySplice(start, end, [], start);
      // The task system class is this grammar's checkbox: assign it (OR-set
      // add), preferring a live class named "task" over the designed seed id.
      const taskClassId =
        captureApi.listClasses().find((cls) => cls.name === "task")?.id ?? SYSTEM_CLASS_UUIDS.task;
      void client.assignClass(nodeRef.current.id, taskClassId).catch((error: unknown) => {
        console.warn(`[capture] assignClass (${taskClassId}) failed:`, error);
      });
      return;
    }
    if (commandId === "url") {
      applySplice(start, end, [], start);
      // The page-level LinkEditModal authors the external_link token at the
      // trigger offset; a typed URL-looking query pre-fills the URL field.
      const looksLikeUrl = /^https?:\/\//i.test(query.trim());
      openLinkEditor({
        kind: "external",
        blockId: nodeRef.current.id,
        tokenIndex: null,
        insertAt: start,
        initialUrl: looksLikeUrl ? query.trim() : "",
        initialLabel: looksLikeUrl ? "" : query.trim(),
      });
      return;
    }
    if (commandId === "query") {
      // §34.31 B1: insert a live query token at the caret, then hand the
      // token's read-mode view an open-builder request (it mounts when this
      // editor exits — see QueryBlockView's module queue).
      const base = applyTextEdit(nodeRef.current.contentAst, draft);
      const token = { type: "query", queryAst: STARTER_QUERY_AST } as ContentAst[number];
      const next = spliceTokens(base, start, end, [token]);
      const tokenIndex = next.findIndex((entry) => entry === token);
      commitAst(withCandidateSpans(next), start);
      requestQueryBuilderOpen(nodeRef.current.id, tokenIndex);
      onExitEdit();
      return;
    }
    if (commandId === "date") {
      // §34.28 #9: typed date → link to the daily page (created on demand).
      // Mirrors the @-picker's date row: ensure the chain, then insert a
      // mention at the caret. A bare `/date` means today; an unparseable
      // query falls back like a no-match (only the sigil is stripped — the
      // typed text stays). The command word itself is not part of the date.
      const trimmed = query.trim();
      const remainder = /^date(\s+|$)/i.test(trimmed) ? trimmed.replace(/^date(\s+|$)/i, "").trim() : trimmed;
      const parsed = parseDate(remainder) ?? (remainder === "" ? parseDate("today") : null);
      if (parsed === null) {
        plainFallback(start);
        return;
      }
      const iso =
        parsed.type === "day" && parsed.month !== undefined && parsed.day !== undefined
          ? toIsoDate(parsed.year, parsed.month, parsed.day)
          : parsed.type === "month" && parsed.month !== undefined
            ? toIsoDate(parsed.year, parsed.month, 1)
            : toIsoDate(parsed.year, 1, 1);
      const ids = chainNodeIds(iso);
      const refId = parsed.type === "year" ? ids.year : parsed.type === "month" ? ids.month : ids.day;
      const insertAt = start;
      applySplice(start, end, [], start);
      void client
        .ensureDateChain(iso)
        .then(() => {
          applySplice(
            insertAt,
            insertAt,
            [{ type: "mention", targetNodeId: refId, text: parsed.label, linkId: uuidv7() }],
            insertAt + parsed.label.length,
          );
        })
        .catch((error: unknown) => {
          console.warn(`[capture] ensureDateChain (${iso}) failed:`, error);
        });
      return;
    }
    if (commandId === "template") {
      // §34.25 T3 (D1 amendment): flat unfiltered template list; the pick
      // instantiates at the caret through the shared instantiator (variables
      // dialog first when the template carries {{variables}}).
      const remainder = query.toLowerCase().startsWith("template")
        ? query.slice("template".length).trim()
        : "";
      applySplice(start, end, [], start);
      openStage({ start, filter: remainder });
      return;
    }
    if (commandId === "hr") {
      // §34.34 B5 (lockstep SHIPPED): the divider token rides the content
      // stream like a hard_break — one token, no text.
      applySplice(start, end, [{ type: "hr" }], start + 1);
      return;
    }
    if (commandId === "code") {
      // §34.34 B3 (lockstep SHIPPED): the block becomes a code_block token.
      // The typed remainder is the language hint ("/code python"); the code
      // text is what the block already carries — the sentence you wrote
      // becomes the code, nothing silently dropped. Editing rides the
      // CodeTextarea surface (CodeBlockEditor — the block's edit mode).
      const trimmed = query.trim();
      const remainder = /^code(\s+|$)/i.test(trimmed)
        ? trimmed.replace(/^code(\s+|$)/i, "").trim()
        : "";
      // The language hint is the remainder's FIRST word ("/code python …");
      // whatever follows the consumed trigger — typed after the hint or
      // already in the block — becomes the code text.
      const langToken = remainder.split(/\s+/)[0] ?? "";
      const language = /^[a-z0-9+#-]{1,64}$/i.test(langToken) ? langToken.toLowerCase() : undefined;
      // Text after the language hint is the code body ("/code python print(x)"
      // → body "print(x)"); text outside the consumed trigger range (written
      // before the slash) rides in front.
      const bodyFromHint = remainder.split(/\s+/).slice(1).join(" ").trim();
      const base = applyTextEdit(nodeRef.current.contentAst, draft);
      const stripped = spliceTokens(base, start, end, []);
      const existing = proseFromAst(stripped).trim();
      const text =
        bodyFromHint !== ""
          ? existing !== ""
            ? `${existing}\n${bodyFromHint}`
            : bodyFromHint
          : existing;
      commitAst(
        [
          {
            type: "code_block",
            ...(language !== undefined ? { language } : {}),
            text,
          } as ContentAst[number],
        ],
        start,
      );
      return;
    }
    if (commandId === "table") {
      // §34.34 B4: a table is a CONTAINER node classed `table` (the class
      // says what-it-is — the whiteboard pattern; no new wire token). It is
      // created as a child of this block at the caret with one row of empty
      // cells; the optional typed remainder is the column count ("/table 5",
      // default three). The caret then moves into the first cell. The
      // container's children render as a CSS grid in BlockRow; every cell
      // is an ordinary block — mentionable, editable, Tab/Enter intact.
      const trimmed = query.trim();
      const remainder = /^table(\s+|$)/i.test(trimmed)
        ? trimmed.replace(/^table(\s+|$)/i, "").trim()
        : "";
      const columns = parseTableColumnCount(remainder) ?? DEFAULT_TABLE_COLUMNS;
      applySplice(start, end, [], start);
      const parentId = nodeRef.current.id;
      void (async () => {
        try {
          const tableClassId = await ensureTableFamily(client);
          const { firstCellId } = await createTable(client, parentId, tableClassId, columns);
          requestFocus(firstCellId, "end");
        } catch (error) {
          console.warn("[capture] /table failed:", error);
        }
      })();
      onExitEdit();
      return;
    }
    applySplice(start, end, [], start);
  };

  /**
   * Enter/Shift+Enter (or click) on a slash-capture row. `candidate` is
   * undefined when the query has no rows — plain fallback keeping the query.
   * (The @/#/+ popups own their keyboard handling inside the node picker.)
   */
  const commitCapture = (candidate: SlashCandidate | undefined, shiftKey: boolean) => {
    const state = capture;
    const el = spanRef.current;
    if (state === null || el === null || state.kind !== "slash") return;
    const caret = caretOffset(el);
    if (caret === null) {
      setCapture(null);
      return;
    }
    setCapture(null);
    if (candidate === undefined) {
      plainFallback(state.start);
      return;
    }
    runSlashCommand(candidate.id, state.start, caret, state.query);
    void shiftKey; // slash rows have no alternative action
  };

  // --- node-picker gestures (@ / # / +) ---------------------------------------

  /**
   * Pick (or create) in the @/#/+ popup. The trigger placeholder is consumed
   * from the draft (whatever the caret covers after it — the popup owned the
   * typing, so normally just the one trigger char); a popup opened over a
   * selection instead consumes the stashed range [start, replaceEnd) — the
   * selected text was never deleted. Then the per-kind action runs: @ inserts
   * a mention token, # assigns the tag, + assigns the class. A mention picked
   * with Ctrl/Cmd+Enter (context.withLabel) keeps the search query as a
   * custom label (displayText) instead of resolving the target's name.
   */
  const commitNodePick = (picked: ClientNode, context?: NodePickContext) => {
    const state = capture;
    if (state === null || state.kind === "slash") return;
    setCapture(null);
    const el = spanRef.current;
    if (el === null) return;
    const caret = caretOffset(el) ?? state.start + 1;
    const end = state.replaceEnd ?? Math.max(caret, state.start + 1);
    if (state.kind === "mention") {
      const customLabel =
        context !== undefined && context.withLabel
          ? context.query.slice(0, MENTION_LABEL_MAX)
          : null;
      if (customLabel !== null && customLabel !== "") {
        applySplice(
          state.start,
          end,
          [
            {
              type: "mention",
              targetNodeId: picked.id,
              text: customLabel,
              displayText: customLabel,
              linkId: uuidv7(),
            },
          ],
          state.start + customLabel.length,
        );
        el.focus();
        return;
      }
      const label = captureApi.displayName(picked.id) ?? "Untitled";
      applySplice(
        state.start,
        end,
        [{ type: "mention", targetNodeId: picked.id, text: label, linkId: uuidv7() }],
        state.start + label.length,
      );
      el.focus();
      return;
    }
    if (state.kind === "tag") {
      void client.assignTag(nodeRef.current.id, picked.id).catch((error: unknown) => {
        console.warn(`[capture] assignTag (${picked.id}) failed:`, error);
      });
      stripTrigger(state.start, end);
      el.focus();
      return;
    }
    void client.assignClass(nodeRef.current.id, picked.id).catch((error: unknown) => {
      console.warn(`[capture] assignClass (${picked.id}) failed:`, error);
    });
    stripTrigger(state.start, end);
    el.focus();
  };

  /**
   * Multi-select apply from the # / + popup (§34.19): every picked node is
   * assigned in pick order (tags / classes), the trigger placeholder is
   * consumed once, and the block refocuses.
   */
  const commitNodePicks = (picked: ClientNode[]) => {
    const state = capture;
    if (state === null || state.kind === "slash") return;
    setCapture(null);
    const el = spanRef.current;
    if (el === null) return;
    const caret = caretOffset(el) ?? state.start + 1;
    const end = state.replaceEnd ?? Math.max(caret, state.start + 1);
    if (state.kind === "tag") {
      for (const node of picked) {
        void client.assignTag(nodeRef.current.id, node.id).catch((error: unknown) => {
          console.warn(`[capture] assignTag (${node.id}) failed:`, error);
        });
      }
    } else {
      for (const node of picked) {
        void client.assignClass(nodeRef.current.id, node.id).catch((error: unknown) => {
          console.warn(`[capture] assignClass (${node.id}) failed:`, error);
        });
      }
    }
    stripTrigger(state.start, end);
    el.focus();
  };

  /**
   * The @/#/+ popup closed without a pick (Escape / click outside): keep the
   * trigger char as plain text and hand focus back to the block — unless the
   * click that closed it is focusing something else (another block, the
   * sidebar), in which case the normal blur flow owns the caret. A popup
   * opened over a selection restores that selection instead (nothing was ever
   * deleted).
   */
  const closeNodePicker = () => {
    const state = capture;
    setCapture(null);
    const el = spanRef.current;
    if (el === null || state === null) return;
    const active = document.activeElement;
    const focusInPopup =
      active instanceof HTMLElement && active.closest("[data-editor-companion]") !== null;
    if (focusInPopup || active === null || active === document.body) {
      if (state.replaceEnd !== undefined) {
        selectRange(el, state.start, state.replaceEnd);
      } else {
        el.focus();
        placeCaret(el, state.start + 1);
      }
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

  const commitVerb = (verbValue: string | { propertySchemaId: string }, locator: string) => {
    const state = verb;
    if (state === null) return;
    setVerb(null);
    writeVerbMark(state.start, state.end, verbValue, locator);
  };

  /**
   * Wrap the covered prose range in a typed_link mark (PG1: the verb is a
   * free string or the bound `{ propertySchemaId }` shape). Shared by the
   * popover submit and the create-and-bind flow.
   */
  const writeVerbMark = (
    start: number,
    end: number,
    verbValue: string | { propertySchemaId: string },
    locator: string,
  ) => {
    const base = applyTextEdit(nodeRef.current.contentAst, draftRef.current);
    const covered = proseFromAst(base).slice(start, end);
    if (covered === "") return;
    const metadata: Record<string, unknown> = {};
    if (locator !== "") metadata.locator = locator;
    const token = { type: "typed_link", verb: verbValue, text: covered, metadata };
    const next = withCandidateSpans(spliceTokens(base, start, end, [token]));
    const el = spanRef.current;
    commitAst(next, start + covered.length);
    el?.focus();
  };

  /**
   * PG1 create-and-bind: author the property schema at capture (typed
   * `object`, multi, empty targetClassFilter — the Tana flagship gesture) and
   * bind the mark to it. The modal stays open until the schema exists; a
   * failure surfaces in the popover and leaves the selection untouched.
   */
  const createAndBindVerb = async (verbStr: string, locator: string): Promise<void> => {
    const state = verb;
    if (state === null) return;
    const schemaId = await client.createPropertySchema({
      name: verbStr,
      type: "object",
      multi: true,
      targetClassFilter: [],
    });
    writeVerbMark(state.start, state.end, { propertySchemaId: schemaId }, locator);
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

  // --- node-link context menu (right-click a mention) -------------------------

  /**
   * Pill mouse gestures (v1 parity): the FIRST click selects the pill — the
   * mousedown only blocks caret placement (the click handler owns selection,
   * so the click of the same gesture can't read as a "second click"); a
   * click on the already-selected pill clears the flash and lets the
   * browser place the caret before/after by half; double-click opens.
   */
  const handleMouseDown = (event: MouseEvent<HTMLSpanElement>) => {
    const el = spanRef.current;
    if (el === null) return;
    const pill = (event.target as HTMLElement).closest?.("[data-atom-key]");
    if (pill === null || pill === undefined || !el.contains(pill)) {
      setSelectedAtomKey(null);
      return;
    }
    const key = (pill as HTMLElement).dataset.atomKey;
    if (key !== selectedAtomKey) {
      // Unselected (or different) pill: no native caret placement; a stale
      // selection on another pill is cleared here, the click re-selects.
      if (selectedAtomKey !== null) setSelectedAtomKey(null);
      event.preventDefault();
      el.focus();
    }
    // Pressing the already-selected pill: default runs — the browser places
    // the caret adjacent (before/after by half), the click clears the flash.
  };

  const handleClick = (event: MouseEvent<HTMLSpanElement>) => {
    const el = spanRef.current;
    if (el === null) return;
    const pill = (event.target as HTMLElement).closest?.("[data-atom-key]");
    if (pill === null || pill === undefined || !el.contains(pill)) return;
    const key = (pill as HTMLElement).dataset.atomKey;
    if (key === undefined) return;
    if (key === selectedAtomKey) {
      // Second click on the selected pill: caret was placed natively.
      setSelectedAtomKey(null);
    } else {
      // First click: the pill becomes the only focus hint.
      setSelectedAtomKey(key);
    }
  };

  const handleDoubleClick = (event: MouseEvent<HTMLSpanElement>) => {
    const el = spanRef.current;
    if (el === null) return;
    const pill = (event.target as HTMLElement).closest?.("[data-atom-key]");
    if (pill === null || pill === undefined || !el.contains(pill)) return;
    const base = applyTextEdit(nodeRef.current.contentAst, draftRef.current);
    const atom = atomFromKey(editableAtoms(base), (pill as HTMLElement).dataset.atomKey);
    if (atom === null) return;
    event.preventDefault();
    setSelectedAtomKey(null);
    openNode(atom.targetNodeId);
  };

  /**
   * Right-click hit test: the pill element under the pointer is exact;
   * otherwise map the point to a prose offset, then to the mention token
   * covering it. Plain text falls through to the browser menu.
   */
  const handleContextMenu = (event: MouseEvent<HTMLSpanElement>) => {
    const el = spanRef.current;
    if (el === null || linkMenu !== null) return;
    const base = applyTextEdit(nodeRef.current.contentAst, draftRef.current);
    const atoms = editableAtoms(base);
    const pill = (event.target as HTMLElement).closest?.("[data-atom-key]");
    let atom: EditableAtom | null = null;
    if (pill !== null && pill !== undefined && el.contains(pill)) {
      atom = atomFromKey(atoms, (pill as HTMLElement).dataset.atomKey);
    } else {
      const offset = proseOffsetFromPoint(el, event.clientX, event.clientY);
      if (offset === null) return;
      const span = proseSpans(base).find((s) => s.start <= offset && offset < s.end);
      if (span === undefined) return;
      atom = atoms.find((a) => a.tokenIndex === span.tokenIndex) ?? null;
      // PG1: a right-click on a typed-link word opens the verb editor modal
      // (the bound-verb / create-and-bind surface) — the LinkEditModal's
      // verb field, mirroring the mention pill's "Edit link…" flow.
      if (atom === null) {
        const token = base[span.tokenIndex];
        if (
          typeof token === "object" &&
          token !== null &&
          (token as { type?: unknown }).type === "typed_link"
        ) {
          const mark = token as { verb?: unknown; metadata?: { locator?: unknown } };
          const rawVerb =
            typeof mark.verb === "string"
              ? mark.verb
              : typeof mark.verb === "object" && mark.verb !== null && "propertySchemaId" in mark.verb
                ? (client
                    .listPropertySchemas()
                    .find((schema) => schema.id === (mark.verb as { propertySchemaId: string }).propertySchemaId)
                    ?.name ?? "")
                : "";
          const locator =
            typeof mark.metadata?.locator === "string" ? mark.metadata.locator : "";
          event.preventDefault();
          flush(); // push unflushed typing so the modal writes over the current AST
          openLinkEditor({
            kind: "verb",
            blockId: nodeRef.current.id,
            tokenIndex: span.tokenIndex,
            insertAt: null,
            initialVerb: rawVerb,
            initialLocator: locator,
          });
        }
        return;
      }
    }
    if (atom === null) return;
    event.preventDefault();
    setLinkMenu({
      x: event.clientX,
      y: event.clientY,
      tokenIndex: atom.tokenIndex,
      start: atom.start,
      end: atom.end,
      targetNodeId: atom.targetNodeId,
    });
  };

  /**
   * The mention the menu was opened on, re-validated against the freshest
   * state (the menu survives the debounced flush, which rewrites the same
   * prose but could in principle rebase the stream).
   */
  const currentLinkMenuMention = (): { menu: LinkMenuState; token: MentionToken } | null => {
    const menu = linkMenu;
    if (menu === null) return null;
    const base = applyTextEdit(nodeRef.current.contentAst, draftRef.current);
    const token = base[menu.tokenIndex];
    if (
      typeof token !== "object" ||
      token === null ||
      (token as { type?: unknown }).type !== "mention"
    ) {
      return null;
    }
    return { menu, token: token as unknown as MentionToken };
  };

  /** "Remove link": replace the mention with its visible text (custom label if set). */
  const removeLink = () => {
    const hit = currentLinkMenuMention();
    if (hit === null) return;
    const kept = hit.token.displayText ?? hit.token.text;
    applySplice(hit.menu.start, hit.menu.end, [{ type: "text", text: kept }], hit.menu.start + kept.length);
  };

  /** "Delete link": drop the mention token wholesale. */
  const deleteLink = () => {
    const hit = currentLinkMenuMention();
    if (hit === null) return;
    applySplice(hit.menu.start, hit.menu.end, [], hit.menu.start);
  };

  /** "Edit link…": the page-level LinkEditModal retargets the mention / sets a label. */
  const editLink = () => {
    const hit = currentLinkMenuMention();
    if (hit === null) return;
    flush(); // push unflushed typing so the modal writes over the current AST
    setLinkMenu(null);
    openLinkEditor({
      kind: "node",
      blockId: nodeRef.current.id,
      tokenIndex: hit.menu.tokenIndex,
      insertAt: null,
      initialNodeId: hit.token.targetNodeId,
      initialLabel: hit.token.displayText ?? "",
    });
  };

  // --- DOM events ---------------------------------------------------------------

  const handleInput = () => {
    const el = spanRef.current;
    if (el === null) return;
    draftRef.current = el.textContent ?? "";
    dirtyRef.current = true;
    setSelectedAtomKey(null);
    updateCapture(draftRef.current, caretOffset(el));
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      flush();
    }, SAVE_DEBOUNCE_MS);
  };

  /**
   * Ctrl/Cmd+C with no selection: the clipboard gets this block's node link
   * (`<origin>/<uuid>`) and a toast confirms it. A range selection falls
   * through to the browser's default text copy.
   */
  const copyNodeLink = () => {
    const name = captureApi.displayName(nodeRef.current.id) ?? "Untitled";
    copyToClipboard(nodeLinkUrl(nodeRef.current.id)).then(
      () => notificationStore.success("Node link copied", name),
      () => notificationStore.error("Couldn't copy", "Clipboard access was denied."),
    );
  };

  /**
   * Paste: a clipboard holding a node link (`<origin>/<uuid>` or a bare
   * uuid) that resolves in the local graph becomes a mention token spliced
   * at the caret/selection instead of the raw text. Anything else keeps
   * the contentEditable default (plain text through the normal draft
   * flow); an unresolvable id pastes as raw text too. (Paste events carry
   * no modifier state, so even Ctrl/Cmd+Shift+V takes this path — a bare
   * uuid as plain text is never the useful outcome.)
   */
  const handlePaste = (event: ClipboardEvent<HTMLSpanElement>) => {
    if (event.clipboardData === null) return;
    const targetId = parseNodeLink(event.clipboardData.getData("text/plain"));
    if (targetId === null) return;
    const name = captureApi.displayName(targetId);
    if (name === null) return; // unknown node: default paste of the raw text
    const el = spanRef.current;
    if (el === null) return;
    event.preventDefault();
    const range = selectionOffsets(el) ?? {
      start: draftRef.current.length,
      end: draftRef.current.length,
    };
    applySplice(
      range.start,
      range.end,
      [{ type: "mention", targetNodeId: targetId, text: name, linkId: uuidv7() }],
      range.start + name.length,
    );
    notificationStore.success("Node link pasted", name);
    el.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    // Slash popup keys (the editor keeps the caret; the popup is visual).
    // The @/#/+ node pickers own their keyboard handling inside the popup's
    // search input — nothing to intercept here while one of those is open.
    if (capture !== null && capture.kind === "slash") {
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
    // §34.19: Alt+Shift+↑/↓ reorders the block among its siblings without
    // dragging (the v1 MOVE_UP/MOVE_DOWN chords). The caret stays in the
    // editor; the write is one object.move per press.
    if (event.altKey && event.shiftKey && !mod && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      const id = nodeRef.current.id;
      const position = positions.get(id);
      if (position === undefined) return;
      const parentId = position.parentId ?? rootId;
      const siblings = client.getChildren(parentId);
      const index = siblings.findIndex((sibling) => sibling.id === id);
      if (index < 0) return;
      if (event.key === "ArrowUp") {
        if (index === 0) return; // already first
        void client.moveObject(id, parentId, undefined, siblings[index - 1]!.id).catch((error: unknown) => {
          console.warn(`[outliner] move up (${id}) failed:`, error);
        });
      } else {
        if (index >= siblings.length - 1) return; // already last
        void client.moveObject(id, parentId, siblings[index + 1]!.id).catch((error: unknown) => {
          console.warn(`[outliner] move down (${id}) failed:`, error);
        });
      }
      return;
    }
    // Atomic pill gestures — a selected pill (or a caret adjacent to one)
    // owns Backspace/Delete/arrows before any other branch (v1 parity: the
    // pill is one logical unit). The caret never sits inside a pill, so
    // "adjacent" means: Backspace with the caret at a pill's end, Delete at
    // a pill's start, arrows onto either boundary.
    if (!event.nativeEvent.isComposing) {
      const selected = currentAtom();
      if (selected !== null) {
        const key = event.key;
        if (key === "Backspace" || key === "Delete") {
          event.preventDefault();
          deleteAtom(selected);
          return;
        }
        if (key === "Enter" && !event.shiftKey && !mod) {
          event.preventDefault();
          setSelectedAtomKey(null);
          openNode(selected.targetNodeId);
          return;
        }
        if (key === "ArrowRight") {
          event.preventDefault();
          setSelectedAtomKey(null);
          const el = spanRef.current;
          if (el !== null) placeCaret(el, selected.end);
          return;
        }
        if (key === "ArrowLeft") {
          event.preventDefault();
          setSelectedAtomKey(null);
          const el = spanRef.current;
          if (el !== null) placeCaret(el, selected.start);
          return;
        }
        if (key === "Escape") {
          setSelectedAtomKey(null);
          return;
        }
        // Any other key clears the visual selection; editing continues at
        // the caret (arrows included — a word-jump must not keep the flash).
        if (key.startsWith("Arrow") || !mod) setSelectedAtomKey(null);
      } else if (!mod) {
        const el = spanRef.current;
        const caret = el === null ? null : caretOffset(el);
        if (el !== null && caret !== null) {
          const base = applyTextEdit(nodeRef.current.contentAst, draftRef.current);
          const atoms = editableAtoms(base);
          if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
            const hit =
              event.key === "ArrowRight"
                ? atoms.find((a) => a.start === caret)
                : atoms.find((a) => a.end === caret);
            if (hit !== undefined) {
              event.preventDefault();
              setSelectedAtomKey(atomKey(hit));
              return;
            }
          } else if (event.key === "Backspace" || event.key === "Delete") {
            const hit =
              event.key === "Backspace"
                ? atoms.find((a) => a.end === caret)
                : atoms.find((a) => a.start === caret);
            if (hit !== undefined) {
              event.preventDefault();
              deleteAtom(hit);
              return;
            }
          }
        }
      }
    }
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
      if (key === "c" && !event.shiftKey) {
        const el = spanRef.current;
        const range = el === null ? null : selectionOffsets(el);
        if (range === null || range.start === range.end) {
          event.preventDefault();
          copyNodeLink();
          return;
        }
      }
    }
    // `@` over a selection: the browser default would delete the selected
    // text and insert the sigil — instead the node picker opens with the
    // selected text as its search query, and the pick replaces the selection
    // with the mention (Ctrl/Cmd+Enter keeps the text as a custom label).
    // Same word-boundary rule as the collapsed-caret trigger; without it the
    // default runs unchanged.
    if (event.key === "@" && !mod && !event.altKey) {
      const el = spanRef.current;
      const range = el === null ? null : selectionOffsets(el);
      if (range !== null && range.start !== range.end) {
        const draft = draftRef.current;
        const boundary = range.start === 0 || /\s/.test(draft[range.start - 1]!);
        if (boundary) {
          event.preventDefault();
          const selectedText = draft
            .slice(range.start, range.end)
            .replace(/\s+/g, " ")
            .trim();
          const anchor = caretLineAnchor();
          setSelectedAtomKey(null);
          setCapture({
            kind: "mention",
            start: range.start,
            query: selectedText,
            index: 0,
            replaceEnd: range.end,
            anchor: { top: anchor.top, left: anchor.left },
          });
        }
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
      const el = spanRef.current;
      const caret = el === null ? null : caretOffset(el);
      const draft = draftRef.current;
      const parentId = nodeRef.current.parentId;
      const currentId = nodeRef.current.id;
      const base = applyTextEdit(nodeRef.current.contentAst, draft);
      // Text-property carriers (§34.80): multi Enter registers the new
      // sibling as the next VALUE; single Enter nests the new block as a
      // CHILD of the carrier (the value's lines). Ordinary blocks: the
      // default outliner semantics below.
      const carrier = carrierEnter?.carrierOf(currentId) ?? null;
      const singleCarrier = carrier !== null && !carrier.multi;
      const firstChildId = singleCarrier ? client.getChildren(currentId)[0]?.id : undefined;
      const childAnchor = firstChildId !== undefined ? { beforeId: firstChildId } : {};
      if (caret !== null && caret > 0 && caret < draft.length) {
        // MID-TEXT: split at the caret. The head stays in this block; the
        // tail moves to a new block right after (v1 splitBlock) — a SIBLING
        // normally, a CHILD of a single-value carrier. The head write
        // supersedes the debounced flush — clear it so the unmount flush
        // can't overwrite the split.
        if (timerRef.current !== null) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        dirtyRef.current = false;
        const head = spliceTokens(base, caret, draft.length, []);
        const tail = spliceTokens(base, 0, caret, []);
        void client.updateObject(currentId, { contentAst: withCandidateSpans(head) });
        void client
          .createObject({
            parentId: singleCarrier ? currentId : parentId,
            contentAst: withCandidateSpans(tail),
            ...(singleCarrier ? childAnchor : parentId !== null ? { afterId: currentId } : {}),
          })
          .then((id) => {
            if (carrier?.multi === true) registerCarrierValue(client, carrier, id);
            requestFocus(id, "start");
          });
        return;
      }
      if (caret === 0 && draft.length > 0) {
        // START: a new empty block BEFORE this one (W1 beforeId) — or a
        // first CHILD for a single-value carrier.
        void client
          .createObject({
            parentId: singleCarrier ? currentId : parentId,
            contentAst: [],
            ...(singleCarrier ? childAnchor : parentId !== null ? { beforeId: currentId } : {}),
          })
          .then((id) => {
            if (carrier?.multi === true) registerCarrierValue(client, carrier, id);
            requestFocus(id, "start");
          });
        return;
      }
      // END / EMPTY: a sibling after this block — but a block WITH CHILDREN
      // takes the new block as its FIRST child instead (v1/Roam); a
      // single-value carrier ALWAYS takes the child branch (its value is
      // one block — Enter adds a line, never a sibling value).
      const children = client.getChildren(currentId);
      if (singleCarrier || children.length > 0) {
        const firstChild = children[0]?.id;
        void client
          .createObject({
            parentId: currentId,
            contentAst: [],
            ...(singleCarrier && firstChildId !== undefined
              ? { beforeId: firstChildId }
              : firstChild !== undefined
                ? { beforeId: firstChild }
                : {}),
          })
          .then((id) => {
            if (carrier?.multi === true) registerCarrierValue(client, carrier, id);
            requestFocus(id, "start");
          });
        return;
      }
      void client
        .createObject({
          parentId,
          contentAst: [],
          ...(parentId !== null ? { afterId: currentId } : {}),
        })
        .then((id) => {
          if (carrier?.multi === true) registerCarrierValue(client, carrier, id);
          requestFocus(id, "start");
        });
      return;
    }
    if (event.key === "Backspace") {
      const el = spanRef.current;
      const text = el?.textContent ?? "";
      const caret = el === null ? null : caretOffset(el);
      const id = nodeRef.current.id;
      if (text !== "") {
        if (caret === 0) {
          // START OF TEXT (v1): merge this block into the previous one when
          // the guard allows (same-parent childless, or an only-child into
          // its parent); otherwise the key does nothing.
          event.preventDefault();
          mergeIntoPrevious(id);
        }
        return; // ordinary in-text deletion
      }
      event.preventDefault();
      const children = client.getChildren(id);
      if (children.length > 0) {
        // EMPTY WITH CHILDREN (owner decision): promote the children into
        // the block's place, then delete the block.
        const parentId = nodeRef.current.parentId;
        if (parentId === null) return; // page-level edge
        children.forEach((child, index) => {
          void client.moveObject(
            child.id,
            parentId,
            index === 0 ? id : children[index - 1]!.id,
          );
        });
        const position = positions.get(id);
        const caretTarget = position?.previousSiblingId ?? parentId;
        void client.deleteObject(id);
        requestFocus(caretTarget, "end");
        return;
      }
      flush(); // clears the block when the draft was just emptied
      const position = positions.get(id);
      const caretTarget = position?.previousSiblingId ?? position?.parentId;
      if (caretTarget !== undefined && caretTarget !== null) {
        requestFocus(caretTarget, "end");
      }
      void client.deleteObject(id);
      return;
    }
    if (event.key === "Delete") {
      const el = spanRef.current;
      const caret = el === null ? null : caretOffset(el);
      if (caret === null || caret !== draftRef.current.length) return; // mid-text: browser default
      event.preventDefault();
      mergeNextInto(nodeRef.current.id);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const id = nodeRef.current.id;
      const position = positions.get(id);
      if (!event.shiftKey) {
        // Indent: under the previous sibling (append as its last child).
        const target = position?.previousSiblingId;
        if (target === undefined || target === null) return; // page-level edge
        void client.moveObject(id, target).catch((error: unknown) => {
          console.warn(`[outliner] indent (${id} → ${target}) failed:`, error);
        });
        return;
      }
      // Outdent: to the grandparent, placed right after the current parent.
      // treeEditMode device setting: "logical" (default) additionally moves
      // the block's subsequent siblings under it (v1 category grouping);
      // "direct" moves only the block.
      const parentId = position?.parentId;
      const grandParentId = position?.grandParentId;
      if (parentId === undefined || parentId === null) return; // page-level edge
      if (grandParentId === undefined || grandParentId === null) return;
      const mode = readDeviceSetting<"direct" | "logical">("treeEditMode", "logical");
      if (mode === "direct") {
        void client.moveObject(id, grandParentId, parentId).catch((error: unknown) => {
          console.warn(`[outliner] outdent (${id} → ${grandParentId}) failed:`, error);
        });
        return;
      }
      const siblings = client.getChildren(parentId);
      const index = siblings.findIndex((sibling) => sibling.id === id);
      const followers = siblings.slice(index + 1);
      void client
        .moveObject(id, grandParentId, parentId)
        .then(() => {
          let after: string | undefined;
          followers.forEach((follower) => {
            void client.moveObject(follower.id, id, after);
            after = follower.id;
          });
        })
        .catch((error: unknown) => {
          console.warn(`[outliner] logical outdent (${id} → ${grandParentId}) failed:`, error);
        });
    }
  };

  const codeToken = codeTokenOf(node.contentAst);

  return (
    <span ref={rootRef} className="nt-editor-root">
      {codeToken !== null ? (
        <CodeBlockEditor node={node} client={client} onExit={onExitEdit} />
      ) : (
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
        onPaste={handlePaste}
        onMouseDown={handleMouseDown}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        onBlur={(event) => {
          flush();
          // Focus moved into a surface that belongs to the edit session
          // (the verb popover, rendered inside the root, or a portaled
          // editor companion such as the link edit modal) — stay in edit
          // mode; anything else ends the session (and closes the popups).
          const nextTarget = event.relatedTarget as Node | null;
          if (nextTarget !== null) {
            if (rootRef.current !== null && rootRef.current.contains(nextTarget)) return;
            if (
              nextTarget instanceof Element &&
              nextTarget.closest("[data-editor-companion]") !== null
            ) {
              return;
            }
          }
          setCapture(null);
          setVerb(null);
          setSelectedAtomKey(null);
          onExitEdit();
        }}
      />
      )}
      {codeToken === null && (
      <FloatingToolbar
        rootRef={rootRef}
        activeMarks={new Set(activeMarks)}
        onToggleMark={toggleMark}
        onVerb={openVerb}
      />
      )}
      {capture !== null &&
        (capture.kind === "slash" ? (
          <TriggerPopup
            position={caretLineAnchor()}
            query={capture.query}
            selectedIndex={Math.min(capture.index, Math.max(captureItems.length - 1, 0))}
            onHighlightChange={(index) =>
              setCapture((current) =>
                current !== null && current.kind === "slash" ? { ...current, index } : current,
              )
            }
            onSelectCommand={(commandId) => {
              const state = capture;
              const el = spanRef.current;
              setCapture(null);
              if (state === null || el === null) return;
              const caret = caretOffset(el);
              if (caret === null) return;
              runSlashCommand(commandId, state.start, caret, state.query);
            }}
            onClose={() => setCapture(null)}
          />
        ) : (
          <NodeSelector
            client={client}
            anchorRect={capture.anchor ?? null}
            searchMode={capture.kind === "mention" ? "all" : capture.kind === "tag" ? "pages" : "classes"}
            scopeTabs={capture.kind === "mention"}
            excludeNodeId={nodeRef.current.id}
            initialSearchQuery={capture.kind === "mention" ? capture.query : ""}
            searchPlaceholder={
              capture.kind === "mention"
                ? "Search pages and blocks…"
                : capture.kind === "tag"
                  ? "Search pages…"
                  : "Search classes…"
            }
            onClose={closeNodePicker}
            onAdd={commitNodePick}
            multiSelect={capture.kind !== "mention"}
            onApplyMulti={capture.kind !== "mention" ? commitNodePicks : undefined}
          />
        ))}
      {templateStage !== null && (
        <TemplateListPopup
          position={caretLineAnchor()}
          client={client}
          ensure={() => ensureTemplateFamily?.() ?? Promise.resolve()}
          initialQuery={templateStage.filter}
          onPick={(templateId) => {
            closeStagePopup();
            templateInstantiator.begin(templateId);
          }}
          onClose={() => {
            const stage = templateStageRef.current;
            clearStage();
            const el = spanRef.current;
            if (el !== null) {
              el.focus();
              placeCaret(el, stage?.start ?? 0);
            }
          }}
        />
      )}
      {templateInstantiator.dialog}
      {linkMenu !== null && (
        <NodeLinkContextMenu
          state={linkMenu}
          client={client}
          onClose={() => setLinkMenu(null)}
          onOpen={(id) => {
            setLinkMenu(null);
            openNode(id);
          }}
          onOpenInSidebar={(id) => {
            setLinkMenu(null);
            openInSidebar(id);
          }}
          onEdit={editLink}
          onRemove={removeLink}
          onDelete={deleteLink}
        />
      )}
      {verb !== null && (
        <VerbPopover
          top={verb.top}
          left={verb.left}
          schemas={client.listPropertySchemas()}
          onBind={(schemaId, verbStr, locator) => {
            setVerb(null);
            writeVerbMark(verb.start, verb.end, { propertySchemaId: schemaId }, locator);
          }}
          onCreateAndBind={createAndBindVerb}
          onSubmit={commitVerb}
          onCancel={cancelVerb}
        />
      )}
    </span>
  );
}
