/**
 * NodeView — the mode dispatch over ONE node (the Revision-11 render
 * cascade, SCHEMA.md): a class node renders the page view composed with
 * the class variant data (M13 — the class page IS a page: the extends
 * corner's ClassPillsList config + the class section stack, see
 * components/pageVariant.ts); a parented non-class node with the render
 * bit unset renders the focused block view (inline body + block chrome);
 * everything else — parentless or present-as-main — renders the Page View
 * (document chrome). Extracted from App.tsx (the main-content restructure,
 * S1) so every host (the main card, the right-rail cards, the floating
 * editors) renders the same dispatcher instead of re-implementing the
 * cascade.
 *
 * The shell also owns the card's chrome-right cluster: pages get the blocks
 * view switcher + the "…" node menu (rendered by PageView — in the nodeview
 * top bar when panelled, else the absolute corner); class/block views keep
 * just the "…" menu in the absolute corner.
 *
 * Surfaces (M15): main (default) · workspace card (compact layout via
 * `cornerMenu: false`) · preview (`preview` — hover/peek: no machinery at
 * all — no corner menu, no global listeners, a read-only body capped at
 * the first level, no section stack; the hover preview keeps its bespoke
 * card until the follow-up swap) and `embedded` (journals feed, calendar
 * embed, floating windows) — `embedded` suppresses the page chrome the host
 * already carries (find/replace chord, top bar) and never shows the corner
 * menu. (A class node renders full chrome on every surface, the pre-S5
 * ClassView behavior — the class variant keeps the embedded flag off so
 * class pages stay visually identical minus the deleted M9/M12 chrome.)
 */

import { rendersAsInlineBlock } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client.js";

import { PageView, BLOCKS_VIEW_MODES } from "./PageView.js";
import { ReferenceSubtree } from "./components/ReferenceSubtree.js";
import { NodeMenuButton, type ShareTarget } from "./components/NodeMenuButton.js";
import { ViewToolbar } from "./views/ViewToolbar.js";
import { useViewModePreference } from "./viewPrefs.js";

export function NodeView({
  client,
  nodeId,
  onOpenNode,
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
   * Preview surface (M15 — hover/peek): no corner menu, no global
   * listeners, a read-only body capped at the first level, no section
   * stack. Nothing renders it yet — swapping NodeHoverPreview's bespoke
   * card for this seam is the registered follow-up.
   */
  preview = false,
}: {
  client: WorkspaceClient | WorkerClient;
  nodeId: string;
  onOpenNode?: ((nodeId: string) => void) | undefined;
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
  const node = client.getNode(nodeId);
  if (node === undefined) {
    return <div className="nt-page-missing">Page not found.</div>;
  }
  const pageView = !node.isClass && !rendersAsInlineBlock(node);
  /**
   * The card's top-right chrome: pages get the blocks view switcher + the
   * "…" node menu (rendered by PageView — in the nodeview top bar when
   * panelled, else the absolute corner); class/block views keep just the
   * "…" menu in the absolute corner. The preview surface carries none.
   */
  const chromeRight =
    pageView && cornerMenu && !preview ? (
      <>
        <div className="nt-node-view__modes" role="group" aria-label="Blocks view">
          <ViewToolbar modes={BLOCKS_VIEW_MODES} value={blocksMode} onChange={setBlocksMode} />
        </div>
        <NodeMenuButton
          client={client}
          node={node}
          onOpenNode={(id) => onOpenNode?.(id)}
          onPresent={onPresent}
          onDeleted={onDeleted}
          shareTarget={shareTarget}
        />
      </>
    ) : undefined;
  const view = rendersAsInlineBlock(node) ? (
    /* Block mode (S4): the body is the plain collection — the node itself as
       the root row with its children under it (ReferenceSubtree builds the
       minimal outliner + SortableContext and renders the real editable
       BlockRow; no drag context here, so rows are editable but not
       draggable — the context-presence law). The wrapper keeps the
       FocusedBlockView-era chrome class (nt-page nt-focused-block). */
    <div className="nt-page nt-focused-block">
      <ReferenceSubtree client={client} rootId={nodeId} onOpenNode={onOpenNode} />
    </div>
  ) : (
    /* Page mode — plain, date (day/period), or class: PageView composes the
       chrome from the variant descriptor (M13). A class node carries the
       class variant data (extends corner + class sections) and keeps the
       embedded flag off (the pre-S5 ClassView rendered full chrome on every
       surface). The preview surface rides the compact layout with the
       capped, read-only body (PageView's `preview` prop). */
    <PageView
      client={client}
      pageId={nodeId}
      onOpenPage={onOpenNode}
      onOpenInSidebar={onOpenInSidebar}
      onDeleted={onDeleted}
      onPresent={onPresent}
      shareTarget={shareTarget}
      embedded={node.isClass ? false : embedded}
      layout={cornerMenu && !preview ? "default" : "compact"}
      preview={preview}
      blocksMode={blocksMode}
      onBlocksModeChange={setBlocksMode}
      chromeRight={chromeRight}
    />
  );
  if (!cornerMenu || preview) return view;
  return (
    <div className="nt-node-view">
      {view}
      {!pageView && (
        <div className="nt-node-view__corner">
          <NodeMenuButton
            client={client}
            node={node}
            onOpenNode={(id) => onOpenNode?.(id)}
            onPresent={onPresent}
            onDeleted={onDeleted}
            shareTarget={shareTarget}
          />
        </div>
      )}
    </div>
  );
}
