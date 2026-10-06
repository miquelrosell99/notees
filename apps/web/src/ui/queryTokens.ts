/**
 * Query-token content helpers — the read/write surface ViewTabs, the Queries
 * hub, and QueryBlockView share for working with `query` content tokens on an
 * owner's contentAst. All writes go through the normal content update path
 * (`object.update` on the owning node's contentAst, token splice by index) —
 * the tokens ride the op log, so saved views sync like any other content
 * (no view entity, no new op).
 */

import type { ContentAst } from "@notees/protocol";

import { mergeQueryViewRecord } from "./queryViewRecord.js";

/** One query token in an owner's content stream. */
export interface QueryTokenEntry {
  /** The token's position in the contentAst (the splice key). */
  index: number;
  queryAst: unknown;
  view: unknown;
}

/** The query tokens of a content stream, in stream order. */
export function listQueryTokens(contentAst: readonly unknown[]): QueryTokenEntry[] {
  const entries: QueryTokenEntry[] = [];
  contentAst.forEach((token, index) => {
    if (typeof token === "object" && token !== null && (token as { type?: unknown }).type === "query") {
      const record = token as { queryAst?: unknown; view?: unknown };
      entries.push({ index, queryAst: record.queryAst, view: record.view });
    }
  });
  return entries;
}

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

/** Merge a patch into the token's view record at `index` (foreign keys ride along). */
export async function patchTokenView(
  client: TokenWriteClient,
  ownerId: string,
  index: number,
  patch: Record<string, unknown>,
): Promise<void> {
  await replaceContentAst(client, ownerId, (tokens) =>
    tokens.map((token, i) =>
      i === index && typeof token === "object" && token !== null
        ? { ...(token as Record<string, unknown>), view: mergeQueryViewRecord((token as { view?: unknown }).view, patch) }
        : token,
    ),
  );
}

/** Append a new query token (the save-as-view write). Returns its index. */
export async function appendQueryToken(
  client: TokenWriteClient,
  ownerId: string,
  token: { queryAst: unknown; view?: Record<string, unknown> },
): Promise<number> {
  const owner = client.getNode(ownerId);
  if (owner === undefined) return -1;
  const index = owner.contentAst.length;
  const next = [...(owner.contentAst as readonly unknown[]), { type: "query", ...token }];
  await client.updateObject(ownerId, { contentAst: next as ContentAst });
  return index;
}

/** Remove the query token at `index` (the tab's delete). */
export async function removeQueryToken(
  client: TokenWriteClient,
  ownerId: string,
  index: number,
): Promise<void> {
  await replaceContentAst(client, ownerId, (tokens) =>
    tokens.filter((_token, i) => i !== index),
  );
}

/** Insert a copy of the token at `index` right after it (duplicate), titled "… copy". */
export async function duplicateQueryToken(
  client: TokenWriteClient,
  ownerId: string,
  index: number,
  copiedTitle: string,
): Promise<void> {
  await replaceContentAst(client, ownerId, (tokens) => {
    const source = tokens[index];
    if (typeof source !== "object" || source === null) return [...tokens];
    const view = mergeQueryViewRecord((source as { view?: unknown }).view, { title: copiedTitle });
    const copy = {
      ...(source as Record<string, unknown>),
      view,
    };
    const next = [...tokens];
    next.splice(index + 1, 0, copy);
    return next;
  });
}

/**
 * Move the token at `fromIndex` to `toIndex` (the tab reorder — the saved
 * views' order IS the token order in the content stream).
 */
export async function moveQueryToken(
  client: TokenWriteClient,
  ownerId: string,
  fromIndex: number,
  toIndex: number,
): Promise<void> {
  await replaceContentAst(client, ownerId, (tokens) => {
    if (
      fromIndex === toIndex ||
      fromIndex < 0 ||
      fromIndex >= tokens.length ||
      toIndex < 0 ||
      toIndex >= tokens.length
    ) {
      return [...tokens];
    }
    const next = [...tokens];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved!);
    return next;
  });
}

/** Set (or clear) the section's default saved view: one token carries the flag. */
export async function setDefaultQueryToken(
  client: TokenWriteClient,
  ownerId: string,
  index: number,
): Promise<void> {
  await replaceContentAst(client, ownerId, (tokens) =>
    tokens.map((token, i) => {
      if (typeof token !== "object" || token === null) return token;
      const view = mergeQueryViewRecord(
        (token as { view?: unknown }).view,
        i === index ? { isDefault: true } : { isDefault: false },
      );
      return { ...(token as Record<string, unknown>), view };
    }),
  );
}

/** Rewrite the token's queryAst at `index` (the hub's "edit this view" save). */
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
