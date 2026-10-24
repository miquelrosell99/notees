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
 *   at the trigger; the create row links a new page named by the query (the
 *   create completes asynchronously — the picker may close while it runs;
 *   the completion splices the mention from the capture snapshot taken when
 *   the popup was open, so the mention still lands at the trigger); the
 *   typed-date row links the journal chain page ("Link to … page" /
 *   "Create … page"). Esc/click-outside keeps the trigger char as plain text
 *   and hands focus back to the block.
 * - `@` over a selection: the browser default (delete the selection, insert
 *   the sigil) is intercepted at a trigger boundary; the picker opens with the
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
 *   Already-assigned classes ride the checkmark (hidden from the empty-query
 *   browse, resurfacing under a matching query): a plain pick REMOVES the
 *   class (the toggle — AND dissolves every inline class_link to it into
 *   plain text, the removal-dissolution ruling) and a Ctrl/Cmd pick
 *   SPLICES THE INLINE CLASS LINK — the `+` drops, a class_link token takes
 *   its place. The MEMBERSHIP is untouched by the convert: the classes
 *   pills are a derived view that hides inline-referenced classes (the
 *   link IS the marker), so no unassign is needed to keep one visible
 *   reference.
 * - `/`  slash commands: the ported TriggerPopup (inline mode) over the
 *   block-type actions the content grammar executes — Text (strip the
 *   trigger), Quote (wrap the block's inline tokens in a quote token),
 *   Task/checkbox (assign the task class, OR-set add), Line break (insert a
 *   hard_break token), Add URL (write a plain text token carrying markdown
 *   [href](href) at the trigger offset — the LinkEditModal is node-only; a
 *   URL-looking query becomes linked prose, anything else falls back to plain
 *   prose and markdown [label](url) pasting remains the label-carrying path),
 *   Query (insert a query token at the caret and open its builder
 *   popover on exit), Date (typed date → mention of the daily
 *   page, chain ensured on demand; a bare /date or an unparseable
 *   remainder opens the calendar popup at the caret and the picked
 *   day links on commit), Template (flat unfiltered
 *   template list — the pick instantiates a fresh page through the clone
 *   engine and links it at the caret). No match + Enter falls back to plain
 *   prose (the query text stays).
 * - Verb on selection: FloatingToolbar → link button / Cmd+K opens the
 *   VerbPopover (free-string verb + optional locator); commit wraps the
 *   covered prose in a typed_link mark via spliceTokens. Schema-at-
 *   capture: the popover live-matches the verb against the
 *   workspace's property schemas — an exact name hit binds the mark to the
 *   existing schema (`verb: { propertySchemaId }`), a miss offers "Create
 *   property '…' and bind" (propertySchema.create typed object/multi, empty
 *   targetClassFilter). Right-clicking an existing typed-link word opens the
 *   LinkEditModal's verb field (same create-and-bind row).
 * All capture commits build on the current draft through applyTextEdit (so
 * unflushed typing is preserved), splice tokens through spliceTokens, then
 * write the result directly with client.updateObject and re-sync the DOM.
 *
 * Keyboard contract (docs/features/outliner.md):
 * - Enter mid-text → split at the caret: head stays, tail moves to a new
 *                  block right after — a SIBLING normally, the FIRST CHILD
 *                  when this block has children (the Roam rule: the children
 *                  stay with the head). A range selection is cut first; the
 *                  split lands at its start.
 * - Enter at start → new empty block BEFORE this one (object.create with
 *                  beforeId — the W1 wire extension).
 * - Enter at end/empty → sibling after; a block WITH CHILDREN takes the new
 *                  block as its FIRST child instead (beforeId against the
 *                  current first child).
 * - Shift+Enter  → allow the contentEditable newline; the flush stores it as
 *                  `hard_break` tokens (the only break token in the grammar).
 * - Backspace at start of text → merge into the previous block (previous
 *                  sibling, or the parent when an only child) past the
 *                  guard (same-parent childless / only-child-into-parent);
 *                  otherwise a no-op.
 * - Backspace on an empty block with children → promote the children into
 *                  the block's place, then delete it; empty without children
 *                  → delete the block and hand the caret to the previous
 *                  sibling (or the parent).
 * - Delete at end → merge a childless next sibling into this block; with NO
 *                  next sibling, an ONLY CHILD merges into this block (its
 *                  children move up into its place). Otherwise a no-op.
 * - Tab          → indent under the previous sibling (object.move, appended as
 *                  its last child). The caret hands back to the same block at
 *                  the same offset — the reparent remounts the row, so the
 *                  edit session is re-requested explicitly; indenting never
 *                  leaves edit mode.
 * - Shift+Tab    → outdent to the grandparent, placed right after the current
 *                  parent. The `treeEditMode` device setting (Settings →
 *                  Editor, default "logical") additionally drags subsequent
 *                  siblings under the outdented block; "direct" moves only it.
 *                  The caret hands back the same way Tab's does.
 * - ↑ / ↓        → move within the text by line (the browser default); on the
 *                  FIRST/LAST visual line the edit session hands to the
 *                  block above/below in VISIBLE document order (folded
 *                  subtrees contribute no rows). ↑ on the first top-level
 *                  block hands the caret to the page title; ↓ on the title
 *                  enters the first block.
 * - → at the end / ← at the start → the edit session hands to the next /
 *                  previous visible block (caret at the start / end). On the
 *                  title, → at the end enters the first block; ← at its
 *                  start is a no-op.
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
 *                  replacing the selection like the default paste; multi-
 *                  line plain text splits into sibling blocks at the caret
 *                  (the first pasted line joins the head, the last absorbs
 *                  the tail); any other text keeps the default plain-text
 *                  paste.
 * - `@` over a selection → open the node picker with the selected text as
 *                  the query; the pick replaces the selection with the link
 *                  (Ctrl/Cmd+Enter keeps the text as the label); Esc restores
 *                  the selection.
 * - Right-click a node link → Open / Open in sidebar / Edit link… /
 *                  Remove link (keeps the text) / Delete link.
 *
 * variant="title" (the page header's title row) relaxes the structural
 * contract where it would damage the page itself — the title IS the page
 * node's content, so nothing may split it or create/delete nodes from it:
 * - Enter (plain) → flush the draft and leave edit mode; never splits,
 *                  never creates a sibling or child block.
 * - Backspace/Delete → ordinary in-text deletion only; the merge/delete-
 *                  block gestures are suppressed (an empty title stays an
 *                  empty page, and the page is never deleted by a key).
 * - Ctrl/Cmd+Enter → no task cycle on the page node.
 * Everything else (marks, @ / # / + captures, slash commands, the link
 * modal, Ctrl/Cmd+C node-link copy, atomic-pill gestures) is unchanged.
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
import { chainNodeIds, deriveDisplayName, parseDateNodeId, rendersAsInlineBlock, SYSTEM_CLASS_UUIDS } from "@notees/domain";
import { uuidv7 } from "uuidv7";

import { parentlessBlockResolverOf } from "../../ui/renderStateLabel.js";
import { focusAtPoint, focusWithCaret, type CaretPlacement } from "@/editor/caret.js";
import {
  caretClientRect,
  caretOffset,
  placeCaret,
  proseOffsetFromPoint,
  proseOffsetRect,
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
import { astFromProse, proseFromAst, proseSpans } from "@/editor/prose.js";
import { caretLineAnchor, selectionAnchor } from "./anchors.js";
import { codeTokenOf, CodeBlockEditor } from "./codeBlock.js";
import {
  MENTION_LABEL_MAX,
  QUOTE_CHILD_TYPES,
  STARTER_QUERY_AST,
  isTriggerBoundary,
  toIsoDate,
  TRIGGER_CHAR,
  truncatePickerHint,
  type CaptureKind,
  type CaptureState,
  type LinkMenuState,
  type MentionToken,
  type SlashCandidate,
  type TemplateStageState,
} from "./captureModel.js";
import { applyTextEdit, spliceTokens } from "@/editor/edit-apply.js";
import { applyMarkToRange, marksOnRange, removeMarkFromRange } from "@/editor/marks.js";
import { withCandidateSpans } from "@/editor/capture.js";
import { dissolveClassLinksInAst } from "../metadata/classRemoval.js";
import type { ClientNode } from "@/core/workspace-client/index.js";

import { VerbPopover } from "../../ui/VerbPopover.js";
import { useOutliner } from "../../ui/outliner-context.js";
import { nodeLinkUrl, parseNodeLink } from "../../ui/nodeLink.js";
import { fullTitleFromClient } from "../../ui/dateDisplay.js";
import { CarrierEnterContext, registerCarrierValue } from "../../ui/textCarrier.js";
import { copyToClipboard } from "../modals/clipboard.js";
import { readDeviceSetting } from "../settings/deviceSettings.js";
import { notificationStore } from "../../components/ui/fleet/notificationStore.js";
import { FloatingToolbar } from "../../ui/editor-popups/FloatingToolbar.js";
import { TriggerPopup, SLASH_COMMANDS, bumpSlashCommandUsage, readSlashCommandUsage } from "../../ui/editor-popups/TriggerPopup.js";
import { NodeSelector, type NodePickContext } from "../pickers/NodeSelector.js";
import { parseDate } from "../date-pickers/dateParser.js";
import { DatePickerPopup } from "../date-pickers/DatePickerPopup.js";
import { NodeLinkContextMenu } from "../node-menu/NodeLinkContextMenu.js";
import { useLinkEditModalOpener } from "../../ui/editor-popups/LinkEditModal.js";
import { requestQueryBuilderOpen } from "../../ui/QueryBlockView.js";
import { requestPropertyCreate } from "../metadata/PropertyCreateHost.js";
import { TemplateListPopup } from "../../ui/templates/TemplateListPopup.js";
import { useTemplateInstantiator } from "../../ui/templates/useTemplateInstantiator.js";
import { ensureTableFamily } from "../classview/tableFamily.js";
import { cycleTaskState } from "../classview/taskCycle.js";
import { createTable, DEFAULT_TABLE_COLUMNS, parseTableColumnCount } from "../classview/tableGrid.js";

export const SAVE_DEBOUNCE_MS = 400;

/** How the caret should land when the editor mounts. */
export type EditorCaret = CaretPlacement | { x: number; y: number };



interface BlockTextEditorProps {
  node: ClientNode;
  caret: EditorCaret;
  onExitEdit: () => void;
  /**
   * "title" — the page header's title row (BlockRow variant="title"): the
   * structural Enter/Backspace/Delete gestures are suppressed so the page
   * node itself can never be split, reparented, or deleted from its title;
   * plain Enter flushes and leaves edit mode. Default "block" = the full
   * outliner contract.
   */
  variant?: "block" | "title" | undefined;
}


export function BlockTextEditor({ node, caret, onExitEdit, variant = "block" }: BlockTextEditorProps) {
  const {
    client,
    rootId,
    positions,
    requestFocus,
    nextBlockId,
    previousBlockId,
    firstBlockId,
    capture: captureApi,
    openNode,
    openInSidebar,
    ensureTemplateFamily,
  } = useOutliner();
  /** Text-property carrier semantics — provided by the property
   *  cell hosting this block as a carrier; null in the ordinary outline.
   *  Mention-open gestures (pill double-click, Enter on a selected pill, the
   *  link context menu's Open) ride the context's `openNode` — the host
   *  funnel (the App openPage seam) resolves node aliases to their terminal. */
  const carrierEnter = useContext(CarrierEnterContext);
  const rootRef = useRef<HTMLSpanElement>(null);
  const spanRef = useRef<HTMLSpanElement>(null);
  const nodeRef = useRef(node);
  nodeRef.current = node;
  // Class chip labels ride the editor's prose projection and the editable
  // DOM (the pill renders the label, so el.textContent === proseFromAst) —
  // the label is the class's CURRENT display name, re-resolved at every
  // build. The wire token stores no text: nothing here writes a captured
  // label back to the log.
  const resolveClassName = useCallback(
    (classId: string): string => captureApi.displayName(classId) ?? "",
    [captureApi],
  );
  // Mention pill labels ride the SAME re-resolution ruling as read mode
  // (BlockRow's InlineTokens): the label is the target's CURRENT FULL
  // TITLE — read mode's uncapped funnel (fullTitleFromClient), never the
  // capped displayName —, so a stale import-era captured text (nested-link
  // UUIDs baked in) never surfaces in edit mode. Null for a broken target:
  // the editor layer then falls back to the captured text, else the raw id
  // (read-mode parity: a dead link shows its id, never silent retargeting).
  // Re-resolved at every build, exactly like the chip labels above; the
  // prose projection, the DOM build, and the atom list all thread THIS
  // resolver, so a label's length is consistent across all three (the
  // single coordinate system — a mismatch would splice at wrong offsets).
  const resolveMentionName = useCallback(
    (targetId: string): string | null => fullTitleFromClient(client, targetId),
    [client],
  );
  // The chip atom's wavy underline tint: the class's effective color — the
  // read-mode nt-link--class look (owner 2026-10-13).
  const resolveClassColor = useCallback(
    (classId: string): string | null => client.effectiveClassColor(classId),
    [client],
  );
  // The divergence ruling (owner 2026-10-15), edit-mode parity: a class_link
  // whose class is NOT assigned to the edited node renders the dashed
  // pending underline (read mode: dashed + click-to-assign).
  const resolveClassAssigned = useCallback(
    (classId: string): boolean => nodeRef.current.classIds.includes(classId),
    [],
  );
  const draftRef = useRef(proseFromAst(node.contentAst, resolveClassName, resolveMentionName));
  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Range captured by the first "*" of the `**`-over-selection shortcut. */
  const starRef = useRef<{ start: number; end: number } | null>(null);
  const [activeMarks, setActiveMarks] = useState<readonly Mark[]>([]);
  const [capture, setCapture] = useState<CaptureState | null>(null);
  /**
   * The node-picker capture as it stood when the popup was last open, kept
   * PAST the popup's close: choosing the picker's create row starts an
   * ASYNC create (the promise-based default create, or the class-aware
   * QuickCreateModal), and the created node can arrive after the capture
   * already went null (Escape / outside press / blur while the create is
   * in flight). commitNodePick then completes the mention from this
   * snapshot instead of the dead live state. (The /template flow's
   * templateStageRef is the same idiom; only non-null captures refresh it,
   * so the snapshot survives the close re-render.)
   */
  const captureSnapshotRef = useRef<CaptureState | null>(null);
  if (capture !== null) captureSnapshotRef.current = capture;
  const [verb, setVerb] = useState<{ start: number; end: number; top: number; left: number } | null>(
    null,
  );
  /**
   * The slash /date calendar pick (null = closed): the draft offset where
   * the trigger text sat (the mention inserts there) + the caret's viewport
   * anchor for the popup. Opens for a BARE /date or an unparseable
   * remainder — a parseable typed date links directly without the popup.
   */
  const [datePick, setDatePick] = useState<{ insertAt: number; anchor: { top: number; left: number } } | null>(null);
  const dateAnchorRef = useRef<HTMLElement | null>(null);
  /** Set when the popup committed a pick — Escape/outside close refocuses the block instead of clobbering the landed caret. */
  const datePickCommittedRef = useRef(false);
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
   * Shared create-with-template flow: family self-heal through
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
    if (draft === proseFromAst(current, resolveClassName, resolveMentionName)) return;
    // Structural apply (untouched runs keep marks/identity) + fresh
    // candidateSpans on every typed_link mark (record-don't-resolve).
    const next = withCandidateSpans(applyTextEdit(current, draft, resolveClassName, resolveMentionName));
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    void client.updateObject(nodeRef.current.id, { contentAst: next });
  }, [client, resolveClassName, resolveMentionName]);

  // --- atomic pills (node links render as single units) -----------------------

  /** The pill selected by click/arrow, validated against the freshest draft. */
  const currentAtom = (): EditableAtom | null => {
    if (selectedAtomKey === null) return null;
    const base = applyTextEdit(nodeRef.current.contentAst, draftRef.current, resolveClassName, resolveMentionName);
    return atomFromKey(editableAtoms(base, resolveClassName, resolveMentionName), selectedAtomKey);
  };

  /** Delete a pill's token wholesale (Backspace/Delete, selected or adjacent). */
  const deleteAtom = (atom: EditableAtom) => {
    setSelectedAtomKey(null);
    applySplice(atom.start, atom.end, [], atom.start);
  };

  /**
   * Backspace-at-start: merge this block's content into the
   * previous block — the previous SIBLING, or the parent when this block is
   * an only child — but only past the guard (same-parent childless, or an
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
      (parent !== undefined && rendersAsInlineBlock(parent, undefined, parentlessBlockResolverOf(client))
        ? parent.id
        : null);
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
    const sourceText = applyTextEdit(node.contentAst, draftRef.current, resolveClassName, resolveMentionName);
    const caretAt = proseFromAst(target.contentAst, resolveClassName, resolveMentionName).length;
    // Splice at the target's end so adjacent text runs coalesce.
    const merged = withCandidateSpans(
      spliceTokens(target.contentAst, caretAt, caretAt, sourceText, resolveClassName, resolveMentionName),
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
   * Delete-at-end: merge the NEXT SIBLING's content into this
   * block when the guard allows (same parent — by construction — and the
   * next block is childless). With NO next sibling, an ONLY CHILD merges
   * INTO this block instead: its content splices at the end, its children
   * move up into its place, and it is deleted. The caret stays at the merge
   * point.
   */
  const mergeNextInto = (blockId: string) => {
    const node = client.getNode(blockId);
    if (node === undefined) return;
    const siblings = node.parentId === null ? [] : client.getChildren(node.parentId);
    const index = siblings.findIndex((sibling) => sibling.id === blockId);
    const next = index >= 0 ? siblings[index + 1] : undefined;
    if (next === undefined) {
      const children = client.getChildren(blockId);
      if (children.length !== 1) return;
      const child = children[0]!;
      const base = applyTextEdit(node.contentAst, draftRef.current, resolveClassName, resolveMentionName);
      const caretAt = proseFromAst(base, resolveClassName, resolveMentionName).length;
      const merged = withCandidateSpans(
        spliceTokens(base, caretAt, caretAt, child.contentAst, resolveClassName, resolveMentionName),
      );
      const grandChildren = client.getChildren(child.id);
      commitAst(merged, caretAt);
      // The child's children move up into its place before it goes.
      let after: string | undefined;
      grandChildren.forEach((grandChild) => {
        void client.moveObject(grandChild.id, blockId, after);
        after = grandChild.id;
      });
      void client.deleteObject(child.id);
      return;
    }
    if (client.getChildren(next.id).length > 0) return;
    const base = applyTextEdit(node.contentAst, draftRef.current, resolveClassName, resolveMentionName);
    const caretAt = proseFromAst(base, resolveClassName, resolveMentionName).length;
    const merged = withCandidateSpans(spliceTokens(base, caretAt, caretAt, next.contentAst, resolveClassName, resolveMentionName));
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
    setActiveMarks([...marksOnRange(nodeRef.current.contentAst, range.start, range.end, resolveClassName, resolveMentionName)]);
  }, [resolveClassName, resolveMentionName]);

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
      const next = marksOnRange(current, range.start, range.end, resolveClassName, resolveMentionName).has(mark)
        ? removeMarkFromRange(current, range.start, range.end, mark, resolveClassName, resolveMentionName)
        : applyMarkToRange(current, range.start, range.end, mark, resolveClassName, resolveMentionName);
      if (JSON.stringify(next) !== JSON.stringify(current)) {
        void client.updateObject(nodeRef.current.id, { contentAst: next });
      }
      // Reflect the toggle immediately: nodeRef still holds the pre-write
      // AST until the client notification re-renders.
      setActiveMarks([...marksOnRange(next, range.start, range.end, resolveClassName, resolveMentionName)]);
    },
    [client, resolveClassName, resolveMentionName],
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
    buildEditableDom(el, nodeRef.current.contentAst, resolveClassName, resolveClassColor, resolveClassAssigned, resolveMentionName);
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
    if (domSignature !== editableDomSignature(node.contentAst, resolveClassName, resolveMentionName)) {
      buildEditableDom(el, node.contentAst, resolveClassName, resolveClassColor, resolveClassAssigned, resolveMentionName);
    }
  }, [node.contentAst, resolveClassName, resolveClassColor, resolveMentionName]);

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
   * trigger char was just typed at a trigger boundary (see
   * isTriggerBoundary). Slash tracks the query inline (the block is the
   * search field); @/#/+ open the node-picker popup with its own search
   * input, anchored at the caret line captured here.
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
      // Boundary rule: any non-word char (or the start of the text) before
      // the sigil opens the picker; a word char means mid-word typing
      // (isTriggerBoundary — the email `a@b` case stays silent).
      if (!isTriggerBoundary(caret === 1 ? undefined : draft[caret - 2]!)) return null;
      if (ch === "@") {
        const anchor = caretLineAnchor();
        return { kind: "mention", start: caret - 1, query: "", index: 0, anchor: { top: anchor.top, left: anchor.left } };
      }
      if (ch === "#") {
        const anchor = caretLineAnchor();
        return { kind: "tag", start: caret - 1, query: "", index: 0, anchor: { top: anchor.top, left: anchor.left } };
      }
      if (ch === "+") {
        // Date-chain class lock (SCHEMA.md "Datetime"): the class set is
        // fixed — the "+" capture never opens on a date node.
        if (parseDateNodeId(nodeRef.current.id) !== null) return null;
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
  const commitAst = (next: ContentAst, caretAfter: number): Promise<void> => {
    const el = spanRef.current;
    if (el === null) return Promise.resolve();
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const prose = proseFromAst(next, resolveClassName, resolveMentionName);
    buildEditableDom(el, next, resolveClassName, resolveClassColor, resolveClassAssigned, resolveMentionName);
    draftRef.current = prose;
    dirtyRef.current = false;
    setSelectedAtomKey(null);
    placeCaret(el, caretAfter);
    // Returned (not fire-and-forget): callers that write MORE state keyed
    // on this content (the removal toggle's unassign — the applier refuses
    // while the content references the class) must await the local apply.
    return client.updateObject(nodeRef.current.id, { contentAst: next });
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
    const base = applyTextEdit(nodeRef.current.contentAst, draftRef.current, resolveClassName, resolveMentionName);
    commitAst(withCandidateSpans(spliceTokens(base, start, end, tokens, resolveClassName, resolveMentionName)), caretAfter);
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
      const base = applyTextEdit(nodeRef.current.contentAst, draft, resolveClassName, resolveMentionName);
      const stripped = spliceTokens(base, start, end, [], resolveClassName, resolveMentionName);
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
      // Title-is-content: the name lives in the class's content — the
      // convenience `name` column is null on class nodes, so the probe
      // compares the derived display name (same rule as taskCycle).
      // Date-chain class lock (SCHEMA.md "Datetime"): the token applies but
      // a date node's class set is fixed — no task assignment.
      if (parseDateNodeId(nodeRef.current.id) !== null) return;
      const taskClassId =
        captureApi
          .listClasses()
          .find((cls) => deriveDisplayName(cls) === "task")?.id ?? SYSTEM_CLASS_UUIDS.task;
      void client.assignClass(nodeRef.current.id, taskClassId).catch((error: unknown) => {
        console.warn(`[capture] assignClass (${taskClassId}) failed:`, error);
      });
      return;
    }
    if (commandId === "url") {
      // Owner ruling: the LinkEditModal is node-only — the URL command writes
      // a plain text token carrying markdown [href](href) at the trigger
      // offset. The external_link token is retired (SCHEMA.md render
      // grammar): links live as markdown spans inside text tokens, parsed at
      // render time — the URL stays ordinary, editable prose that renders
      // linked. (A URL containing ] or ) may not re-parse as a link; it then
      // renders literally — same best-effort contract as imports.)
      const trimmed = query.trim();
      const remainder = /^url(\s+|$)/i.test(trimmed) ? trimmed.replace(/^url(\s+|$)/i, "").trim() : trimmed;
      if (/^https?:\/\/\S+$/i.test(remainder)) {
        applySplice(start, end, [{ type: "text", text: `[${remainder}](${remainder})` }], start + remainder.length + 2);
      } else {
        plainFallback(start);
      }
      return;
    }
    if (commandId === "query") {
      // Insert a live query token at the caret, then hand the
      // token's read-mode view an open-builder request (it mounts when this
      // editor exits — see QueryBlockView's module queue).
      const base = applyTextEdit(nodeRef.current.contentAst, draft, resolveClassName, resolveMentionName);
      const token = { type: "query", queryAst: STARTER_QUERY_AST } as ContentAst[number];
      const next = spliceTokens(base, start, end, [token], resolveClassName, resolveMentionName);
      const tokenIndex = next.findIndex((entry) => entry === token);
      commitAst(withCandidateSpans(next), start);
      requestQueryBuilderOpen(nodeRef.current.id, tokenIndex);
      onExitEdit();
      return;
    }
    if (commandId === "date") {
      // Typed date → link to the daily page (created on demand).
      // A PARSEABLE remainder links directly ("/date feb 14"); a BARE /date
      // or an unparseable remainder opens the calendar popup at the caret —
      // the v1 behavior: the Date entry SHOWS the calendar, and the picked
      // day links on commit.
      const trimmed = query.trim();
      const remainder = /^date(\s+|$)/i.test(trimmed) ? trimmed.replace(/^date(\s+|$)/i, "").trim() : trimmed;
      const parsed = remainder === "" ? null : parseDate(remainder);
      if (parsed === null) {
        applySplice(start, end, [], start);
        datePickCommittedRef.current = false;
        setDatePick({ insertAt: start, anchor: caretLineAnchor() });
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
      // Flat unfiltered template list; the pick
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
      // Display-time rule (owner 2026-10-16): the divider is an ORDINARY
      // block whose content is exactly "---" — BlockRow derives the <hr> at
      // render time (zero wire footprint; the retired inline `hr` token
      // grammar stays parseable for old logs but the menu no longer authors
      // it). The trigger text is stripped from this block, the rule lands
      // as a sibling right after it, and the caret moves into the rule
      // block's editor — the /table focus precedent: editing shows the raw
      // dashes, and anything typed turns the block back into prose.
      applySplice(start, end, [], start);
      const parentId = nodeRef.current.parentId;
      void client
        .createObject({
          parentId,
          contentAst: [{ type: "text", text: "---" }],
          afterId: nodeRef.current.id,
        })
        .then((ruleId) => requestFocus(ruleId, "end"))
        .catch((error: unknown) => {
          console.warn("[capture] /hr failed:", error);
        });
      return;
    }
    if (commandId === "code") {
      // The block becomes a code_block token.
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
      const base = applyTextEdit(nodeRef.current.contentAst, draft, resolveClassName, resolveMentionName);
      const stripped = spliceTokens(base, start, end, [], resolveClassName, resolveMentionName);
      const existing = proseFromAst(stripped, resolveClassName, resolveMentionName).trim();
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
      // A table is a CONTAINER node classed `table` (the class
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
    if (commandId === "property") {
      // Owner ruling 2026-10-20 (S1 + the entry-point ruling): the slash
      // "/property" command opens the pre-creation modal with the typed
      // remainder carried in as the name, this block as the value context
      // (the host initializes the placeholder after the create — the row
      // appears as the panel's "+ Add property" flow). The trigger text is
      // stripped from the block either way.
      const trimmed = query.trim();
      const remainder = /^property(\s+|$)/i.test(trimmed)
        ? trimmed.replace(/^property(\s+|$)/i, "").trim()
        : "";
      applySplice(start, end, [], start);
      requestPropertyCreate({ nodeId: nodeRef.current.id, initialName: remainder });
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
   * a mention token, # assigns the tag, + assigns the class (a Ctrl/Cmd+Enter
   * pick on + assigns AND inserts an inline class_link in the same gesture).
   * A mention opened via Ctrl/Cmd+Shift+L (capture.fixedLabel) labels the link
   * with the original selection; a plain Ctrl/Cmd+Enter mention pick
   * (context.withLabel) keeps the search query as a custom label (displayText)
   * instead of resolving the target's name.
   */
  const commitNodePick = (picked: ClientNode, context?: NodePickContext) => {
    // The pick itself reads the live capture; an async create's completion
    // can arrive after the picker already closed (the capture is null) —
    // splice from the last-open snapshot instead (see captureSnapshotRef).
    const state = capture ?? captureSnapshotRef.current;
    if (state === null || state.kind === "slash") return;
    setCapture(null);
    const el = spanRef.current;
    if (el === null) return;
    const caret = caretOffset(el) ?? state.start + 1;
    const end = state.replaceEnd ?? Math.max(caret, state.start + 1);
    if (state.kind === "mention") {
      // Label precedence: a Ctrl/Cmd+Shift+L popup carries the selection
      // itself as fixedLabel (the search query stays empty); otherwise a
      // Ctrl/Cmd+Enter pick keeps the query as the custom label.
      const customLabel =
        state.fixedLabel !== undefined && state.fixedLabel !== ""
          ? state.fixedLabel.slice(0, MENTION_LABEL_MAX)
          : context !== undefined && context.withLabel
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
    if (state.kind === "class") {
      // Plain pick: assign the class, the trigger drops. A Ctrl/Cmd+Enter
      // pick (context.withLabel) is the DIRECT INLINE INSERTION (owner
      // 2026-10-23): assign the class AND splice a class_link token at the
      // trigger in one gesture — the same end state as the older two-step
      // flow (assign, then ⌃↵ the checkmarked row to convert). Membership
      // stays; the pill row hides inline-referenced classes.
      void client.assignClass(nodeRef.current.id, picked.id).catch((error: unknown) => {
        console.warn(`[capture] assignClass (${picked.id}) failed:`, error);
      });
      if (context !== undefined && context.withLabel) {
        applySplice(
          state.start,
          end,
          [{ type: "class_link", classId: picked.id }],
          state.start + 1,
        );
        el.focus();
        return;
      }
      stripTrigger(state.start, end);
      el.focus();
      return;
    }
  };

  /**
   * Assigned-class pick from the `+` popup (`NodeSelector`'s `onAssignedPick`
   * — the checkmarked rows that resurface under a matching query; the
   * capture snapshot idiom mirrors commitNodePick for async closes). The
   * gesture set (owner 2026-10-15): a PLAIN pick REMOVES the class — the
   * toggle, the row's checkmark reads as its state — AND dissolves every
   * inline class_link to it into plain text (the removal-dissolution
   * ruling: no dangling reference), computed over the post-trigger-strip
   * draft in this one gesture; a Ctrl/Cmd pick SPLICES AN INLINE CLASS
   * LINK at the trigger (the `+` drops, a `class_link` token takes its
   * place). The MEMBERSHIP is untouched by the convert either
   * way — the classes pills are a derived view: a class referenced inline
   * hides its pill automatically (NodePills parses the content), so the
   * link IS the marker; the same class can still wear pill chrome where
   * the content does not reference it.
   */
  const commitAssignedClassPick = (picked: ClientNode, context?: NodePickContext) => {
    const state = capture ?? captureSnapshotRef.current;
    if (state === null || state.kind === "slash") return;
    setCapture(null);
    const el = spanRef.current;
    if (el === null) return;
    const caret = caretOffset(el) ?? state.start + 1;
    const end = state.replaceEnd ?? Math.max(caret, state.start + 1);
    if (context !== undefined && context.withLabel) {
      // Inline class link: no displayText — the link renders the class's
      // current name (re-resolved at every build; the wire stores no text).
      // Membership stays: the pill row hides inline-referenced classes.
      applySplice(
        state.start,
        end,
        [{ type: "class_link", classId: picked.id }],
        state.start + 1,
      );
      el.focus();
      return;
    }
    // The removal ruling (owner 2026-10-15): the class goes away AND every
    // inline class_link to it dissolves into plain text — one gesture, never
    // a dangling reference. Computed over the post-trigger-strip DRAFT
    // (applyTextEdit keeps unflushed typing), so the draft stays the single
    // source of truth.
    const base = spliceTokens(
      applyTextEdit(nodeRef.current.contentAst, draftRef.current, resolveClassName, resolveMentionName),
      state.start,
      end,
      [],
      resolveClassName,
      resolveMentionName,
    );
    const dissolved = dissolveClassLinksInAst(base, picked.id, (id) => resolveClassName(id) || id);
    // The unassign MUST land after the strip's local apply — the applier
    // refuses a class.unassign while the content references the class (the
    // no-divergence law), and the strip is what un-references it.
    void commitAst(withCandidateSpans(dissolved.ast as ContentAst), state.start)
      .then(() => client.unassignClass(nodeRef.current.id, picked.id))
      .catch((error: unknown) => {
        console.warn(`[capture] class removal (${picked.id}) failed:`, error);
      });
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

  /**
   * "@" over a selection (owner 2026-10-06 — the selection toolbar's @
   * button AND the typed sigil share this): the node picker opens with the
   * selected text as its search query; the pick replaces the selection with
   * the mention (Ctrl/Cmd+Enter keeps the text as a custom label). The
   * typed sigil requires the boundary rule (without it the browser
   * default inserts the char); the toolbar button always opens. False when
   * there is no selection to ride.
   *
   * mode "query" (the @ / Ctrl+L contract above) carries the selection as
   * the search query. mode "label" (Ctrl/Cmd+Shift+L, or Shift-/Ctrl-click
   * on the toolbar's @ button — owner 2026-10-22) opens with an EMPTY
   * query — the selection is kept as the inserted link's custom label
   * (fixedLabel), never fed to the search. Both render a faint mode banner
   * (hint) above the picker's search field so the pending write is legible.
   */
  const openMentionFromSelection = (
    requireBoundary: boolean,
    mode: "query" | "label" = "query",
  ): boolean => {
    const el = spanRef.current;
    const range = el === null ? null : selectionOffsets(el);
    if (range === null || range.start === range.end) return false;
    const draft = draftRef.current;
    const boundary = isTriggerBoundary(range.start === 0 ? undefined : draft[range.start - 1]!);
    if (requireBoundary && !boundary) return false;
    const selectedText = draft
      .slice(range.start, range.end)
      .replace(/\s+/g, " ")
      .trim();
    if (mode === "label" && selectedText === "") return false;
    const anchor = caretLineAnchor();
    setSelectedAtomKey(null);
    setCapture({
      kind: "mention",
      start: range.start,
      query: mode === "label" ? "" : selectedText,
      index: 0,
      replaceEnd: range.end,
      ...(mode === "label" ? { fixedLabel: selectedText } : {}),
      hint:
        mode === "label"
          ? `Link with custom label "${truncatePickerHint(selectedText)}"`
          : "Replacing selection with link",
      anchor: { top: anchor.top, left: anchor.left },
    });
    return true;
  };

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
    const base = applyTextEdit(nodeRef.current.contentAst, draftRef.current, resolveClassName, resolveMentionName);
    const covered = proseFromAst(base, resolveClassName, resolveMentionName).slice(start, end);
    if (covered === "") return;
    const metadata: Record<string, unknown> = {};
    if (locator !== "") metadata.locator = locator;
    const token = { type: "typed_link", verb: verbValue, text: covered, metadata };
    const next = withCandidateSpans(spliceTokens(base, start, end, [token], resolveClassName, resolveMentionName));
    const el = spanRef.current;
    commitAst(next, start + covered.length);
    el?.focus();
  };

  /**
   * PG1 create-and-bind, rerouted through the S1 pre-creation modal (owner
   * ruling 2026-10-20: creation opens a modal BEFORE any op is written; the
   * instant object/multi create is retired). The typed verb carries in as
   * the name with object/multi pre-selected; on confirm the new schema id
   * binds the mark (the same writeVerbMark as the bind row). The promise
   * settles on create OR cancel so the popover's pending state clears.
   */
  const createAndBindVerb = (verbStr: string, locator: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const state = verb;
      if (state === null) {
        resolve();
        return;
      }
      requestPropertyCreate({
        initialName: verbStr,
        initialType: "object",
        initialMulti: true,
        onCreated: (schemaId) => {
          try {
            writeVerbMark(state.start, state.end, { propertySchemaId: schemaId }, locator);
            setVerb(null);
            resolve();
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
        onCancel: () => resolve(),
      });
    });

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
   * Pill mouse gestures: the FIRST click selects the pill — the
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
    const base = applyTextEdit(nodeRef.current.contentAst, draftRef.current, resolveClassName, resolveMentionName);
    const atom = atomFromKey(editableAtoms(base, resolveClassName, resolveMentionName), (pill as HTMLElement).dataset.atomKey);
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
    const base = applyTextEdit(nodeRef.current.contentAst, draftRef.current, resolveClassName, resolveMentionName);
    const atoms = editableAtoms(base, resolveClassName, resolveMentionName);
    const pill = (event.target as HTMLElement).closest?.("[data-atom-key]");
    let atom: EditableAtom | null = null;
    if (pill !== null && pill !== undefined && el.contains(pill)) {
      atom = atomFromKey(atoms, (pill as HTMLElement).dataset.atomKey);
    } else {
      const offset = proseOffsetFromPoint(el, event.clientX, event.clientY);
      if (offset === null) return;
      const span = proseSpans(base, resolveClassName, resolveMentionName).find((s) => s.start <= offset && offset < s.end);
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
    // Class chips own no link menu (they reference a class, not a node link):
    // the click-selection stands, the browser menu shows.
    if (atom.kind === "chip") return;
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
    const base = applyTextEdit(nodeRef.current.contentAst, draftRef.current, resolveClassName, resolveMentionName);
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
      initialEmbedded: hit.token.isEmbedded === true,
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
   * at the caret/selection instead of the raw text; an unresolvable id
   * pastes as raw text. Multi-line plain text splits at the caret into
   * sibling blocks — the head keeps the text before the caret plus the
   * first pasted line, each further line becomes its own block, and the
   * last line absorbs the tail after the caret (the caret lands at the
   * start of that tail). Everything else — single-line text, the title
   * row, code blocks, text-property carrier values — keeps the
   * contentEditable default (plain text through the normal draft flow).
   * (Paste events carry no modifier state, so even Ctrl/Cmd+Shift+V takes
   * this path — a bare uuid as plain text is never the useful outcome.)
   */
  const handlePaste = (event: ClipboardEvent<HTMLSpanElement>) => {
    if (event.clipboardData === null) return;
    const text = event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
    const targetId = parseNodeLink(text);
    if (targetId !== null) {
      const name = captureApi.displayName(targetId);
      if (name !== null) {
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
        return;
      }
    }
    if (!text.includes("\n")) return; // single-line: the default plain-text paste
    // Trailing blank lines are copy noise — a paste ending in "\n\n" must
    // not mint trailing empty blocks.
    const lines = text.split("\n");
    while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    if (lines.length < 2) return; // "only\n": one visual line — the default paste
    // Structural no-splits: the title row (it IS the page — the header
    // contract never creates nodes from it), code blocks, and text-property
    // carrier values (their Enter semantics are value-local; a paste there
    // stays plain text).
    if (variant === "title" || codeToken !== null) return;
    const currentId = nodeRef.current.id;
    if (carrierEnter?.carrierOf(currentId) != null) return;
    const el = spanRef.current;
    if (el === null) return;
    event.preventDefault();
    const range = selectionOffsets(el) ?? {
      start: draftRef.current.length,
      end: draftRef.current.length,
    };
    // The head write supersedes the debounced flush — clear it so the
    // unmount flush can't overwrite the split (same as the Enter split).
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    dirtyRef.current = false;
    const parentId = nodeRef.current.parentId;
    const draft = draftRef.current;
    const base = applyTextEdit(nodeRef.current.contentAst, draft, resolveClassName, resolveMentionName);
    // Head: keep [0, caret) and replace the selection with the first line.
    const head = spliceTokens(base, range.start, draft.length, astFromProse(lines[0]!, []), resolveClassName, resolveMentionName);
    // Tail: everything after the selection; it rides the LAST pasted line.
    const tail = spliceTokens(base, 0, range.end, [], resolveClassName, resolveMentionName);
    void client.updateObject(currentId, { contentAst: withCandidateSpans(head) });
    const lastLine = lines[lines.length - 1]!;
    // The last line PREPENDS to the tail (spliceTokens merges adjacent text
    // runs, so "Y" + "def" stores as one "Ydef" run).
    const last = spliceTokens(tail, 0, 0, astFromProse(lastLine, []), resolveClassName, resolveMentionName);
    const created: ContentAst[] = [
      ...lines.slice(1, -1).map((line) => withCandidateSpans(astFromProse(line, []))),
      withCandidateSpans(last),
    ];
    // afterId chaining keeps fractional sibling order — the first create
    // anchors after the current block, each next one after the previous
    // (the pattern extractToPage uses for N sibling inserts).
    let chain: Promise<string> = client.createObject({
      parentId,
      contentAst: created[0]!,
      ...(parentId !== null ? { afterId: currentId } : {}),
    });
    for (const contentAst of created.slice(1)) {
      chain = chain.then((prevId) => client.createObject({ parentId, contentAst, afterId: prevId }));
    }
    // Caret at the start of the tail, inside the last pasted line's block.
    void chain.then((lastId) => requestFocus(lastId, lastLine.length));
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
    // Alt+Shift+↑/↓ reorders the block among its siblings without
    // dragging (the MOVE_UP/MOVE_DOWN chords). The caret stays in the
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
    // owns Backspace/Delete/arrows before any other branch (the
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
          const base = applyTextEdit(nodeRef.current.contentAst, draftRef.current, resolveClassName, resolveMentionName);
          const atoms = editableAtoms(base, resolveClassName, resolveMentionName);
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
    // Arrow navigation across blocks — the edit session hands to the
    // adjacent VISIBLE block (folded subtrees contribute no rows). Up/Down
    // keep the browser's within-text line movement and only intercept on
    // the first/last VISUAL line (rect-probed; unmeasurable platforms read
    // as a boundary, jsdom included). Shift (text selection) and Alt
    // (history) stay on the browser default; the pill branches above keep
    // their priority (an arrow onto an adjacent pill selects it, it does
    // not jump blocks). The title row is the page's top: ↓ (and → at its
    // end) enter the first block, ↑ on the first top-level block hands the
    // caret UP to the title.
    if (
      capture === null &&
      !mod &&
      !event.altKey &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "ArrowLeft" || event.key === "ArrowRight")
    ) {
      const el = spanRef.current;
      const caret = el === null ? null : caretOffset(el);
      if (el !== null && caret !== null) {
        const draft = draftRef.current;
        const id = nodeRef.current.id;
        // Caret on the first/last rendered line of the editor (zero-height
        // or unmeasurable rects count as a boundary — single-line blocks
        // are always both).
        const onFirstLine = () => {
          const caretRect = caretClientRect(el);
          const firstRect = proseOffsetRect(el, 0);
          return firstRect === null || caretRect === null || caretRect.top <= firstRect.top + 1;
        };
        const onLastLine = () => {
          const caretRect = caretClientRect(el);
          const lastRect = proseOffsetRect(el, el.textContent?.length ?? 0);
          return lastRect === null || caretRect === null || caretRect.bottom >= lastRect.bottom - 1;
        };
        const handUp = (caretAt: CaretPlacement) => {
          event.preventDefault();
          if (variant === "title") return; // the title is the top of the page
          const prev = previousBlockId(id);
          if (prev !== null) {
            requestFocus(prev, caretAt);
          } else if (positions.get(id)?.parentId === rootId) {
            // The first top-level block: ↑ hands the caret to the header.
            requestFocus(rootId, "end");
          }
        };
        const handDown = (caretAt: CaretPlacement) => {
          event.preventDefault();
          if (variant === "title") {
            const first = firstBlockId();
            if (first !== null) requestFocus(first, caretAt);
            return;
          }
          const next = nextBlockId(id);
          if (next !== null) requestFocus(next, caretAt);
        };
        if (event.key === "ArrowUp" && onFirstLine()) handUp("start");
        else if (event.key === "ArrowDown" && onLastLine()) handDown("start");
        else if (event.key === "ArrowLeft" && caret === 0) handUp("end");
        else if (event.key === "ArrowRight" && caret === draft.length) handDown("start");
      }
    }
    if (mod && !event.altKey) {
      const key = event.key.toLowerCase();
      // Cmd/Ctrl+Enter: the task-state cycle (not a
      // task -> task+Pending -> task+Done -> not a task; see taskCycle.ts).
      // Shift stays out so Cmd+Shift+Enter keeps Shift+Enter's hard-break
      // newline semantics. While a slash popup is open, the Enter branch
      // above already committed the popup and returned — the popup's commit
      // wins over the cycle by design.
      if (key === "enter" && !event.shiftKey) {
        // No task cycle on the page node itself (the title row).
        if (variant === "title") return;
        event.preventDefault();
        const id = nodeRef.current.id;
        void cycleTaskState(client, id).catch((error: unknown) => {
          console.warn(`[editor] task cycle (${id}) failed:`, error);
        });
        return;
      }
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
      // Ctrl/Cmd+L over a selection: the @ gesture — the picker opens with
      // the selected text as its search query and the pick replaces the
      // selection. Ctrl/Cmd+Shift+L instead searches with an EMPTY query
      // and keeps the selected text as the inserted link's custom label.
      // Without a selection neither intercepts (the browser keeps Ctrl+L).
      if (key === "l") {
        const el = spanRef.current;
        const range = el === null ? null : selectionOffsets(el);
        if (range !== null && range.start !== range.end) {
          const opened = event.shiftKey
            ? openMentionFromSelection(false, "label")
            : openMentionFromSelection(true, "query");
          if (opened) event.preventDefault();
        }
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
    // Same boundary rule as the collapsed-caret trigger; without it the
    // default runs unchanged.
    if (event.key === "@" && !mod && !event.altKey) {
      const range = (() => {
        const el = spanRef.current;
        return el === null ? null : selectionOffsets(el);
      })();
      if (range !== null && range.start !== range.end) {
        if (openMentionFromSelection(true)) {
          event.preventDefault();
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
      if (variant === "title") {
        // The title IS the page node: Enter commits and leaves edit mode —
        // it never splits the title and never creates a body block.
        spanRef.current?.blur();
        return;
      }
      const el = spanRef.current;
      const range = el === null ? null : selectionOffsets(el);
      const caret = range === null ? null : range.start;
      const draft = draftRef.current;
      const parentId = nodeRef.current.parentId;
      const currentId = nodeRef.current.id;
      const base = applyTextEdit(nodeRef.current.contentAst, draft, resolveClassName, resolveMentionName);
      // A live range selection is cut first (the browser default is
      // prevented): every branch below works over the cut text and the split
      // lands at the range start.
      const cut =
        range !== null && range.start !== range.end
          ? spliceTokens(base, range.start, range.end, [], resolveClassName, resolveMentionName)
          : base;
      const cutLen = proseFromAst(cut, resolveClassName, resolveMentionName).length;
      // Text-property carriers: multi Enter registers the new
      // sibling as the next VALUE; single Enter nests the new block as a
      // CHILD of the carrier (the value's lines). Ordinary blocks: the
      // default outliner semantics below.
      const carrier = carrierEnter?.carrierOf(currentId) ?? null;
      const singleCarrier = carrier !== null && !carrier.multi;
      const firstChildId = singleCarrier ? client.getChildren(currentId)[0]?.id : undefined;
      const childAnchor = firstChildId !== undefined ? { beforeId: firstChildId } : {};
      if (caret !== null && caret > 0 && caret < cutLen) {
        // MID-TEXT: split at the caret. The head stays in this block; the
        // tail moves to a new block right after — a SIBLING normally, the
        // FIRST CHILD when this block has children (the children stay with
        // the head). The head write supersedes the debounced flush — clear
        // it so the unmount flush can't overwrite the split.
        if (timerRef.current !== null) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        dirtyRef.current = false;
        const head = spliceTokens(cut, caret, cutLen, [], resolveClassName, resolveMentionName);
        const tail = spliceTokens(cut, 0, caret, [], resolveClassName, resolveMentionName);
        const firstChild = client.getChildren(currentId)[0]?.id;
        const nest = !singleCarrier && firstChild !== undefined;
        void client.updateObject(currentId, { contentAst: withCandidateSpans(head) });
        void client
          .createObject({
            parentId: singleCarrier ? currentId : nest ? currentId : parentId,
            contentAst: withCandidateSpans(tail),
            ...(singleCarrier
              ? childAnchor
              : nest
                ? { beforeId: firstChild }
                : parentId !== null
                  ? { afterId: currentId }
                  : {}),
          })
          .then((id) => {
            if (carrier?.multi === true) registerCarrierValue(client, carrier, id);
            requestFocus(id, "start");
          });
        return;
      }
      if (caret === 0 && cutLen > 0) {
        // START: a new empty block BEFORE this one (W1 beforeId) — or a
        // first CHILD for a single-value carrier. A cut selection commits
        // first so the emptied text doesn't linger.
        if (cut !== base) {
          void client.updateObject(currentId, { contentAst: withCandidateSpans(cut) });
        }
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
      // takes the new block as its FIRST child instead (the Roam rule); a
      // single-value carrier ALWAYS takes the child branch (its value is
      // one block — Enter adds a line, never a sibling value). A cut
      // selection commits first so the emptied text doesn't linger.
      if (cut !== base) {
        void client.updateObject(currentId, { contentAst: withCandidateSpans(cut) });
      }
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
    if (event.key === "Backspace" && variant !== "title") {
      const el = spanRef.current;
      const text = el?.textContent ?? "";
      const caret = el === null ? null : caretOffset(el);
      const id = nodeRef.current.id;
      if (text !== "") {
        if (caret === 0) {
          // START OF TEXT: merge this block into the previous one when
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
    if (event.key === "Delete" && variant !== "title") {
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
      // The reparent remounts this row under a different parent — React
      // drops the component instance and its edit state with it — so the
      // caret offset is captured NOW and the edit session is re-requested
      // on the moved block once the move lands. Indenting never leaves
      // edit mode.
      const el = spanRef.current;
      const caretAt = el === null ? null : caretOffset(el);
      const refocus = () => requestFocus(id, caretAt ?? "end");
      if (!event.shiftKey) {
        // Indent: under the previous sibling (append as its last child).
        const target = position?.previousSiblingId;
        if (target === undefined || target === null) return; // page-level edge
        void client
          .moveObject(id, target)
          .then(refocus)
          .catch((error: unknown) => {
            console.warn(`[outliner] indent (${id} → ${target}) failed:`, error);
          });
        return;
      }
      // Outdent: to the grandparent, placed right after the current parent.
      // treeEditMode device setting: "logical" (default) additionally moves
      // the block's subsequent siblings under it (category grouping);
      // "direct" moves only the block.
      const parentId = position?.parentId;
      const grandParentId = position?.grandParentId;
      if (parentId === undefined || parentId === null) return; // page-level edge
      if (grandParentId === undefined || grandParentId === null) return;
      const mode = readDeviceSetting<"direct" | "logical">("treeEditMode", "logical");
      if (mode === "direct") {
        void client
          .moveObject(id, grandParentId, parentId)
          .then(refocus)
          .catch((error: unknown) => {
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
          refocus();
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
        onMention={(mode) => {
          openMentionFromSelection(false, mode);
        }}
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
            // The relation's current members: assigned rows carry the
            // checkmark and re-surface under a matching query (they hide
            // from the empty-query browse — the candidate set is what can
            // still be added). The `+` popup's assigned rows report through
            // onAssignedPick (toggle / convert-to-inline); `#`'s acknowledge
            // idempotently.
            nodes={
              capture.kind === "mention"
                ? undefined
                : (capture.kind === "class"
                    ? (client.getNode(nodeRef.current.id)?.classIds ?? [])
                    : (client.getNode(nodeRef.current.id)?.tagIds ?? [])
                  )
                    .map((id) => client.getNode(id))
                    .filter((n): n is ClientNode => n !== undefined)
            }
            searchPlaceholder={
              capture.kind === "mention"
                ? "Search pages and blocks…"
                : capture.kind === "tag"
                  ? "Search pages…"
                  : "Search classes…"
            }
            onClose={closeNodePicker}
            onAdd={commitNodePick}
            onAssignedPick={capture.kind === "class" ? commitAssignedClassPick : undefined}
            hint={capture.kind === "mention" ? capture.hint : undefined}
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
      {datePick !== null && (
        <>
          {/* Zero-size fixed anchor at the caret line (viewport coords) —
              the popup flips/clamps from there via its viewport positioner. */}
          <span
            ref={(el) => {
              dateAnchorRef.current = el;
            }}
            aria-hidden="true"
            style={{
              position: "fixed",
              top: datePick.anchor.top,
              left: datePick.anchor.left,
              width: 0,
              height: 0,
              pointerEvents: "none",
            }}
          />
          <DatePickerPopup
            value={{ isRange: false, start: null, end: null }}
            onCommit={(value) => {
              // Day precision only (range/time chrome off): a point commit.
              if (!("iso" in value)) return;
              const iso = value.iso;
              const ids = chainNodeIds(iso);
              const insertAt = datePick.insertAt;
              datePickCommittedRef.current = true;
              return client.ensureDateChain(iso).then(() => {
                // The display label rides the same parser the typed path
                // uses ("October 18, 2026").
                const label = parseDate(iso)?.label ?? iso;
                applySplice(
                  insertAt,
                  insertAt,
                  [{ type: "mention", targetNodeId: ids.day, text: label, linkId: uuidv7() }],
                  insertAt + label.length,
                );
              });
            }}
            onClose={() => {
              const pick = datePick;
              const committed = datePickCommittedRef.current;
              setDatePick(null);
              // The popup held the focus while open: Escape / outside close
              // hands it back to the block (after a commit the splice already
              // landed the caret — no refocus clobber).
              if (committed) return;
              const el = spanRef.current;
              if (el !== null) {
                el.focus();
                placeCaret(el, pick.insertAt);
              }
            }}
            anchorRef={dateAnchorRef}
            firstDayOfWeek={1}
            precision="day"
            allowRange={false}
            allowTime={false}
          />
        </>
      )}
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
