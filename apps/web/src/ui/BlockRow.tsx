/**
 * BlockRow — one block: bullet dot (a chevron toggle when the block has
 * children) + inline token content + nested children (recursive, indented).
 * Two display modes on the content div:
 *
 * - read mode: InlineTokens (marks/chips render read-only per SCHEMA.md).
 *   Read-only projections keep the full row chrome — property icon buttons,
 *   classes column, tags row, the collapsed Metadata section — rendered
 *   statically, so a read-only row reads aligned with its editable twin.
 *   Two read-only click contracts: the tree projections (Child pages)
 *   open the node on content click; the inert flat-list variant
 *   (`readOnlyInert`, the node-collection list view) leaves the content
 *   click dead — the bullet element is the only open gesture.
 * - edit mode: a click swaps in BlockTextEditor (contentEditable prose
 *   editing, the outliner keyboard contract). While a block is editing,
 *   the row reports its state through EditThreadContext and the page
 *   body select surface draws the edit thread — a separate MEASURED
 *   overlay (EditThread.tsx): one SVG polyline from the top-level
 *   ancestor bullet down to the editing block bullet, turning right
 *   with a rounded corner at each level change (owner 2026-10-20, third
 *   pass — the two `:has()` takes styled the tree rails and lit whole
 *   subtree columns; the reference look is one line anchored at the
 *   bullets, a shape the tree chrome cannot draw). The overlay carries
 *   z-index 1 — above the tree chrome (the resting rails pass under the
 *   thread where the columns coincide) and below the bullets and the
 *   hover chevron (z-index 2) — and passes clicks through; no thread for
 *   a top-level edit, in prose, or in cards. The outliner level grid
 *   (app.css): each block is one grid whose template splits AT the
 *   bullet centerline — [gutter][half-grip][half-grip][content] — and
 *   the children container spans from that centerline, so the indent
 *   rails ride the bullet column by construction (two vars,
 *   --nt-row-gutter and --nt-grip-half, single-source the row gutter and
 *   the grip width; no hand-derived margins left). The thread arms end at
 *   each path bullet near edge — under a dot, a few px BEFORE a class icon
 *   or list marker (owner 2026-10-20: the arm struck through glyphs and
 *   read as an overlap) — and at an intermediate glyph the path
 *   SURROUNDS its lower-left corner (a loop of inverted rounding: hug the
 *   left edge, round the bottom-left, rejoin the center column just
 *   below the glyph) so the downward line keeps its original position —
 *   the staircase stays on the bullet centers through dots and icons.
 *   While a block edits, the ancestor path dots and class icons wear the
 *   accent at RESTING SIZE (the thread reads through them; only the
 *   editing bullet grows — the scale is the engaged-row signal). The
 *   editing bullet highlight stays
 *   direct-row scoped (a descendant selector lit the whole subtree —
 *   owner 2026-10-20: children must not read as active), and the collapse
 *   chevron reveals on grip hover ONLY — no focus reveal of any kind: an
 *   editing block shows no chevron until hovered, like every other block.
 *   An open node menu (grip or prose right-click — the same gripMenu
 *   state) anchors to its block: `nt-block--menu-open` carries the
 *   hover/active bullet highlight until the menu closes (owner 2026-10-20:
 *   the menu floats free at the pointer; the lit bullet names its block).
 *
 * A collapsed block (session-local display state from OutlinerContext) hides
 * its entire subtree — the children container is not rendered. The chevron
 * toggles collapse without entering edit mode (stopPropagation). Collapse
 * is honored in EVERY view mode (owner ruling 2026-10-15): in prose view
 * (`proseMode`) the chevron start-anchors the row — hover-revealed like the
 * outline gutter idiom and PERSISTENT at rest while the block is collapsed
 * (the persistent chevron IS the collapsed indicator — nothing silently
 * hidden); the v1 indent-line rail stays outline-only (prose has no indent
 * line — indents are flattened by definition).
 *
 * The condensed layer (owner 2026-10-15, refined same day after owner
 * feedback — the opt-in `condensed` prop, page body only): a truncatable
 * block renders its one-line excerpt (`excerptOf`, the prose-flatten
 * derivation) instead of its full content, with a PERMANENT muted "…"
 * stretchtext mark after the text — and that mark IS the layer's one toggle
 * in both directions (owner ruling: the lens pin button and the back-arrow
 * retired). On the condensed row the mark pins the block; the hidden-links
 * badge rides beside it, revealed with the row (hover + focus-within; the
 * resting-rows-stay-clean law — the permanent "…" names the truncation at
 * rest). The interaction contract: CLICKING THE ROW ENTERS EDIT on the
 * block's full content (the standard outline click-to-edit — the excerpt is
 * display chrome, the editor always edits the real content); BLUR
 * RE-CONDENSES the row again. Only the mark adds the block to the context's
 * `stretched` set: a pinned row renders full content in read mode with the
 * "…" returned at the END OF THE TEXT (inline after the last word — it
 * follows the text wherever it wraps, not the row's right edge), and the
 * set becomes purely the mark-pinned set — editing never pins, blur never
 * unpins; only the mark / condense-all unpins, and the badge never rides a
 * pinned row (all text visible — the hidden count is 0 by definition).
 * Prose-less and untruncated rows never condense — a one-line block is its
 * own excerpt; no caret can ever sit inside a derived projection (the
 * excerpt row swaps in the full editor). Stretch state rides the
 * OutlinerContext (`stretched`, device-persisted like the folds); collapse
 * and stretch stay orthogonal and compose on the same row.
 *
 * Drag-and-drop: each row is sortable within its sibling group (dnd-kit,
 * vertical strategy) via the bullet/chevron grip handle — only inside a
 * workspace editing surface (the drag scope PageView provides; outside it
 * the grip stays inert). Drops resolve to `object.move` through the intent
 * model in block-dnd.ts; the drop indicator arrives through DropLineContext,
 * proximity-snapped to the nearest valid location of the drag session.
 * Drag preview is frozen by design: NO row ever applies the sortable
 * strategy transform, so nothing slides to make room while dragging — the
 * feedback is the highlight line at the drop position (the drop- intent
 * classes), the dragged source reading faint in place (the drag-source
 * class), and the floating DragOverlay chip; the reorder itself commits on
 * drop.
 *
 * Edit mode is also entered in response to a focus request from the
 * outliner gestures (Enter creates a sibling, Backspace-delete hands the
 * caret to the previous block, Tab/Shift+Tab reparent and hand the caret
 * back, the arrow keys hand it to the adjacent block). Data comes from the
 * WorkspaceClient read API; the client itself arrives through
 * OutlinerContext.
 *
 * variant="title" is the page-header projection: the page node itself as a
 * bullet-less, chrome-less row (see the prop doc below) — the shared token
 * rendering and the full block editor, minus the outline chrome.
 */

import { memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";

import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";

import { excerptOf, isRuleContent, parseDateNodeId } from "@notees/domain";

import type { BlockTreeNode, ClientNode, EffectiveProperty, WorkspaceClient } from "@/core/workspace-client/index.js";
import type { WorkerClient } from "@/core/worker-client.js";
import { hiddenLinksOf } from "@/editor/condensed.js";

import { Icon } from "./Icon.js";
import { InlineTokens } from "./InlineTokens.js";
import { fullTitleFromClient } from "./dateDisplay.js";
import { AssetView } from "./AssetView.js";
import { BlockBacklinkPanel, BlockBacklinkToggle } from "./BlockBacklinks.js";
import { BlockTextEditor, type EditorCaret } from "../features/block-editor/index.js";
import { PropertiesSection, TagsRow } from "../features/metadata/index.js";
import { PropertyIconButton } from "../features/metadata/PropertyIconButton.js";
import type { SelectionOption } from "../features/pickers/SelectionPropertyControl.js";
import { NodePills } from "../features/metadata/NodePills.js";
import { NodeContextMenu } from "../features/node-menu/NodeContextMenu.js";
import { openNodeLinkMenu } from "../features/node-menu/NodeLinkContextMenu.js";
import { nodeIcon, definedNodeIcon } from "./iconFor.js";
import { EmbedView } from "./EmbedView.js";
import { linkOnlyMentionTarget } from "./linkOnlyBlock.js";
import { EmbedCardView } from "./EmbedCardView.js";
import { QueryBlockView } from "./QueryBlockView.js";
import { WhiteboardCanvas } from "./WhiteboardCanvas.js";
import { DragSourcesContext, DropLineContext, WorkspaceDragScopeContext } from "./block-dnd.js";
import { useOutliner } from "./outliner-context.js";
import { useEditThread } from "./EditThread.js";
import { Button } from "../components/ui/fleet/index.js";
import { Badge } from "../components/ui/fleet/Badge.js";
import { CondensedLinksPopup } from "../features/node-menu/CondensedLinksPopup.js";
import { InlineConfirmButton } from "../components/ui/fleet/InlineConfirmButton.js";
import { tableClassIdOf } from "../features/classview/tableFamily.js";
import { addTableColumn, addTableRow, deleteTableColumn, deleteTableRow, tableColumnCount } from "../features/classview/tableGrid.js";
import { deriveListMarker } from "./listStyle.js";

/** Display positions (schema-level) a block row surfaces itself; the
 *  collapsed properties panel below omits them (no duplicated value read). */
const ROW_DISPLAY_POSITIONS = ["bullet", "inline"] as const;

interface BlockRowProps {
  tree: BlockTreeNode;
  client: WorkspaceClient | WorkerClient;
  resolveName?: ((nodeId: string) => string | null) | undefined;
  /**
   * Read-only projection: renders the same
   * row chrome but disables every mutation gesture — no drag, no edit on
   * click, no context menu. The metadata chrome (property icon buttons,
   * classes column, tags row, the collapsed Metadata section) renders
   * aligned with the editable row, statically.
   *
   * Clicking the content opens the node by default (the Child pages tree,
   * the Class View's "Extended by" list); `readOnlyInert` turns that off
   * too — the flat node-collection list sets it so the bullet is the only
   * open gesture (the row's hover feedback is scoped to the bullet).
   */
  readOnly?: boolean | undefined;
  /**
   * The inert read-only variant (the flat node-collection list): a content
   * click does NOTHING — opening rides the bullet element alone. The row
   * wears `nt-block--inert` (cursor + hover rules). Only meaningful with
   * `readOnly`.
   */
  readOnlyInert?: boolean | undefined;
  /**
   * Flat collection-list projection: block-scale widget tokens (embeds,
   * queries, whiteboards, assets) render their compact PLACEHOLDER instead
   * of the live surface — a live `query` inside a result row could recurse,
   * and the list names the widget while the page body owns the live
   * surface. Threaded down the recursion by the view that sets it.
   */
  suppressWidgets?: boolean | undefined;
  /**
   * Prose-view transform: the row rides the `nt-prose` flattening (bullets
   * hidden, indents flattened by CSS). Collapse is HONORED (owner ruling
   * 2026-10-15): the chevron start-anchors the row, hover-revealed and
   * persistent while collapsed; only the v1 indent-line rail stays
   * outline-only (prose has no indent line). Threaded down the recursion by
   * the view that sets it.
   */
  proseMode?: boolean | undefined;
  /**
   * The condensed layer opt-in (owner 2026-10-15): set ONLY by the page
   * body while its condensed toggle is engaged — every other surface
   * (embedded feeds, read-only projections, exports, shares) never passes
   * it and renders full content by construction. Under the layer a
   * truncatable block renders its excerpt row (stretch via the context's
   * `stretched` set); prose-less and one-line blocks render the ordinary
   * row. Threaded down the recursion by the view that sets it.
   */
  condensed?: boolean | undefined;
  /**
   * Table-row projection: set by the table container's grid branch
   * on each of its row children. The row root becomes a CSS-subgrid row and
   * renders ONLY its cell children (each an ordinary editable block) — no
   * row chrome of its own.
   */
  tableRow?: boolean | undefined;
  /**
   * Title projection (the page header): the page node itself as a
   * bullet-less, chrome-less row — full editor powers on the page's own
   * content (inline tokens render and edit exactly as in body blocks), but
   * no grip/drag, no collapse, no property/backlink/tags chrome, no
   * children, and no row context menu (the header owns the right-click
   * page menu). The content wrapper carries `nt-title-content`, NOT
   * `nt-block-content`, so body-row selectors never match the header row.
   * Block-scale widget tokens (embeds, queries, whiteboards, assets) render
   * nothing here — they live in the body surface.
   */
  variant?: "block" | "title" | undefined;
  /**
   * Hide the backlink gutter: the row-end count toggle and its expanded
   * linked-references panel render nothing. Set by list projections where
   * the count is reference noise (the Child pages tree, the Class View's
   * "Extended by" list). Threaded down the recursion by the view that sets
   * it.
   */
  hideBacklinks?: boolean | undefined;
  /**
   * A trailing affordance rendered as the LAST CHILD of this row's children
   * container (the child indent level — never a sibling of the row): the
   * focused block view's "+ Add block" ghost (GhostRow over this node).
   * The children container mounts even with zero real children while this
   * is set (unless the row is collapsed) so the affordance shows on an
   * empty body too. Not sortable — the row carries no drag wiring.
   */
  trailingGhost?: ReactNode | undefined;
  /**
   * Mount straight into edit mode (the table text cell's placeholder
   * creates its carrier and lands the user in the editor in one click):
   * the initial editing state is true and the editor's mount effect lands
   * the caret. Only the INITIAL state — later mounts render read mode.
   */
  autoEdit?: boolean | undefined;
}

export function BlockRowRenderer({ tree, client, resolveName, readOnly = false, readOnlyInert = false, suppressWidgets = false, proseMode = false, tableRow = false, variant = "block", hideBacklinks = false, condensed = false, trailingGhost = undefined, autoEdit = false }: BlockRowProps) {

  const [gripMenu, setGripMenu] = useState<{ x: number; y: number } | null>(null);
  const { node, children } = tree;
  const childIds = useStableIdArray(children.map((child) => child.node.id));
  // Scoped re-render: the memo compares props, but the row renders per-node
  // data that changes WITHOUT the node identity changing (the materialized
  // backlink count, effective property values, class/mention chip titles).
  // A notification naming one of this row's rerender targets (its own id via
  // property/edge writes, its classes, its chip targets) forces a render;
  // scoped notifications naming none leave the memo's bail intact, and
  // scope-unknown forces conservatively.
  const rerenderTargetsRef = useRef<Set<string>>(new Set());
  rerenderTargetsRef.current = collectRerenderTargets(node);
  const [, forceRowRender] = useState(0);
  useEffect(
    () =>
      client.subscribe((change) => {
        const affected = change.affectedNodeIds;
        if (affected === undefined) {
          forceRowRender((v) => v + 1);
          return;
        }
        const targets = rerenderTargetsRef.current;
        for (const id of affected) {
          if (targets.has(id)) {
            forceRowRender((v) => v + 1);
            return;
          }
        }
      }),
    [client],
  );
  const isTitle = variant === "title";
  const {
    client: outlinerClient,
    rootId,
    openNode,
    openInSidebar,
    focusRequest,
    acknowledgeFocus,
    collapsed,
    toggleCollapse,
    stretched,
    toggleStretched,
    selectionEnabled,
    selection,
    selectionAnchor,
    setSelectionAnchor,
    replaceSelection,
    rangeBetween,
    toggleSelected,
    clearSelection,
    consumeDragClick,
    focusMode,
  } = useOutliner();
  const dropLine = useContext(DropLineContext);
  // The drag session's source set: a selection-stack drag faints EVERY root
  // row (the grip row's own isDragging only covers the one under the grip).
  const dragSources = useContext(DragSourcesContext);
  const [editing, setEditing] = useState(autoEdit);
  const [caret, setCaret] = useState<EditorCaret>("end");
  // Right-gutter backlink toggle (SCHEMA.md:117): the badge reads the
  // materialized count (cheap stored number, renders unconditionally at 0
  // hides the toggle); the linked-references query stays lazy until the
  // first expand. A hidden gutter (the hideBacklinks list projections)
  // skips the read — the count reads 0, so the toggle, the panel, and the
  // row-end's count branch all stay out.
  const backlinkCount = hideBacklinks ? 0 : client.getBacklinkCount(node.id);
  const [backlinksExpanded, setBacklinksExpanded] = useState(false);
  const isCollapsed = collapsed.has(node.id);
  // The classes column's own lock: date-chain nodes carry their precision's
  // system class and nothing else (SCHEMA.md "Datetime"), so their pills
  // render static everywhere — otherwise the column is mutable on EVERY
  // row, read-only projections included (owner ruling 2026-10-21: class
  // membership answers edits from reference rows — ×, "+", drag-sort; the
  // 2026-10-23 ruling made those rows' CONTENT editable too, so the column
  // is simply mutable on every row that renders it).
  const classesLocked = parseDateNodeId(node.id) !== null;
  // The links-badge popup (condensed layer): position-free state — the
  // popup unmounts with the excerpt chrome when the row stretches.
  const [linksPopupOpen, setLinksPopupOpen] = useState(false);
  const linksBadgeRef = useRef<HTMLButtonElement | null>(null);
  // Sortable within this row's sibling group; the bullet/chevron area is the
  // drag handle (whole-row drag would fight text editing). A small activation
  // distance keeps plain clicks untouched. The title row is never sortable
  // (and renders outside the body's drag scope) and rows outside a workspace
  // editing surface aren't either — the disabled flag keeps the hook inert,
  // the same pattern read-only projections use.
  const dragScope = useContext(WorkspaceDragScopeContext);
  // useSortable stays for the grip's activator props + the droppable ref, but
  // its strategy transform is deliberately NEVER applied: a frozen preview
  // (nothing slides to make room) with a highlight line + faint source.
  const { attributes, listeners, setNodeRef, isDragging } = useSortable({
    id: node.id,
    disabled: readOnly || isTitle || !dragScope,
  });

  // --- the indent rail -----------------------------------------------------
  // The rail (the collapse control riding the children container's left
  // border) extends UP from the children container across the block's
  // metadata sections to the row's bottom edge (owner: the line reaches the
  // bullet) — so its top is measured, not a CSS constant: the metadata
  // stack (properties / tags / backlinks) varies per block and per
  // expansion state. A ResizeObserver re-measures on any layout change
  // (row wraps, a metadata section expands, a tag arrives).
  const blockRef = useRef<HTMLDivElement | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const childrenRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLButtonElement | null>(null);
  const extendRail = useCallback(() => {
    const childrenEl = childrenRef.current;
    const rowEl = rowRef.current;
    const railEl = railRef.current;
    if (childrenEl === null || rowEl === null || railEl === null) return;
    const gap = childrenEl.getBoundingClientRect().top - rowEl.getBoundingClientRect().bottom;
    railEl.style.top = `${-Math.max(0, gap)}px`;
  }, []);
  useLayoutEffect(() => {
    extendRail();
    const blockEl = blockRef.current;
    if (blockEl === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => extendRail());
    observer.observe(blockEl);
    return () => observer.disconnect();
  }, [extendRail, isCollapsed, children.length, editing, backlinksExpanded, node.tagIds.length]);

  // The rail click folds EACH direct child individually (owner rule
  // 2026-10-14: "collapse EACH INDIVIDUAL CHILD BLOCK, not the block that
  // owns the thread"): the owner's own expansion stays, the direct children
  // rows remain, their subtrees fold at once. When every collapsible child
  // is already folded, the click unfolds them all.
  const collapseFromRailClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const collapsible = children.filter((child) => child.children.length > 0);
    if (collapsible.length === 0) return;
    const allCollapsed = collapsible.every((child) => collapsed.has(child.node.id));
    for (const child of collapsible) {
      // Target: collapsed unless every child is already folded (then unfold).
      if (collapsed.has(child.node.id) === allCollapsed) toggleCollapse(child.node.id);
    }
  };

  useEffect(() => {
    if (focusRequest === null || focusRequest.id !== node.id) return;
    acknowledgeFocus();
    if (readOnly) return;
    setCaret(focusRequest.caret);
    setEditing(true);
  }, [focusRequest, node.id, acknowledgeFocus, readOnly]);

  // The edit thread (EditThread.tsx): report this row's edit state so the
  // page body's measured overlay can draw the ancestor path. The clear is
  // guarded in the provider (only the current owner clears) so a caret
  // hand-off between blocks can't tear the new thread down.
  const editThread = useEditThread();
  useEffect(() => {
    if (editThread === null || !editing) return;
    editThread.reportEditing(node.id);
    return () => editThread.clearEditing(node.id);
  }, [editThread, editing, node.id]);

  // Selection and edit mode are mutually exclusive (owner 2026-10-14):
  // whichever block is editing hands back to read mode the moment a
  // selection forms — the selection surface has taken over. (The DOM-focus
  // side rides the selection surface's explicit editor blur; this is the
  // state-level truth, so it holds even where focus events don't fire.)
  useEffect(() => {
    if (editing && selection.size > 0) setEditing(false);
  }, [editing, selection]);

  const enterEdit = (event: MouseEvent<HTMLDivElement>) => {
    if (editing) return;
    // The click that RELEASED a selection drag is swallowed (accidental);
    // any other click edits normally.
    if (consumeDragClick(node.id)) return;
    if (readOnly) {
      // Read-only projection: a content click opens the node — except the
      // inert flat-list variant, where the bullet is the only open gesture.
      if (!readOnlyInert) openNode(node.id);
      return;
    }
    // The title row never joins the block multi-selection (it lives outside
    // the selection surface); a click there always edits.
    if (!isTitle) {
      // Block multi-selection: shift+click extends the range from the
      // anchor, Ctrl/Cmd+click toggles one row — neither enters edit mode.
      if (selectionEnabled && event.shiftKey) {
        const anchor = selectionAnchor ?? node.id;
        setSelectionAnchor(anchor);
        replaceSelection(new Set(rangeBetween(anchor, node.id)), anchor);
        return;
      }
      if (selectionEnabled && (event.ctrlKey || event.metaKey)) {
        if (selectionAnchor === null) setSelectionAnchor(node.id);
        toggleSelected(node.id);
        return;
      }
      // A plain click with a live selection resets it, then edits as usual.
      if (selection.size > 0) clearSelection();
    }
    setCaret({ x: event.clientX, y: event.clientY });
    setEditing(true);
  };

  // effectiveClassIcons() is the narrow revision-cached read (stable reference
  // until the store actually changes), so keying on it keeps this memo valid
  // across class-icon changes without re-running on every row re-map; the
  // pre-fix [node, node.classIds] key re-ran a full listClasses query per row
  // per refresh. Chain-resolved (#1 follow-up): a class parent with the icon
  // now reaches the row.
  const classIcons = outlinerClient.effectiveClassIcons();
  const gripIcon = useMemo(() => nodeIcon(node, classIcons), [node, classIcons]);
  // Per-block list style (store schema v23): when the node carries one, the
  // derived marker replaces the bullet dot. The NUMBER is render-time
  // derivation only — the position within the contiguous run of same-style
  // siblings directly above (any other sibling resets the count) — so it is
  // computed from the parent's child list per render, never stored. The
  // class-icon branch above is untouched (listStyle is orthogonal to class
  // membership and task cycling).
  const listMarker =
    node.listStyle !== null && node.parentId !== null
      ? deriveListMarker(node, client.getChildren(node.parentId))
      : null;
  // Display-time horizontal rule (owner 2026-10-16): a block whose content
  // is EXACTLY "---" renders an <hr> in place of bullet + text — the node is
  // an ordinary text block on the wire and in the store (zero protocol
  // footprint), the rule is purely render state. Edit mode shows the raw
  // dashes (the editor is the source of truth — the row is never a trapped
  // surface), and typing anything else turns the block back into an
  // ordinary block by construction. Children are not rendered: a rule
  // terminates a section.
  const ruleDisplay = !editing && isRuleContent(node.contentAst);

  const dropClass =
    dropLine !== null && dropLine.targetId === node.id ? ` nt-drop-${dropLine.intent}` : "";
  const selectedClass = selection.has(node.id) ? " nt-block--selected" : "";
  const dragSourceClass =
    isDragging || dragSources?.has(node.id) === true ? " nt-block--drag-source" : "";

  // A block carrying the table class renders its children (rows)
  // as a CSS grid instead of the outline list. The class says what-it-is
  // (the whiteboard pattern) — the same branch covers read-only projections.
  const isTableContainer = !tableRow && node.classIds.includes(tableClassIdOf(outlinerClient));

  // Table-row projection: the root is the subgrid row; only the cell blocks
  // render, each through the ordinary BlockRow path (a cell IS a block — the
  // existing editor machinery applies). All hooks ran above, so the early
  // return is safe.
  if (tableRow) {
    return (
      <div
        className={`nt-blocktable-row${dragSourceClass}`}
        ref={setNodeRef}
        data-block-id={node.id}
      >
        <SortableContext items={childIds} strategy={verticalListSortingStrategy}>
          {children.map((child) => (
            <BlockRow
              key={child.node.id}
              tree={child}
              client={client}
              resolveName={resolveName}
              readOnly={readOnly}
              proseMode={proseMode}
              condensed={condensed}
              suppressWidgets={suppressWidgets}
              hideBacklinks={hideBacklinks}
            />
          ))}
        </SortableContext>
      </div>
    );
  }

  // Select-typed or boolean properties whose SCHEMA carries a
  // "bullet"/"inline" display position ride the block row as icon buttons
  // (the Logseq-DB "beginning of the block" behavior; the buttons and the
  // boolean glyphs are the design) — one button per property, in
  // ALPHABETICAL order by property name (owner ruling 2026-10-21 — binding
  // sequence retired; the groups sort by name across both sources). Valued
  // properties group from the effective rows (row.display is schema-sourced);
  // a bound-but-empty binding still mounts the button — the unset affordance
  // is how a fresh task gets its status. The properties panel below omits
  // these positions so the value never reads twice. Reads follow the
  // PropertiesSection pattern: plain render reads over the client, refreshed
  // by the surrounding view's client.subscribe re-render. The title row
  // renders none of this chrome — skip the whole read.
  const bulletDisplayGroups: Array<{
    propertySchemaId: string;
    label: string;
    options: SelectionOption[];
    rows: EffectiveProperty[];
    multi: boolean;
    boolean: boolean;
    display: "bullet" | "inline";
  }> = [];
  const inlineDisplayGroups: Array<{
    propertySchemaId: string;
    label: string;
    options: SelectionOption[];
    rows: EffectiveProperty[];
    multi: boolean;
    boolean: boolean;
    display: "bullet" | "inline";
  }> = [];
  if (!isTitle) {
    const effectiveRows = client.getEffectiveProperties(node.id);
    // The property chrome renders schema names — a schema rename/update
    // must force this row too.
    for (const row of effectiveRows) rerenderTargetsRef.current.add(row.propertySchemaId);
    const schemasById = new Map(
      client.listPropertySchemas().map((schema) => [schema.id, schema]),
    );
    const selectDisplayGroups: typeof bulletDisplayGroups = [];
    {
      const seenGroups = new Set<string>();
      const assignedDisplayRows: Array<{ row: EffectiveProperty; display: "bullet" | "inline" }> =
        [];
      for (const row of effectiveRows) {
        const display = row.display;
        if (display !== "bullet" && display !== "inline") continue;
        // An ASSIGNED-EMPTY row (owner ruling 2026-10-23 — property.assign
        // without a value) joins the button pass below — no binding scan
        // sees it. A BOUND-but-empty row is covered by the binding pass
        // itself (its declaration IS a class binding) — skip it here.
        if (row.source === "assigned") {
          assignedDisplayRows.push({ row, display });
          continue;
        }
        if (row.source === "bound") continue;
        const type = row.schema?.type;
        if (type !== "select" && type !== "multi_select" && type !== "boolean") continue;
        if (seenGroups.has(row.propertySchemaId)) continue;
        seenGroups.add(row.propertySchemaId);
        const groupRows = effectiveRows.filter(
          (r) => r.propertySchemaId === row.propertySchemaId,
        );
        selectDisplayGroups.push({
          propertySchemaId: row.propertySchemaId,
          label: row.schema?.name ?? row.propertySchemaId,
          options: schemasById.get(row.propertySchemaId)?.options ?? [],
          rows: groupRows,
          multi: row.schema?.multi ?? type === "multi_select",
          boolean: type === "boolean",
          display,
        });
      }
      // Bound-but-empty bindings with a row display position: no effective row
      // exists yet (no value, no default), but the button is how the value
      // gets set — the panel's empty-bindings pass, same gate: the render
      // contracts are property-level — display/hide-when-empty read from the
      // schema row; options-bearing selects only, booleans synthesize their
      // own; hide-when-empty stays hidden).
      for (const classId of node.classIds) {
        for (const binding of client.getClassBindings(classId)) {
          if (binding.type !== "select" && binding.type !== "multi_select" && binding.type !== "boolean") continue;
          if (seenGroups.has(binding.propertySchemaId)) continue;
          const schemaRow = schemasById.get(binding.propertySchemaId);
          const display = schemaRow?.display ?? null;
          if (display !== "bullet" && display !== "inline") continue;
          if (schemaRow?.hideWhenEmpty === true) continue;
          const isBoolean = binding.type === "boolean";
          const options = schemaRow?.options ?? [];
          if (!isBoolean && options.length === 0) continue;
          seenGroups.add(binding.propertySchemaId);
          selectDisplayGroups.push({
            propertySchemaId: binding.propertySchemaId,
            label: binding.name,
            options,
            rows: [],
            multi: binding.multi,
            boolean: isBoolean,
            display,
          });
        }
      }
      // Assigned-but-empty properties with a row display position ride the
      // same button pass (owner ruling 2026-10-23): the assignment row is
      // the only trace of the declaration — no binding pass sees it.
      // Bound-but-empty rows need no arm here: the binding scan above IS
      // their declaration.
      for (const { row, display } of assignedDisplayRows) {
        const schemaRow = schemasById.get(row.propertySchemaId);
        const type = schemaRow?.type;
        if (type !== "select" && type !== "multi_select" && type !== "boolean") continue;
        if (seenGroups.has(row.propertySchemaId)) continue;
        if (schemaRow?.hideWhenEmpty === true) continue;
        const isBoolean = type === "boolean";
        const options = schemaRow?.options ?? [];
        if (!isBoolean && options.length === 0) continue;
        seenGroups.add(row.propertySchemaId);
        selectDisplayGroups.push({
          propertySchemaId: row.propertySchemaId,
          label: row.schema?.name ?? row.propertySchemaId,
          options,
          rows: [],
          multi: schemaRow?.multi ?? type === "multi_select",
          boolean: isBoolean,
          display,
        });
      }
      selectDisplayGroups.sort((a, b) => a.label.localeCompare(b.label));
    }
    for (const group of selectDisplayGroups) {
      if (group.display === "bullet") bulletDisplayGroups.push(group);
      else inlineDisplayGroups.push(group);
    }
  }

  // The content read both display modes share: inline tokens read-only, or
  // the full block editor swapped in on click. The title projection
  // suppresses the block-scale widget renderers (embeds, queries,
  // whiteboards, assets) — those surfaces render in the body, never in the
  // header. The flat collection-list projection suppresses them to the
  // PLACEHOLDER fallback instead (InlineTokens names the widget): a live
  // query inside a list row could recurse, and the list names the widget
  // while the page body owns the live surface.
  // Mention opens ride `openNode` — the host funnel (the App openPage seam)
  // resolves node aliases to their terminal.
  const suppressWidget = isTitle ? () => null : undefined;
  /** The live widget renderer, or the placeholder fallback in flat lists. */
  const widget = <R,>(renderer: R): R | undefined => (suppressWidgets ? undefined : renderer);
  // The Revision-12 link-based display transformation (SCHEMA.md "Node
  // structure"), refined by the owner ruling 2026-10-16: a block whose
  // ENTIRE content is a single mention marked EMBEDDED (the token's manual
  // isEmbedded flag) presents the referenced node's content inline in
  // place (transclusion-style, regardless of the target's structural
  // role). The default link is an ordinary inline link — an unmarked
  // link-only block renders the chip. Gated off the title row (the page
  // header never transcludes), table cells, and the flat collection-list
  // projection (its rows stay one-line flat; the EmbedView cycle guard
  // rides the page's EmbedBoundary). Editing is untouched — the click
  // still swaps in the block editor; only the display projection
  // transforms.
  const linkOnlyTarget =
    isTitle || tableRow || suppressWidgets ? null : linkOnlyMentionTarget(node.contentAst);
  const tokens = linkOnlyTarget !== null ? (
    <EmbedView nodeId={linkOnlyTarget} />
  ) : (
    <InlineTokens
      tokens={node.contentAst}
      resolveName={resolveName}
      resolveFullTitle={(id) => fullTitleFromClient(client, id)}
      resolveVerb={(schemaId) =>
        outlinerClient.listPropertySchemas().find((schema) => schema.id === schemaId)?.name ?? null
      }
      onOpenNode={(targetId) => openNode(targetId)}
      onMentionMenu={(info) => openNodeLinkMenu({ blockId: node.id, ...info })}
      resolveColor={(id) => {
        const target = outlinerClient.getNode(id);
        return target === undefined ? null : outlinerClient.effectiveNodeColor(target);
      }}
      // The linked node's DEFINED effective icon (own icon else first class
      // icon — no display default, so iconless links stay text-only).
      resolveIcon={(id) => {
        const target = outlinerClient.getNode(id);
        return target === undefined ? null : definedNodeIcon(target, classIcons);
      }}
      resolveClassColor={(id) => outlinerClient.effectiveClassColor(id)}
      resolveClassAssigned={(id) => node.classIds.includes(id)}
      onAssignClass={(id) => {
        void outlinerClient.assignClass(node.id, id).catch((error: unknown) => {
          console.warn(`[block] assignClass (${id}) failed:`, error);
        });
      }}
      renderEmbed={
        suppressWidget ??
        widget((id: string, _token: unknown, index: number) => <EmbedView nodeId={id} hostId={node.id} tokenIndex={index} />)
      }
      renderEmbedCard={
        suppressWidget ??
        widget((id: string, view: "small_card" | "wide_card", _token: unknown, index: number) => (
          <EmbedCardView nodeId={id} view={view} hostId={node.id} tokenIndex={index} />
        ))
      }
      renderQuery={
        suppressWidget ??
        widget((token: unknown, index: number) => (
          <QueryBlockView
            client={outlinerClient}
            ownerId={node.id}
            tokenIndex={index}
            queryAst={(token as { queryAst?: unknown }).queryAst}
            view={(token as { view?: unknown }).view}
            rootId={rootId}
            onOpenNode={openNode}
          />
        ))
      }
      renderWhiteboard={
        suppressWidget ??
        widget((_token: unknown, index: number) => (
          <WhiteboardCanvas
            client={outlinerClient}
            hostId={node.id}
            tokenIndex={index}
            embedded
          />
        ))
      }
      renderAsset={
        suppressWidget ??
        widget((token: unknown, _index: number, fullBleed: boolean) => {
          const assetId = (token as { assetId?: unknown }).assetId;
          return typeof assetId === "string" ? (
            <AssetView client={client} assetId={assetId} fullBleed={fullBleed} />
          ) : null;
        })
      }
    />
  );

  // --- the condensed layer (owner 2026-10-15) --------------------------------
  // The excerpt re-derives at render (names-are-projections at block level):
  // an edit updates every resting block for free. The derivation rides the
  // prose coordinate system — `cutOffset` classifies each mention token as
  // visible (span start before the cut) or hidden (start at/after it) with
  // no second flatten grammar. Prose-less blocks (an excerpt of "") and
  // one-line blocks (!truncated) are their own row: they never condense.
  const excerpt = condensed ? excerptOf(node.contentAst, (classId) => outlinerClient.getDisplayName(classId)) : null;
  const stretchedFull = condensed && stretched.has(node.id);
  const excerpted =
    condensed && !editing && excerpt !== null && excerpt.text !== "" && excerpt.truncated && !stretchedFull;
  // A hidden link is a MENTION past the cut (typed links are targetless —
  // the badge never implies a link the graph can't resolve; class chips are
  // render-only by decree).
  const hiddenLinks =
    excerpted && excerpt !== null
      ? hiddenLinksOf(node.contentAst, excerpt.cutOffset, (classId) => outlinerClient.getDisplayName(classId) ?? "")
      : [];
  // A mixed block (sentence + inline image) names its prose-less payload in
  // the excerpt row — nothing silently hidden.
  const mediaCount = (() => {
    let count = 0;
    const walk = (stream: readonly unknown[]): void => {
      for (const token of stream) {
        if (typeof token !== "object" || token === null) continue;
        const t = token as { type?: unknown; children?: unknown };
        if (t.type === "asset_ref" || t.type === "embed_ref") count += 1;
        else if ((t.type === "quote" || t.type === "heading") && Array.isArray(t.children)) walk(t.children);
      }
    };
    walk(node.contentAst);
    return count;
  })();

  // Title projection: the page header's editable title — bullet-less and
  // chrome-less by definition, only the content column renders. The heading
  // role keeps the page-title landmark; the wrapper class is
  // title-specific (NOT .nt-block-content) so body-row selectors never
  // match the header row. All hooks ran above, so the early return is safe.
  if (isTitle) {
    return (
      <div
        className="nt-block nt-block--title nt-page-title"
        role="heading"
        aria-level={1}
        data-block-id={node.id}
      >
        <div className="nt-block-row">
          <div className="nt-title-content" onClick={enterEdit}>
            {editing ? (
              <BlockTextEditor
                node={node}
                caret={caret}
                onExitEdit={() => setEditing(false)}
                variant="title"
              />
            ) : (
              tokens
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`nt-block${readOnly ? " nt-block--readonly" : ""}${readOnly && readOnlyInert ? " nt-block--inert" : ""}${editing ? " nt-block--editing" : ""}${gripMenu !== null ? " nt-block--menu-open" : ""}${isCollapsed && children.length > 0 ? " nt-block--collapsed" : ""}${dropClass}${selectedClass}${dragSourceClass}`}
      ref={(el) => {
        blockRef.current = el;
        setNodeRef(el);
      }}
      data-block-id={node.id}
    >
      <div className="nt-block-row" ref={rowRef}>
        <span
          className="nt-block-grip"
          title="Drag to move"
          {...attributes}
          {...listeners}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (readOnly) return;
            setGripMenu({ x: event.clientX, y: event.clientY });
          }}
        >
          {children.length > 0 && !ruleDisplay && (
            <button
              type="button"
              className="nt-block-chevron"
              aria-label={isCollapsed ? "Expand block" : "Collapse block"}
              aria-expanded={!isCollapsed}
              onClick={(event) => {
                // The chevron is a display toggle, not content editing.
                event.stopPropagation();
                toggleCollapse(node.id);
              }}
            >
              {isCollapsed ? (
                <Icon path="mdi-chevron-right" size={0.8} />
              ) : (
                <Icon path="mdi-chevron-down" size={0.8} />
              )}
            </button>
          )}
          <span
            className={`nt-bullet${isCollapsed && children.length > 0 ? " nt-bullet--collapsed" : ""}`}
            title="Zoom in (Shift+click: open in sidebar)"
            onClick={(event) => {
              event.stopPropagation();
              // Shift+click peeks the block in the right sidebar; a plain
              // click zooms to the focused block view.
              if (event.shiftKey) {
                openInSidebar(node.id);
              } else {
                openNode(node.id);
              }
            }}
          >
            {!ruleDisplay && children.length > 0 && (
              <span className="nt-bullet-ring" aria-hidden="true" />
            )}
            {ruleDisplay ? null : !focusMode && gripIcon !== null ? (
              <span className="nt-bullet-icon">
                <Icon path={gripIcon} size={0.8} />
              </span>
            ) : listMarker !== null ? (
              <span className="nt-list-marker" aria-hidden="true">
                {listMarker}
              </span>
            ) : (
              <span className="nt-bullet-dot" aria-hidden="true" />
            )}
          </span>
        </span>
        {/* The value-display buttons: the bullet group
            hugs the bullet element, the inline group hugs the content.
            Siblings of the grip and content — never inside .nt-block-content
            (the contentEditable DOM must stay untouched). In read-only
            projections the icons render but open nothing. Focus mode (#12)
            hides both groups — properties are exactly what it suppresses. */}
        {!focusMode && bulletDisplayGroups.length > 0 && (
          <span className="nt-block-bullet-props">
            {bulletDisplayGroups.map((group) => (
              <PropertyIconButton
                key={group.propertySchemaId}
                client={client}
                nodeId={node.id}
                propertySchemaId={group.propertySchemaId}
                label={group.label}
                options={group.options}
                rows={group.rows}
                multi={group.multi}
                boolean={group.boolean}
                disabled={readOnly}
              />
            ))}
          </span>
        )}
        {!focusMode && inlineDisplayGroups.length > 0 && (
          <span className="nt-block-inline-props">
            {inlineDisplayGroups.map((group) => (
              <PropertyIconButton
                key={group.propertySchemaId}
                client={client}
                nodeId={node.id}
                propertySchemaId={group.propertySchemaId}
                label={group.label}
                options={group.options}
                rows={group.rows}
                multi={group.multi}
                boolean={group.boolean}
                disabled={readOnly}
              />
            ))}
          </span>
        )}
        {/* The condensed row stays EDITABLE (owner refinement 2026-10-15):
            clicking anywhere on it enters edit on the block's FULL content —
            the excerpt is display chrome and the editor always edits the
            real content (no data-path change). Blur re-condenses the row;
            the "…" mark is the only way into (and out of) the pinned
            read-mode row. */}
        {/* The text owns the bullet's context menu: right-click anywhere on
            the block's prose opens the node menu (owner 2026-10-15). While
            editing the session keeps its own menu (mention pills, typed
            links, browser menu on plain text) — the guard returns before
            preventDefault so that flow is untouched. An inner element that
            already claimed the menu (the mention pill preventDefaults on
            its own onContextMenu) wins through defaultPrevented. Read-only
            mirrors the grip: the native menu is suppressed, nothing
            opens. */}
        <div
          className="nt-block-content"
          onClick={enterEdit}
          onContextMenu={(event) => {
            if (editing) return;
            if (event.defaultPrevented) return;
            event.preventDefault();
            event.stopPropagation();
            if (readOnly) return;
            setGripMenu({ x: event.clientX, y: event.clientY });
          }}
        >
          {ruleDisplay ? (
            // The rule replaces bullet + text at display time; clicking the
            // row still enters edit (the standard click-to-edit — the editor
            // shows the raw dashes, so the block is never invisible/trapped).
            <hr className="nt-block-rule" />
          ) : editing ? (
            <BlockTextEditor node={node} caret={caret} onExitEdit={() => setEditing(false)} />
          ) : excerpted && excerpt !== null ? (
            <>
              <span className="nt-block-excerpt">{excerpt.text}</span>
              {/* The "…" IS the toggle (owner ruling 2026-10-15): the classic
                  stretchtext mark is now the layer's ONE control in both
                  directions — tap to pin (stretch in place), and on a pinned
                  row it returns at the END of the text to un-pin. Generous
                  hit padding (it is a small glyph); the click stops so it
                  pins instead of entering edit. */}
              <button
                type="button"
                className="nt-block-excerpt__ellipsis"
                aria-label="Show full content"
                title="Show full content"
                onClick={(event) => {
                  event.stopPropagation();
                  toggleStretched(node.id);
                }}
              >
                …
              </button>
              {mediaCount > 0 && (
                <span className="nt-block-excerpt__media" title="Contains media">
                  ⊞ image
                </span>
              )}
              {/* Revealed with the row (hover + focus-within, the CSS pair) —
                  the links badge opens the hidden-targets popup. */}
              <span className="nt-block-excerpt__chrome">
                {hiddenLinks.length > 0 && (
                  <button
                    type="button"
                    ref={linksBadgeRef}
                    className="nt-block-links-badge"
                    aria-label={`${hiddenLinks.length} hidden links`}
                    aria-expanded={linksPopupOpen}
                    title={`${hiddenLinks.length} hidden links`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setLinksPopupOpen((open) => !open);
                    }}
                  >
                    <Icon path="mdi-link-variant" size={0.7} />
                    <Badge size="xs">{hiddenLinks.length}</Badge>
                  </button>
                )}
                {linksPopupOpen && (
                  <CondensedLinksPopup
                    client={client}
                    links={hiddenLinks}
                    anchorRef={linksBadgeRef}
                    onOpenNode={openNode}
                    onClose={() => setLinksPopupOpen(false)}
                  />
                )}
              </span>
            </>
          ) : condensed && stretchedFull ? (
            <>
              {tokens}
              {/* The "…" returned at the END OF THE TEXT (owner ruling: NOT
                  the row's right edge — it follows the last word wherever
                  the text wraps, permanent and tappable). Tap → un-pin; the
                  click stops so it condenses instead of entering edit. The
                  badge never rides a pinned row: all text is visible, so
                  the hidden-link count is 0 by definition. Pinned renders
                  as a FILLED CHIP in the app's active-toggle register
                  (owner refinement: muted mark = closed, filled chip =
                  open) — the chip is the single cue in every mode. */}
              <button
                type="button"
                className="nt-block-excerpt__ellipsis nt-block-excerpt__ellipsis--pinned"
                aria-label="Condense"
                title="Condense"
                onClick={(event) => {
                  event.stopPropagation();
                  toggleStretched(node.id);
                }}
              >
                …
              </button>
            </>
          ) : (
            tokens
          )}
        </div>
        {/* Right end of the row: the classes column (first pill + "+N"
            overflow popup, drag to reorder) and the backlink gutter toggle
            (SCHEMA.md:117 — the count badge rides the materialized
            node_stats number). The gutter is reference material, so it shows
            in read-only projections too; the classes column also renders in
            read-only (hiding only when the row carries no classes at all)
            and stays MUTABLE there — owner ruling 2026-10-21: class
            membership answers edits from reference rows (× / "+" /
            drag-sort); only the date-chain lock renders it static. */}
        {!focusMode && (backlinkCount > 0 || !readOnly || node.classIds.length > 0) && (
          <div className="nt-block-row-end">
            {(!readOnly || node.classIds.length > 0) && (
              <div className="nt-block-classes">
                <NodePills
                  client={client}
                  nodeId={node.id}
                  classIds={node.classIds}
                  onOpenPage={openNode}
                  overflow
                  iconOnlyAdd
                  addAtStart
                  readOnly={classesLocked}
                />
              </div>
            )}
            {backlinkCount > 0 && !focusMode && (
              <BlockBacklinkToggle
                count={backlinkCount}
                expanded={backlinksExpanded}
                onToggle={() => setBacklinksExpanded((v) => !v)}
              />
            )}
          </div>
        )}
      </div>
      {/* Expanded block backlinks: the linked-references system query scoped
          to this block, lazy per the section contract (query on first
          toggle, cached until an invalidating notification). Hidden in
          focus mode (#12) with the gutter toggle. */}
      {backlinkCount > 0 && !focusMode && (
        <BlockBacklinkPanel nodeId={node.id} expanded={backlinksExpanded} client={client} />
      )}
      {/* Tags: dedicated row below the block row, only when set (assignment
          rides the `#` trigger). Read-only projections render the same row
          with static pills (edit/read alignment). Focus mode (#12) hides
          them with the rest of the block metadata. */}
      {!focusMode && node.tagIds.length > 0 && (
        <div className="nt-block-tags">
          <TagsRow client={client} nodeId={node.id} tagIds={node.tagIds} onOpenPage={openNode} readOnly={readOnly} />
        </div>
      )}
      {/* Properties: the same collapsed "Metadata N" section the page view
          uses, rendered in read-only with static values so the row stays
          aligned with its editable twin. Rows whose schema display rides
        the block row (bullet/inline) are omitted — the button above
        already surfaces the value. Focus mode (#12) hides the whole
        section. */}
      {!focusMode && (
        <PropertiesSection
          client={client}
          nodeId={node.id}
          onOpenPage={openNode}
          hideWhenEmpty
          omitDisplayPositions={ROW_DISPLAY_POSITIONS}
          readOnly={readOnly}
        />
      )}
      {/* Block-level metadata now lives around the row: classes ride the
          right-hand column, tags the dedicated row below, properties the
          collapsed "Properties N" section (all above). */}
      <NodeContextMenu
        state={gripMenu === null ? null : { ...gripMenu, node, isPage: false }}
        client={outlinerClient}
        onClose={() => setGripMenu(null)}
        onOpenNode={openNode}
      />
      {/* A table container's children are the grid rows. The
          column template comes from the FIRST row's cell count; ragged rows
          show blanks (fewer cells) or spill into implicit tracks (more).
          The + Row / + Column hover affordance rides the container (hidden
          in read-only projections). A display-time rule suppresses the
          whole subtree zone: a rule terminates a section, so neither the
          table grid nor the children container renders. */}
      {!ruleDisplay && (isTableContainer ? (
        <>
          {!readOnly && (
            <div className="nt-blocktable-toolbar" role="toolbar" aria-label="Table">
              <Button
                size="xs"
                variant="ghost"
                icon="mdiTableRowPlusAfter"
                aria-label="Add row"
                onClick={() => {
                  void addTableRow(client, node.id, tableColumnCount(children));
                }}
              >
                Row
              </Button>
              <Button
                size="xs"
                variant="ghost"
                icon="mdiTableColumnPlusAfter"
                aria-label="Add column"
                onClick={() => {
                  void addTableColumn(client, children);
                }}
              >
                Column
              </Button>
              {/* − Row / − Column: the inline-confirm pattern (a delete is
                  destructive; the confirm/check row replaces the trigger).
                  The last row / right-most column are the targets — the
                  append gestures' mirror. */}
              <InlineConfirmButton
                size="sm"
                variant="ghost"
                title="Delete last row"
                confirmTitle="Confirm delete row"
                cancelTitle="Cancel"
                disabled={children.length === 0}
                onConfirm={() => {
                  const last = children[children.length - 1];
                  if (last !== undefined) void deleteTableRow(client, last);
                }}
              >
                − Row
              </InlineConfirmButton>
              <InlineConfirmButton
                size="sm"
                variant="ghost"
                title="Delete last column"
                confirmTitle="Confirm delete column"
                cancelTitle="Cancel"
                disabled={tableColumnCount(children) === 0}
                onConfirm={() => {
                  void deleteTableColumn(client, children, tableColumnCount(children) - 1);
                }}
              >
                − Column
              </InlineConfirmButton>
            </div>
          )}
          {children.length > 0 && !isCollapsed && (
            <div
              className="nt-blocktable"
              style={{
                gridTemplateColumns: `repeat(${tableColumnCount(children)}, minmax(0, 1fr))`,
              }}
            >
              <SortableContext items={childIds} strategy={verticalListSortingStrategy}>
                {children.map((child) => (
                  <BlockRow
                    key={child.node.id}
                    tree={child}
                    client={client}
                    resolveName={resolveName}
                    readOnly={readOnly}
                    proseMode={proseMode}
                    tableRow
                    suppressWidgets={suppressWidgets}
                    hideBacklinks={hideBacklinks}
                  />
                ))}
              </SortableContext>
            </div>
          )}
        </>
      ) : (
      <>
        {(children.length > 0 || trailingGhost !== undefined) && !isCollapsed && (
          <SortableContext items={childIds} strategy={verticalListSortingStrategy}>
            <div className="nt-block-children" ref={childrenRef}>
              {/* The vertical indent line is itself the fold control (owner
                  rule 2026-10-14): one click anywhere on it folds EACH direct
                  child individually — the owner's own expansion stays, the
                  children rows remain, their subtrees fold at once. The
                  rail's top extends to the row's bottom edge across the
                  metadata sections (see extendRail), so the line reaches
                  the bullet. */}
              {/* The indent-line fold gesture stays OUTLINE-ONLY (owner ruling
                  2026-10-15): prose flattens the indents, so there is no rail
                  to ride — collapse in prose owns the chevron alone. */}
              {!proseMode && (
                <button
                  type="button"
                  className="nt-block-children__rail"
                  aria-label="Collapse children"
                  title="Collapse children"
                  ref={railRef}
                  onClick={collapseFromRailClick}
                />
              )}
              {children.map((child) => (
                <BlockRow
                  key={child.node.id}
                  tree={child}
                  client={client}
                  resolveName={resolveName}
                  readOnly={readOnly}
                  proseMode={proseMode}
                  condensed={condensed}
                  suppressWidgets={suppressWidgets}
                  hideBacklinks={hideBacklinks}
                />
              ))}
              {/* The trailing ghost (the focused block view's "+ Add block"
                  affordance) rides the children container at the CHILD
                  indent level — never a sibling of this row — after the
                  last real child. */}
              {trailingGhost}
            </div>
          </SortableContext>
        )}
      </>
      ))}
    </div>
  );
}

