/**
 * createNodesWithClasses — the "New" flow's write (owner 2026-10-06): one
 * untitled node per picked class, each created as a main page; the first
 * pick lands in the main view. Shared by the sidebar's New button and the
 * top bar's collapsed-sidebar cluster.
 */

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

type AnyClient = WorkspaceClient | WorkerClient;

export function createNodesWithClasses(
  client: AnyClient,
  classIds: string[],
  onOpenPage: (nodeId: string) => void,
): void {
  void (async () => {
    let first: string | null = null;
    for (const classId of classIds) {
      const id = await client.createObject({ classIds: [classId], presentAsMain: true });
      first ??= id;
    }
    if (first !== null) onOpenPage(first);
  })().catch((error: unknown) => {
    console.warn("[new-node] creation failed:", error);
  });
}
