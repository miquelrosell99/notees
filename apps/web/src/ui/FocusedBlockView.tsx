/**
 * FocusedBlockView — the focused block view (the bullet-zoom surface):
 * the focused node as the PARENT of a NodeCollection (owner 2026-10-20 —
 * the v1 "show parents" NodeCollection prop, generalized). Each view mode
 * decides the parent display: outline renders it as the root block row
 * with the children nested under it (the zoom grammar — parent row, rail,
 * indented children); prose renders it as an editable top-level header
 * (the title-variant row — title-is-content: the block's own text IS the
 * header), the children flattened below by the prose transform. Cards and
 * table have no defined parent display yet — the view wears outline for
 * them until the mode decides (owner 2026-10-20).
 *
 * A bare call since 2026-10-23: the collection's BODY MODE (`rootId`) +
 * the self-hosted bundle carry everything — the outliner context (rooted
 * at the focused block), the edit thread (the overlay walks from the
 * focused block down to the editing child), and the "+ Add block" ghost
 * (riding the parent row's children container — the child indent level,
 * never a sibling of the focused block; prose trails it at the flattened
 * list's end). The view mode rides the same per-node device preference
 * the page view uses (`nodeBlocks.<id>`); the switcher itself stays page
 * chrome (the focused view keeps the "…" corner only).
 *
 * ReferenceSubtree stays for the genuine subtree renders (linked
 * references, the hover-preview trampoline) — the focused view is the
 * only zoom surface.
 */

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client/index.js";

import { NodeCollection } from "../features/collection/NodeCollection.js";
import type { ViewMode } from "../features/collection/types.js";

export function FocusedBlockView({
  client,
  node,
  viewMode,
  readOnly = false,
  onOpenNode,
}: {
  client: WorkspaceClient | WorkerClient;
  /** The focused node — the collection's parent. */
  node: ClientNode;
  /** The per-node child-blocks view preference (the page view's triad). */
  viewMode: ViewMode;
  /** Read-only projection (the hover preview): clicks navigate, never edit. */
  readOnly?: boolean;
  onOpenNode?: ((nodeId: string) => void) | undefined;
}) {
  // Cards/table have no defined parent display yet — the focused view wears
  // outline for them until the mode decides (owner 2026-10-20).
  const effectiveMode: ViewMode = viewMode === "prose" ? "prose" : "outline";
  return (
    <div className="nt-page nt-focused-block">
      <NodeCollection
        viewMode={effectiveMode}
        client={client}
        rootId={node.id}
        parent={node}
        tree
        editable={!readOnly}
        ghost={!readOnly}
        onNodeClick={(id) => onOpenNode?.(id)}
      />
    </div>
  );
}