/**
 * Structural share for the id arrays feeding dnd-kit's SortableContext: its
 * context value keys on the items array's IDENTITY, so a fresh array per
 * render re-renders every sortable row through context — defeating the row
 * memo. The render-phase ref write mirrors the file's latest-value pattern;
 * the array is replaced only when the id SEQUENCE changes.
 */
export function useStableIdArray(ids: string[]): string[] {
  const ref = useRef<string[]>(ids);
  const prev = ref.current;
  if (prev.length !== ids.length || prev.some((id, index) => id !== ids[index])) {
    ref.current = ids;
  }
  return ref.current;
}

/**
 * The ids whose changes force a row to re-render: the row's own node (the
 * materialized backlink count and the effective property values change
 * WITHOUT the node identity changing), its class ids (chip labels/icons),
 * and its content's mention / class-link targets (chip titles). Slice 3's
 * edge-target inclusion lands exactly these ids in a content change's
 * affected set, so a scoped notification check covers them — and one naming
 * none of them leaves the memo's bail intact (the op-lag win).
 */
function collectRerenderTargets(node: ClientNode): Set<string> {
  const targets = new Set<string>([node.id, ...node.classIds]);
  const walk = (tokens: readonly unknown[]): void => {
    for (const token of tokens) {
      if (typeof token !== "object" || token === null) continue;
      const t = token as {
        type?: unknown;
        targetNodeId?: unknown;
        classId?: unknown;
        children?: unknown;
      };
      if (t.type === "mention" && typeof t.targetNodeId === "string") targets.add(t.targetNodeId);
      else if (t.type === "class_link" && typeof t.classId === "string") targets.add(t.classId);
      if (Array.isArray(t.children)) walk(t.children);
    }
  };
  walk(node.contentAst);
  return targets;
}

