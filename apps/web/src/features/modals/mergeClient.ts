/**
 * mergeClient — the merge seams the merge modals ride. Plan-07 retired the
 * server merge route: BOTH modes plan and apply against the local derived
 * store (in-process on the UI thread, worker mode inside the worker via
 * RPC). One leg, zero server reads.
 */

import type { MergePlanSummary } from "@notees/store";

import type { AnyClient } from "../../ui/app/clients.js";

/** The dry-run counts of merging `sourceId` into `targetId`. */
export function previewMerge(
  client: AnyClient,
  sourceId: string,
  targetId: string,
): Promise<MergePlanSummary> {
  return Promise.resolve(client.planMergeSummary(sourceId, targetId));
}

/** Apply one source → target merge (the caller sequences multi-source). */
export function applyMerge(client: AnyClient, sourceId: string, targetId: string): Promise<void> {
  // One undo-journal batch per source (the planner's contract).
  return client.mergeNodes(sourceId, targetId).then(() => {});
}
