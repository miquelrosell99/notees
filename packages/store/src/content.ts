/**
 * Plaintext extraction for the FTS index (v1 `derived/search.py` port,
 * extended per SCHEMA.md's owed FTS spec): text runs, typed-link text,
 * mention captured text, math expressions and recursive quote children come
 * from the domain excerpt helper; asset original names are joined from
 * node_asset. Plaintext is derived by the applier, never stored as truth.
 */

import { plainTextExcerpt } from "@notees/domain";
import type { ContentAst } from "@notees/protocol";

import type { StoreDatabase } from "./types.js";

export function parseContentAst(raw: string | null | undefined): ContentAst {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ContentAst) : [];
  } catch {
    return [];
  }
}

/** Derived search plaintext for one node's serialized contentAst. */
export function extractSearchPlaintext(db: StoreDatabase, raw: string | null | undefined): string {
  const ast = parseContentAst(raw);
  const parts: string[] = [plainTextExcerpt(ast)];

  const lookup = db.prepare(
    "SELECT original_name FROM node_asset WHERE asset_id = ? ORDER BY node_id LIMIT 1",
  );
  const seenAssets = new Set<string>();
  const walk = (tokens: readonly unknown[]): void => {
    for (const token of tokens) {
      if (typeof token !== "object" || token === null) continue;
      const t = token as { type?: unknown; assetId?: unknown; children?: unknown };
      if (t.type === "asset_ref" && typeof t.assetId === "string" && !seenAssets.has(t.assetId)) {
        seenAssets.add(t.assetId);
        const row = lookup.get(t.assetId) as { original_name: string } | undefined;
        if (row && row.original_name) parts.push(row.original_name);
      } else if (t.type === "quote" && Array.isArray(t.children)) {
        walk(t.children);
      }
    }
  };
  walk(ast);

  return parts
    .filter((p) => p.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
