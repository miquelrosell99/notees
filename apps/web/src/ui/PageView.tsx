/**
 * PageView — a page inside the floating content card: the ancestor
 * breadcrumbs, the page header (icon + editable title + view toggles), the
 * collapsible Metadata section, the recursive block tree of the page's
 * children + the "add block" affordance for an empty page, then (after a
 * divider) the system sections (linked references — expanded, child pages
 * and unlinked references — collapsed) per SCHEMA.md's lazy-loading
 * contract. Reads from a client (in-process WorkspaceClient or the
 * WorkerClient proxy — same surface) and re-renders on its (naive)
 * notifications.
 *
 * PageView also owns the OutlinerContext: the write surface, the per-render
 * outline position map (sibling/parent facts for Tab/Backspace), the focus
 * request that hands the caret between blocks after structural gestures, and
 * the session-local view transforms: subtree collapse (a Set of hidden node
 * ids, display-only) and prose mode (the `nt-prose` class on the tree).
 *
 * Editor chrome owned here: the find & replace widget (Ctrl/Cmd+Shift+F)
 * searching the block tree's prose projection, and the page-level
 * LinkEditModal host for NODE links (owner ruling: external links navigate —
 * they never open the modal; the slash "Add URL" flow authors the token
 * directly in the editor — see editor-popups/).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { DndContext, DragOverlay, type DragEndEvent, type DragMoveEvent, type DragStartEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";

import { rendersWithDocumentChrome, parseDateNodeId, SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { BlockTreeNode, ClientNode, WorkspaceClient } from "@/core/workspace-client.js";
import { proseFromAst } from "@/editor/prose.js";

import { ExportPageModal } from "./components/modals/ExportPageModal.js";
import { SharePageModal } from "./components/modals/SharePageModal.js";
import type { ShareTarget } from "./components/NodeMenuButton.js";
import { NodeContextMenu } from "./components/NodeContextMenu.js";
import { DayPageHeader } from "./components/DayPageHeader.js";
import { DayPageSections } from "./components/DayPageSections.js";
import { CreatedSection } from "./components/CreatedSection.js";
import { isoOfDateParts, createdPeriodBounds } from "./components/calendarViewUtils.js";
import { nodeIcon } from "./iconFor.js";
import { displayNameForSettings, displayNameFromClient } from "./dateDisplay.js";

import {
  DropLineContext,
  blockCollisionDetection,
  dropLineFromDragEvent,
  dropZoneOf,
  executeMove,
  executeMoveFromClient,
  moveErrorMessage,
  resolveMove,
  resolveMoveFromClient,
  useBlockDndSensors,
  type DropLine,
} from "./block-dnd.js";
import { PropertiesSection, PropertiesSidebar, ClassesRow, TagsRow } from "./components/MetadataSection.js";
import { IconPickerPopup } from "./components/IconPickerPopup.js";
import { BannerCard, CoverCard, bannerAssetIdOf, setNodeBanner } from "./components/PageBanner.js";
import { AssetUploadModal } from "./components/modals/AssetUploadModal.js";
import { PageFooter } from "./components/PageFooter.js";
import { SelectionBar } from "./components/SelectionBar.js";
import { SystemSections } from "./components/SystemSections.js";
import { canHaveCoverOf, coverAssetIdOf, ensureCoverProperty } from "./components/coverProperty.js";
import { ensureAliasProperty } from "./components/aliasProperty.js";
import { AliasesButton } from "./components/AliasesButton.js";
import { AliasOfBanner } from "./components/AliasOfBanner.js";
import { useDeviceSetting } from "./components/modals/deviceSettings.js";
import { EmbedBoundary } from "./EmbedView.js";
import { Icon } from "./Icon.js";
import { BlockRow } from "./BlockRow.js";
import { WhiteboardCanvas } from "./WhiteboardCanvas.js";
import { OutlinerContext, useOutlinerValue } from "./outliner-context.js";
import { useBlockSelectionSurface } from "./use-block-selection.js";
import { NodeCollection } from "./views/index.js";
import type { NodeCollectionItem, ViewMode } from "./views/index.js";
import { useViewModePreference } from "./viewPrefs.js";
import { FindReplaceWidget } from "./editor-popups/FindReplaceWidget.js";
import {
  LinkEditModalHost,
} from "./editor-popups/LinkEditModal.js";
import { replaceRangeInAst } from "./editor-popups/block-find-replace.js";
import { ensureTemplateFamily } from "./components/templateFamily.js";
import { GhostRow, realizeGhost } from "./GhostRow.js";

/** The child-blocks triad, in switcher order. Exported for the NodeView
 *  chrome, which hosts the switcher at the card's top-right. */
export const BLOCKS_VIEW_MODES: ViewMode[] = ["outline", "prose", "cards"];

