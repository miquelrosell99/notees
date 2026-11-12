/**
 * NodeView — the mode dispatch over ONE node (the Revision-11 render
 * cascade, SCHEMA.md): a class node renders the page view composed with
 * the class variant data (the class page IS a page: the extends
 * corner's ClassPillsList config + the class section stack, see
 * components/pageVariant.ts); a parented non-class node with the render
 * bit unset renders the focused block view (inline body + block chrome);
 * everything else — parentless or present-as-main — renders the Page View
 * (document chrome). Extracted from App.tsx (the main-content restructure)
 * so every host (the main card, the right-rail cards, the floating
 * editors) renders the same dispatcher instead of re-implementing the
 * cascade.
 *
 * The shell also owns the card's chrome-right cluster: pages get the blocks
 * view switcher + the "…" node menu as two pieces (rendered by PageView —
 * in the nodeview top bar when panelled, with the context-panel toggle
 * between them, else the absolute corner); class pages ride the same top
 * bar / corner via the "…" piece (the old class-only absolute corner
 * overlapped the panelled bar's context toggle); inline-block (focused)
 * views on the main surface wear the page view's PANELLED composition —
 * the shared MainContentFrame, the same nodeview top bar (now with the
 * view switcher too, offering the focused view's honest outline/prose
 * pair), and BOTH panel columns carrying the focused node's info
 * (graph/TOC/Activity/Version history/Comments) and metadata — toggled
 * from the same bar, riding the same app-wide device prefs; the compact
 * (sections-layout) register rides the absolute corner like every compact
 * page.
 *
 * Surfaces: main (default) · workspace card (compact layout via
 * `cornerMenu: false`) · preview (`preview` — hover/peek: no machinery at
 * all — no corner menu, no global listeners, a read-only body capped at
 * the first level, no section stack; the hover preview renders it) and
 * `embedded` (journals feed, calendar embed, floating windows) —
 * `embedded` suppresses the page chrome the host already carries
 * (find/replace chord, top bar) and never shows the corner menu. (A class
 * node renders full chrome on every surface, the pre-restructure
 * ClassView behavior — the class variant keeps the embedded flag off so
 * class pages stay visually identical minus the deleted curated chrome.)
 */

import type { ReactNode } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client/index.js";

import { PageView, BLOCKS_VIEW_MODES } from "./PageView.js";
import { FocusedBlockView } from "./FocusedBlockView.js";
import { NodeMenuButton, type ShareTarget } from "../features/node-menu/NodeMenuButton.js";
import { rendersAsInlineBlockOf } from "./renderStateLabel.js";
import { ViewToolbar } from "../features/collection/ViewToolbar.js";
import type { ViewMode } from "../features/collection/types.js";
import { LocalGraphCard } from "../features/collection/LocalGraphCard.js";
import { TocSection } from "./app/sidebarSections.js";
import { ActivityLogSection } from "../features/page-sections/ActivityLogSection.js";
import { VersionHistorySection } from "../features/page-sections/VersionHistorySection.js";
import { CommentsSection } from "../features/page-sections/CommentsSection.js";
import { PropertiesSidebar } from "../features/metadata/index.js";
import { useDeviceSetting } from "../features/settings/deviceSettings.js";
import { useViewModePreference } from "./viewPrefs.js";
import { MainContentFrame } from "./MainContentFrame.js";
import { NodeTopbar } from "./PageChrome.js";

/**
 * The focused view's switcher modes: the collection coerces every other
 * mode to outline until cards/table decide a parent display, so the bar
 * offers the honest pair only.
 */
const FOCUSED_BLOCKS_MODES: ViewMode[] = ["outline", "prose"];

