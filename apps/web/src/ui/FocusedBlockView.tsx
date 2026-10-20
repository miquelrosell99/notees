/**
 * FocusedBlockView — the focused block view (the bullet-zoom surface):
 * the focused node as the PARENT of a NodeCollection. Each view mode
 * decides the parent display: outline renders it as the root block row
 * with the children nested under it (the zoom grammar — parent row, rail,
 * indented children); prose renders it as an editable top-level header
 * (the title-variant row — title-is-content: the block's own text IS the
 * header), the children flattened below by the prose transform. Cards and
 * table have no defined parent display yet — the view falls back to
 * outline for them (a documented gap until the modes decide).
 *
 * Hosts the same machinery ReferenceSubtree did — its own OutlinerContext
 * (the rows consume it; the navigation fallback is the container's
 * onOpenNode) and the edit-thread provider + measured overlay (the thread
 * runs from the focused block down to the editing child). The "+ Add
 * block" ghost trails the parent row's children container (the child
 * indent level — never a sibling of the focused block), realized through
 * the shared outliner client. The view mode rides the same per-node
 * device preference the page view uses (`nodeBlocks.<id>`); the switcher
 * itself stays page chrome (the focused view keeps the "…" corner only).
 *
 * ReferenceSubtree stays for the genuine subtree renders (linked
 * references, the hover-preview trampoline) — the focused view is the
 * only zoom surface.
 */

import { useRef } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client/index.js";

import { NodeCollection } from "../features/collection/NodeCollection.js";
import { childQuery } from "../features/collection/childQuery.js";
import type { ViewMode } from "../features/collection/types.js";
import { GhostRow, realizeGhost } from "./GhostRow.js";
import { OutlinerContext, useOutlinerValue } from "./outliner-context.js";
import { EditThreadOverlay, EditThreadProvider } from "./EditThread.js";

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
  const outliner = useOutlinerValue(client, node.id, { openNode: (id) => onOpenNode?.(id) });
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Cards/table have no defined parent display yet — the focused view wears
  // outline for them until the mode decides.
  const effectiveMode: ViewMode = viewMode === "prose" ? "prose" : "outline";
  return (
    <OutlinerContext.Provider value={outliner}>
      <EditThreadProvider>
        <div ref={hostRef} className="nt-page nt-focused-block nt-edit-thread-host">
          {/* The edit thread (EditThread.tsx): the measured overlay draws
              from the FOCUSED block row (the view root, a real bullet)
              down to the editing child — same host contract as the page
              body. */}
          <EditThreadOverlay client={client} hostRef={hostRef} rootId={node.id} />
          <NodeCollection
            viewMode={effectiveMode}
            client={client}
            items={childQuery(client, node.id)}
            tree
            editable={!readOnly}
            parent={node}
            parentTrailing={
              readOnly ? undefined : (
                <GhostRow
                  parentId={node.id}
                  onRealize={() => {
                    void realizeGhost(client, outliner, node.id).catch((error: unknown) => {
                      console.warn(`[outliner] ghost realize (${node.id}) failed:`, error);
                    });
                  }}
                />
              )
            }
            onNodeClick={(id) => onOpenNode?.(id)}
          />
        </div>
      </EditThreadProvider>
    </OutlinerContext.Provider>
  );
}
