/**
 * GhostRow — the v1 ghost block recovered: every expanded block (and the
 * page root) trails a muted "+ Add block" row at the next depth; the click
 * realizes it into a real empty block under that parent (created after the
 * last real child) and focuses it. The §34.85 ruling: the ghost is the SOLE
 * add affordance and shows even on empty bodies.
 *
 * The row is display state only — it never enters a SortableContext items
 * array, carries no sortable/drag wiring, and the click is the single write.
 * Mounts gate it: no ghosts in read-only projections, embedded renders,
 * prose/cards transforms, or table containers.
 */

import type { OutlinerContextValue } from "./outliner-context.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import "./GhostRow.css";

/** The v1 ghost identity: `__ghost-<parentId>` (never a real node id). */
export function ghostIdFor(parentId: string): string {
  return `__ghost-${parentId}`;
}

interface GhostRowProps {
  parentId: string;
  onRealize: () => void;
}

export function GhostRow({ parentId, onRealize }: GhostRowProps) {
  return (
    <div className="nt-ghost-row" data-ghost={ghostIdFor(parentId)} data-ghost-parent={parentId}>
      {/* The gutter/bullet renders the normal row chrome at this depth (a
          muted dot — no chevron, no drag, no zoom), keeping the affordance
          aligned with the rows above it. */}
      <span className="nt-ghost-row__gutter" aria-hidden="true">
        <span className="nt-ghost-row__bullet" />
      </span>
      <button
        type="button"
        className="nt-ghost-row__add"
        aria-label="Add block"
        onClick={(event) => {
          event.stopPropagation();
          onRealize();
        }}
      >
        + Add block
      </button>
    </div>
  );
}

/**
 * Realize a ghost into a real block (v1 handleGhostRealize parity): create
 * the empty child of the ghost's parent AFTER its last real child, then hand
 * the caret to the new block. A flush of any pending draft happens through
 * the usual debounced exit — the create is one object.create.
 */
export async function realizeGhost(
  client: Pick<WorkspaceClient, "getChildren" | "createObject">,
  outliner: Pick<OutlinerContextValue, "requestFocus">,
  parentId: string,
): Promise<void> {
  const children = client.getChildren(parentId);
  const last = children[children.length - 1];
  const id = await client.createObject({
    parentId,
    contentAst: [],
    ...(last !== undefined ? { afterId: last.id } : {}),
  });
  outliner.requestFocus(id, "start");
}
