/**
 * mergeClient — the mode-split merge seams the merge modals ride.
 *
 * The store planner needs ZERO changes: the in-process WorkspaceClient
 * plans (`planMergeSummary`) and applies (`mergeNodes` — one undo-journal
 * batch per source) against the local SQLite projection; the worker
 * WorkerClient rides the server's merge route (`mergeNodesRemote` —
 * `?dryRun=true` for the preview) and pulls afterwards so the local
 * projection catches up. `previewMerge`/`applyMerge` pick the leg from the
 * client instance; `pullIfRemote` is the no-op in-process / one-pull
 * worker tail of a completed multi-source merge.
 */

import type { MergePlanSummary } from "@notees/store";

import type { AnyClient } from "../../ui/app/clients.js";
import { WorkspaceClient } from "@/core/workspace-client/index.js";

/** The dry-run counts of merging `sourceId` into `targetId`. */
export function previewMerge(
  client: AnyClient,
  sourceId: string,
  targetId: string,
): Promise<MergePlanSummary> {
  if (client instanceof WorkspaceClient) {
    return Promise.resolve(client.planMergeSummary(sourceId, targetId));
  }
  return client.mergeNodesRemote(sourceId, targetId, true);
}

/** Apply one source → target merge (the caller sequences multi-source). */
export function applyMerge(client: AnyClient, sourceId: string, targetId: string): Promise<void> {
  if (client instanceof WorkspaceClient) {
    // One undo-journal batch per source (the planner's contract).
    return client.mergeNodes(sourceId, targetId).then(() => {});
  }
  return client.mergeNodesRemote(sourceId, targetId, false).then(() => {});
}

/**
 * After a remote merge the route wrote server-side: pull so the local
 * projection (and every view over it) catches up. In-process merges already
 * applied to the local projection — nothing to pull.
 */
export function pullIfRemote(client: AnyClient): Promise<void> {
  if (client instanceof WorkspaceClient) return Promise.resolve();
  return client.pull();
}
