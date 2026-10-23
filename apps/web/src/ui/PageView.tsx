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
 * is now THREE columns — context · NodeView · properties (owner 2026-10-23:
 * the properties sidebar moved to the RIGHT and the context column to the
 * LEFT — the main sidebar already owns the far-left band, the usually-open
 * properties panel balances it from the right, and the usually-closed
 * context panel tucks in between). The COMPOSITION lives in the shared
 * MainContentFrame (owner 2026-10-23 — generalized out of this view so any
 * main-content view opts in via props): this view passes the nodeview top
 * bar, the context sections, and the properties sidebar as slots; the frame
 * owns the chrome registers (the raised-card panels, the column split),
 * never the content. The context
 * column (`.nt-page-context`) hosts, top-down: LocalGraphCard, TocSection,
 * the Activity section (relocated from the card-bottom stack —
 * `SystemSections`' activity branch died with the move), the Version
 * history section (the per-node op-log slice, owner 2026-10-14), the
 * Comments
 * section (the original model: child blocks classed `comment`, threaded,
 * quick-add/reply), and — as its bottom section, the footer with the word
 * count + Created/Updated stamps (the card-bottom bar relocated here,
 * owner 2026-10-09). Column collapse: EACH panel column keeps its own
 * device-local collapse, toggled from the nodeview top bar (the
 * properties hamburger pattern, now a pair) — the `layout` prop stays
 * BINARY ("default"/"compact"); per-column device prefs replace the plan's
 * recorded "third state" option (registered choice, owner resolution).
 * The dedupe check (the layout precondition): the right rail's
 * ReferencesSection and the page's own Backlinks section both rendered
 * getLinkedReferences — the SAME data — verdict: the rail's
 * ReferencesSection is DELETED (see components/sidebarSections.tsx); the
 * Backlinks section stays the one home in the SectionStack — since the
 * tab strip's retirement (owner 2026-10-09) a normal NodeCollection
 * section. The context column keeps graph + TOC +
 * Activity + Version history + Comments ONLY. Embedded/journal/calendar surfaces and the
 * focus/compact variants render NO context column (main-surface chrome
 * only); the class variant joined the PANELLED layout owner 2026-10-12 —
 * Metadata + Class properties + Templates ride its first column — and its
 * context column too (owner correction, the column is node-relevant for
 * every node kind). The right rail is cards-only — the generic frame around
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
 * ids, display-only), prose mode (the `nt-prose` class on the tree), and the
 * condensed layer (the per-page display toggle whose stretched set rides the
 * context — owner 2026-10-15).
 *
 * Editor chrome owned here: the find & replace widget (Ctrl/Cmd+Shift+F)
 * searching the block tree's prose projection, the Capacities-parity
 * find-in-page bar (Ctrl/Cmd+F — findInPage.ts walks the subtree DATA, so
 * collapsed/hidden blocks are found like rendered ones), and the page-level
 * LinkEditModal host for NODE links (owner ruling: external links navigate —
 * they never open the modal; the slash "Add URL" flow authors the token
 * directly in the editor — see editor-popups/).
 */

import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";