export function NodeView({
  client,
  nodeId,
  onOpenNode,
  /**
   * The RAW open (no alias redirect): browser-deep-link identity + the
   * aliases UI's NAVIGATE, which deliberately opens an alias node's OWN
   * view. Defaults to onOpenNode.
   */
  onOpenNodeRaw,
  onOpenInSidebar,
  onDeleted,
  onPresent,
  cornerMenu = false,
  shareTarget = undefined,
  /**
   * Embedded surface (journals feed, calendar embed, floating editor
   * windows): the page renders its slim chrome — no corner menu, and the
   * page-level global listeners stay off so stacked feeds don't install one
   * document listener per entry.
   */
  embedded = false,
  /**
   * Preview surface (hover/peek: NodeHoverPreview renders it): no corner
   * menu, no global listeners, a read-only body capped at the first level,
   * no section stack — a trampoline, not an editor.
   */
  preview = false,
  /**
   * Document-level listeners (find/replace chord, fold chords). Defaults to
   * the main-surface value (`!preview`); the right-rail workspace cards pass
   * false explicitly — the chords stay main-surface-only.
   */
  globalShortcuts = undefined,
  /**
   * The session-only layout toggle: true
   * renders the main content as in-flow SECTIONS (the compact layout —
   * Metadata + the variant's sections stacked in the content flow), false
   * keeps the panelled default (the properties sidebar rides the first
   * column). The app top bar's layout button flips it; it lasts the session.
   */
  sectionsLayout = false,
  /**
   * The peek-card surface (the right rail's NodeCard): every system section
   * starts collapsed — the card is a glance, not a workspace.
   */
  sectionsStartCollapsed = false,
  /**
   * Extra content for the view's own top-bar actions cluster (the chrome
   * ruling, ONE bar per surface): the host injects
   * surface-specific actions (the day page's DayStepper) into the bar
   * NodeView/PageView already render instead of stacking a second bar
   * above. Main-surface chrome only: embedded/preview renders suppress
   * it with the rest of the chrome (the pieces below gate on cornerMenu
   * && !preview).
   */
  topBarActionsExtra = undefined,
}: {
  client: WorkspaceClient | WorkerClient;
  nodeId: string;
  onOpenNode?: ((nodeId: string) => void) | undefined;
  /**
   * The RAW open (no alias redirect): browser-deep-link identity + the
   * aliases UI's NAVIGATE, which deliberately opens an alias node's OWN
   * view. Defaults to onOpenNode.
   */
  onOpenNodeRaw?: ((nodeId: string) => void) | undefined;
  onOpenInSidebar?: ((nodeId: string) => void) | undefined;
  onDeleted?: ((node: ClientNode) => void) | undefined;
  /**
   * Presentation mode: the page's "Present" surfaces (the "…" menu, the
   * header context menu) request a deck of this node's subtree, routed to
   * the deck host above.
   */
  onPresent?: ((nodeId: string) => void) | undefined;
  /**
   * Main-card mode: also render the "…" node menu pinned to the content
   * card's top-right chrome. Only the main view card opts in; sidebar peek
   * cards keep their own header actions and skip it.
   */
  cornerMenu?: boolean | undefined;
  /** Shares: server coordinates for the "Share…" surface (pages). */
  shareTarget?: ShareTarget | undefined;
  embedded?: boolean | undefined;
  preview?: boolean | undefined;
  globalShortcuts?: boolean | undefined;
  /** Session-only: render the main content as in-flow sections (see above). */
  sectionsLayout?: boolean | undefined;
  /** The peek-card surface: all system sections start collapsed. */
  sectionsStartCollapsed?: boolean | undefined;
  /** Extra actions injected into the view's own top bar (the day page's
   *  DayStepper) — one bar per surface, never a stacked second bar. */
  topBarActionsExtra?: ReactNode;
}) {
  /**
   * The child-blocks view mode, owned here because the switcher rides this
   * view's top-right chrome (left of the "…" menu). The same per-page
   * device preference PageView falls back to, so the choice survives the
   * move.
   */
  const [blocksMode, setBlocksMode] = useViewModePreference(
    `nodeBlocks.${nodeId}`,
    "outline",
    BLOCKS_VIEW_MODES,
  );
  /**
   * The panelled focused view wears the SAME global panel + focus-mode
   * device state the page view reads (the panels' open/closed state is
   * app-wide, not per view).
   */
  const [focusMode] = useDeviceSetting("focusMode", false);
  const [sidePanelCollapsed, setSidePanelCollapsed] = useDeviceSetting(
    "pageSidePanelCollapsed",
    false,
  );
  const [contextPanelCollapsed, setContextPanelCollapsed] = useDeviceSetting(
    "pageContextPanelCollapsed",
    false,
  );
  const node = client.getNode(nodeId);
  if (node === undefined) {
    return <div className="nt-page-missing">Page not found.</div>;
  }
  const inlineBlock = rendersAsInlineBlockOf(client, node);
  const pageView = !node.isClass && !inlineBlock;
  /**
   * The card's top-right chrome pieces: pages AND the focused block view
   * get the blocks view switcher (rendered by NodeView — in the nodeview
   * top bar when panelled, else the absolute corner); the "…" menu rides
   * the same sites (chromeMenu for pages, focusedMenu for the focused
   * view). The preview surface carries none.
   */
  const chromeModes =
    (pageView || inlineBlock) && cornerMenu && !preview ? (
      <div className="nt-node-view__modes" role="group" aria-label="Blocks view">
        <ViewToolbar
          modes={inlineBlock ? FOCUSED_BLOCKS_MODES : BLOCKS_VIEW_MODES}
          value={blocksMode}
          onChange={setBlocksMode}
        />
      </div>
    ) : undefined;
  const chromeMenu =
    !inlineBlock && cornerMenu && !preview ? (
      <NodeMenuButton
        client={client}
        node={node}
        onOpenNode={(id) => onOpenNode?.(id)}
        onPresent={onPresent}
        onDeleted={onDeleted}
        shareTarget={shareTarget}
      />
    ) : undefined;
  /**
   * The inline-block (focused) view's menu: the same "…" node menu pages
   * carry, riding the SAME nodeview top bar the page view composes when
   * panelled (below), or the compact register's absolute corner beside the
   * view switcher.
   */
  const focusedMenu =
    inlineBlock && cornerMenu && !preview ? (
      <NodeMenuButton
        client={client}
        node={node}
        onOpenNode={(id) => onOpenNode?.(id)}
        onPresent={onPresent}
        onDeleted={onDeleted}
        shareTarget={shareTarget}
      />
    ) : undefined;
  /**
   * The panelled main surface (the default): the focused view wears the
   * page view's panelled composition — the shared frame, the nodeview top
   * bar, and BOTH panel columns for the FOCUSED node. The compact
   * (sections-layout) register rides the absolute corner like every
   * compact page.
   */
  const focusedPanelled = inlineBlock && cornerMenu && !preview && !sectionsLayout;
  const view = rendersAsInlineBlockOf(client, node) ? (
    /* Block mode — the focused block view: the node is
       the PARENT of a NodeCollection (the v1 "show parents" prop,
       generalized) — each view mode decides the parent display (outline:
       the root block row with children nested; prose: an editable
       top-level header). FocusedBlockView hosts the outliner context, the
       edit-thread overlay, and the trailing ghost; the preview surface
       passes readOnly — the trampoline is never an editor. No drag scope:
       rows are editable but not draggable — the context-presence law. */
    <FocusedBlockView
      client={client}
      node={node}
      viewMode={blocksMode}
      readOnly={preview}
      panelled={focusedPanelled}
      onOpenNode={onOpenNode}
      onOpenInSidebar={onOpenInSidebar}
    />
  ) : (
    /* Page mode — plain, date (day/period), or class: PageView composes the
       chrome from the variant descriptor. A class node carries the
       class variant data (extends corner + class sections) and keeps the
       embedded flag off (the pre-restructure ClassView rendered full chrome on every
       surface). The preview surface rides the compact layout with the
       capped, read-only body (PageView's `preview` prop). */
    <PageView
      client={client}
      pageId={nodeId}
      onOpenPage={onOpenNode}
      onOpenPageRaw={onOpenNodeRaw ?? onOpenNode}
      onOpenInSidebar={onOpenInSidebar}
      onDeleted={onDeleted}
      onPresent={onPresent}
      shareTarget={shareTarget}
      embedded={node.isClass ? false : embedded}
      layout={cornerMenu && !preview ? (sectionsLayout ? "compact" : "default") : "compact"}
      preview={preview}
      sectionsStartCollapsed={sectionsStartCollapsed}
      blocksMode={blocksMode}
      onBlocksModeChange={setBlocksMode}
      chromeModes={chromeModes}
      chromeMenu={chromeMenu}
      topBarActionsExtra={cornerMenu && !preview ? topBarActionsExtra : undefined}
      globalShortcuts={globalShortcuts}
    />
  );
  if (!cornerMenu || preview) return view;

  /**
   * The TOC entry jump (the focused view's context column): scroll the
   * view to the block and flash it — a TOC entry is navigation within the
   * surface, not an open gesture.
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

  if (focusedPanelled) {
    return (
      <div className="nt-node-view nt-node-view--panelled">
        {/* The focused block view wears the page view's panelled
            composition: the SAME nodeview top bar (context toggle + classes
            pills left, the view switcher + "…" menu right, the properties
            toggle trailing) over the shared frame — the context column and
            the properties sidebar carry the FOCUSED node's info and
            metadata, and both columns keep the page view's device-local
            collapse (the panel state is app-wide). */}
        <MainContentFrame
          topBar={
            <NodeTopbar
              client={client}
              nodeId={nodeId}
              classIds={node.classIds}
              sidePanelCollapsed={sidePanelCollapsed}
              onToggleSidePanel={() => setSidePanelCollapsed(!sidePanelCollapsed)}
              contextPanelCollapsed={contextPanelCollapsed}
              onToggleContextPanel={
                focusMode ? undefined : () => setContextPanelCollapsed(!contextPanelCollapsed)
              }
              chromeModes={chromeModes}
              chromeMenu={focusedMenu}
              onOpenPage={onOpenNode}
              focusMode={focusMode}
            />
          }
          leftPanel={
            !contextPanelCollapsed && !focusMode ? (
              <>
                {/* The node-relevant info widgets, same stack the page
                    view's context column carries — for the focused node. */}
                <LocalGraphCard
                  client={client}
                  nodeId={nodeId}
                  onOpenNode={(id) => onOpenNode?.(id)}
                />
                <TocSection client={client} pageId={nodeId} onJumpToBlock={jumpToBlock} />
                <ActivityLogSection client={client} nodeId={nodeId} />
                <VersionHistorySection client={client} nodeId={nodeId} />
                <CommentsSection client={client} nodeId={nodeId} onOpenNode={onOpenNode} />
              </>
            ) : undefined
          }
          rightPanel={
            !sidePanelCollapsed && !focusMode ? (
              <PropertiesSidebar
                client={client}
                nodeId={nodeId}
                onOpenPage={onOpenNode}
                onOpenInSidebar={onOpenInSidebar}
                onOpenPageRaw={(id) => (onOpenNodeRaw ?? onOpenNode)?.(id)}
              />
            ) : undefined
          }
        >
          {/* The same middle-cell register the panelled page rides: the
              cell wrapper is the scroll box, the 46rem cap centers the
              focused collection inside it. */}
          <div className="nt-page-content">
            <div className="nt-nodeview-body">{view}</div>
          </div>
        </MainContentFrame>
      </div>
    );
  }

  return (
    <div className="nt-node-view">
      {/* The compact (sections-layout) focused view rides the page view's
          absolute corner: the view switcher + the "…" menu, no in-flow
          bar. Page views keep their own corner inside PageView. */}
      {inlineBlock && (
        <div className="nt-node-view__corner">
          {chromeModes}
          {focusedMenu}
        </div>
      )}
      {view}
    </div>
  );
}
