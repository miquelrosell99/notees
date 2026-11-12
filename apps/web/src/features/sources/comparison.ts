/**
 * The "New comparison" author (research-tier2 slice 6): one `comparison`-
 * classed node (the workflow class — Task 2's deterministic id) titled from
 * the matrix, with ONE EMBED CHILD PER PICKED SOURCE (D3: the evidence
 * lives beside the claim; the embed renders the live subtree, so a
 * corrected source heals every comparison embedding it). The node is
 * parentless (`isEmbedded: false` — document chrome) and the call reports
 * its id for the caller to open — the annotation surface is the node
 * itself.
 *
 * The workflow-installed precondition is the CALLER's job (the matrix view
 * offers the one-click enable when the comparison class is absent —
 * authoring an unclassed comparison page silently is never the path).
 */

import { workflowEntityId } from "@notees/domain";

import type { CreateObjectInput } from "../../core/workspace-client/index.js";
import {
  comparisonTitleFor,
  matrixRows,
  type MatrixReadSurface,
} from "./sourcesQuery.js";

/** The deterministic id of the workflow's comparison class (Task 2). */
export const COMPARISON_CLASS_ID = workflowEntityId("research", "class", "comparison");

/** The write surface the author needs — the matrix reads + object.create. */
export type ComparisonAuthorClient = MatrixReadSurface &
  Pick<{ createObject(partial: CreateObjectInput): Promise<string> }, "createObject">;

/**
 * Author the comparison node over the picked source ids and report its id.
 * The title derives from the LIVE matrix rows (a stale id contributes no
 * title); the embeds ride the picked order.
 */
export async function createComparison(
  client: ComparisonAuthorClient,
  ids: readonly string[],
): Promise<string> {
  const rows = matrixRows(client, ids);
  const id = await client.createObject({
    isEmbedded: false,
    name: comparisonTitleFor(rows.map((row) => row.title)),
    classIds: [COMPARISON_CLASS_ID],
  });
  for (const row of rows) {
    await client.createObject({
      parentId: id,
      contentAst: [{ type: "embed_ref", nodeId: row.id }],
    });
  }
  return id;
}