import { rendersWithDocumentChrome, SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client/index.js";

import { ExportPageModal } from "../features/export/ExportPageModal.js";
import { parentRenderFacts } from "./renderStateLabel.js";
import { SharePageModal } from "../features/sharing/SharePageModal.js";
import type { ShareTarget } from "../features/node-menu/NodeMenuButton.js";
import { NodeContextMenu } from "../features/node-menu/NodeContextMenu.js";
import { DayPageSections } from "../features/calendar/DayPageSections.js";
import { CreatedSection } from "../features/page-sections/CreatedSection.js";
import { ActivityLogSection } from "../features/page-sections/ActivityLogSection.js";
import { VersionHistorySection } from "../features/page-sections/VersionHistorySection.js";
import { ClassPillsList } from "../features/metadata/ClassPillsList.js";
import { pageVariantOf } from "../features/page-sections/pageVariant.js";
import { definedNodeIcon } from "./iconFor.js";

import { WorkspaceDragScopeContext } from "./block-dnd.js";
import { useWorkspaceDndZone } from "./useWorkspaceDnd.js";
import { EditThreadOverlay, EditThreadProvider } from "./EditThread.js";
import { PropertiesSection, PropertiesSidebar, ClassesRow, metadataRowCount } from "../features/metadata/index.js";
import { bannerAssetIdOf, setNodeBanner } from "../features/page-sections/PageBanner.js";
import { AssetUploadModal } from "../features/modals/AssetUploadModal.js";
import { SelectionBar } from "../features/block-editor/SelectionBar.js";
import { SelectionOutline } from "./SelectionOutline.js";
import { childQuery } from "../features/collection/childQuery.js";
import { coverAssetIdOf } from "../features/metadata/coverProperty.js";
import { ensureAliasProperty } from "../features/metadata/aliasProperty.js";
import { AliasOfBanner } from "../features/metadata/AliasOfBanner.js";
import { useDeviceSetting } from "../features/settings/deviceSettings.js";
import { LocalGraphCard } from "../features/collection/LocalGraphCard.js";
import { TocSection } from "./app/sidebarSections.js";
import { CommentsSection } from "../features/page-sections/CommentsSection.js";
import { EmbedBoundary } from "./EmbedView.js";
import { Icon } from "./Icon.js";
import { BlockRow, useStableIdArray } from "./BlockRow.js";
import { WhiteboardCanvas } from "./WhiteboardCanvas.js";
import { OutlinerContext } from "./outliner-context.js";
import { NodeCollection } from "../features/collection/index.js";
import type { ViewMode } from "../features/collection/index.js";
import { useViewModePreference, useCondensedPreference } from "./viewPrefs.js";
import { Button } from "../components/ui/fleet/Button.js";
import { FindReplaceWidget } from "./editor-popups/FindReplaceWidget.js";
import { FindInPageBar } from "../features/find-in-page/FindInPageBar.js";
import {
  LinkEditModalHost,
} from "./editor-popups/LinkEditModal.js";
import { replaceRangeInAst } from "./editor-popups/block-find-replace.js";
import { ensureTemplateFamily } from "../features/templates/templateFamily.js";
import { GhostCard, GhostRow, realizeGhost } from "./GhostRow.js";
import { usePageMachinery } from "./usePageMachinery.js";
import { MainContentFrame } from "./MainContentFrame.js";
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
   * menu), owned by NodeView as two pieces: the panelled main layout rides
   * them on the nodeview top bar's right section with the context-panel
   * toggle between; compact layouts render them back to back in the absolute
   * top-right corner (as before).
   */
  chromeModes = undefined,
  chromeMenu = undefined,
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
   * Embedded mode (journals feed): the title renders as a plain heading
   * with an explicit "Open page" button beside it (navigating to the full
   * page view) instead of the inline editable title row, and the
   * page-level find/replace shortcut stays off so stacked feeds don't
   * install one document listener per entry.
   */
  embedded?: boolean;
  layout?: "default" | "compact";
  blocksMode?: ViewMode;
  onBlocksModeChange?: ((mode: ViewMode) => void) | undefined;
  chromeModes?: ReactNode;
  chromeMenu?: ReactNode;
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
   * The condensed layer (owner 2026-10-15) — a display toggle over the
   * triad, NOT a view mode: it answers how much of each block's own prose
   * shows, independent of how the tree lays out. Persisted per page through
   * the device-settings seam (`condensed.<pageId>`), like the view modes.
   * The layer TOGGLE itself lives in the app TopBar + the command palette
   * (owner directive 2026-10-15 — one surface per action); this view only
   * READS the pref and opts the body in. The stretched set (the exceptions
   * rendered full) lives in the outliner context and survives a layer
   * toggle and a reload, like the folds.
   */
  const [condensedPref] = useCondensedPreference(pageId);
  // The layer reaches the page BODY only: embedded feeds (journal, calendar
  // day pages) and the preview seam render full content exactly as today,
  // and every read-only projection never even receives the opt-in.
  const layerActive = condensedPref && !embedded && !preview;
  /**
   * Focus mode (#12) — device-local: the page keeps its title, its editable
   * body, AND the panelled layout's geometry (owner 2026-10-15: the compact
   * fallback's 46rem column read condensed; focus mode keeps the normal
   * spacing and simply hides the chrome) — the surrounding chrome (classes
   * corner, header icon, tags, cover, date bar, properties, system sections,
   * footer, and in the panelled layout both side panels + the top bar's
   * panel toggles/classes cluster) steps aside.
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
  /**
   * The panelled main layout: the class variant re-joined it owner
   * 2026-10-12 (the class page gets the properties-sidebar layout — the
   * Metadata panel + the variant's `sidebarSections` ride the first column,
   * Classed nodes the content column). The context column rides EVERY
   * panelled page, class pages included (owner 2026-10-12, "for any
   * nodeview in general" — graph/TOC/Activity/Comments are node-relevant
   * whatever the node kind). Focus mode KEEPS this layout (owner
   * 2026-10-15 — the normal spacing, elements hidden, not the compact
   * fallback's narrowed column): the two panel asides and the top bar's
   * panel controls/classes simply don't render while it is on.
   */
  const panelled =
    layout === "default" && !embedded && !preview;
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number } | null>(null);
  const [exporting, setExporting] = useState<{ pageId: string; name: string } | null>(null);
  const [sharing, setSharing] = useState<{ pageId: string; name: string } | null>(null);
  const [, setVersion] = useState(0);
  useEffect(
    () =>
      client.subscribe((change) => {
        // Scoped changes that don't name this page skip the version bump:
        // the notification payload is ancestor-expanded, so an edit landing
        // inside this page's subtree already carries pageId; every read this
        // view renders is either scoped to pageId or owned by a
        // self-subscribing child (the sections). Structural or scope-unknown
        // payloads bump as before.
        if (
          change.affectedNodeIds !== undefined &&
          change.structural !== true &&
          !change.affectedNodeIds.includes(pageId)
        ) {
          return;
        }
        setVersion((v) => v + 1);
      }),
    [client, pageId],
  );
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
    rawNode !== undefined &&
    (rendersWithDocumentChrome(rawNode, parentRenderFacts(client, rawNode)) || rawNode.isClass)
      ? rawNode
      : undefined;
  /**
   * The DEFINED icon (own or a class-contributed one — no display-default
   * fallback): the header hides the icon element entirely when null (the
   * Capacities precedent; the action row's "Add icon" is the affordance).
   */
  const headerIcon =
    page !== undefined ? definedNodeIcon(page, client.effectiveClassIcons()) : null;
  const tree = page !== undefined ? client.getBlockTree(pageId) : [];
  // Stable identity for dnd-kit's SortableContext (a fresh array per render
  // would re-render every sortable row through context — the row memo's
  // defeat). Structural share: replaced only when the id sequence changes.
  const stableTreeIds = useStableIdArray(tree.map((child) => child.node.id));
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
    // Fire-and-forget with the CalendarView family-ensure ruling: a
    // rejection (the store closing mid-deploy — a test teardown can race
    // this passive effect past client.close()) must not surface as an
    // unhandled rejection; the ensure is idempotent and the next mount
    // re-runs it.
    void ensureAliasProperty(client).catch(() => {});
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
   * The Capacities-parity find-in-page bar (Ctrl/Cmd+F — owner slice): opens
   * over the open page's whole block tree; the search walks the subtree
   * DATA (findInPage.ts), so collapsed/hidden blocks are found like rendered
   * ones. Same surface gating as the find/replace chord: no stacked-surface
   * listeners (embedded feeds, the preview seam), and no block tree on a
   * whiteboard page. The honest-handoff rule: a mod+F keyed while focus sits
   * in an input/textarea/contentEditable that ISN'T the find bar's own is
   * left to the platform (the browser's native find, the editor's chords) —
   * this view only intercepts the chord it owns. While the bar is open the
   * same chord focuses + selects its input, the browser tab habit.
   */
  const [findInPageOpen, setFindInPageOpen] = useState(false);
  const findInPageInputRef = useRef<HTMLInputElement>(null);
  const findInPageShortcuts =
    (globalShortcuts ?? !preview) && !embedded && whiteboardTokenIndex < 0;
  useEffect(() => {
    if (!findInPageShortcuts) return;
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.key.toLowerCase() !== "f") return;
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const inField = target.closest("input, textarea, [contenteditable='true']") !== null;
      const inFindBar = target.closest("[data-find-in-page]") !== null;
      if (inField && !inFindBar) return;
      e.preventDefault();
      if (findInPageOpen) {
        findInPageInputRef.current?.focus();
        findInPageInputRef.current?.select();
      } else {
        setFindInPageOpen(true);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [findInPageShortcuts, findInPageOpen]);

  /**
   * The workspace drag session: this surface joins the host as a zone. The
   * facts ride live getters (positions refresh per render; the host reads
   * them at measure/resolve time) — no-op without a host.
   */
  const generatedZoneId = useId();
  const positionsRef = useRef(outliner.positions);
  positionsRef.current = outliner.positions;
  const selectionRootsRef = useRef(outliner.selectionRoots);
  selectionRootsRef.current = outliner.selectionRoots;
  useWorkspaceDndZone({
    id: generatedZoneId,
    rootRef: pageRootRef,
    getPositions: () => positionsRef.current,
    getSelection: () => selectionRootsRef.current,
    client,
  });

  if (!page) {
    return <div className="nt-page-missing">Page not found.</div>;
  }

  /**
   * The variant's section stacks: the descriptor's SectionSpec-shaped
   * entries mount their existing section components at the placement sites —
   * the content stack (between the body and the system sections), the
   * panelled first column (`sidebarSections`, rendered under the Metadata
   * panel — only when panelled; the compact layout keeps them in the content
   * stack in their original order), and the page's reference family +
   * the variant's relation sections (`systemSections` — the self-gating
   * Child pages / Backlinks / Unlinked mentions ride it on every variant,
   * with the unlinked spec omitted on the date family; owner 2026-10-21:
   * the <SystemSections/> group component died by subtraction, placement
   * is data, the sections own their gates).
   */
  const variantSectionCtx = {
    client,
    nodeId: pageId,
    onOpenPage,
    onOpenClass: onOpenPage,
    embedded,
  };
  const contentSectionSpecs = panelled
    ? variant.sections
    : [...(variant.sidebarSections ?? []), ...variant.sections];
  const variantSections = contentSectionSpecs.map((spec) => (
    <Fragment key={`${spec.key}-${pageId}`}>{spec.render(variantSectionCtx)}</Fragment>
  ));
  const variantSidebarSections = (variant.sidebarSections ?? []).map((spec) => (
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
   * card grid — the affordance is the GhostCard, the grid's last cell
   * (the `trailingGhost` slot), not a row after the grid. The click
   * realizes the ghost into a real empty block at the end and focuses it.
   */
  const ghostVisible = !embedded && !preview;

  /**
   * The page body: the whiteboard canvas, or the editable block tree + the
   * aggregation/system sections (all inside the same workspace drag zone).
   * In the panelled main layout this rides the content column between the
   * two panel columns (context left, properties right); compact layouts
   * render it full-width.
   */
  const bodyContent = (
    <>
      {whiteboardTokenIndex >= 0 || (whiteboardClassed && !embedded) ? (
        whiteboardTokenIndex >= 0 ? (
          <>
            <WhiteboardCanvas client={client} hostId={pageId} tokenIndex={whiteboardTokenIndex} />
            {!preview && !focusMode && (
              <div className="nt-page-section-stack">{variantSystemSections}</div>
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
            <SortableContext items={stableTreeIds} strategy={verticalListSortingStrategy}>
              <div
                ref={selectionRootRef}
                className="nt-select-surface nt-edit-thread-host"
                onMouseDownCapture={selectionSurface.onMouseDownCapture}
              >
                {/* The edit thread (EditThread.tsx): the measured overlay
                    paints behind the rows (the host isolates the stacking
                    context) and draws the ancestor path to the editing
                    block — a separate layer, never the tree's own rails. */}
                <EditThreadOverlay client={client} hostRef={selectionRootRef} rootId={pageId} />
                <NodeCollection
                  viewMode={blocksMode}
                  client={client}
                  items={blockItems}
                  tree
                  editable={!preview}
                  condensed={layerActive}
                  showBreadcrumbs={false}
                  maxDepth={preview ? PREVIEW_BODY_DEPTH : undefined}
                  onNodeClick={(id) => onOpenPage?.(id)}
                  onNodeShiftClick={(id) => onOpenInSidebar?.(id)}
                  /* Cards mode: the add affordance is the grid's last cell
                     (the GhostCard) — it must live INSIDE the grid to read
                     as a card slot, so it rides the collection's
                     trailingGhost slot instead of trailing the collection
                     like the row ghost below. */
                  trailingGhost={
                    ghostVisible && blocksMode === "cards" ? (
                      <GhostCard
                        parentId={pageId}
                        onRealize={() => {
                          void realizeGhost(client, outliner, pageId).catch((error: unknown) => {
                            console.warn(`[outliner] ghost realize (${pageId}) failed:`, error);
                          });
                        }}
                      />
                    ) : undefined
                  }
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
                    (bullets are hidden in that transform). Cards wears
                    the GhostCard inside the grid instead (the
                    trailingGhost above — a grid needs its slot as a
                    cell, not a row after the grid). */}
                {ghostVisible && blocksMode !== "cards" && (
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
                {/* The selection card: one outline per contiguous run of
                    selected rows (the set is whole-subtree, so a run is
                    always a rectangle — a selected block wraps its
                    children). */}
                {outliner.selection.size > 0 && (
                  <SelectionOutline surfaceRef={selectionRootRef} selection={outliner.selection} />
                )}
              </div>
            </SortableContext>
            {/* The sections join the same drag zone: the Child pages
                section's read-only rows are droppable (zone-aware —
                a drop anchored on a main child promotes into the Pages
                zone, see the host's drop resolution). The variant's
                section stack (the class sections) inserts its descriptors
                here — data, not a slot. Every section-mounted chrome rides
                ONE chromeless stack container: it owns no hairline, no
                margin, no hide — each section's own top border is its
                separator (it exists iff the section does) and the stack
                rule spaces the survivors (owner ruling 2026-10-20: the
                per-section hairline retires the group's single boundary
                line). The container is always mounted; its guards are the
                per-family ones inside. */}
            <div className="nt-page-section-stack">
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
            </div>
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
            a trampoline card never carries. Embedded renders (the journal
            and calendar day feeds) drop the section — and its divider —
            entirely while the page carries no property rows: a feed of
            empty "Metadata 0" headers is chrome without content (owner
            2026-10-09). The standalone compact page keeps the section even
            when empty — it is that layout's add-property entry point. */}
        {!focusMode && !panelled && !preview && (!embedded || metadataRowCount(client, pageId) > 0) && (
          <>
            <PropertiesSection
              client={client}
              nodeId={pageId}
              onOpenPage={onOpenPage}
              onOpenPageRaw={(id) => (onOpenPageRaw ?? onOpenPage)?.(id)}
            />
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
   * (owner 2026-10-06; the top bar lifted above the columns 2026-10-09) is
   * a full-width nodeview top bar over a 3-column split: the context column
   * (graph · TOC · Activity · Comments + the footer as its bottom section)
   * rides the first column, the node view the second, and the properties
   * sidebar the third (the swap owner 2026-10-23 — context left, properties
   * right; each panel toggle sits directly above its column in the top bar).
   * Each panel column keeps its own device-local collapse, toggled
   * from the nodeview top bar. Compact layouts render the same chrome
   * full-width, header first, with the top-right chrome in the absolute
   * corner.
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

  /**
   * The Table-of-content entry jump (owner 2026-10-12): scroll the main
   * view to the block and flash it — a TOC entry is navigation within the
   * page, not an open gesture.
   */
  const jumpToBlock = (blockId: string) => {
    const el = document.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`);
    if (!(el instanceof HTMLElement)) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove("nt-block--flash");
    // Restart the flash animation when the same entry is clicked twice.
    void el.offsetWidth;
    el.classList.add("nt-block--flash");
    window.setTimeout(() => el.classList.remove("nt-block--flash"), 1400);
  };

  /**
   * The find-in-page bar (Ctrl/Cmd+F): docked sticky at the top of the page
   * content column — in the panelled layout the nodeview body is the scroll
   * box and the node top bar rides above it, so the bar mounts as the
   * scroll box's first child (directly below the top bar); compact layouts
   * mount it ahead of the header, sticky against whatever scrolls there.
   */
  const findInPageBar = findInPageOpen ? (
    <FindInPageBar
      client={client}
      pageId={pageId}
      scopeRef={pageRootRef}
      inputRef={findInPageInputRef}
      onClose={() => setFindInPageOpen(false)}
    />
  ) : null;

  /**
   * The condensed layer's per-page-body chrome (owner 2026-10-15): the
   * condense-all reset ONLY — the layer toggle itself moved to the app
   * TopBar + the command palette (owner directive 2026-10-15, one surface
   * per action). The reset rides the card's top-right cluster beside the
   * view switcher, shown only while the layer is on AND the stretched set
   * is non-empty — no dead chrome. Main-surface chrome only: where the "…"
   * menu is (chromeMenu), i.e. never on embedded feeds or the preview seam.
   * Toggling the layer off (from the TopBar) restores the ordinary
   * rendering and leaves the stretched set intact (inert while the layer
   * is off, like the folds where a surface ignores them).
   */
  const condensedChrome =
    chromeMenu !== undefined && !embedded && !preview ? (
      <>
        {layerActive && outliner.stretched.size > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            icon="mdi mdi-arrow-collapse-vertical"
            aria-label="Condense all"
            title="Condense all"
            onClick={() => outliner.clearStretched()}
          />
        )}
      </>
    ) : undefined;

  const pageChrome = fullscreenWhiteboard ? (
    <WhiteboardCanvas client={client} hostId={pageId} tokenIndex={whiteboardTokenIndex} />
  ) : (
    <>
      {panelled ? (
        <>
          {/* The panelled composition rides the shared MainContentFrame
              (owner 2026-10-23 — the layout generalized out of this view):
              the nodeview top bar spans the WHOLE card above the column
              split, the context sections ride the left panel card, the
              properties sidebar the right. The frame owns the chrome
              registers only; whether a panel renders stays this view's
              call (its device-local collapse prefs + focus mode below),
              and the bar never rescales when a panel shows or hides. */}
          <MainContentFrame
            topBar={
              <NodeTopbar
                client={client}
                nodeId={pageId}
                classIds={page.classIds}
                sidePanelCollapsed={sidePanelCollapsed}
                onToggleSidePanel={() => setSidePanelCollapsed(!sidePanelCollapsed)}
                contextPanelCollapsed={contextPanelCollapsed}
                onToggleContextPanel={
                  focusMode ? undefined : () => setContextPanelCollapsed(!contextPanelCollapsed)
                }
                chromeModes={chromeModes}
                condensedChrome={condensedChrome}
                chromeMenu={chromeMenu}
                onOpenPage={onOpenPage}
                focusMode={focusMode}
                classesCorner={
                  variant.cornerPills !== undefined ? (
                    <ClassPillsList
                      client={client}
                      nodeId={pageId}
                      onOpenPage={onOpenPage}
                      {...variant.cornerPills}
                    />
                  ) : undefined
                }
              />
            }
            leftPanel={
              !contextPanelCollapsed && !focusMode ? (
                <>
                  {/* The node-relevant widgets (the references dedupe
                      check rejected the rail's ReferencesSection — the
                      Backlinks section owns that data). Top down: the
                      local graph (a collapsed-by-default section — the
                      graph mounts, and loads, only on the first expand),
                      the heading-derived Table of content (clicking an
                      entry jumps the main view to the block), the node's
                      own Activity feed, Version history (the per-node
                      op-log slice), and Comments (threaded, quick-add). */}
                  <LocalGraphCard client={client} nodeId={pageId} onOpenNode={(id) => onOpenPage?.(id)} />
                  <TocSection client={client} pageId={pageId} onJumpToBlock={jumpToBlock} />
                  <ActivityLogSection client={client} nodeId={pageId} />
                  <VersionHistorySection client={client} nodeId={pageId} />
                  <CommentsSection client={client} nodeId={pageId} onOpenNode={onOpenPage} />
                  {/* The footer (word count + Created/Updated stamps) is the
                      column's bottom section (owner 2026-10-09): the
                      card-bottom bar retired — the auto top margin pins it
                      to the card bottom. */}
                  <div className="nt-page-context__footer">{footerChrome}</div>
                </>
              ) : undefined
            }
            rightPanel={
              !sidePanelCollapsed && !focusMode ? (
                <>
                  <PropertiesSidebar
                    client={client}
                    nodeId={pageId}
                    onOpenPage={onOpenPage}
                    onOpenPageRaw={(id) => (onOpenPageRaw ?? onOpenPage)?.(id)}
                  />
                  {/* The class variant's panel stack (owner 2026-10-12):
                      Class properties + Templates under the Metadata panel.
                      Empty for every other variant. */}
                  {variantSidebarSections.length > 0 && (
                    <div className="nt-page-side-panel__sections">{variantSidebarSections}</div>
                  )}
                </>
              ) : undefined
            }
          >
            {/* The journal-measure cap rides the host's own wrapper (the
                frame's middle cell carries none): the content column caps
                at 46rem and centers inside whatever space the panels leave. */}
            <div className="nt-page-content">
              {/* The nodeview proper: auto height between the full-width
                  top bar above the columns and the card bottom — it scrolls
                  when the content outgrows the cell. The footer moved to the
                  context column's bottom (owner 2026-10-09). */}
              <div className="nt-nodeview-body">
                {findInPageBar}
                {headerChrome}
                {mainChrome}
              </div>
            </div>
          </MainContentFrame>
        </>
      ) : (
        <>
          {findInPageBar}
          {headerChrome}
          {mainChrome}
          {footerChrome}
          {(chromeModes !== undefined || chromeMenu !== undefined) && (
            <div className="nt-node-view__corner">
              {chromeModes}
              {condensedChrome}
              {chromeMenu}
            </div>
          )}
        </>
      )}
    </>
  );

  return (
    <OutlinerContext.Provider value={outliner}>
      <LinkEditModalHost client={client}>
        {/* The edit thread (EditThread.tsx): rows report their edit state;
            the select surface below hosts the measured SVG overlay. */}
        <EditThreadProvider>
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
        </EditThreadProvider>
      </LinkEditModalHost>
    </OutlinerContext.Provider>
  );
}
