/**
 * Query-token content helpers — the read/write surface the query node's
 * section uses for working with `query` content tokens on a block's
 * contentAst. All writes go through the normal content update path
 * (`object.update` on the node's contentAst, token splice by index) — the
 * tokens ride the op log, so a query's default AST syncs like any other
 * content. The block itself is MARKED by the query system class; the token is payload.
 */

import type { ContentAst } from "@notees/protocol";

/** The minimal write surface the token mutators need (both client classes satisfy it). */
export interface TokenWriteClient {
  getNode(id: string): { contentAst: ContentAst } | undefined;
  updateObject(id: string, fields: { contentAst: ContentAst }): Promise<void>;
}

async function replaceContentAst(
  client: TokenWriteClient,
  ownerId: string,
  map: (tokens: readonly unknown[]) => unknown[],
): Promise<void> {
  const owner = client.getNode(ownerId);
  if (owner === undefined) return;
  await client.updateObject(ownerId, {
    contentAst: map(owner.contentAst as readonly unknown[]) as ContentAst,
  });
}

/** Append a new query token (a classed block's first Apply, which creates the payload). */
export async function appendQueryToken(
  client: TokenWriteClient,
  ownerId: string,
  token: { queryAst: unknown },
): Promise<number> {
  const owner = client.getNode(ownerId);
  if (owner === undefined) return -1;
  const index = owner.contentAst.length;
  const next = [...(owner.contentAst as readonly unknown[]), { type: "query", ...token }];
  await client.updateObject(ownerId, { contentAst: next as ContentAst });
  return index;
}

/** Rewrite the token's queryAst at `index` (the per-tab builder's default-tab commit). */
export async function updateQueryTokenAst(
  client: TokenWriteClient,
  ownerId: string,
  index: number,
  queryAst: unknown,
): Promise<void> {
  await replaceContentAst(client, ownerId, (tokens) =>
    tokens.map((token, i) =>
      i === index && typeof token === "object" && token !== null
        ? { ...(token as Record<string, unknown>), queryAst }
        : token,
    ),
  );
}
