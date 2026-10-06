/**
 * NodeView — the mode dispatch over ONE node (the Revision-11 render
 * cascade, SCHEMA.md): a class node renders the Class View; a parented
 * non-class node with the render bit unset renders the focused block view
 * (inline body + block chrome); everything else — parentless or
 * present-as-main — renders the Page View (document chrome). Extracted from
 * App.tsx (the main-content restructure, S1) so every host (the main card,
 * the right-rail cards, the floating editors) renders the same dispatcher
 * instead of re-implementing the cascade.
 *
 * The shell also owns the card's chrome-right cluster: pages get the blocks
 * view switcher + the "…" node menu (rendered by PageView — in the nodeview
 * top bar when panelled, else the absolute corner); class/block views keep
 * just the "…" menu in the absolute corner.
 *
 * Surfaces (M15): main (default) · workspace card (compact layout via
 * `cornerMenu: false`) · preview and `embedded` (journals feed, calendar
 * embed, floating windows) — `embedded` suppresses the page chrome the host
 * already carries (find/replace chord, top bar) and never shows the corner
 * menu.
 */

import { rendersAsInlineBlock } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client.js";

import { PageView, BLOCKS_VIEW_MODES } from "./PageView.js";
import { ClassView } from "./ClassView.js";
import { FocusedBlockView } from "./components/FocusedBlockView.js";
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
   * "…" menu in the absolute corner.
   */
  const chromeRight =
    pageView && cornerMenu ? (
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
  const view = node.isClass ? (
    <ClassView client={client} classId={nodeId} onOpenClass={onOpenNode} onOpenPage={onOpenNode} />
  ) : rendersAsInlineBlock(node) ? (
    <FocusedBlockView client={client} blockId={nodeId} onOpenNode={onOpenNode} />
  ) : (
    <PageView
      client={client}
      pageId={nodeId}
      onOpenPage={onOpenNode}
      onOpenInSidebar={onOpenInSidebar}
      onDeleted={onDeleted}
      onPresent={onPresent}
      shareTarget={shareTarget}
      embedded={embedded}
      layout={cornerMenu ? "default" : "compact"}
      blocksMode={blocksMode}
      onBlocksModeChange={setBlocksMode}
      chromeRight={chromeRight}
    />
  );
  if (!cornerMenu) return view;
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
