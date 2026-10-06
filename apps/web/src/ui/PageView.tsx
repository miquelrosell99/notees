/**
 * PageView — a page inside the floating content card: the page chrome
 * (top bar, day-aware header + cover aside, compact in-flow properties,
 * footer) around the recursive block tree of the page's children + the
 * "add block" affordance for an empty page, then the aggregation sections
 * (day/month/year) and the system sections (linked references — expanded,
 * child pages and unlinked references — collapsed) per SCHEMA.md's
 * lazy-loading contract. Reads from a client (in-process WorkspaceClient or
 * the WorkerClient proxy — same surface) and re-renders on its (naive)
 * notifications.
 *
 * S3b of the main-content restructure: the chrome LEAVES (NodeTopbar,
 * PageHeaderChrome, PageFooterChrome) live in PageChrome.tsx; the editing
 * machinery lives in usePageMachinery.ts. What stays here is the composer:
 * the reads (page/tree/cover), the body (the block tree inside the drag
 * context), the notices + compact properties in mainChrome, and the
 * panelled/compact composition (S7 reworks the columns).
 *
 * S5 (M13): the page mode is composed from DATA — `pageVariantOf`
 * (components/pageVariant.ts) derives the variant (plain / date-day /
 * date-period / class): the day/month/year facts, the class corner's
 * extends-pills relation config (ClassPillsList, M11), and the class
 * section stack ride the descriptor — no slots, no ClassView branch. The
 * deleted class chrome (M9/M12): no curated icon button, no color dot, no
 * cycle banner — the shared header icon button is the single icon+color
 * entry.
 *
 * PageView also owns the OutlinerContext: the write surface, the per-render
 * outline position map (sibling/parent facts for Tab/Backspace), the focus
 * request that hands the caret between blocks after structural gestures, and
 * the session-local view transforms: subtree collapse (a Set of hidden node
 * ids, display-only) and prose mode (the `nt-prose` class on the tree).
 *
 * Editor chrome owned here: the find & replace widget (Ctrl/Cmd+Shift+F)
 * searching the block tree's prose projection, and the page-level
 * LinkEditModal host — read-mode clicks on external_link chips open the
 * modal, and the editor's slash "Add URL" flow opens it through the same
 * opener (see editor-popups/).
 */

import { Fragment, useEffect, useState, type ReactNode } from "react";

import { DndContext, DragOverlay } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";

