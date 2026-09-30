/**
 * FocusedBlockView — a block node opened directly (bullet zoom, deep link,
 * reference navigation): the block is the root of an editable block list,
 * no page header. The topbar breadcrumbs carry the context.
 */

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { ReferenceSubtree } from "./ReferenceSubtree.js";

type AnyClient = WorkspaceClient | WorkerClient;

export function FocusedBlockView({
  client,
  blockId,
  onOpenNode,
}: {
  client: AnyClient;
  blockId: string;
  onOpenNode?: ((nodeId: string) => void) | undefined;
}) {
  return (
    <div className="nt-page nt-focused-block">
      <ReferenceSubtree client={client} rootId={blockId} onOpenNode={onOpenNode} />
    </div>
  );
}
