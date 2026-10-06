/**
 * GhostRow — the v1 ghost block recovered, §34.109-refined: the page root
 * trails exactly ONE muted "+ Add block" row as the last sibling of the main
 * level; the click realizes it into a real empty block after the last child
 * and focuses it. Blocks no longer trail their own ghosts at every depth
 * (owner 2026-10-06: one ghost per page, not one per level). The §34.85
 * ruling stands in spirit: the ghost is the SOLE add affordance and shows
 * even on empty bodies — in outline AND prose mode (prose hides bullets,
 * so the `prose` flag drops this row's gutter to read as plain trailing
 * text). Cards, read-only projections, and embedded renders mount none.
 *
 * The row is display state only — it never enters a SortableContext items
 * array, carries no sortable/drag wiring, and the click is the single write.
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
  /**
   * Prose mode (the view transform hides every bullet): drop the gutter so
   * the row reads as plain trailing text, flush with the prose paragraphs.
   */
  prose?: boolean | undefined;
}

export function GhostRow({ parentId, onRealize, prose = false }: GhostRowProps) {
  return (
    <div
      className={prose ? "nt-ghost-row nt-ghost-row--prose" : "nt-ghost-row"}
      data-ghost={ghostIdFor(parentId)}
      data-ghost-parent={parentId}
    >
      {/* The gutter/bullet renders the normal row chrome at this depth (a
          faint dot — never a real bullet's weight; no chevron, no drag, no
          zoom), keeping the affordance aligned with the rows above it. */}
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
