/**
 * The merge REST transport helper (the worker main-thread proxy's merge
 * path): POST /api/objects/:id/merge {targetId} — the server runs the same
 * store planner the in-process client's mergeNodes rides, sequentially
 * submits the plan's ops (the source trash last), and returns the
 * MergePlanSummary. The ?dryRun=true variant plans WITHOUT writing — the
 * duplicates merge modal's preview in worker mode. Pure fetch plumbing — no
 * store, no client state (the asset-transport.ts register).
 */

import type { MergePlanSummary } from "@notees/store";

/**
 * POST /api/objects/:sourceId/merge. Auth is the workspace API key header
 * (the asset transport's register). A guard failure answers 422 with the
 * server's error envelope — the message is extracted so the caller's error
 * line reads like the in-process MergeGuardError's.
 */
export async function postObjectMerge(
  serverUrl: string,
  apiKey: string,
  workspaceId: string,
  sourceId: string,
  targetId: string,
  dryRun: boolean,
): Promise<MergePlanSummary> {
  const base = serverUrl.replace(/\/+$/, "");
  const query = dryRun ? "?dryRun=true" : "";
  const response = await fetch(
    `${base}/api/objects/${encodeURIComponent(sourceId)}/merge${query}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
        "X-Workspace-Id": workspaceId,
      },
      body: JSON.stringify({ targetId }),
    },
  );
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: { message?: unknown } };
      if (typeof body.error?.message === "string" && body.error.message !== "") {
        detail = body.error.message;
      }
    } catch {
      // A non-JSON error body — the status line stands.
    }
    throw new Error(`merge failed: ${detail}`);
  }
  const body = (await response.json()) as { summary?: unknown };
  if (typeof body.summary !== "object" || body.summary === null) {
    throw new Error("merge failed: response missing summary");
  }
  return body.summary as MergePlanSummary;
}