import { rendersWithDocumentChrome, SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client.js";

import { ExportPageModal } from "./components/modals/ExportPageModal.js";
import { SharePageModal } from "./components/modals/SharePageModal.js";
import type { ShareTarget } from "./components/NodeMenuButton.js";
import { NodeContextMenu } from "./components/NodeContextMenu.js";
import { DayPageSections } from "./components/DayPageSections.js";
import { CreatedSection } from "./components/CreatedSection.js";
import { ClassPillsList } from "./components/ClassPillsList.js";
import { pageVariantOf } from "./components/pageVariant.js";
import { nodeIcon } from "./iconFor.js";

import {
  DropLineContext,
  blockCollisionDetection,
} from "./block-dnd.js";
import { PropertiesSection, PropertiesSidebar, ClassesRow } from "./components/MetadataSection.js";
import { SelectionBar } from "./components/SelectionBar.js";
import { SystemSections } from "./components/SystemSections.js";
import { childQuery } from "./components/childQuery.js";
import { canHaveCoverOf, coverAssetIdOf, ensureCoverProperty } from "./components/coverProperty.js";
import { ensureAliasOfProperty, ensureAliasProperty } from "./components/aliasProperty.js";
import { AliasOfBanner } from "./components/AliasOfBanner.js";
import { useDeviceSetting } from "./components/modals/deviceSettings.js";
import { EmbedBoundary } from "./EmbedView.js";
import { WhiteboardCanvas } from "./WhiteboardCanvas.js";
import { OutlinerContext } from "./outliner-context.js";
import { NodeCollection } from "./views/index.js";
import type { ViewMode } from "./views/index.js";
import { useViewModePreference } from "./viewPrefs.js";
import { FindReplaceWidget } from "./editor-popups/FindReplaceWidget.js";
import { LinkEditModalHost } from "./editor-popups/LinkEditModal.js";
import { GhostRow, realizeGhost } from "./GhostRow.js";
import { usePageMachinery } from "./usePageMachinery.js";
import { NodeTopbar, PageHeaderChrome, PageFooterChrome } from "./PageChrome.js";

/** The child-blocks triad, in switcher order. Exported for the NodeView
 *  chrome, which hosts the switcher at the card's top-right. */
export const BLOCKS_VIEW_MODES: ViewMode[] = ["outline", "prose", "cards"];

/**
 * The body items (S4/M1): the childQuery factory — children as siblings,
 * comment-classed rows cut at every level (M19). The body itself is the
 * plain NodeCollection dispatcher below.
 */

export function PageView({
  client,
  pageId,
  onOpenPage,
  onOpenInSidebar,
  onDeleted,
  onPresent,
  embedded = false,
  /**
   * Layout mode (owner 2026-10-06, the Capacities-style main layout):
   * "default" (the main content card) puts the properties in a collapsible
   * LEFT side panel inside the card, the classes pills at the content
   * column's top-left, and moves the blocks view switcher out to the card's
   * top-right (the NodeView chrome). "compact" keeps the v1 in-flow chrome —
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
  /** shares: server coordinates for the "Share…" item + modal. */
  shareTarget = undefined,
}: {
  client: WorkspaceClient | WorkerClient;
  pageId: string;
  /** Page navigation (child-pages rows, reference crumbs). */
  onOpenPage?: ((pageId: string) => void) | undefined;
  /** Shift+click peek target: open the node as a card in the right sidebar. */
  onOpenInSidebar?: ((nodeId: string) => void) | undefined;
  /** Post-delete navigation (host routes to the parent / default view). */
  onDeleted?: ((node: ClientNode) => void) | undefined;
  /** Presentation mode: "Present" decks this page's subtree read-only. */
  onPresent?: ((pageId: string) => void) | undefined;
  /**
   * Embedded mode (journals feed): the title renders as a static button that
   * navigates to the full page view instead of the inline TitleEditor, and
   * the page-level find/replace shortcut stays off so stacked feeds don't
   * install one document listener per entry.
   */
  embedded?: boolean;
  layout?: "default" | "compact";
  blocksMode?: ViewMode;
  onBlocksModeChange?: ((mode: ViewMode) => void) | undefined;
  chromeRight?: ReactNode;
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
   * content top-left. Device-local collapse (never an op); the class variant
   * (M13) and focus mode keep the compact in-flow chrome.
   */
  const variant = pageVariantOf(client, pageId);
  const [sidePanelCollapsed, setSidePanelCollapsed] = useDeviceSetting(
    "pageSidePanelCollapsed",
    false,
  );
  const panelled =
    layout === "default" && !embedded && !focusMode && variant.variant !== "class";
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number } | null>(null);
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

  // --- editing machinery: outliner, selection, find/replace, DnD -------------
  // (usePageMachinery — S3a of the main-content restructure; constructed
  // after the block-tree read below.)

  // The page read accepts a class node (M13: the class page IS a page —
  // rendersWithDocumentChrome excludes classes by design; the class variant
  // re-admits the class node).
  const rawNode = client.getNode(pageId);
  const page =
    rawNode !== undefined && (rendersWithDocumentChrome(rawNode) || rawNode.isClass)
      ? rawNode
      : undefined;
  const headerIcon =
    page !== undefined ? nodeIcon(page, client.effectiveClassIcons()) : null;
  const tree = page !== undefined ? client.getBlockTree(pageId) : [];
  /** The same tree in the view system's input shape (session view state). */
  const blockItems = childQuery(client, pageId);
  /**
   * #4/#7 — the date variants: a node whose id parses at day
   * precision is a day page and gets the date header (weekday/Today flags +
   * the week flag, owner 2026-10-06) and the three aggregation sections;
   * month/year pages carry the Created aggregation too. Both facts ride the
   * variant descriptor now (pageVariantOf); embedded renders (journal feed,
   * calendar daily-note embed) skip both at the render sites — they already
   * sit on aggregation surfaces.
   */
  const dayIso = variant.dayIso ?? null;
  /** Month/year Created bounds (null on day pages and non-date nodes). */
  const createdPeriod = variant.createdPeriod ?? null;

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
   * are seed-manifest entries nothing else authors (the v1 migration is the
   * only other writer), so a fresh workspace self-heals them on first page
   * view — an idempotent no-op once present. The banner below then reads
   * the effective cover value; pages without one (date pages, whiteboard
   * pages, everything not classed `source`) render no banner at all.
   */
  useEffect(() => {
    void ensureCoverProperty(client);
  }, [client]);

  /**
   * Alias property self-heal: the seeded
   * multi-value `alias` text schema and the seeded single-value node-typed
   * `aliasOf` schema (global scope, no class bindings) are authored
   * idempotently on first page view — the server seed only runs on an
   * empty workspace, so existing workspaces would never see them otherwise
   * (the ensureCoverProperty precedent).
   */
  useEffect(() => {
    void ensureAliasProperty(client);
    void ensureAliasOfProperty(client);
  }, [client]);

  /** The cover's asset target, when the page carries the property. */
  const coverAssetId =
    page !== undefined && !embedded && whiteboardTokenIndex < 0
      ? coverAssetIdOf(client, pageId)
      : null;
  /** the v1 element renders whenever the page can carry a cover —
   *  set or empty (the card shows the Add affordance when empty). */
  const coverPossible =
    page !== undefined && !embedded && whiteboardTokenIndex < 0
      ? canHaveCoverOf(client, pageId)
      : false;

  /**
   * The editing machinery (S3a): outliner construction, selection surface,
   * find/replace, the DnD wiring, and the fold chords — one hook so this
   * component stays a chrome composer. `globalShortcuts: true` is the main
   * surface; embedded renders imply false inside the hook.
   */
  const machinery = usePageMachinery({
    client,
    pageId,
    tree,
    embedded,
    forClass: variant.variant === "class",
    focusMode,
    globalShortcuts: true,
    onOpenPage,
    onOpenInSidebar,
  });
  const {
    pageRootRef,
    selectionRootRef,
    outliner,
    selectionSurface,
    findOpen,
    setFindOpen,
    findDocs,
    handleFindReplace,
    handleExternalLinkClick,
    linkOpenerRef,
  } = machinery;
  const {
    sensors,
    dropLine,
    dragging,
    moveError,
    handleDragStart,
    handleDragMove,
    handleDragEnd,
    handleDragCancel,
  } = machinery.dnd;

  if (!page) {
    return <div className="nt-page-missing">Page not found.</div>;
  }

  /**
   * The variant's section stacks (M13): the descriptor's SectionSpec-shaped
   * entries mount their existing section components at the two placement
   * sites the old slots used — between the body and the date sections, and
   * ahead of the default <SystemSections/>. Empty for plain/date variants,
   * so the map is the no-op it always was there.
   */
  const variantSectionCtx = { client, nodeId: pageId, onOpenPage, onOpenClass: onOpenPage };
  const variantSections = variant.sections.map((spec) => (
    <Fragment key={`${spec.key}-${pageId}`}>{spec.render(variantSectionCtx)}</Fragment>
  ));
  const variantSystemSections = variant.systemSections.map((spec) => (
    <Fragment key={`${spec.key}-${pageId}`}>{spec.render(variantSectionCtx)}</Fragment>
  ));

  /**
   * ghost (owner refinement of ): the page root trails exactly
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
            {!focusMode && variantSystemSections}
            {!focusMode && (
              <SystemSections client={client} pageId={pageId} onOpenPage={onOpenPage} withActivity={!embedded} />
            )}
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
                    {/* ghost trailing block (owner refinement of
                        ): the page root trails exactly ONE "+ Add
                        block" ghost row as the last sibling of the main
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
                    zone, see handleDragEnd). The variant's section stack
                    (M13: the class sections) inserts its descriptors here —
                    data, not a slot. */}
                {variantSections}
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
                {!focusMode && variantSystemSections}
                {!focusMode && (
                  <SystemSections client={client} pageId={pageId} onOpenPage={onOpenPage} withActivity={!embedded} />
                )}
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
   * the v1 header layout (the PageHeaderChrome leaf): header left,
   * the collapsible cover CARD right. Shared by both layout modes; the
   * day-header swap rides the variant's `dayIso`.
   */
  const headerChrome = (
    <PageHeaderChrome
      client={client}
      page={page}
      embedded={embedded}
      focusMode={focusMode}
      dayIso={dayIso}
      headerIcon={headerIcon}
      coverPossible={coverPossible}
      coverAssetId={coverAssetId}
      onOpenPage={onOpenPage}
      onHeaderMenu={(x, y) => setHeaderMenu({ x, y })}
    />
  );

  /** Notices, the alias banner, the compact in-flow properties (compact
   *  layouts only), and the block body — everything after the header and
   *  before the footer in both layout modes. */
  const mainChrome = (
    <>
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
        {/* The compact layouts keep the v1 in-flow properties list (the
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

  const footerChrome = (
    <PageFooterChrome
      client={client}
      page={page}
      tree={tree}
      onOpenNode={onOpenPage}
      embedded={embedded}
      focusMode={focusMode}
    />
  );

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
            <aside className="nt-page-side-panel" aria-label="Properties">
              <PropertiesSidebar client={client} nodeId={pageId} onOpenPage={onOpenPage} />
            </aside>
          )}
          <div className="nt-page-content">
            {/* The nodeview top bar (PageChrome.tsx): the sidebar collapse
                toggle and the classes pills on the left, the view-mode
                switcher + the node menu on the right. Pinned to the top of
                the column. */}
            <NodeTopbar
              client={client}
              nodeId={pageId}
              classIds={page.classIds}
              sidePanelCollapsed={sidePanelCollapsed}
              onToggleSidePanel={() => setSidePanelCollapsed(!sidePanelCollapsed)}
              chromeRight={chromeRight}
              onOpenPage={onOpenPage}
            />
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
      <LinkEditModalHost client={client} openerRef={linkOpenerRef}>
        <div
          className={
            [
              "nt-page",
              panelled ? "nt-page--panelled" : "",
              variant.variant === "class" ? "nt-class" : "",
            ].filter(Boolean).join(" ")
          }
          ref={pageRootRef}
          onClick={handleExternalLinkClick}
        >
          {/* Classes: compact layouts pin the pills to the card's top-left
              corner; the panelled main layout carries them in the nodeview
              top bar. The class variant's corner is the extends relation's
              ClassPillsList config (M11/M13) — data, not a slot. */}
          {!panelled && !embedded && !focusMode && (
            <div className="nt-page-classes-corner">
              {variant.cornerPills !== undefined ? (
                <ClassPillsList
                  client={client}
                  nodeId={pageId}
                  onOpenPage={onOpenPage}
                  {...variant.cornerPills}
                />
              ) : (
                <ClassesRow client={client} nodeId={pageId} classIds={page.classIds} onOpenPage={onOpenPage} />
              )}
            </div>
          )}
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
        {/* block multi-selection: the floating group-ops bar rides
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
