/**
 * ReferenceSubtree — renders a referencing node (and its children,
 * recursively) with the REAL editor row (BlockRow): the node context menu
 * on right-click, class-icon bullets, click-to-zoom bullets, collapse
 * chevrons, in-place editing — identical to the main block tree. Writes go
 * through the shared outliner client, so edits inside a reference behave
 * exactly like edits in the page body (same ops, same sync).
 *
 * The ROOT row starts COLLAPSED when it has children (owner 2026-10-21,
 * the collection-list ruling): a backlinks/unlinked row reads one row per
 * reference, the subtree behind the chevron — same default, same
 * session-local override as the flat outline list.
 *
 * `readOnly` (the hover preview's preview surface) renders the same rows
 * inert: clicks navigate instead of editing, the context menu stays shut,
 * and the rows wear the readonly class (excluded from drag measuring). The
 * read-only projection also mounts no ghost (the add affordance is editing
 * chrome).
 *
 * The "+ Add block" ghost is OPT-IN (`showGhost`, owner 2026-10-20): this
 * component serves system chrome surfaces — the Backlinks / Unlinked
 * mentions sections, the property carrier cell — where the trailing ghost
 * leaked in as stray editing chrome (a click would append a child block to
 * a referencing node from inside a read-out section). The ghost belongs to
 * document bodies (the page root, the focused block view), never to
 * collection sections; their add affordance is the section's own "+"
 * (showAddButton/onAdd).
 *
 * BlockRow consumes OutlinerContext and useSortable, so each subtree hosts
 * its own OutlinerContext (via useOutlinerValue, same as PageView)
 * and its own SortableContext — but NO DndContext: the surrounding page
 * view's DndContext owns every row, so blocks drag across lists (page body
 * ↔ linked references) within one drag session.
 *
 * The edit thread (owner 2026-10-20): the focused view is a NodeCollection
 * parent now (FocusedBlockView) — ReferenceSubtree keeps the genuine
 * subtree renders (linked references, the hover-preview trampoline).
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";

import type { WorkerClient } from "@/core/worker-client.js";
import type { BlockTreeNode, ClientNode, WorkspaceClient } from "@/core/workspace-client/index.js";

import { BlockRow, useStableIdArray } from "../../ui/BlockRow.js";
import { displayNameFromClient } from "../../ui/dateDisplay.js";
import { GhostRow, realizeGhost } from "../../ui/GhostRow.js";
import { OutlinerContext, useOutlinerValue } from "../../ui/outliner-context.js";

type AnyClient = WorkspaceClient | WorkerClient;

/** Cycle-protection depth cap, mirroring the client's getBlockTree default. */
const TREE_DEPTH_CAP = 64;

function toTree(client: AnyClient, node: ClientNode, remaining = TREE_DEPTH_CAP): BlockTreeNode {
  return {
    node,
    children:
      remaining <= 0
        ? []
        : client.getChildren(node.id).map((child) => toTree(client, child, remaining - 1)),
  };
}

/** The referencing node plus its whole subtree — editable, or read-only. */
export function ReferenceSubtree({
  client,
  rootId,
  onOpenNode,
  readOnly = false,
  showGhost = false,
}: {
  client: AnyClient;
  rootId: string;
  onOpenNode?: ((nodeId: string) => void) | undefined;
  /** Read-only projection (the hover preview): clicks navigate, never edit. */
  readOnly?: boolean;
  /**
   * Trail the "+ Add block" ghost as the root's last CHILD (the focused
   * block view's affordance register). DEFAULT OFF: every current surface
   * of this component is system chrome, where the ghost is stray editing
   * chrome — document bodies mount their own GhostRow directly.
   */
  showGhost?: boolean;
}) {
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  const node = client.getNode(rootId);
  // Stable identity — the memoized BlockRow compares it by reference, so a
  // fresh arrow per render would defeat the row bail-out.
  const resolveName = useCallback((id: string) => displayNameFromClient(client, id), [client]);
  // Stable identity for dnd-kit's SortableContext (the row memo's defeat
  // otherwise — see useStableIdArray).
  const rootIds = useStableIdArray(node !== undefined ? [node.id] : []);
  // The root row starts COLLAPSED when it has children (owner 2026-10-21,
  // the collection-list ruling — the backlinks/unlinked rows read one row
  // per reference, the subtree behind the chevron). The override is
  // session-local (the OutlinerContext contract). A `showGhost` surface is
  // an editing document, not a read-out list — the "+ Add block" ghost
  // rides the children container, so the root stays expanded.
  const childCount = node === undefined ? 0 : client.getChildren(rootId).length;
  const defaultCollapsed = useMemo(
    () => (!showGhost && childCount > 0 ? new Set([rootId]) : undefined),
    [rootId, childCount, showGhost],
  );
  const outliner = useOutlinerValue(client, rootId, {
    openNode: (id) => onOpenNode?.(id),
    defaultCollapsed,
  });

  if (node === undefined) return null;
  const tree = toTree(client, node);

  return (
    <OutlinerContext.Provider value={outliner}>
      <SortableContext items={rootIds} strategy={verticalListSortingStrategy}>
        <div className="nt-refblock-tree">
          <BlockRow
            tree={tree}
            client={client}
            resolveName={resolveName}
            readOnly={readOnly}
            /* The "+ Add block" affordance rides ONLY when the surface opts
               in (`showGhost`) and edits: the root block trails ONE ghost
               as the last CHILD (the child indent level — never a sibling
               of the root). The click realizes it into a real empty child
               and focuses it. The read-only projection (the hover
               preview) mounts none, same as every other read-only
               surface. */
            trailingGhost={
              showGhost && !readOnly ? (
                <GhostRow
                  parentId={rootId}
                  onRealize={() => {
                    void realizeGhost(client, outliner, rootId).catch((error: unknown) => {
                      console.warn(`[outliner] ghost realize (${rootId}) failed:`, error);
                    });
                  }}
                />
              ) : undefined
            }
          />
        </div>
      </SortableContext>
    </OutlinerContext.Provider>
  );
}