/**
 * Row bail-out contract (op-lag row-bailout): a row re-renders only when a
 * prop it renders from changes. `tree` compares by NODE IDENTITY at every
 * level — client rows are identity-stable across store revisions
 * (mapNodeCached's column-stamp cache; the node-identity spec in
 * workspace-client.test.ts), so an unchanged subtree bails even though the
 * view-level tree wrappers are rebuilt per render. Every scalar/enum prop
 * compares by value; `resolveName` and `trailingGhost` compare by REFERENCE
 * — a render site that passes a referentially unstable callback simply
 * never bails (the pre-memo behavior), it can never be served a stale
 * closure. Context (the outliner value) is memo-stable by construction, so
 * context-driven re-renders fire exactly when the tree/collapse/selection
 * facts change — which the node-identity compare then refines per row.
 */
function sameTreeNode(a: BlockTreeNode, b: BlockTreeNode): boolean {
  if (a.node !== b.node || a.children.length !== b.children.length) return false;
  for (let i = 0; i < a.children.length; i += 1) {
    if (!sameTreeNode(a.children[i]!, b.children[i]!)) return false;
  }
  return true;
}

function areBlockRowPropsEqual(prev: BlockRowProps, next: BlockRowProps): boolean {
  return (
    prev.client === next.client &&
    prev.resolveName === next.resolveName &&
    prev.readOnly === next.readOnly &&
    prev.readOnlyInert === next.readOnlyInert &&
    prev.suppressWidgets === next.suppressWidgets &&
    prev.proseMode === next.proseMode &&
    prev.condensed === next.condensed &&
    prev.tableRow === next.tableRow &&
    prev.variant === next.variant &&
    prev.hideBacklinks === next.hideBacklinks &&
    prev.autoEdit === next.autoEdit &&
    prev.trailingGhost === next.trailingGhost &&
    sameTreeNode(prev.tree, next.tree)
  );
}

/**
 * The memoized row: an unchanged row (stable node identities at every tree
 * level + unchanged props) bails out of re-rendering while its parent view
 * re-reenders around an edit elsewhere. `BlockRowRenderer` stays exported
 * by name — the render-count specs spy on it (a spy on the memo wrapper
 * itself could not intercept renders).
 */
export const BlockRow = memo(BlockRowRenderer, areBlockRowPropsEqual);
