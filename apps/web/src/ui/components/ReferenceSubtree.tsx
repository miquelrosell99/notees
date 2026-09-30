/**
 * ReferenceSubtree — renders a referencing node (and its children,
 * recursively) with the REAL editor row (BlockRow): the node context menu
 * on right-click, class-icon bullets, click-to-zoom bullets, collapse
 * chevrons, in-place editing — identical to the main block tree. Writes go
 * through the shared outliner client, so edits inside a reference behave
 * exactly like edits in the page body (same ops, same sync).
 *
 * BlockRow consumes OutlinerContext and useSortable, so each subtree hosts
 * its own OutlinerContext (via useOutlinerValue, same as PageView/ClassView)
 * and its own local DndContext + SortableContext (mirror of PageView's,
 * without the DragOverlay — inner drags simply show no ghost). Drop handling
 * is a no-op: reordering references is not supported in this slice.
 */

import { useEffect, useState } from "react";

import { DndContext } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";

import type { WorkerClient } from "@/core/worker-client.js";
import type { BlockTreeNode, ClientNode, WorkspaceClient } from "@/core/workspace-client.js";

import { BlockRow } from "../BlockRow.js";
import { blockCollisionDetection, useBlockDndSensors } from "../block-dnd.js";
import { displayNameFromClient } from "../dateDisplay.js";
import { OutlinerContext, useOutlinerValue } from "../outliner-context.js";

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

/** The referencing node plus its whole subtree, editable. */
export function ReferenceSubtree({
  client,
  rootId,
  onOpenNode,
}: {
  client: AnyClient;
  rootId: string;
  onOpenNode?: ((nodeId: string) => void) | undefined;
}) {
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);
  const outliner = useOutlinerValue(client, rootId, {
    openNode: (id) => onOpenNode?.(id),
  });
  const sensors = useBlockDndSensors();

  const node = client.getNode(rootId);
  if (node === undefined) return null;
  const tree = toTree(client, node);

  return (
    <OutlinerContext.Provider value={outliner}>
      <DndContext sensors={sensors} collisionDetection={blockCollisionDetection}>
        <SortableContext items={[node.id]} strategy={verticalListSortingStrategy}>
          <div className="nt-refblock-tree">
            <BlockRow tree={tree} resolveName={(id) => displayNameFromClient(client, id)} />
          </div>
        </SortableContext>
      </DndContext>
    </OutlinerContext.Provider>
  );
}