/** BlockTreeNode → the collection input shape (recursive). */
function toCollectionItem(entry: BlockTreeNode): NodeCollectionItem {
  return { node: entry.node, children: entry.children.map(toCollectionItem) };
}

export function PageView({
  client,
  pageId,
  onOpenPage,
  onOpenPageRaw,
  onOpenInSidebar,
  onDeleted,
  onPresent,
  embedded = false,
  /**
   * Layout mode (owner 2026-10-06, the Capacities-style main layout):
   * "default" (the main content card) puts the properties in a collapsible
   * LEFT side panel inside the card, the classes pills at the content
   * column's top-left, and moves the blocks view switcher out to the card's
   * top-right (the NodeView chrome). "compact" keeps the in-flow chrome —
   * the properties as a list section under the header — for secondary
   * surfaces (sidebar peek cards; embedded renders keep their own slim
   * chrome). Focus mode always compacts.
   */
  layout = "default",
  /**
   * The child-blocks view mode, lifted to the NodeView chrome when the host
   * renders the switcher at the card's top-right; falls back to the internal
   * per-page device preference when unset (embedded renders).
   */
  blocksMode: blocksModeProp = undefined,
  onBlocksModeChange = undefined,
  /**
   * The card's top-right chrome (the blocks view switcher + the "…" node
   * menu), owned by NodeView. In the panelled main layout it rides the
   * nodeview top bar's right section; compact layouts render it in the
   * absolute top-right corner (as before).
   */
  chromeRight = undefined,
  /**
   * Class composition (the Class View renders a class node through PageView):
   * accepts a class node in the page read (getPage excludes classes), adds
   * `rootClassName` to the `.nt-page` root, and enables the slots below. All
   * slots default to the plain-page chrome.
   */
  forClass = false,
  rootClassName = undefined,
  /** Replaces the default classes corner cluster (ClassView: extends pills). */
  corner = undefined,
  /** Replaces the default header icon button + picker (ClassView: curated). */
  iconButton = undefined,
  /** Right-aligned extras in the title row (ClassView: the class color dot). */
  headerActions = undefined,
  /** Rendered right after the header (ClassView: the extends-cycle banner). */
  notice = undefined,
  /** Inserted between the block tree and the system sections (class sections). */
  sections = undefined,
  /** Replaces the default <SystemSections/> (ClassView: extends-by + system). */
  systemSections = undefined,
  /** Shares: server coordinates for the "Share…" item + modal. */
  shareTarget = undefined,
}: {
  client: WorkspaceClient | WorkerClient;
  pageId: string;
  /** Page navigation (child-pages rows, reference crumbs). */
  onOpenPage?: ((pageId: string) => void) | undefined;
  /**
   * The RAW page navigation (no alias redirect): the aliases UI's NAVIGATE
   * opens an alias node's OWN view through this. Defaults to onOpenPage.
   */
  onOpenPageRaw?: ((pageId: string) => void) | undefined;
  /** Shift+click peek target: open the node as a card in the right sidebar. */
  onOpenInSidebar?: ((nodeId: string) => void) | undefined;
  /** Post-delete navigation (host routes to the parent / default view). */
  onDeleted?: ((node: ClientNode) => void) | undefined;
  /** Presentation mode: "Present" decks this page's subtree read-only. */
  onPresent?: ((pageId: string) => void) | undefined;
  /**
   * Embedded mode (journals feed): the title renders as a static button that
   * navigates to the full page view instead of the inline editable title
   * row, and the page-level find/replace shortcut stays off so stacked
   * feeds don't install one document listener per entry.
   */
  embedded?: boolean;
  layout?: "default" | "compact";
  blocksMode?: ViewMode;
  onBlocksModeChange?: ((mode: ViewMode) => void) | undefined;
  chromeRight?: ReactNode;
  forClass?: boolean;
  rootClassName?: string | undefined;
  corner?: ReactNode;
  iconButton?: ReactNode;
  headerActions?: ReactNode;
  notice?: ReactNode;
  sections?: ReactNode;
  systemSections?: ReactNode;
  shareTarget?: ShareTarget | undefined;
}) {
  /**
   * Child-blocks view mode (the outline/prose/cards triad): durable display
   * state per page — device-local, never an op. Unset/stale
   * values fall back to outline, the surface default. The main NodeView owns
   * the switcher (card top-right) and passes the mode down; standalone
   * renders keep the internal preference.
   */
  const [internalBlocksMode, setInternalBlocksMode] = useViewModePreference(
    `nodeBlocks.${pageId}`,
    "outline",
    BLOCKS_VIEW_MODES,
  );
  const blocksMode = blocksModeProp ?? internalBlocksMode;
  const setBlocksMode = onBlocksModeChange ?? setInternalBlocksMode;
  /**
   * Focus mode (#12) — device-local: the page keeps its title and editable
   * body, but the surrounding chrome (classes corner, header icon, tags,
   * cover, date bar, properties, system sections, footer) steps aside.
   */
  const [focusMode] = useDeviceSetting("focusMode", false);
  /**
   * The Capacities-style main layout: left properties panel + classes at the
   * content top-left. Device-local collapse (never an op); class composition
   * and focus mode keep the compact in-flow chrome.
   */
  const [sidePanelCollapsed, setSidePanelCollapsed] = useDeviceSetting(
    "pageSidePanelCollapsed",
    false,
  );
  const panelled =
    layout === "default" && !embedded && !focusMode && !forClass;
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number } | null>(null);
  /** Icon picker popup anchor + open state (clicking the page icon). */
  const pageIconRef = useRef<HTMLElement | null>(null);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [exporting, setExporting] = useState<{ pageId: string; name: string } | null>(null);
  const [sharing, setSharing] = useState<{ pageId: string; name: string } | null>(null);
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);
  /**
   * View transforms (SCHEMA.md: display state, never content). Collapse is a
   * per-session set of hidden subtree roots; prose mode flattens bullets and
   * indents via the `nt-prose` class. Neither is persisted in this slice.
   * (Collapse state itself lives in the OutlinerContext value, see the hook.)
   */

  // --- editor chrome: find & replace + link edit modal -----------------------

  /** Page root: find/replace highlights blocks inside it. */
  const pageRootRef = useRef<HTMLDivElement>(null);
  /** The block-tree selection surface (multi-selection gestures). */
  const selectionRootRef = useRef<HTMLDivElement>(null);
  const [findOpen, setFindOpen] = useState(false);

  // Ctrl/Cmd+Shift+F opens the find & replace widget (page view only —
  // embedded journal entries skip it so feeds don't stack document listeners).
  useEffect(() => {
    if (embedded) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setFindOpen(true);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [embedded]);

  const handleFindReplace = useCallback(
    (blockId: string, start: number, end: number, text: string) => {
      const block = client.getNode(blockId);
      if (block === undefined) return;
      void client.updateObject(blockId, {
        contentAst: replaceRangeInAst(block.contentAst, start, end, text),
      });
    },
    [client],
  );

  // --- drag-and-drop reordering (block-dnd.ts intent model) -------------------
  const sensors = useBlockDndSensors();
  const [dropLine, setDropLine] = useState<DropLine | null>(null);
  const [dragging, setDragging] = useState<{ id: string; label: string } | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  useEffect(() => {
    if (moveError === null) return;
    const timer = setTimeout(() => setMoveError(null), 4000);
    return () => clearTimeout(timer);
  }, [moveError]);

  // The page read accepts a class node only in class composition (getPage
  // excludes classes by design — rendersWithDocumentChrome is the page test).
  const rawNode = client.getNode(pageId);
  const page =
    rawNode !== undefined &&
    (rendersWithDocumentChrome(rawNode) || (forClass && rawNode.isClass))
      ? rawNode
      : undefined;
  const headerIcon =
    page !== undefined ? nodeIcon(page, client.effectiveClassIcons()) : null;
  const tree = page !== undefined ? client.getBlockTree(pageId) : [];
  /** The same tree in the view system's input shape (session view state). */
  const blockItems: NodeCollectionItem[] = tree.map(toCollectionItem);
  /**
   * The day branch: a node whose id parses at day precision
   * is a day page and gets the date header (weekday/Today flags + the week
   * flag, owner 2026-10-06) and the three aggregation sections. The month
   * and year pages carry the Created aggregation too (owner 2026-10-06).
   * Embedded renders (journal feed, calendar daily-note embed) skip both —
   * they already sit on aggregation surfaces.
   */
  const parsedDay = page !== undefined ? parseDateNodeId(pageId) : null;
  const dayIso =
    parsedDay !== null && parsedDay.precision === "day" ? isoOfDateParts(parsedDay) : null;
  /** Month/year Created bounds (null on day pages and non-date nodes). */
  const createdPeriod =
    page !== undefined && parsedDay !== null && parsedDay.precision !== "day"
      ? createdPeriodBounds({
          year: parsedDay.year,
          month: parsedDay.month,
          precision: parsedDay.precision,
        })
      : null;

  // Fullscreen whiteboard (SCHEMA.md: a whiteboard page carries a
  // `whiteboard` content token — the whiteboard CLASS, not any node kind,
  // says so): the spatial canvas renders IN PLACE OF the outline tree — the
  // children are the cards. The whiteboard CLASS is identity too (owner
  // ruling): a node classed `whiteboard` whose content carries no token yet
  // still opens in whiteboard mode — the token is authored lazily on open.
  const whiteboardTokenIndex = page?.contentAst.findIndex(
    (token) =>
      typeof token === "object" && token !== null &&
      (token as { type?: unknown }).type === "whiteboard",
  ) ?? -1;
  const whiteboardClassed =
    page !== undefined && page.classIds.includes(SYSTEM_CLASS_UUIDS.whiteboard);
  useEffect(() => {
    if (
      page === undefined ||
      embedded ||
      whiteboardTokenIndex >= 0 ||
      !whiteboardClassed
    ) {
      return;
    }
    void client.updateObject(page.id, {
      contentAst: [...page.contentAst, { type: "whiteboard", layout: { cards: {}, shapes: [], strokes: [] } }],
    });
  }, [client, page, embedded, whiteboardTokenIndex, whiteboardClassed]);

  /**
   * Cover property self-heal: the cover schema + source binding
   * are seed-manifest entries nothing else authors (the migration import is
   * the only other writer), so a fresh workspace self-heals them on first page
   * view — an idempotent no-op once present. The banner below then reads
   * the effective cover value; pages without one (date pages, whiteboard
   * pages, everything not classed `source`) render no banner at all.
   */
  useEffect(() => {
    void ensureCoverProperty(client);
  }, [client]);

  /**
   * Alias property self-heal: the seeded multi-value `alias` text schema
   * (global scope, no class binding) is authored idempotently on first page
   * view — the server seed only runs on an empty workspace, so existing
   * workspaces would never see it otherwise (the ensureCoverProperty
   * precedent). The node-alias carrier is the `aliasedNodeId` wire node
   * field — no schema to ensure.
   */
  useEffect(() => {
    void ensureAliasProperty(client);
  }, [client]);

  /** The cover's asset target, when the page carries the property. */
  const coverAssetId =
    page !== undefined && !embedded && whiteboardTokenIndex < 0
      ? coverAssetIdOf(client, pageId)
      : null;
  /** The cover element renders whenever the page can carry a cover —
   *  set or empty (the card shows the Add affordance when empty). */
  const coverPossible =
    page !== undefined && !embedded && whiteboardTokenIndex < 0
      ? canHaveCoverOf(client, pageId)
      : false;

  /**
   * The banner (the bannerAssetId wire field): the full-width element above
   * the header. Renders whenever the page can carry one — set or empty —
   * like the cover; whiteboard pages and embedded renders host none (the
   * cover gating precedent). The upload modal is host-owned so the page
   * context menu's Add banner rides the same flow as the empty affordance.
   */
  const bannerAssetId =
    page !== undefined && !embedded && whiteboardTokenIndex < 0
      ? bannerAssetIdOf(client, pageId)
      : null;
  const bannerPossible = page !== undefined && !embedded && whiteboardTokenIndex < 0;
  const [bannerUploadOpen, setBannerUploadOpen] = useState(false);

  const outliner = useOutlinerValue(client, pageId, {
    // Render-cascade navigation for query result lists (App routes the id).
    openNode: (id) => onOpenPage?.(id),
    openInSidebar: (id) => onOpenInSidebar?.(id),
    // The slash template flow self-heals the template family
    // before instantiating (idempotent no-op once present).
    ensureTemplateFamily: () => ensureTemplateFamily(client),
    // Block multi-selection: the main page body is a selection
    // surface; embedded feed entries and class composition aren't.
    selection: !embedded && !forClass,
    // Focus mode (#12): block rows hide their reference/property chrome.
    focusMode,
  });
  const positions = outliner.positions;
  const outlinerRef = useRef(outliner);
  outlinerRef.current = outliner;

  // Ctrl+. (toggle) / Ctrl+Alt+← (fold) / Ctrl+Alt+→ (unfold) — the
  // fold chords on the FOCUSED block (the row is discovered from the active
  // element — the editor stays the focus owner, no focus ledger). Alt+←/→
  // belongs to Back/Forward (the App keymap), so fold moved to the Ctrl+Alt+
  // arrow pair (free in Chrome/Firefox/Safari; some OS display drivers rotate
  // the screen on it — out of the page's reach, same story with
  // Alt+arrows in browsers).
  useEffect(() => {
    if (embedded) return;
    const handler = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const key = event.key;
      const toggle = !event.altKey && !event.shiftKey && key === ".";
      const fold = event.altKey && !event.shiftKey && key === "ArrowLeft";
      const unfold = event.altKey && !event.shiftKey && key === "ArrowRight";
      if (!toggle && !fold && !unfold) return;
      const root = pageRootRef.current;
      const active = document.activeElement;
      if (root === null || !(active instanceof Element) || !root.contains(active)) return;
      const blockId = active.closest("[data-block-id]")?.getAttribute("data-block-id");
      if (blockId === null || blockId === undefined) return;
      if (outlinerRef.current.client.getChildren(blockId).length === 0) return;
      event.preventDefault();
      const collapsed = outlinerRef.current.collapsed.has(blockId);
      if (fold) {
        if (!collapsed) outlinerRef.current.toggleCollapse(blockId);
      } else if (unfold) {
        if (collapsed) outlinerRef.current.toggleCollapse(blockId);
      } else {
        outlinerRef.current.toggleCollapse(blockId);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [embedded]);

  // --- block multi-selection ----------------------------------------------------
  const selectionSurface = useBlockSelectionSurface(
    outliner,
    selectionRootRef,
    !embedded && !forClass,
  );

  /** Searchable documents: one prose projection per block in the tree. */
  const findDocs = useMemo(() => {
    const docs: { id: string; prose: string }[] = [];
    const walk = (nodes: BlockTreeNode[]) => {
      for (const entry of nodes) {
        docs.push({ id: entry.node.id, prose: proseFromAst(entry.node.contentAst) });
        walk(entry.children);
      }
    };
    walk(tree);
    return docs;
  }, [tree]);

  const handleDragStart = (event: DragStartEvent) => {
    const id = String(event.active.id);
    setDragging({ id, label: displayNameFromClient(client, id) ?? id });
    setMoveError(null);
  };

  const handleDragMove = (event: DragMoveEvent) => {
    setDropLine(dropLineFromDragEvent(event, positions));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const line = dropLineFromDragEvent(event, positions);
    const activeId = String(event.active.id);
    setDropLine(null);
    setDragging(null);
    if (line === null) return;
    let resolution = resolveMove({ activeId, line, positions });
    let crossTree = false;
    if (resolution.status === "noop" && positions.get(line.targetId) === undefined) {
      // The target row lives outside the page's own tree (a linked
      // reference / embed / a main-children section row): resolve the drop
      // straight from the client.
      resolution = resolveMoveFromClient({ activeId, line, client });
      crossTree = resolution.status === "move";
    }
    if (resolution.status === "noop") return;
    if (resolution.status === "refused") {
      setMoveError(resolution.reason);
      return;
    }
    void (async () => {
      try {
        const moveObject = (id: string, parentId: string | null, afterId?: string) =>
          afterId === undefined
            ? client.moveObject(id, parentId)
            : client.moveObject(id, parentId, afterId);
        if (crossTree) {
          await executeMoveFromClient({ activeId, command: resolution.command, client, moveObject });
        } else {
          await executeMove({ activeId, command: resolution.command, positions, moveObject });
        }
        // Zone-aware render bit: a drop anchored on a main-children row
        // promotes the dragged node into the Pages zone; a body-anchored
        // drop demotes it into the inline body. Only the flip issues an
        // update (matching the zone the node already has is a pure move).
        const zone = dropZoneOf(line, (id) => client.getNode(id));
        const dragged = client.getNode(activeId);
        if (dragged !== undefined && dragged.presentAsMain !== (zone === "main")) {
          await client.updateObject(activeId, { presentAsMain: zone === "main" });
        }
      } catch (err) {
        setMoveError(moveErrorMessage(err));
      }
    })();
  };

  const handleDragCancel = () => {
    setDropLine(null);
    setDragging(null);
  };

  if (!page) {
    return <div className="nt-page-missing">Page not found.</div>;
  }

  /**
   * The ghost row (owner-refined): the page root trails exactly
   * ONE muted "add block" ghost row as the last sibling of the main level —
   * rendered ALWAYS in the child-blocks section (outline and prose,
   * non-embedded, focus mode included), including an empty body, as the
   * sole "add" affordance. Blocks no longer trail their own ghosts at
   * deeper levels. Prose hides bullets (app.css .nt-prose), so the ghost
   * mounts there with its gutter dropped (the `prose` flag). Cards is a
   * card grid, not a block list — no ghost. The click realizes the ghost
   * into a real empty block at the end and focuses it.
   */
  const ghostVisible = !embedded && blocksMode !== "cards";

  /**
   * The page body: the whiteboard canvas, or the editable block tree + the
   * aggregation/system sections (all inside the same drag context). In the
   * panelled main layout this rides the content column beside the left
   * properties panel; compact layouts render it full-width.
   */
  const bodyContent = (
    <>
      {whiteboardTokenIndex >= 0 || (whiteboardClassed && !embedded) ? (
        whiteboardTokenIndex >= 0 ? (
          <>
            <WhiteboardCanvas client={client} hostId={pageId} tokenIndex={whiteboardTokenIndex} />
            {!focusMode &&
              (systemSections ?? (
                <SystemSections client={client} pageId={pageId} onOpenPage={onOpenPage} withActivity={!embedded} />
              ))}
          </>
        ) : (
          // Classed whiteboard without the token yet: the open effect is
          // authoring it — one bare frame, then the canvas mounts.
          <div className="nt-whiteboard-boot" aria-label="Opening whiteboard…" />
        )
      ) : (
        <>
          <EmbedBoundary rootId={pageId}>
            <DndContext
              sensors={sensors}
              collisionDetection={blockCollisionDetection}
              onDragStart={handleDragStart}
              onDragMove={handleDragMove}
              onDragEnd={handleDragEnd}
              onDragCancel={handleDragCancel}
            >
              <DropLineContext.Provider value={dropLine}>
                <SortableContext items={tree.map((child) => child.node.id)} strategy={verticalListSortingStrategy}>
                  <div
                    ref={selectionRootRef}
                    className={tree.length === 0 ? "nt-select-surface nt-select-surface--empty" : "nt-select-surface"}
                    onMouseDownCapture={selectionSurface.onMouseDownCapture}
                  >
                    <NodeCollection
                      viewMode={blocksMode}
                      client={client}
                      items={blockItems}
                      tree
                      editable
                      onNodeClick={(id) => onOpenPage?.(id)}
                      onNodeShiftClick={(id) => onOpenInSidebar?.(id)}
                    />
                    {/* The ghost trailing block (owner-refined): the page
                        root trails exactly ONE "+ Add block" ghost row as
                        the last sibling of the main
                        level — display-only until the click, which creates
                        a real empty block after the last child and focuses
                        it (never an op by itself). Blocks no longer trail
                        their own ghosts at deeper levels, and focus mode
                        keeps the body (hence this ghost) — only chrome
                        steps aside. Prose mounts it too, gutter dropped
                        (bullets are hidden in that transform). */}
                    {ghostVisible && (
                      <GhostRow
                        parentId={pageId}
                        prose={blocksMode === "prose"}
                        onRealize={() => {
                          void realizeGhost(client, outliner, pageId).catch((error: unknown) => {
                            console.warn(`[outliner] ghost realize (${pageId}) failed:`, error);
                          });
                        }}
                      />
                    )}
                  </div>
                </SortableContext>
                {/* The system sections join the same drag context: the Child
                    pages section's read-only rows are droppable (zone-aware —
                    a drop anchored on a main child promotes into the Pages
                    zone, see handleDragEnd). Class composition inserts its
                    class-relevant sections ahead of them. */}
                {sections}
                {dayIso !== null && !embedded && (
                  <DayPageSections
                    client={client}
                    pageId={pageId}
                    iso={dayIso}
                    onOpenPage={onOpenPage}
                  />
                )}
                {createdPeriod !== null && !embedded && (
                  <CreatedSection
                    client={client}
                    pageId={pageId}
                    after={createdPeriod.after}
                    before={createdPeriod.before}
                    onOpenPage={onOpenPage}
                  />
                )}
                {!focusMode &&
                  (systemSections ?? (
                    <SystemSections client={client} pageId={pageId} onOpenPage={onOpenPage} withActivity={!embedded} />
                  ))}
              </DropLineContext.Provider>
              <DragOverlay dropAnimation={null}>
                {dragging !== null && <div className="nt-drag-ghost">{dragging.label}</div>}
              </DragOverlay>
            </DndContext>
          </EmbedBoundary>
        </>
      )}
    </>
  );

  /**
   * The header layout: the full-width banner above (when the page can carry
   * one), then header left, the collapsible cover CARD right (always
   * rendered when the page can carry a cover, even empty).
   * Shared by both layout modes.
   */
  const headerChrome = (
    <>
          {bannerPossible && !focusMode && (
            <BannerCard
              client={client}
              pageId={pageId}
              assetId={bannerAssetId}
              onUploadRequest={() => setBannerUploadOpen(true)}
            />
          )}
          <div className="page-header-section">
          <header className="nt-page-header">
          <div className="page-header__title-row">
            {dayIso !== null && !embedded ? (
              /* Day pages: the header IS the date header — weekday + Today
                 flags above the (dateFormat-aware) title, the ISO week flag
                 after it. Right-click keeps the node context menu. */
              <span
                className="nt-page-title-wrap"
                onContextMenu={(event) => {
                  event.preventDefault();
                  setHeaderMenu({ x: event.clientX, y: event.clientY });
                }}
              >
                <DayPageHeader iso={dayIso} title={displayNameForSettings(page)} />
              </span>
            ) : (
              <>
            {!focusMode &&
              (iconButton !== undefined ? (
                iconButton
              ) : (
                <>
                  <span
                    className="page-icon-btn"
                    title="Page icon (click: change icon)"
                    ref={pageIconRef}
                    onClick={() => {
                      if (!embedded) setIconPickerOpen((open) => !open);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setHeaderMenu({ x: event.clientX, y: event.clientY });
                    }}
                  >
                    {headerIcon !== null ? (
                      <Icon path={headerIcon} size={1.4} className="page-icon-large" />
                    ) : (
                      <span className="page-icon-placeholder">◈</span>
                    )}
                  </span>
                  {iconPickerOpen && (
                    <IconPickerPopup
                      value={page.icon ?? undefined}
                      anchorEl={pageIconRef.current}
                      onSelect={(iconValue) => {
                        // "" clears (Icon treats empty as no icon).
                        void client.updateObject(pageId, { icon: iconValue });
                      }}
                      onClose={() => setIconPickerOpen(false)}
                    />
                  )}
                </>
              ))}
            {/* Right-click anywhere on the title (not just the icon) opens the
                page's node context menu — the browser menu is never the
                honest surface for a node. */}
            <span
              className="nt-page-title-wrap"
              onContextMenu={(event) => {
                event.preventDefault();
                setHeaderMenu({ x: event.clientX, y: event.clientY });
              }}
            >
            {embedded ? (
              <button
                type="button"
                className="nt-page-title-link"
                title="Open page"
                onClick={() => onOpenPage?.(pageId)}
              >
                {displayNameForSettings(page)}
              </button>
            ) : (
              /* The title is a bullet-less BlockRow over the page node itself
                 (no children — the body tree stays the separate collection
                 below): display renders the content's inline tokens (links,
                 mentions), a click swaps in the full block editor. */
              <BlockRow
                variant="title"
                tree={{ node: page, children: [] }}
                client={client}
                resolveName={(id) => displayNameFromClient(client, id)}
              />
            )}
            </span>
            {/* The aliases affordance: every page whose alias-terminal is
                this page, listed + added from the ALIASED node's own title
                row (null chrome for embedded/focus renders). */}
            {!embedded && !focusMode && (
              <AliasesButton
                client={client}
                nodeId={pageId}
                onOpenPageRaw={(id) => (onOpenPageRaw ?? onOpenPage)?.(id)}
              />
            )}
              </>
            )}
            {headerActions !== undefined && !focusMode && (
              <div className="nt-page-toolbar">{headerActions}</div>
            )}
          </div>
          {!embedded && !focusMode && (
            <TagsRow client={client} nodeId={pageId} tagIds={page.tagIds} onOpenPage={onOpenPage} />
          )}
        </header>
        {coverPossible && !focusMode && (
          <aside className="page-header-section__cover">
            <CoverCard client={client} pageId={pageId} assetId={coverAssetId} />
          </aside>
        )}
        </div>
    </>
  );

  /** Notices, the alias banner, the compact in-flow properties (compact
   *  layouts only), and the block body — everything after the header and
   *  before the footer in both layout modes. */
  const mainChrome = (
    <>
        {notice}
        {moveError !== null && (
          <div role="alert" className="nt-dnd-error">
            {moveError}
          </div>
        )}
        {/* Issue #7 — an alias page names its main page and jumps to it;
            null for every ordinary page. */}
        {!embedded && !focusMode && (
          <AliasOfBanner client={client} aliasPageId={pageId} onOpenPage={onOpenPage} />
        )}
        {/* The compact layouts keep the in-flow properties list (the
            panelled main layout moves it into the left side panel). */}
        {!focusMode && !panelled && (
          <>
            <PropertiesSection client={client} nodeId={pageId} onOpenPage={onOpenPage} />
            <div className="nt-metadata-divider" />
          </>
        )}
        {bodyContent}
    </>
  );

  const footerChrome = !embedded && !focusMode ? (
    <PageFooter client={client} page={page} tree={tree} onOpenNode={onOpenPage} />
  ) : null;

  /**
   * The page chrome composed per layout mode. The panelled main layout
   * (owner 2026-10-06) is a 2-column, 1-row split: the properties sidebar
   * rides the first column (1/3 of the space) and the whole node view rides
   * the second (2/3) — behind a nodeview top bar (the sidebar collapse
   * toggle + classes list left, the view switcher + node menu right, over a
   * full-width divider border). Compact layouts render the same chrome
   * full-width, header first, with the top-right chrome in the absolute
   * corner.
   */
  const pageChrome = (
    <>
      {panelled ? (
        <div className="nt-page-body">
          {!sidePanelCollapsed && (
            <aside className="nt-page-side-panel">
              <PropertiesSidebar client={client} nodeId={pageId} onOpenPage={onOpenPage} />
            </aside>
          )}
          <div className="nt-page-content">
            {/* The nodeview top bar: the sidebar collapse toggle and the
                classes pills on the left, the view-mode switcher + the node
                menu on the right, over a divider border like the sidebar's.
                Pinned to the top of the column. */}
            <div className="nt-node-topbar">
              <button
                type="button"
                className="nt-icon-btn"
                aria-label={sidePanelCollapsed ? "Show properties panel" : "Hide properties panel"}
                aria-pressed={!sidePanelCollapsed}
                title={sidePanelCollapsed ? "Show properties panel" : "Hide properties panel"}
                onClick={() => setSidePanelCollapsed(!sidePanelCollapsed)}
              >
                <Icon path="mdi-page-layout-sidebar-left" size={1} />
              </button>
              <div className="nt-node-topbar__classes">
                {corner !== undefined ? (
                  corner
                ) : (
                  <ClassesRow client={client} nodeId={pageId} classIds={page.classIds} onOpenPage={onOpenPage} />
                )}
              </div>
              <span className="nt-node-topbar__spacer" aria-hidden="true" />
              {chromeRight !== undefined && (
                <div className="nt-node-topbar__right">{chromeRight}</div>
              )}
            </div>
            {/* The nodeview proper: auto height between the pinned top bar
                and footer — it scrolls when the content outgrows the cell. */}
            <div className="nt-nodeview-body">
              {headerChrome}
              {mainChrome}
            </div>
            {footerChrome}
          </div>
        </div>
      ) : (
        <>
          {headerChrome}
          {mainChrome}
          {footerChrome}
          {chromeRight !== undefined && (
            <div className="nt-node-view__corner">{chromeRight}</div>
          )}
        </>
      )}
    </>
  );

  return (
    <OutlinerContext.Provider value={outliner}>
      <LinkEditModalHost client={client}>
        <div
          className={
            [
              "nt-page",
              panelled ? "nt-page--panelled" : "",
              rootClassName ?? "",
            ].filter(Boolean).join(" ")
          }
          ref={pageRootRef}
        >
          {/* Classes: compact layouts pin the pills to the card's top-left
              corner; the panelled main layout carries them in the nodeview
              top bar. Class composition swaps in its extends (parent-class)
              pills. */}
          {!panelled && !embedded && !focusMode &&
            (corner !== undefined ? (
              corner
            ) : (
              <div className="nt-page-classes-corner">
                <ClassesRow client={client} nodeId={pageId} classIds={page.classIds} onOpenPage={onOpenPage} />
              </div>
            ))}
          {findOpen && (
            <FindReplaceWidget
              blocks={findDocs}
              highlightRootRef={pageRootRef}
              onReplace={handleFindReplace}
              onClose={() => setFindOpen(false)}
            />
          )}
          {pageChrome}
        </div>
        <NodeContextMenu
          state={
            headerMenu === null
              ? null
              : { ...headerMenu, node: page, isPage: true }
          }
          client={client}
          onClose={() => setHeaderMenu(null)}
          onOpenNode={(id) => {
            setHeaderMenu(null);
            onOpenPage?.(id);
          }}
          onAddBanner={
            bannerPossible
              ? () => {
                  setHeaderMenu(null);
                  setBannerUploadOpen(true);
                }
              : undefined
          }
          onPresent={onPresent}
          onExport={(id, name) => {
            setHeaderMenu(null);
            setExporting({ pageId: id, name });
          }}
          onShare={
            shareTarget === undefined
              ? undefined
              : (id, name) => {
                  setHeaderMenu(null);
                  setSharing({ pageId: id, name });
                }
          }
          onDeleted={(node) => {
            setHeaderMenu(null);
            onDeleted?.(node);
          }}
        />
        {/* The banner upload (the empty affordance + the context menu's
            Add banner): image-only accept; the landed asset node's id
            writes the bannerAssetId wire field. */}
        {bannerUploadOpen && (
          <AssetUploadModal
            isOpen
            client={client}
            assetClassId={SYSTEM_CLASS_UUIDS.asset}
            accept="image/jpeg,image/png,image/webp"
            onClose={() => setBannerUploadOpen(false)}
            onUploaded={(assetNodeId) => void setNodeBanner(client, pageId, assetNodeId)}
          />
        )}
        {/* Block multi-selection: the floating group-ops bar rides
            the page chrome while a selection is live. */}
        {outliner.selectionEnabled && <SelectionBar client={client} />}
        {exporting !== null && (
          <ExportPageModal
            isOpen
            client={client}
            nodeUuid={exporting.pageId}
            nodeName={exporting.name}
            onClose={() => setExporting(null)}
          />
        )}
        {sharing !== null && shareTarget !== undefined && (
          <SharePageModal
            isOpen
            serverUrl={shareTarget.serverUrl}
            token={shareTarget.credential}
            nodeUuid={sharing.pageId}
            nodeName={sharing.name}
            onClose={() => setSharing(null)}
          />
        )}
      </LinkEditModalHost>
    </OutlinerContext.Provider>
  );
}
