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
 * The main-content restructure: the chrome LEAVES (NodeTopbar,
 * PageHeaderChrome, PageFooterChrome) live in PageChrome.tsx; the editing
 * machinery lives in usePageMachinery.ts. What stays here is the composer:
 * the reads (page/tree/cover), the body (the block tree), the notices +
 * compact properties in mainChrome, and the panelled/compact composition.
 *
 * Drag-and-drop: the page renders INSIDE the workspace drag session (the
 * host in App — useWorkspaceDnd.ts) and joins it as a ZONE: this view
 * registers the drag facts the machinery still owns (the measured page root
 * + the outliner's live positions) and provides the drag scope around its
 * tree, so block rows are draggable exactly on workspace surfaces. Without
 * a host (standalone renders) the registration is a no-op and the rows stay
 * editable but inert — the context-presence law. The drop indicator arrives
 * through the host's DropLineContext; the overlay chip, the sensors, and
 * the move-error banner are host-owned.
 *
 * The page mode is composed from DATA — `pageVariantOf`
 * (components/pageVariant.ts) derives the variant (plain / date-day /
 * date-period / class): the day/month/year facts, the class corner's
 * extends-pills relation config (ClassPillsList), and the class
 * section stack ride the descriptor — no slots, no ClassView branch. The
 * deleted class chrome: no curated icon button, no color dot, no
 * cycle banner — the shared header icon button is the single icon+color
 * entry.
 *
 * The panelled main layout
 * is now THREE columns — NodeView · properties · context. The context
 * column (`.nt-page-context`) hosts, top-down: LocalGraphCard, TocSection,
 * the Activity section (relocated from the card-bottom stack —
 * `SystemSections`' activity branch died with the move), and the Comments
 * section (the original model: child blocks classed `comment`, threaded,
 * quick-add/reply). Column collapse: EACH panel column keeps its own
 * device-local collapse, toggled from the nodeview top bar (the
 * properties hamburger pattern, now a pair) — the `layout` prop stays
 * BINARY ("default"/"compact"); per-column device prefs replace the plan's
 * recorded "third state" option (registered choice, owner resolution).
 * The dedupe check (the layout precondition): the right rail's
 * ReferencesSection and the page's own Backlinks tab both rendered
 * getLinkedReferences — the SAME data — verdict: the rail's
 * ReferencesSection is DELETED (see components/sidebarSections.tsx); the
 * Backlinks tab stays the one home in the SectionStack, where the
 * tab/filter machinery lands later. The context column keeps graph + TOC +
 * Activity + Comments ONLY. Embedded/journal/calendar surfaces and the
 * class/focus/compact variants render NO context column (main-surface
 * chrome only). The right rail is cards-only — the generic frame around
 * NodeView (components/NodeCardFrame.tsx).
 *
 * The `preview` surface seam — NodeView's `preview` prop renders
 * this view with NO corner menu, NO global listeners, a READ-ONLY body
 * capped at the page's first body level (maxDepth 1 — outline only; other
 * view modes render uncapped), and NO section stack: the hover preview
 * (NodeHoverPreview) renders it, and the write machinery steps aside — no
 * banner/cover affordances, no properties list, no whiteboard
 * lazy-authoring, no block multi-selection. A trampoline, not a page.
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

import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

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
import { ActivityLogSection } from "./components/ActivityLogSection.js";
import { ClassPillsList } from "./components/ClassPillsList.js";
import { pageVariantOf } from "./components/pageVariant.js";
import { nodeIcon } from "./iconFor.js";

import { WorkspaceDragScopeContext } from "./block-dnd.js";
import { useWorkspaceDndZone } from "./useWorkspaceDnd.js";
import { PropertiesSection, PropertiesSidebar, ClassesRow } from "./components/MetadataSection.js";
import { bannerAssetIdOf, setNodeBanner } from "./components/PageBanner.js";
import { AssetUploadModal } from "./components/modals/AssetUploadModal.js";
import { SelectionBar } from "./components/SelectionBar.js";
import { SystemSections } from "./components/SystemSections.js";
import { childQuery } from "./components/childQuery.js";
import { coverAssetIdOf } from "./components/coverProperty.js";
import { ensureAliasProperty } from "./components/aliasProperty.js";
import { AliasesButton } from "./components/AliasesButton.js";
import { AliasOfBanner } from "./components/AliasOfBanner.js";
import { useDeviceSetting } from "./components/modals/deviceSettings.js";
import { LocalGraphCard } from "./components/LocalGraphCard.js";
import { TocSection } from "./components/sidebarSections.js";
import { CommentsSection } from "./components/CommentsSection.js";
import { EmbedBoundary } from "./EmbedView.js";
import { Icon } from "./Icon.js";
import { BlockRow } from "./BlockRow.js";
import { WhiteboardCanvas } from "./WhiteboardCanvas.js";
import { OutlinerContext } from "./outliner-context.js";
import { NodeCollection } from "./views/index.js";
import type { ViewMode } from "./views/index.js";
import { useViewModePreference } from "./viewPrefs.js";
import { FindReplaceWidget } from "./editor-popups/FindReplaceWidget.js";
import {
  LinkEditModalHost,
} from "./editor-popups/LinkEditModal.js";
import { replaceRangeInAst } from "./editor-popups/block-find-replace.js";
import { ensureTemplateFamily } from "./components/templateFamily.js";
import { GhostRow, realizeGhost } from "./GhostRow.js";
import { usePageMachinery } from "./usePageMachinery.js";
import { NodeTopbar, PageHeaderChrome, PageFooterChrome } from "./PageChrome.js";

/** The child-blocks triad, in switcher order. Exported for the NodeView
 *  chrome, which hosts the switcher at the card's top-right. */
export const BLOCKS_VIEW_MODES: ViewMode[] = ["outline", "prose", "cards"];

/**
 * The preview surface's body cap: the page's FIRST body level only —
 * the outline view's maxDepth honors it; other view modes render uncapped
 * (the seam's honest limit until a view-mode-aware cap lands).
 */
const PREVIEW_BODY_DEPTH = 1;

/**
 * The body items: the childQuery factory — children as siblings,
 * comment-classed rows cut at every level. The body itself is the
 * plain NodeCollection dispatcher below.
 */

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
   * top-right (the NodeView chrome). "compact" keeps the original in-flow chrome —
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
  /**
   * The preview surface seam (hover/peek — NodeHoverPreview renders it):
   * no chromeRight/corner menu (NodeView guarantees), no global listeners,
   * a read-only body capped at the first body level, and no section stack.
   * The write machinery steps aside too: no banner/cover affordances, no
   * properties list, no whiteboard lazy-authoring, no block
   * multi-selection — a trampoline, not an editor.
   */
  preview = false,
  /**
   * Document-level listeners (find/replace chord, fold chords). Defaults to
   * the main-surface value (`!preview`); secondary surfaces (the right-rail
   * workspace cards) pass false explicitly — the chords stay main-surface-only.
   */
  globalShortcuts = undefined,
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
  shareTarget?: ShareTarget | undefined;
  preview?: boolean;
  globalShortcuts?: boolean | undefined;
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
   * and focus mode keep the compact in-flow chrome.
   */
  const variant = pageVariantOf(client, pageId);
  const [sidePanelCollapsed, setSidePanelCollapsed] = useDeviceSetting(
    "pageSidePanelCollapsed",
    false,
  );
  /**
   * The context column's own device-local collapse — a per-column
   * pref like the properties panel's (the `layout` prop stays binary; the
   * "third state" option the plan recorded as open is resolved THIS way,
   * registered in the module doc).
   */
  const [contextPanelCollapsed, setContextPanelCollapsed] = useDeviceSetting(
    "pageContextPanelCollapsed",
    false,
  );
  const panelled =
    layout === "default" && !embedded && !focusMode && !preview && variant.variant !== "class";
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
  // (usePageMachinery — the main-content restructure; constructed
  // after the block-tree read below.)

  // The page read accepts a class node (the class page IS a page —
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
      preview ||
      whiteboardTokenIndex >= 0 ||
      !whiteboardClassed
    ) {
      return;
    }
    void client.updateObject(page.id, {
      contentAst: [...page.contentAst, { type: "whiteboard", layout: { cards: {}, shapes: [], strokes: [] } }],
    });
  }, [client, page, embedded, preview, whiteboardTokenIndex, whiteboardClassed]);

  /**
   * Alias property self-heal: the seeded multi-value `alias` text schema
   * (global scope, no class binding) is authored idempotently on first page
   * view — the server seed only runs on an empty workspace, so existing
   * workspaces would never see it otherwise (the ensureTaskFamily
   * precedent). The node-alias carrier is the `aliasedNodeId` wire node
   * field — no schema to ensure.
   */
  useEffect(() => {
    void ensureAliasProperty(client);
  }, [client]);

  /**
   * The cover (the coverAssetId wire node field, the banner's twin): the
   * header-row card reads the node column, so a cover set by any client
   * shows here. No schema to self-heal — the retired cover property is
   * superseded; the field is platform-fixed.
   */
  const coverAssetId =
    page !== undefined && !embedded && !preview && whiteboardTokenIndex < 0
      ? coverAssetIdOf(client, pageId)
      : null;
  /** The cover element renders whenever the page can carry a cover —
   *  any document-chrome page, set or empty (the card shows the Add
   *  affordance when empty). The preview surface hosts none (the
   *  Add/Change upload is machinery). */
  const coverPossible =
    page !== undefined && !embedded && !preview && whiteboardTokenIndex < 0;

  /**
   * The banner (the bannerAssetId wire field): the full-width element above
   * the header. Renders whenever the page can carry one — set or empty —
   * like the cover; whiteboard pages and embedded renders host none (the
   * cover gating precedent). The upload modal is host-owned so the banner
   * row's empty affordance rides one flow everywhere.
   * The preview surface hosts none (the Add/Change upload is machinery).
   */
  const bannerAssetId =
    page !== undefined && !embedded && !preview && whiteboardTokenIndex < 0
      ? bannerAssetIdOf(client, pageId)
      : null;
  const bannerPossible = page !== undefined && !embedded && !preview && whiteboardTokenIndex < 0;
  const [bannerUploadOpen, setBannerUploadOpen] = useState(false);

  /**
   * The editing machinery: outliner construction, selection surface,
   * find/replace, and the fold chords — one hook so this component stays a
   * chrome composer. Embedded renders imply no document listeners; the
   * preview surface passes none explicitly — a peek installs no document
   * listeners.
   */
  const machinery = usePageMachinery({
    client,
    pageId,
    tree,
    embedded,
    forClass: variant.variant === "class",
    focusMode,
    preview,
    globalShortcuts: globalShortcuts ?? !preview,
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
  } = machinery;

  /**
   * The workspace drag session: this surface joins the host as a zone. The
   * facts ride live getters (positions refresh per render; the host reads
   * them at measure/resolve time) — no-op without a host.
   */
  const generatedZoneId = useId();
  const positionsRef = useRef(outliner.positions);
  positionsRef.current = outliner.positions;
  useWorkspaceDndZone({
    id: generatedZoneId,
    rootRef: pageRootRef,
    getPositions: () => positionsRef.current,
    client,
  });

  if (!page) {
    return <div className="nt-page-missing">Page not found.</div>;
  }

  /**
   * The variant's section stacks: the descriptor's SectionSpec-shaped
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
   * ghost (owner refinement): the page root trails exactly
   * ONE muted "add block" ghost row as the last sibling of the main level —
   * rendered ALWAYS in the child-blocks section (outline and prose,
   * non-embedded, focus mode included), including an empty body, as the
   * sole "add" affordance. Blocks no longer trail their own ghosts at
   * deeper levels. Prose hides bullets (app.css .nt-prose), so the ghost
   * mounts there with its gutter dropped (the `prose` flag). Cards is a
   * card grid, not a block list — no ghost. The click realizes the ghost
   * into a real empty block at the end and focuses it.
   */
  const ghostVisible = !embedded && !preview && blocksMode !== "cards";

  /**
   * The page body: the whiteboard canvas, or the editable block tree + the
   * aggregation/system sections (all inside the same workspace drag zone).
   * In the panelled main layout this rides the content column beside the left
   * properties panel; compact layouts render it full-width.
   */
  const bodyContent = (
    <>
      {whiteboardTokenIndex >= 0 || (whiteboardClassed && !embedded) ? (
        whiteboardTokenIndex >= 0 ? (
          <>
            <WhiteboardCanvas client={client} hostId={pageId} tokenIndex={whiteboardTokenIndex} />
            {!preview && !focusMode && variantSystemSections}
            {!preview && !focusMode && (
              <SystemSections client={client} pageId={pageId} onOpenPage={onOpenPage} />
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
            <SortableContext items={tree.map((child) => child.node.id)} strategy={verticalListSortingStrategy}>
              <div
                ref={selectionRootRef}
                className="nt-select-surface"
                onMouseDownCapture={selectionSurface.onMouseDownCapture}
              >
                <NodeCollection
                  viewMode={blocksMode}
                  client={client}
                  items={blockItems}
                  tree
                  editable={!preview}
                  maxDepth={preview ? PREVIEW_BODY_DEPTH : undefined}
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
            {/* The system sections join the same drag zone: the Child
                pages section's read-only rows are droppable (zone-aware —
                a drop anchored on a main child promotes into the Pages
                zone, see the host's drop resolution). The variant's
                section stack (the class sections) inserts its descriptors
                here — data, not a slot. */}
            {variantSections}
            {!preview && dayIso !== null && !embedded && (
              <DayPageSections
                client={client}
                pageId={pageId}
                iso={dayIso}
                onOpenPage={onOpenPage}
              />
            )}
            {!preview && createdPeriod !== null && !embedded && (
              <CreatedSection
                client={client}
                pageId={pageId}
                after={createdPeriod.after}
                before={createdPeriod.before}
                onOpenPage={onOpenPage}
              />
            )}
            {!preview && !focusMode && variantSystemSections}
            {!preview && !focusMode && (
              <SystemSections client={client} pageId={pageId} onOpenPage={onOpenPage} />
            )}
          </EmbedBoundary>
        </>
      )}
    </>
  );

  /**
   * The header layout (the PageHeaderChrome leaf): the full-width banner
   * above (when the page can carry one), then header left, the collapsible
   * cover CARD right. Shared by both layout modes; the day-header swap rides
   * the variant's `dayIso`. The banner state + upload modal stay HERE (the
   * host): the leaf renders the banner and reports the Add/Change request
   * back up, so the banner row rides one modal everywhere.
   */
  const headerChrome = (
    <PageHeaderChrome
      client={client}
      page={page}
      embedded={embedded}
      focusMode={focusMode}
      preview={preview}
      dayIso={dayIso}
      headerIcon={headerIcon}
      bannerPossible={bannerPossible}
      bannerAssetId={bannerAssetId}
      onBannerUploadRequest={() => setBannerUploadOpen(true)}
      coverPossible={coverPossible}
      coverAssetId={coverAssetId}
      onOpenPage={onOpenPage}
      onOpenPageRaw={(id) => (onOpenPageRaw ?? onOpenPage)?.(id)}
      onHeaderMenu={(x, y) => setHeaderMenu({ x, y })}
    />
  );

  /** Notices, the alias banner, the compact in-flow properties (compact
   *  layouts only), and the block body — everything after the header and
   *  before the footer in both layout modes. (The transient move-error
   *  banner is host-owned — the workspace drag session renders it.) */
  const mainChrome = (
    <>
        {/* Issue #7 — an alias page names its main page and jumps to it;
            null for every ordinary page. */}
        {!embedded && !focusMode && (
          <AliasOfBanner client={client} aliasPageId={pageId} onOpenPage={onOpenPage} />
        )}
        {/* The compact layouts keep the original in-flow properties list (the
            panelled main layout moves it into the left side panel). The
            preview surface hosts none — the properties editor is machinery
            a trampoline card never carries. */}
        {!focusMode && !panelled && !preview && (
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
   * (owner 2026-10-06) is a 3-column split: the properties sidebar rides the
   * first column, the whole node view (top bar / nodeview / footer) the
   * second, and the context column (graph · TOC · Activity ·
   * Comments, each hidden by its own emptiness rules) the third. Each panel
   * column keeps its own device-local collapse, toggled from the nodeview
   * top bar. Compact layouts render the same chrome full-width, header
   * first, with the top-right chrome in the absolute corner.
   */
  /**
   * The fullscreen whiteboard surface: the MAIN surface's whiteboard page
   * renders the canvas as the card's SOLE content — the page chrome (the
   * panelled columns, the nodeview top bar, the header, the footer) steps
   * aside entirely and the canvas fills the card edge to edge. Embedded
   * feed entries and the preview seam keep the in-flow canvas (the capped
   * branch in bodyContent below).
   */
  const fullscreenWhiteboard = whiteboardTokenIndex >= 0 && !embedded && !preview;

  const pageChrome = fullscreenWhiteboard ? (
    <WhiteboardCanvas client={client} hostId={pageId} tokenIndex={whiteboardTokenIndex} />
  ) : (
    <>
      {panelled ? (
        <div className="nt-page-body">
          {!sidePanelCollapsed && (
            <aside className="nt-page-side-panel" aria-label="Properties">
              <PropertiesSidebar client={client} nodeId={pageId} onOpenPage={onOpenPage} />
            </aside>
          )}
          <div className="nt-page-content">
            {/* The nodeview top bar (PageChrome.tsx): the properties +
                context collapse toggles and the classes pills on the left,
                the view-mode switcher + the node menu on the right. Pinned
                to the top of the column. */}
            <NodeTopbar
              client={client}
              nodeId={pageId}
              classIds={page.classIds}
              sidePanelCollapsed={sidePanelCollapsed}
              onToggleSidePanel={() => setSidePanelCollapsed(!sidePanelCollapsed)}
              contextPanelCollapsed={contextPanelCollapsed}
              onToggleContextPanel={() => setContextPanelCollapsed(!contextPanelCollapsed)}
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
          {!contextPanelCollapsed && (
            <aside className="nt-page-context" aria-label="Context">
              {/* The node-relevant widgets, relocated from the right
                  rail (the rail is workspace cards only). The references
                  dedupe check rejected the rail's ReferencesSection — the
                  Backlinks tab owns that data (see the module doc). */}
              <LocalGraphCard client={client} nodeId={pageId} onOpenNode={(id) => onOpenPage?.(id)} />
              <TocSection client={client} pageId={pageId} activeId={pageId} onOpenNode={(id) => onOpenPage?.(id)} />
              {/* The Activity feed relocated from the card-bottom
                  stack; its useSectionData lazy contract rides along. */}
              <ActivityLogSection client={client} onOpenPage={onOpenPage} />
              {/* Comments — child blocks classed `comment`, threaded. */}
              <CommentsSection client={client} nodeId={pageId} onOpenNode={onOpenPage} />
            </aside>
          )}
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
        {/* The drag scope: inside it block rows are draggable (the workspace
            session owns them); every PageView tree is a workspace editing
            surface, standalone renders included — without a host the grips
            stay inert (the context-presence law). */}
        <WorkspaceDragScopeContext.Provider value={true}>
        <div
          className={
            [
              "nt-page",
              fullscreenWhiteboard
                ? "nt-page--whiteboard"
                : panelled
                  ? "nt-page--panelled"
                  : "",
              variant.variant === "class" ? "nt-class" : "",
            ].filter(Boolean).join(" ")
          }
          ref={pageRootRef}
        >
          {/* Classes: compact layouts pin the pills to the card's top-left
              corner; the panelled main layout carries them in the nodeview
              top bar. The class variant's corner is the extends relation's
              ClassPillsList config — data, not a slot. */}
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
        </WorkspaceDragScopeContext.Provider>
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
